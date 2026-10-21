import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimiter';
import { readSession as readUntisSession } from '../webuntis/session';

const router = Router();

const registerSchema = z.object({
  endpoint: z.string().url().max(500),
  p256dh: z.string().max(255),
  auth: z.string().max(255),
  // The apps send their WebUntis session; the website's lives in its sealed
  // session cookie on this address and is read from there.
  jsessionid: z.string().max(100).optional(),
  bearerToken: z.string().max(1000).optional(),
});

// POST /push/register
router.post('/register', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  const body = registerSchema.parse(req.body);
  const website = body.jsessionid ? null : readUntisSession(req);
  const jsessionid = body.jsessionid ?? website?.sessionId;
  if (!jsessionid) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const bearerToken = body.bearerToken ?? website?.bearerToken ?? '';

  await prisma.pushSubscription.upsert({
    where: { endpoint: body.endpoint },
    update: {
      stableUid,
      p256dh: body.p256dh,
      auth: body.auth,
      jsessionid,
      bearerToken,
      knownUnread: -1,
    },
    create: {
      stableUid,
      endpoint: body.endpoint,
      p256dh: body.p256dh,
      auth: body.auth,
      jsessionid,
      bearerToken,
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
