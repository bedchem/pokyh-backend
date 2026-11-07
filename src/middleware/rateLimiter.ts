import rateLimit from 'express-rate-limit';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config';

// No request skips a limiter for carrying the apps' X-Server-Key: the key
// ships inside every app and proves nothing about the caller.

export const globalLimiter = rateLimit({
  windowMs: config.rateLimit.globalWindowMs,
  max: config.rateLimit.globalMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  // The usage heartbeat (once a minute per open app) has its own per-account
  // limiter; behind a school's single address it would otherwise use up the
  // bucket that real requests need.
  skip: (req) => req.method === 'OPTIONS' || req.path === '/usage/ping',
});

// Password sign-ins of POKYH-only accounts: what stops guessing a password.
export const authLimiter = rateLimit({
  windowMs: config.rateLimit.authWindowMs,
  max: config.rateLimit.authMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later.' },
});

const appLoginByAddress = rateLimit({
  windowMs: config.rateLimit.appLoginWindowMs,
  max: config.rateLimit.appLoginMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anmeldungen. Bitte warte ein paar Minuten.', code: 'rate_limited' },
});

const appLoginByAccount = rateLimit({
  windowMs: config.rateLimit.appLoginWindowMs,
  max: config.rateLimit.appLoginPerAccountMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anmeldungen. Bitte warte ein paar Minuten.', code: 'rate_limited' },
  keyGenerator: (req) => `app-login:${String(req.body?.username ?? '').trim().toLowerCase().slice(0, 100)}`,
});

/**
 * POST /auth/login: the apps' sign-in (it carries the app key) is limited per
 * address — generous, a school's pupils share one — and per account, since
 * every attempt costs WebUntis requests; a POKYH-only password sign-in by the
 * strict authLimiter.
 */
export const appLoginLimiters: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (!req.headers['x-server-key']) {
    authLimiter(req, res, next);
    return;
  }
  appLoginByAddress(req, res, (err?: unknown) => {
    if (err) return next(err);
    appLoginByAccount(req, res, next);
  });
};

// Token refresh limiter — generous because refresh is gated by an unguessable
// token, not a password, and entire schools share one NATed public IP.
export const refreshLimiter = rateLimit({
  windowMs: config.rateLimit.refreshWindowMs,
  max: config.rateLimit.refreshMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many token refreshes, please try again later.' },
});

// Guards the DB-issued-API-key lookup path (src/middleware/apiKey.ts): every
// request whose key doesn't match the static master key costs one indexed
// Prisma round-trip. Without this, an unauthenticated caller could hammer the
// shared production database with garbage keys at unlimited volume. Keyed by
// IP and sized like readLimiter — generous enough for legitimate issued-key
// integrations, which always miss the static-key fast path and land here on
// every call.
export const apiKeyLookupLimiter = rateLimit({
  windowMs: config.rateLimit.readWindowMs,
  max: config.rateLimit.readMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
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

// Live streams (EventSource). The website opens them straight from the browser,
// a few per page, and a whole school reaches the API through one address: an
// address-wide budget turned away every pupil after the first few. Mount only
// after requireAuth and count per account; globalLimiter still bounds each
// address.
export const sseLimiter = rateLimit({
  windowMs: config.rateLimit.sseWindowMs,
  max: config.rateLimit.sseMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many live connections, please try again later.' },
  keyGenerator: (req) => `sse:${req.user?.stableUid ?? 'unauthenticated'}`,
});
