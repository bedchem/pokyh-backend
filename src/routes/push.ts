import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimiter';
import { readSession as readUntisSession } from '../webuntis/session';
import { isDeviceToken } from '../services/apns';
import { apnsActive } from '../services/pushPoller';
import { PUSH_KINDS, wantsKind } from '../services/pushNotices';

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

const apnsSchema = z.object({
  token: z.string().refine(isDeviceToken, 'not an APNs device token'),
  environment: z.enum(['sandbox', 'production']),
  // What the phone wants from here; the rest it checks for itself. All of it when left out.
  kinds: z.array(z.enum(PUSH_KINDS)).max(PUSH_KINDS.length).optional(),
  jsessionid: z.string().max(100).optional(),
  bearerToken: z.string().max(1000).optional(),
});

// POST /push/apns — the iOS app sends this on every launch, so the WebUntis
// session the message poll needs stays fresh. Without one (POKYH-only
// accounts) the device still gets to-dos and reminders.
router.post('/apns', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const { stableUid, sid } = req.user!;
  const body = apnsSchema.parse(req.body);
  // No key, no pushes. The app stops its own checks once registered, so accepting the token here
  // would leave it with no notifications at all; a refusal keeps it checking for itself.
  if (!apnsActive()) {
    res.status(503).json({ error: 'Push notifications are not set up on this server.', code: 'apns_off' });
    return;
  }
  const session = {
    kinds: (body.kinds ?? PUSH_KINDS).join(','),
    sessionId: sid ?? null,
    jsessionid: body.jsessionid ?? '',
    bearerToken: body.bearerToken ?? '',
  };

  // A token that moves to another account (sign out, sign in as someone
  // else) starts counting unread messages from scratch, and so does one that
  // only now asks for messages; otherwise the count stays, or every launch
  // would swallow the next new message.
  const existing = await prisma.apnsDevice.findUnique({ where: { token: body.token }, select: { stableUid: true, kinds: true } });
  const sameAccount = existing?.stableUid === stableUid && wantsKind(existing.kinds, 'messages');

  await prisma.apnsDevice.upsert({
    where: { token: body.token },
    update: { stableUid, environment: body.environment, ...session, ...(sameAccount ? {} : { knownUnread: -1 }) },
    create: { stableUid, token: body.token, environment: body.environment, ...session },
  });

  res.status(204).send();
});

// DELETE /push/apns — sign out on the phone, or notifications turned off.
router.delete('/apns', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  const { token } = z.object({ token: z.string().max(200) }).parse(req.body);

  await prisma.apnsDevice.deleteMany({ where: { stableUid, token } });

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
