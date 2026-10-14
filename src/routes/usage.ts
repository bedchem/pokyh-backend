import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { optionalAuth } from '../middleware/auth';
import { logger } from '../utils/logger';
import { hasUsageConsent } from '../services/privacyConsent';
import { visitorKeyFor } from '../services/visitorKey';
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
// row. Nothing else is kept: no IP address, user agent, path or content.
//
// Without the account's consent the row is anonymous — only a day-scoped
// visitor key, so the aggregate figures still count everyone (anonymous,
// aggregated, first-party measurement; Garante 2021). With consent the row
// also names the account, which the admin lists show.

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

// `account` is who sent the ping; `named` whether the row may say so.
async function applyPing(ping: Ping, account: string | null, named: boolean, device: UsageDevice, now: Date): Promise<void> {
  const screens = Math.min(ping.screens, MAX_PING_SCREENS);
  const existing = await prisma.usageSession.findUnique({
    where: { id: ping.sessionId },
    select: { stableUid: true, visitorKey: true, dayKey: true, activeSeconds: true, lastSeenAt: true },
  });

  if (!existing) {
    const { dayKey, hour } = localDayAndHour(now, config.usageAnalytics.timezone);
    await prisma.usageSession.create({
      data: {
        id: ping.sessionId,
        stableUid: named ? account : null,
        visitorKey: account ? await visitorKeyFor(account, dayKey) : null,
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
  // The key is the visit's own day's, so a visit past midnight still matches.
  const visitorKey = account ? await visitorKeyFor(account, existing.dayKey) : null;
  if (existing.visitorKey && visitorKey && existing.visitorKey !== visitorKey) return;
  if (existing.stableUid && account && existing.stableUid !== account) return;

  const add = creditedSeconds(ping.activeSeconds, now.getTime() - existing.lastSeenAt.getTime(), existing.activeSeconds);
  await prisma.usageSession.update({
    where: { id: ping.sessionId },
    data: {
      activeSeconds: { increment: add },
      screens: { increment: screens },
      lastSeenAt: now,
      // Signed in during the visit, or the consent changed meanwhile.
      ...(visitorKey && !existing.visitorKey ? { visitorKey } : {}),
      ...(named && account && !existing.stableUid ? { stableUid: account } : {}),
      ...(!named && existing.stableUid ? { stableUid: null } : {}),
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
  const account = req.user?.stableUid ?? null;
  const named = account ? await hasUsageConsent(account).catch(() => false) : false;
  const device: UsageDevice = ping.device ?? classifyUserAgent(req.headers['user-agent'])?.device ?? 'other';
  const now = new Date();

  try {
    await applyPing(ping, account, named, device, now);
  } catch (err) {
    // Two first pings of one visit can race; the loser simply updates.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      await applyPing(ping, account, named, device, now).catch(() => {});
    } else {
      if (config.debug) logger.warn('[usage] ping not stored', { message: err instanceof Error ? err.message : String(err), requestId: req.id });
      res.status(503).json({ error: 'Usage analytics unavailable' });
      return;
    }
  }

  res.status(204).send();
});

export { router as usageRouter };
