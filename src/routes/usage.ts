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

// A student's class, for the anonymous per-class totals; parents and accounts
// without a class are left out. Held briefly: every open app pings.
const CLASS_CACHE_MS = 10 * 60 * 1000;
const classCache = new Map<string, { klasse: string | null; at: number }>();

async function classOf(stableUid: string): Promise<string | null> {
  const hit = classCache.get(stableUid);
  if (hit && Date.now() - hit.at < CLASS_CACHE_MS) return hit.klasse;
  const user = await prisma.user.findUnique({ where: { stableUid }, select: { role: true, webuntisKlasseName: true } });
  const name = user?.webuntisKlasseName.trim() ?? '';
  const klasse = user && user.role !== 'parent' && name ? name.slice(0, 64) : null;
  if (classCache.size > 5000) classCache.clear();
  classCache.set(stableUid, { klasse, at: Date.now() });
  return klasse;
}

// Adds to a class's totals for the day. Best effort: a lost addition never
// costs the ping itself.
async function addToClass(account: string, dayKey: string, seconds: number, visits: number, people: number): Promise<void> {
  if (seconds === 0 && visits === 0 && people === 0) return;
  const klasse = await classOf(account);
  if (!klasse) return;
  await prisma.usageClassDay.upsert({
    where: { dayKey_klasse: { dayKey, klasse } },
    create: { dayKey, klasse, seconds, visits, people },
    update: { seconds: { increment: seconds }, visits: { increment: visits }, people: { increment: people } },
  });
}

// `account` is who sent the ping; `named` whether the row may say so.
// Resolves to true when the ping started a new visit.
async function applyPing(ping: Ping, account: string | null, named: boolean, device: UsageDevice, now: Date): Promise<boolean> {
  const screens = Math.min(ping.screens, MAX_PING_SCREENS);
  const existing = await prisma.usageSession.findUnique({
    where: { id: ping.sessionId },
    select: { stableUid: true, visitorKey: true, dayKey: true, activeSeconds: true, lastSeenAt: true },
  });

  if (!existing) {
    const { dayKey, hour } = localDayAndHour(now, config.usageAnalytics.timezone);
    const visitorKey = account ? await visitorKeyFor(account, dayKey) : null;
    // The day's first visit of this person makes one more person for its class.
    const firstToday = visitorKey ? (await prisma.usageSession.count({ where: { dayKey, visitorKey } })) === 0 : false;
    const credited = creditedSeconds(ping.activeSeconds, FIRST_PING_WINDOW_MS, 0);
    await prisma.usageSession.create({
      data: {
        id: ping.sessionId,
        stableUid: named ? account : null,
        visitorKey,
        device,
        client: ping.client,
        appVersion: ping.client === 'app' ? (ping.appVersion ?? '') : '',
        dayKey,
        startHour: hour,
        activeSeconds: credited,
        screens,
        startedAt: now,
        lastSeenAt: now,
      },
    });
    if (account) await addToClass(account, dayKey, credited, 1, firstToday ? 1 : 0).catch(() => {});
    return true;
  }

  // A visit belongs to the account that started it. Another account's ping
  // with the same id is ignored rather than merged into someone else's row.
  // The key is the visit's own day's, so a visit past midnight still matches.
  const visitorKey = account ? await visitorKeyFor(account, existing.dayKey) : null;
  if (existing.visitorKey && visitorKey && existing.visitorKey !== visitorKey) return false;
  if (existing.stableUid && account && existing.stableUid !== account) return false;

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
  if (account && add > 0) await addToClass(account, existing.dayKey, add, 0, 0).catch(() => {});
  return false;
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
    // A new visit reaches an open Analytics page at once (adminLive).
    res.locals['usageNewVisit'] = await applyPing(ping, account, named, device, now);
  } catch (err) {
    // Two first pings of one visit can race; the loser simply updates.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      await applyPing(ping, account, named, device, now).catch(() => false);
    } else {
      if (config.debug) logger.warn('[usage] ping not stored', { message: err instanceof Error ? err.message : String(err), requestId: req.id });
      res.status(503).json({ error: 'Usage analytics unavailable' });
      return;
    }
  }

  res.status(204).send();
});

export { router as usageRouter };
