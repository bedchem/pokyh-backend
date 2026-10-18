import { Router, Request, Response } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { readLimiter } from '../middleware/rateLimiter';
import { NotFoundError } from '../utils/errors';
import { defaultSchoolId, schoolOfUser } from '../services/schools';
import { loadAccountActivity } from '../services/accountActivity';

const router = Router();

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
