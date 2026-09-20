import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { prisma } from '../db';
import { config } from '../config';
import { requireAuth } from '../middleware/auth';
import { authLimiter, learnLoginLimiter, refreshLimiter } from '../middleware/rateLimiter';
import { generateStableUid, generateClassCode, generateClassId } from '../utils/uid';
import { validateWebUntis } from '../services/webuntis';
import { getLearnConfig } from '../services/learnConfig';
import { reclaimDishRatings } from '../services/dishRatings';
import { logger } from '../utils/logger';
import { AccountRole, normalizeAccountClass } from '../utils/accountClass';
import {
  AppError,
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
} from '../utils/errors';

const router = Router();

type AuthenticatedUserResponse = {
  token: string;
  refreshToken: string;
  user: {
    stableUid: string;
    username: string;
    webuntisKlasseId: number;
    webuntisKlasseName: string;
    classId: string | null;
    isAdmin: boolean;
    isUntisUser: boolean;
    role: string;
  };
};

// ─── helpers ────────────────────────────────────────────────────────────────

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function signJwt(payload: {
  stableUid: string;
  username: string;
  klasseId: number;
  klasseName: string;
  role: string;
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

async function removeUserFromClasses(stableUid: string): Promise<void> {
  const memberships = await prisma.classMember.findMany({
    where: { stableUid },
    select: { classId: true },
  });
  if (memberships.length === 0) return;

  const classIds = [...new Set(memberships.map((membership) => membership.classId))];
  await prisma.classMember.deleteMany({ where: { stableUid } });
  // Delete only classes that are still empty at deletion time. The relation
  // filter avoids racing a student who joins after the membership cleanup.
  await prisma.class.deleteMany({
    where: { id: { in: classIds }, members: { none: {} } },
  });
}

// Auto-join / leave / create class based on webuntisKlasseId. Parent accounts
// are deliberately never class members, even when a caller submits the class
// of a child or an old deployment left a parent ClassMember row behind.
async function syncUserClass(
  stableUid: string,
  username: string,
  klasseId: number,
  klasseName: string,
  role: AccountRole = 'student'
): Promise<string | null> {
  if (role === 'parent') {
    await prisma.user.updateMany({
      where: {
        stableUid,
        OR: [
          { webuntisKlasseId: { not: 0 } },
          { webuntisKlasseName: { not: '' } },
        ],
      },
      data: { webuntisKlasseId: 0, webuntisKlasseName: '' },
    });
    await removeUserFromClasses(stableUid);
    return null;
  }

  // 0. No class assigned (klasseId 0 / missing) — common for parents/teachers,
  // but also a transient client-side resolution miss. Do NOT wipe an existing
  // membership in that case (that would unenrol a user whose class simply failed
  // to resolve on one login). Keep any existing class; otherwise no class.
  if (!klasseId || klasseId <= 0) {
    const existing = await prisma.classMember.findFirst({
      where: { stableUid },
      select: { classId: true },
    });
    return existing?.classId ?? null;
  }

  // 1. Reconcile every membership. This also repairs legacy users that were in
  // multiple classes: only the class matching the current WebUntis id survives.
  const memberships = await prisma.classMember.findMany({
    where: { stableUid },
    include: {
      class: { select: { webuntisKlasseId: true } },
    },
  });
  const existingMembership = memberships.find(
    (membership) => membership.class.webuntisKlasseId === klasseId,
  );

  const wrongClassIds = memberships
    .filter((membership) => membership.class.webuntisKlasseId !== klasseId)
    .map((membership) => membership.classId);
  if (wrongClassIds.length > 0) {
    await prisma.classMember.deleteMany({
      where: { stableUid, classId: { in: wrongClassIds } },
    });
    // Delete only classes that are still empty when this query executes.
    await prisma.class.deleteMany({
      where: { id: { in: wrongClassIds }, members: { none: {} } },
    });
  }

  if (existingMembership) {
    await prisma.classMember.update({
      where: { classId_stableUid: { classId: existingMembership.classId, stableUid } },
      data: { username, role: 'student' },
    });
    return existingMembership.classId;
  }

  // 2. Find existing class with this webuntisKlasseId
  const targetClass = await prisma.class.findFirst({
    where: { webuntisKlasseId: klasseId },
    select: { id: true },
  });

  if (targetClass) {
    // Join existing class
    await prisma.classMember.upsert({
      where: { classId_stableUid: { classId: targetClass.id, stableUid } },
      create: { classId: targetClass.id, stableUid, username, role },
      update: { username, role },
    });
    return targetClass.id;
  }

  // 3. Create new class
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
          create: { stableUid, username, role },
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
        create: { classId: existing.id, stableUid, username, role },
        update: { username, role },
      });
      return existing.id;
    }
    throw err;
  }
}

