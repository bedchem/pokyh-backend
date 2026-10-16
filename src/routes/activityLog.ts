import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { prisma } from '../db';
import { optionalAuth } from '../middleware/auth';
import { clientIp } from '../middleware/requestLogger';
import { logger } from '../utils/logger';
import { hasUsageConsent } from '../services/privacyConsent';
import { recordWebVisit } from '../services/webVisits';
import { schoolOfUser } from '../services/schools';
import { config } from '../config';

const router = Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  // Keyed by the default client address (`req.ip`, which follows TRUST_PROXY).
  // Keying on the raw X-Forwarded-For header would let a caller pick a fresh
  // bucket for every request.
  message: { error: 'Too many activity log events' },
});

const ALLOWED_EVENTS = new Set(['page_view', 'download', 'login', 'logout']);

const bodySchema = z.object({
  event: z.string().max(50),
  page:   z.string().max(500).optional(),
  detail: z.string().max(500).optional(),
});

// POST /activity-log — authenticated via API key (applied in routes/index.ts), user via optional JWT
router.post('/', limiter, optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid payload' });
    return;
  }

  const { event, page, detail } = parsed.data;

  if (!ALLOWED_EVENTS.has(event)) {
    res.status(400).json({ error: 'Unknown event type' });
    return;
  }

  // Page views are usage statistics: with the account's consent they keep who
  // and from where; without it only the anonymous count of the page is kept.
  // Sign-ins, sign-outs and downloads stay complete (security, abuse).
  const named = event !== 'page_view'
    || (req.user ? await hasUsageConsent(req.user.stableUid).catch(() => false) : false);

  const ip = named ? clientIp(req) : null;

  const stableUid = named ? req.user?.stableUid ?? null : null;
  const username  = named ? req.user?.username  ?? null : null;
  const userAgent = named ? (req.headers['user-agent'] ?? '').slice(0, 500) || null : null;

  // Write to daily log file (persists even if DB is down)
  logger.info('Frontend activity', {
    action: 'frontend_activity',
    event,
    page:   page ?? null,
    detail: detail ?? null,
    username,
    stableUid,
    ip,
    userAgent,
  });

  // The account's school, also for an anonymous page view (a coarse group:
  // a school's admins see their own school's activity only).
  const schoolId = req.user ? await schoolOfUser(req.user.stableUid).catch(() => null) : null;

  // Non-blocking DB write
  prisma.frontendActivityLog.create({
    data: { event, page: page ?? null, detail: detail ?? null, stableUid, username, ip, userAgent, schoolId },
  }).catch(() => {});

  // Every page view of the website, signed in or not, is also one website
  // visit for the visitor statistics (services/webVisits.ts); it names the
  // account only with its consent, as above. Best effort.
  if (event === 'page_view') {
    recordWebVisit(req, page, stableUid).catch((e) => {
      if (config.debug) logger.warn('[activity-log] web visit not stored', { message: e instanceof Error ? e.message : String(e), requestId: req.id });
    });
  }

  res.status(204).send();
});

export { router as activityLogRouter };
