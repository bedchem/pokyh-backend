import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { readLimiter, writeLimiter } from '../middleware/rateLimiter';
import { NotFoundError } from '../utils/errors';
import { defaultSchoolId, schoolOfUser } from '../services/schools';
import { loadAccountActivity } from '../services/accountActivity';
import { BELL_MARK_BATCH, addBellMarks, bellMarksOf } from '../services/bellMarks';
import { exportAccountData } from '../services/dataExport';
import { logger } from '../utils/logger';
import { rateLimit } from 'express-rate-limit';

const router = Router();

// A bell notification's identifier ("grade:4711", "todo:<uuid>:<due>").
const bellKeys = z.array(z.string().min(1).max(120).regex(/^[A-Za-z0-9:._-]+$/)).max(BELL_MARK_BATCH);
const bellMarksSchema = z.object({ seen: bellKeys.default([]), cleared: bellKeys.default([]) });

// GET /users/me — returns current authenticated user
router.get('/me', readLimiter, requireAuth, async (req: Request, res: Response) => {
  const { stableUid } = req.user!;

  const user = await prisma.user.findUnique({ where: { stableUid } });
  if (!user) {
    throw new NotFoundError('User not found');
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
    role: user.role,
  });
});

// GET /users/me/activity — the account's own activity for its profile: active
// days, sign-ins and (with consent) time in Pokyh. Only ever about the caller.
router.get('/me/activity', readLimiter, requireAuth, async (req: Request, res: Response) => {
  res.set('Cache-Control', 'private, no-store');
  res.json(await loadAccountActivity(req.user!.stableUid));
});

// GET /users/me/export — "Daten anfordern": everything POKYH keeps about the
// account as one JSON file (services/dataExport.ts), at once. A few times an
// hour per account is plenty.
const exportLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `data-export:${req.user?.stableUid ?? 'none'}`,
  message: { error: 'Du hast deine Daten gerade erst angefordert. Bitte versuche es in einer Stunde wieder.', code: 'rate_limited' },
});

router.get('/me/export', readLimiter, requireAuth, exportLimiter, async (req: Request, res: Response) => {
  const data = await exportAccountData(req.user!.stableUid);
  logger.info('Account data exported by its account', { action: 'data_export', username: req.user!.username });
  const day = new Date().toISOString().slice(0, 10);
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', `attachment; filename="pokyh-daten-${day}.json"`);
  res.type('application/json').send(JSON.stringify(data, null, 2));
});

// GET /users/me/bell — which of the bell's notifications the account has seen
// and cleared away, on any device (services/bellMarks.ts).
router.get('/me/bell', readLimiter, requireAuth, async (req: Request, res: Response) => {
  res.set('Cache-Control', 'private, no-store');
  res.json(await bellMarksOf(req.user!.stableUid));
});

// POST /users/me/bell — { seen?, cleared? }: marks more of them; nothing is unmarked.
router.post('/me/bell', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const { seen, cleared } = bellMarksSchema.parse(req.body);
  await addBellMarks(req.user!.stableUid, seen, cleared);
  res.status(204).send();
});

// GET /users/:userId — userId can be username or stableUid
router.get('/:userId', readLimiter, requireAuth, async (req: Request, res: Response) => {
  const userId = req.params['userId'] as string;

  const user = await prisma.user.findFirst({
    where: {
      OR: [{ username: userId }, { stableUid: userId }],
    },
  });

  // Accounts of other schools are not visible from the app.
  if (!user || (user.schoolId ?? defaultSchoolId()) !== (await schoolOfUser(req.user!.stableUid))) {
    throw new NotFoundError('User not found');
  }

  const admin = await prisma.admin.findUnique({
    where: { stableUid: user.stableUid },
  });
  const membership = await prisma.classMember.findFirst({
    where: { stableUid: user.stableUid },
  });

  res.json({
    stableUid: user.stableUid,
    username: user.username,
    webuntisKlasseId: user.webuntisKlasseId,
    webuntisKlasseName: user.webuntisKlasseName,
    classId: membership?.classId ?? null,
    isAdmin: admin !== null,
    role: user.role,
  });
});

export { router as usersRouter };
