import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { prisma } from '../db';
import { config } from '../config';
import { requireAuth } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimiter';
import { generateStableUid, generateClassCode, generateClassId } from '../utils/uid';
import {
  UnauthorizedError,
  ForbiddenError,
} from '../utils/errors';

const router = Router();

// ─── helpers ────────────────────────────────────────────────────────────────

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function signJwt(payload: {
  stableUid: string;
  username: string;
  klasseId: number;
  klasseName: string;
  isUntisUser?: boolean;
}): string {
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  } as jwt.SignOptions);
}

async function generateRefreshToken(stableUid: string): Promise<string> {
  const raw = randomBytes(40).toString('hex');
  const hash = hashToken(raw);
  const expiresAt = new Date();
  expiresAt.setTime(expiresAt.getTime() + config.refreshTokenExpiresInHours * 60 * 60 * 1000);

  // Delete all existing tokens for this user — keep DB clean, one session per user
  await prisma.refreshToken.deleteMany({
    where: { stableUid },
  });

  await prisma.refreshToken.create({
    data: {
      stableUid,
      tokenHash: hash,
      expiresAt,
    },
  });

  return raw;
}

// Auto-join / leave / create class based on webuntisKlasseId
async function syncUserClass(
  stableUid: string,
  username: string,
  klasseId: number,
  klasseName: string
): Promise<string | null> {
  // 1. Check if user is already in a class with this webuntisKlasseId
  const existingMembership = await prisma.classMember.findFirst({
    where: {
      stableUid,
      class: { webuntisKlasseId: klasseId },
    },
    select: { classId: true },
  });

  if (existingMembership) {
    return existingMembership.classId;
  }

  // 2. Find classes where user is member but webuntisKlasseId differs → leave
  const wrongMemberships = await prisma.classMember.findMany({
    where: { stableUid },
    include: {
      class: { select: { webuntisKlasseId: true } },
    },
  });

  for (const membership of wrongMemberships) {
    if (membership.class.webuntisKlasseId !== klasseId) {
      // Leave this class
      await prisma.classMember.delete({
        where: { classId_stableUid: { classId: membership.classId, stableUid } },
      });

      // If no members left, delete the class
      const remainingCount = await prisma.classMember.count({
        where: { classId: membership.classId },
      });
      if (remainingCount === 0) {
        await prisma.class.delete({ where: { id: membership.classId } }).catch(() => {});
      }
    }
  }

  // 3. Find existing class with this webuntisKlasseId
  const targetClass = await prisma.class.findFirst({
    where: { webuntisKlasseId: klasseId },
    select: { id: true },
  });

  if (targetClass) {
    // Join existing class
    await prisma.classMember.upsert({
      where: { classId_stableUid: { classId: targetClass.id, stableUid } },
      create: { classId: targetClass.id, stableUid, username },
      update: { username },
    });
    return targetClass.id;
  }

  // 4. Create new class
  const newClassId = generateClassId();
  const code = generateClassCode();

  try {
    await prisma.class.create({
      data: {
        id: newClassId,
        name: klasseName,
        code,
        webuntisKlasseId: klasseId,
        createdBy: stableUid,
        createdByName: username,
        members: {
          create: { stableUid, username },
        },
      },
    });
    return newClassId;
  } catch (err: unknown) {
    // Race condition: another process created the class, try to join it
    const existing = await prisma.class.findFirst({
      where: { webuntisKlasseId: klasseId },
      select: { id: true },
    });
    if (existing) {
      await prisma.classMember.upsert({
        where: { classId_stableUid: { classId: existing.id, stableUid } },
        create: { classId: existing.id, stableUid, username },
        update: { username },
      });
      return existing.id;
    }
    throw err;
  }
}

// ─── POST /auth/login ────────────────────────────────────────────────────────

const loginSchema = z.object({
  username: z.string().min(1).max(100).trim().toLowerCase(),
  klasseId: z.number().int().positive(),
  klasseName: z.string().min(0).max(100),
});

const localLoginSchema = z.object({
  username: z.string().min(1).max(100).trim().toLowerCase(),
  password: z.string().min(1).max(200),
});

