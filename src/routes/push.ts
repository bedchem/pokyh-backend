import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimiter';

const router = Router();

const registerSchema = z.object({
  endpoint: z.string().url().max(500),
  p256dh: z.string().max(255),
  auth: z.string().max(255),
  jsessionid: z.string().max(100),
  bearerToken: z.string().max(1000),
});

// POST /push/register
router.post('/register', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  const body = registerSchema.parse(req.body);

  await prisma.pushSubscription.upsert({
    where: { endpoint: body.endpoint },
    update: {
      stableUid,
      p256dh: body.p256dh,
      auth: body.auth,
      jsessionid: body.jsessionid,
      bearerToken: body.bearerToken,
      knownUnread: -1,
    },
    create: {
      stableUid,
      endpoint: body.endpoint,
      p256dh: body.p256dh,
      auth: body.auth,
      jsessionid: body.jsessionid,
      bearerToken: body.bearerToken,
    },
  });

  res.status(204).send();
});

// DELETE /push/unsubscribe — called when user revokes permission
router.delete('/unsubscribe', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  const { endpoint } = z.object({ endpoint: z.string().url() }).parse(req.body);

  await prisma.pushSubscription.deleteMany({ where: { stableUid, endpoint } });

  res.status(204).send();
});

export { router as pushRouter };
