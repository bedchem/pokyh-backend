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
  // Learn's BFF multiplexes many authenticated people through one server IP.
  // Its own route-level limiters use the verified stable UID after auth, so do
  // not make all learners compete for the application's IP-wide global bucket.
  skip: (req) => req.method === 'OPTIONS' || hasValidServerKey(req) || req.path.startsWith('/learn'),
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

// The Learn login BFF is already API-key protected but all authenticating users
// arrive from the same host. Key this sensitive operation by the normalized
// submitted username rather than the BFF IP, so one failed account cannot deny
// service to the whole school. WebUntis remains the actual credential check.
export const learnLoginLimiter = rateLimit({
  windowMs: config.rateLimit.authWindowMs,
  max: config.rateLimit.authMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later.' },
  keyGenerator: (req) => {
    const candidate = req.body && typeof req.body === 'object' && typeof req.body.username === 'string'
      ? req.body.username.trim().toLocaleLowerCase('en-US').slice(0, 100)
      : 'invalid-request';
    return `learn-login:${candidate}`;
  },
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

// These limiters must be mounted only after requireAuth. The BFF turns all
// browser traffic into one backend source IP, so a stable user ID is the only
// fair and reliable key for protected Learn reads/writes.
export const learnReadLimiter = rateLimit({
  windowMs: config.rateLimit.readWindowMs,
  max: config.rateLimit.readMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many learning reads, please slow down.' },
  keyGenerator: (req) => `learn-read:${req.user?.stableUid ?? 'unauthenticated'}`,
});

export const learnWriteLimiter = rateLimit({
  windowMs: config.rateLimit.writeWindowMs,
  max: config.rateLimit.writeMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many learning changes, please slow down.' },
  keyGenerator: (req) => `learn-write:${req.user?.stableUid ?? 'unauthenticated'}`,
});

export const sseLimiter = rateLimit({
  windowMs: config.rateLimit.sseWindowMs,
  max: config.rateLimit.sseMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many SSE connections from this IP.' },
});
