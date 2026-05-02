import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
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
}): string {
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  } as jwt.SignOptions);
}

async function generateRefreshToken(stableUid: string): Promise<string> {
  const raw = randomBytes(40).toString('hex');
  const hash = hashToken(raw);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + config.refreshTokenExpiresInDays);

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

router.post('/login', authLimiter, async (req: Request, res: Response) => {
  // Verify X-Server-Key header
  const serverKey = req.headers['x-server-key'];
  if (!serverKey || typeof serverKey !== 'string') {
    throw new UnauthorizedError('Missing X-Server-Key header');
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
      },
    });
  } else {
    user = await prisma.user.update({
      where: { username },
      data: {
        webuntisKlasseId: klasseId,
        webuntisKlasseName: klasseName,
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
  });
});

export { router as authRouter };
