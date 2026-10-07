import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { prisma } from '../db';
import { optionalAuth } from '../middleware/auth';
import { clientIp } from '../middleware/requestLogger';
import { logger } from '../utils/logger';

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

  const ip = clientIp(req);

  const stableUid = req.user?.stableUid ?? null;
  const username  = req.user?.username  ?? null;
  const userAgent = (req.headers['user-agent'] ?? '').slice(0, 500) || null;

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

  // Non-blocking DB write
  prisma.frontendActivityLog.create({
    data: { event, page: page ?? null, detail: detail ?? null, stableUid, username, ip, userAgent },
  }).catch(() => {});

  res.status(204).send();
});

export { router as activityLogRouter };