router.post('/login', authLimiter, async (req: Request, res: Response) => {
  const serverKey = req.headers['x-server-key'];

  // ── Local password login (no server key) ──────────────────────────────────
  if (!serverKey) {
    const body = localLoginSchema.parse(req.body);
    const { username, password } = body;

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user || !user.passwordHash) {
      throw new UnauthorizedError('Ungültige Zugangsdaten');
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedError('Ungültige Zugangsdaten');
    }

    const admin = await prisma.admin.findUnique({ where: { stableUid: user.stableUid } });
    const token = signJwt({
      stableUid: user.stableUid,
      username: user.username,
      klasseId: 0,
      klasseName: '',
      isUntisUser: false,
    });
    const refreshToken = await generateRefreshToken(user.stableUid);

    return res.json({
      token,
      refreshToken,
      user: {
        stableUid: user.stableUid,
        username: user.username,
        webuntisKlasseId: 0,
        webuntisKlasseName: '',
        classId: null,
        isAdmin: admin !== null,
        isUntisUser: false,
      },
    });
  }

  // ── Server-to-server Untis login ──────────────────────────────────────────
  if (typeof serverKey !== 'string') {
    throw new UnauthorizedError('Invalid X-Server-Key header');
  }

  const expectedBuf = Buffer.from(config.serverKey, 'utf8');
  const actualBuf = Buffer.from(serverKey, 'utf8');
  let validKey = false;
  if (actualBuf.length === expectedBuf.length) {
    try {
      validKey = timingSafeEqual(expectedBuf, actualBuf);
    } catch {
      validKey = false;
    }
  }
  if (!validKey) {
    throw new ForbiddenError('Invalid server key');
  }

  const body = loginSchema.parse(req.body);
  const { username, klasseId, klasseName } = body;

  // Upsert user — create with new stableUid, update keeps existing stableUid
  let user = await prisma.user.findUnique({ where: { username } });

  if (!user) {
    const stableUid = generateStableUid();
    user = await prisma.user.create({
      data: {
        stableUid,
        username,
        webuntisKlasseId: klasseId,
        webuntisKlasseName: klasseName,
        isUntisUser: true,
      },
    });
  } else {
    user = await prisma.user.update({
      where: { username },
      data: {
        webuntisKlasseId: klasseId,
        webuntisKlasseName: klasseName,
        isUntisUser: true,
      },
    });
  }

  // Sync class membership
  const classId = await syncUserClass(user.stableUid, username, klasseId, klasseName);

  // Check admin status
  const admin = await prisma.admin.findUnique({
    where: { stableUid: user.stableUid },
  });
  const isAdmin = admin !== null;

  // Generate tokens
  const token = signJwt({
    stableUid: user.stableUid,
    username: user.username,
    klasseId: user.webuntisKlasseId,
    klasseName: user.webuntisKlasseName,
    isUntisUser: true,
  });
  const refreshToken = await generateRefreshToken(user.stableUid);

  res.json({
    token,
    refreshToken,
    user: {
      stableUid: user.stableUid,
      username: user.username,
      webuntisKlasseId: user.webuntisKlasseId,
      webuntisKlasseName: user.webuntisKlasseName,
      classId,
      isAdmin,
      isUntisUser: true,
    },
  });
});

// ─── POST /auth/register ─────────────────────────────────────────────────────

const registerSchema = z.object({
  username: z
    .string()
    .min(3, 'Benutzername muss mindestens 3 Zeichen lang sein')
    .max(30, 'Benutzername darf maximal 30 Zeichen lang sein')
    .regex(/^[a-z0-9_-]+$/, 'Nur Kleinbuchstaben, Zahlen, _ und - erlaubt')
    .trim(),
  password: z.string().min(8, 'Passwort muss mindestens 8 Zeichen lang sein').max(200),
});

router.post('/register', authLimiter, async (req: Request, res: Response) => {
  const body = registerSchema.parse(req.body);
  const { username, password } = body;

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    return res.status(409).json({ error: 'Benutzername bereits vergeben' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const stableUid = generateStableUid();

  const user = await prisma.user.create({
    data: {
      stableUid,
      username,
      webuntisKlasseId: 0,
      webuntisKlasseName: '',
      passwordHash,
      isUntisUser: false,
    },
  });

  const token = signJwt({
    stableUid: user.stableUid,
    username: user.username,
    klasseId: 0,
    klasseName: '',
    isUntisUser: false,
  });
  const refreshToken = await generateRefreshToken(user.stableUid);

  res.status(201).json({
    token,
    refreshToken,
    user: {
      stableUid: user.stableUid,
      username: user.username,
      webuntisKlasseId: 0,
      webuntisKlasseName: '',
      classId: null,
      isAdmin: false,
      isUntisUser: false,
    },
  });
});

// ─── POST /auth/refresh ──────────────────────────────────────────────────────

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

router.post('/refresh', authLimiter, async (req: Request, res: Response) => {
  const { refreshToken: rawToken } = refreshSchema.parse(req.body);
  const tokenHash = hashToken(rawToken);

  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    throw new UnauthorizedError('Invalid or expired refresh token');
  }

  const { user } = stored;

  const token = signJwt({
    stableUid: user.stableUid,
    username: user.username,
    klasseId: user.webuntisKlasseId,
    klasseName: user.webuntisKlasseName,
  });

  res.json({ token });
});

// ─── POST /auth/logout ───────────────────────────────────────────────────────

const logoutSchema = z.object({
  refreshToken: z.string().min(1),
});

router.post('/logout', requireAuth, async (req: Request, res: Response) => {
  const body = logoutSchema.safeParse(req.body);
  if (body.success) {
    const tokenHash = hashToken(body.data.refreshToken);
    await prisma.refreshToken
      .updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      .catch(() => {});
  }
  res.json({ ok: true });
});

// ─── GET /auth/me ────────────────────────────────────────────────────────────

router.get('/me', requireAuth, async (req: Request, res: Response) => {
  const { stableUid } = req.user!;

  const user = await prisma.user.findUnique({ where: { stableUid } });
  if (!user) {
    throw new UnauthorizedError('User not found');
  }

  const admin = await prisma.admin.findUnique({ where: { stableUid } });
  const membership = await prisma.classMember.findFirst({ where: { stableUid } });

  res.json({
    stableUid: user.stableUid,
    username: user.username,
    webuntisKlasseId: user.webuntisKlasseId,
    webuntisKlasseName: user.webuntisKlasseName,
    classId: membership?.classId ?? null,
    isAdmin: admin !== null,
    isUntisUser: user.isUntisUser,
  });
});

export { router as authRouter };
