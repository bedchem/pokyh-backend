import { Router, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { prisma } from '../db';
import { config } from '../config';
import { optionalAuth } from '../middleware/auth';
import { logger } from '../utils/logger';
import { schoolOfUser } from '../services/schools';
import { browserFamily, cleanReport, type ClientErrorSource } from '../security/clientErrorSanitizer';

// POST /client-errors — error reports of the web app and the native apps, for
// the panel's "Frontend-Logs". Never trusted: one report per request, a small
// body, validated and scrubbed (security/clientErrorSanitizer.ts), rate
// limited per address, and the same error is stored at most a few times a
// minute however often it is sent. Stores no IP address, no account and no
// user-agent string: the account's school (for the school's own view), a
// coarse browser family and the cleaned error.
//
// Disclosed in the privacy notice; legal basis: legitimate interest in a
// working, secure service (Art. 6(1)(f) GDPR) — the data is technical and
// minimised, nothing is used for profiling.

const MAX_BODY_BYTES = 16 * 1024;

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: () => config.clientErrors.perMinute,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many error reports' },
});

// fingerprint → [minute, count]: a page stuck in an error loop cannot fill
// the table.
const recent = new Map<string, [number, number]>();

function tooFrequent(fingerprint: string): boolean {
  const minute = Math.floor(Date.now() / 60_000);
  const entry = recent.get(fingerprint);
  if (!entry || entry[0] !== minute) {
    if (recent.size > 10_000) recent.clear();
    recent.set(fingerprint, [minute, 1]);
    return false;
  }
  entry[1] += 1;
  return entry[1] > config.clientErrors.perErrorPerMinute;
}

export async function storeClientError(req: Request, body: unknown, forcedSource?: ClientErrorSource): Promise<'stored' | 'dropped' | 'invalid'> {
  const report = cleanReport(body, forcedSource);
  if (!report) return 'invalid';
  if (tooFrequent(report.fingerprint)) return 'dropped';
  const schoolId = req.user ? await schoolOfUser(req.user.stableUid).catch(() => null) : (req.adminScope?.schoolId ?? null);
  await prisma.clientErrorLog.create({
    data: { ...report, browser: browserFamily(req.headers['user-agent']), schoolId },
  });
  return 'stored';
}

const router = Router();

router.post('/', limiter, optionalAuth, async (req: Request, res: Response): Promise<void> => {
  if (!config.clientErrors.enabled) {
    res.status(204).send();
    return;
  }
  const length = Number(req.headers['content-length'] ?? 0);
  if (length > MAX_BODY_BYTES) {
    res.status(413).json({ error: 'Report too large' });
    return;
  }
  try {
    const outcome = await storeClientError(req, req.body);
    if (outcome === 'invalid') {
      res.status(400).json({ error: 'Invalid report' });
      return;
    }
  } catch (err) {
    if (config.debug) logger.warn('[client-errors] report not stored', { message: err instanceof Error ? err.message : String(err), requestId: req.id });
  }
  // Accepted or dropped look the same to the sender.
  res.status(204).send();
});

export { router as clientErrorsRouter };
