import rateLimit from 'express-rate-limit';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { config } from '../config';

// Trusted server-to-server callers present a valid X-Server-Key (e.g. the
// Next.js frontend proxying /auth/login for every user). These requests all
// originate from ONE IP (the frontend server / tunnel), so counting them in the
// per-IP auth limiter would let a few dozen logins exhaust the bucket for every
// user at once. The server key is the trust boundary, so skip the limiter for
// requests that carry it — anonymous/browser auth attempts are still limited.
function hasValidServerKey(req: Request): boolean {
  const provided = req.headers['x-server-key'];
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const expectedBuf = Buffer.from(config.serverKey, 'utf8');
  const actualBuf = Buffer.from(provided, 'utf8');
  if (actualBuf.length !== expectedBuf.length) return false;
  try {
    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

export const globalLimiter = rateLimit({
  windowMs: config.rateLimit.globalWindowMs,
  max: config.rateLimit.globalMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  skip: (req) => req.method === 'OPTIONS' || hasValidServerKey(req),
});

export const authLimiter = rateLimit({
  windowMs: config.rateLimit.authWindowMs,
  max: config.rateLimit.authMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later.' },
  // Trusted server-to-server logins bypass the per-IP brute-force limiter.
  skip: (req) => hasValidServerKey(req),
});

// Token refresh limiter — generous because refresh is gated by an unguessable
// token, not a password, and entire schools share one NATed public IP.
export const refreshLimiter = rateLimit({
  windowMs: config.rateLimit.refreshWindowMs,
  max: config.rateLimit.refreshMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many token refreshes, please try again later.' },
  skip: (req) => hasValidServerKey(req),
});

export const writeLimiter = rateLimit({
  windowMs: config.rateLimit.writeWindowMs,
  max: config.rateLimit.writeMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many write requests, please slow down.' },
});

export const readLimiter = rateLimit({
  windowMs: config.rateLimit.readWindowMs,
  max: config.rateLimit.readMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many read requests, please slow down.' },
});

export const sseLimiter = rateLimit({
  windowMs: config.rateLimit.sseWindowMs,
  max: config.rateLimit.sseMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many SSE connections from this IP.' },
});
