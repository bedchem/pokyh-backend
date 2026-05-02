import { Router, Request, Response } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { readLimiter } from '../middleware/rateLimiter';
import { NotFoundError } from '../utils/errors';

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
  });
});

// GET /users/:userId — userId can be username or stableUid
router.get('/:userId', readLimiter, requireAuth, async (req: Request, res: Response) => {
  const userId = req.params['userId'] as string;

  const user = await prisma.user.findFirst({
    where: {
      OR: [{ username: userId }, { stableUid: userId }],
    },
  });

  if (!user) {
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
  });
});

export { router as usersRouter };