/**
 * Creates the normal POKYH session only after a trusted WebUntis validation.
 * Both the established server-to-server login and the Learn-only BFF route use
 * this one path, which prevents their user/profile semantics from diverging.
 */
async function completeWebUntisLogin({
  username,
  klasseId,
  klasseName,
  role,
}: {
  username: string;
  klasseId: number;
  klasseName: string;
  role: 'student' | 'parent';
}): Promise<AuthenticatedUserResponse> {
  const accountClass = normalizeAccountClass(role, klasseId, klasseName);
  klasseId = accountClass.klasseId;
  klasseName = accountClass.klasseName;
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
        role,
      },
    });
    // A recreated account (rollover, rebuild) gets its earlier dish votes back.
    reclaimDishRatings(user.stableUid, user.username).catch((err) => {
      logger.warn('dish rating reclaim failed', { error: err instanceof Error ? err.message : String(err) });
    });
  } else {
    user = await prisma.user.update({
      where: { username },
      data: {
        webuntisKlasseId: klasseId,
        webuntisKlasseName: klasseName,
        isUntisUser: true,
        role,
      },
    });
  }

  const classId = await syncUserClass(user.stableUid, username, klasseId, klasseName, role);
  const isAdmin = await prisma.admin.findUnique({ where: { stableUid: user.stableUid } }) !== null;
  const token = signJwt({
    stableUid: user.stableUid,
    username: user.username,
    klasseId: user.webuntisKlasseId,
    klasseName: user.webuntisKlasseName,
    role: user.role,
    isUntisUser: true,
  });
  const refreshToken = await generateRefreshToken(user.stableUid);

  return {
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
      role: user.role,
    },
  };
}

// ─── POST /auth/login ────────────────────────────────────────────────────────

const loginSchema = z.object({
  username: z.string().min(1).max(100).trim().toLowerCase(),
  // 0 = no class (parents/teachers/staff). syncUserClass handles the no-class case.
  // Coerce + default so a missing/string klasseId never 422s a valid login.
  klasseId: z.coerce.number().int().nonnegative().default(0),
  klasseName: z.string().min(0).max(100).default(''),
  // The backend normalizes every parent to klasseId=0/name="" and removes any
  // stale membership, even if a trusted caller accidentally sends child data.
  role: z.enum(['student', 'parent']).optional().default('student'),
});

const localLoginSchema = z.object({
  username: z.string().min(1).max(100).trim().toLowerCase(),
  password: z.string().min(1).max(200),
});

const learnLoginSchema = z.object({
  username: z.string().min(1).max(100).trim().toLowerCase(),
  password: z.string().min(1).max(200),
  privacyNoticeVersion: z.string().trim().max(80).optional(),
});

