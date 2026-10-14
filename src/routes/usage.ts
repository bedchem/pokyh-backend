import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { optionalAuth } from '../middleware/auth';
import { logger } from '../utils/logger';
import { hasUsageConsent } from '../services/privacyConsent';
import {
  USAGE_CLIENTS,
  USAGE_DEVICES,
  classifyUserAgent,
  creditedSeconds,
  localDayAndHour,
  type UsageDevice,
} from '../services/usageAnalytics';

// POST /usage/ping — the foreground heartbeat behind the admin Analytics page.
//
// The web app and the iOS and Android apps call this when a visit starts,
// about once a minute while Pokyh is in the foreground, and once more when it
// goes to the background. Each call carries the foreground seconds and opened
// screens since the previous one; the server adds them to that visit's single
// row. Nothing else is kept: no IP address, user agent, path or content — and
// nothing at all for an account that has not consented to the usage
// statistics (or for no account), whatever the client sends.

const router = Router();

// A signed-in person gets a bucket of their own; guests share one per address
// (a whole school can sit behind one). Pings come about once a minute, so the
// limit only ever stops a broken client.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: (req) => (req.user ? 30 : 600),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `usage:${req.user.stableUid}` : `usage-ip:${req.ip ?? 'unknown'}`),
  message: { error: 'Too many usage pings' },
});

const pingSchema = z.object({
  sessionId: z.string().uuid(),
  // The client's own view of its device wins: it can tell an iPad from a Mac,
  // which its user agent cannot.
  device: z.enum(USAGE_DEVICES).optional(),
  client: z.enum(USAGE_CLIENTS),
  appVersion: z.string().max(32).regex(/^[0-9A-Za-z.+_-]*$/).optional(),
  activeSeconds: z.number().int().min(0).max(3600).default(0),
  screens: z.number().int().min(0).max(500).default(0),
});

// Screens per ping are capped as well; one minute of use does not open more.
const MAX_PING_SCREENS = 60;
// The first ping of a visit is credited at most this much wall-clock time.
const FIRST_PING_WINDOW_MS = 115 * 1000;

type Ping = z.infer<typeof pingSchema>;

async function applyPing(ping: Ping, stableUid: string | null, device: UsageDevice, now: Date): Promise<void> {
  const screens = Math.min(ping.screens, MAX_PING_SCREENS);
  const existing = await prisma.usageSession.findUnique({
    where: { id: ping.sessionId },
    select: { stableUid: true, activeSeconds: true, lastSeenAt: true },
  });

  if (!existing) {
    const { dayKey, hour } = localDayAndHour(now, config.usageAnalytics.timezone);
    await prisma.usageSession.create({
      data: {
        id: ping.sessionId,
        stableUid,
        device,
        client: ping.client,
        appVersion: ping.client === 'app' ? (ping.appVersion ?? '') : '',
        dayKey,
        startHour: hour,
        activeSeconds: creditedSeconds(ping.activeSeconds, FIRST_PING_WINDOW_MS, 0),
        screens,
        startedAt: now,
        lastSeenAt: now,
      },
    });
    return;
  }

  // A visit belongs to the account that started it. Another account's ping
  // with the same id is ignored rather than merged into someone else's row.
  if (existing.stableUid && stableUid && existing.stableUid !== stableUid) return;

  const add = creditedSeconds(ping.activeSeconds, now.getTime() - existing.lastSeenAt.getTime(), existing.activeSeconds);
  await prisma.usageSession.update({
    where: { id: ping.sessionId },
    data: {
      activeSeconds: { increment: add },
      screens: { increment: screens },
      lastSeenAt: now,
      // A guest who signs in during the visit.
      ...(stableUid && !existing.stableUid ? { stableUid } : {}),
    },
  });
}

router.post('/ping', optionalAuth, limiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = pingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid payload' });
    return;
  }

  const ping = parsed.data;
  const stableUid = req.user?.stableUid ?? null;
  // Measured only with consent. The answer is the same either way, so a
  // client learns nothing from it and simply keeps going.
  if (!stableUid || !(await hasUsageConsent(stableUid).catch(() => false))) {
    res.status(204).send();
    return;
  }
  const device: UsageDevice = ping.device ?? classifyUserAgent(req.headers['user-agent'])?.device ?? 'other';
  const now = new Date();

  try {
    await applyPing(ping, stableUid, device, now);
  } catch (err) {
    // Two first pings of one visit can race; the loser simply updates.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      await applyPing(ping, stableUid, device, now).catch(() => {});
    } else {
      if (config.debug) logger.warn('[usage] ping not stored', { message: err instanceof Error ? err.message : String(err), requestId: req.id });
      res.status(503).json({ error: 'Usage analytics unavailable' });
      return;
    }
  }

  res.status(204).send();
});

export { router as usageRouter };