// The Learn BFF has the ordinary API key but deliberately never receives the
// backend's server key. It validates WebUntis credentials here, then receives
// the same signed Pokyh session as the established Pokyh WebUntis login flow.
// No password is stored or logged by this route.
router.post('/learn-login', learnLoginLimiter, async (req: Request, res: Response) => {
  const { username, password, privacyNoticeVersion } = learnLoginSchema.parse(req.body);
  const learnCfg = await getLearnConfig();
  if (!learnCfg.legalGateReady) {
    throw new AppError('Pokyh Learn is not available until its operator completes the required privacy configuration', 503);
  }
  if (learnCfg.legalGateEnabled && privacyNoticeVersion !== learnCfg.privacyNoticeVersion) {
    throw new ValidationError('Please acknowledge the current Pokyh Learn privacy notice before signing in');
  }
  let result: AuthenticatedUserResponse;
  try {
    const untis = await validateWebUntis(username, password);
    result = await completeWebUntisLogin({
      username,
      klasseId: untis.klasseId,
      klasseName: untis.klasseName,
      role: 'student',
    });
  } catch {
    throw new UnauthorizedError('WebUntis-Anmeldung fehlgeschlagen');
  }
  if (learnCfg.legalGateEnabled) {
    await prisma.learnProfile.upsert({
      where: { stableUid: result.user.stableUid },
      create: {
        stableUid: result.user.stableUid,
        privacyNoticeVersion: learnCfg.privacyNoticeVersion,
        privacyNoticeAcknowledgedAt: new Date(),
      },
      update: {
        privacyNoticeVersion: learnCfg.privacyNoticeVersion,
        privacyNoticeAcknowledgedAt: new Date(),
      },
    });
  }
  res.json(result);
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
    const classId = await syncUserClass(
      user.stableUid,
      user.username,
      user.webuntisKlasseId,
      user.webuntisKlasseName,
      user.role === 'parent' ? 'parent' : 'student',
    );
    const accountClass = normalizeAccountClass(
      user.role === 'parent' ? 'parent' : 'student',
      user.webuntisKlasseId,
      user.webuntisKlasseName,
    );
    const token = signJwt({
      stableUid: user.stableUid,
      username: user.username,
      klasseId: accountClass.klasseId,
      klasseName: accountClass.klasseName,
      role: user.role,
      isUntisUser: false,
    });
    const refreshToken = await generateRefreshToken(user.stableUid);

    return res.json({
      token,
      refreshToken,
      user: {
        stableUid: user.stableUid,
        username: user.username,
        webuntisKlasseId: accountClass.klasseId,
        webuntisKlasseName: accountClass.klasseName,
        classId,
        isAdmin: admin !== null,
        isUntisUser: false,
        role: user.role,
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
  const { username, klasseId, klasseName, role } = body;

  res.json(await completeWebUntisLogin({ username, klasseId, klasseName, role }));
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

  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
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
    role: user.role,
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
      role: user.role,
    },
  });
});

// ─── POST /auth/refresh ──────────────────────────────────────────────────────

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

router.post('/refresh', refreshLimiter, async (req: Request, res: Response) => {
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
  const accountClass = normalizeAccountClass(
    user.role === 'parent' ? 'parent' : 'student',
    user.webuntisKlasseId,
    user.webuntisKlasseName,
  );

  const token = signJwt({
    stableUid: user.stableUid,
    username: user.username,
    klasseId: accountClass.klasseId,
    klasseName: accountClass.klasseName,
    role: user.role,
  });
  // Rotate on every use: a refresh token that leaks once and gets replayed
  // would otherwise stay valid for its entire lifetime with no signal.
  // generateRefreshToken() deletes this (and any other) existing token for
  // the user before issuing the new one.
  const refreshToken = await generateRefreshToken(user.stableUid);

  res.json({ token, refreshToken });
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

  if (user.role === 'parent') {
    await syncUserClass(
      user.stableUid,
      user.username,
      0,
      '',
      'parent',
    );
  }

  const admin = await prisma.admin.findUnique({ where: { stableUid } });
  const accountClass = normalizeAccountClass(
    user.role === 'parent' ? 'parent' : 'student',
    user.webuntisKlasseId,
    user.webuntisKlasseName,
  );
  const membership = user.role === 'parent'
    ? null
    : await prisma.classMember.findFirst({ where: { stableUid } });

  res.json({
    stableUid: user.stableUid,
    username: user.username,
    webuntisKlasseId: accountClass.klasseId,
    webuntisKlasseName: accountClass.klasseName,
    classId: membership?.classId ?? null,
    isAdmin: admin !== null,
    isUntisUser: user.isUntisUser,
    role: user.role,
  });
});

export { router as authRouter };
