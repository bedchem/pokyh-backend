import { Request, Response, NextFunction } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { schoolOfUser } from '../services/schools';
import { noteAccountDay, noteSignIn } from '../services/accountDays';

// Paths to skip logging (health checks, static assets, admin panel HTML). The
// usage heartbeat arrives once a minute from every open app; logging each one
// would bury the real requests and keep IP/user agent for a ping that is
// meant to store neither.
const SKIP_PATHS = new Set(['/health', '/readyz', '/favicon.ico', '/usage/ping']);
const SKIP_PREFIXES = ['/admin/', '/admin'];

export function clientIp(req: Request): string {
  return (req.ip ?? req.socket.remoteAddress ?? 'unknown').slice(0, 45);
}

// Feature areas of the request log. "admin" is the admin panel's own API
// traffic: it is shown on the Anfragen page apart from the apps' requests and
// never counted as app activity.
export type RequestScope = 'admin' | 'core';

export function requestScopeOf(path: string): RequestScope {
  if (path === '/api/admin' || path.startsWith('/api/admin/')) return 'admin';
  return 'core';
}

// Rows are written in batches: one INSERT for every request of the last
// moment instead of one per request (a busy minute is thousands of them).
// A crash loses at most the last FLUSH_MS of the log.
type LogRow = Prisma.RequestLogCreateManyInput;
const FLUSH_MS = 500;
const FLUSH_ROWS = 250;
const MAX_PENDING = 10_000;
let pending: LogRow[] = [];
let flushTimer: NodeJS.Timeout | null = null;

async function writeRows(rows: LogRow[]): Promise<void> {
  try {
    await prisma.requestLog.createMany({ data: rows });
  } catch (e) {
    if (config.debug) logger.warn('[requestLogger] DB write failed', { message: e instanceof Error ? e.message : String(e), rows: rows.length });
  }
}

/** Writes what is waiting now (also at shutdown). */
export async function flushRequestLogs(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (pending.length === 0) return;
  const rows = pending;
  pending = [];
  await writeRows(rows);
}

// Accounts deleted a moment ago: a row of theirs still on its way to the
// queue (its school was being looked up) is dropped too.
const forgotten = new Set<string>();

/**
 * A deleted account's rows that are still waiting are dropped, so its emptied
 * log stays empty (services/accountDeletion.ts).
 */
export function dropPendingLogsOf(stableUid: string, username: string): void {
  pending = pending.filter((row) => row.stableUid !== stableUid && row.username !== username);
  forgotten.add(stableUid);
  forgotten.add(`name:${username}`);
  setTimeout(() => { forgotten.delete(stableUid); forgotten.delete(`name:${username}`); }, 60_000).unref();
}

function queueRow(row: LogRow): void {
  if ((row.stableUid && forgotten.has(row.stableUid)) || (row.username && forgotten.has(`name:${row.username}`))) return;
  // The database away for long: the oldest rows give way, the API keeps going.
  if (pending.length >= MAX_PENDING) pending.shift();
  pending.push(row);
  if (pending.length >= FLUSH_ROWS) void flushRequestLogs();
  else if (!flushTimer) {
    flushTimer = setTimeout(() => { flushTimer = null; void flushRequestLogs(); }, FLUSH_MS);
    flushTimer.unref();
  }
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  // Skip static assets and noise
  if (
    SKIP_PATHS.has(req.path) ||
    SKIP_PREFIXES.some((p) => req.path.startsWith(p)) ||
    req.path.startsWith('/_')
  ) {
    return next();
  }

  const start = Date.now();
  // Read now: by the time the response finishes, a router has cut its mount
  // path off req.path ("/api/admin/analytics" would be logged as "/").
  const path = req.path;

  // Feature segmentation: lets the admin Logs page filter by area without a
  // second logging pipeline (see GET /api/admin/logs's `scope` query param).
  const scope = requestScopeOf(path);

  res.on('finish', () => {
    const duration = Date.now() - start;
    // `req.ip` honours the operator's TRUST_PROXY setting: a forwarded
    // address is used only when it comes from a trusted proxy, so a caller
    // cannot choose the address that ends up in the logs. Bounded to the
    // column width so an unusual value can never make the insert fail.
    const ip = clientIp(req);

    // A sign-in has no session yet, so its route names the account it signed
    // in (res.locals.signedIn); the account can then see its own sign-ins
    // (services/accountActivity.ts).
    const signedIn = res.locals.signedIn as { stableUid: string; username: string } | undefined;
    const username = req.user?.username ?? signedIn?.username ?? req.adminUser?.username ?? req.adminUser?.role ?? null;
    const logMeta = {
      method: req.method,
      path,
      status: res.statusCode,
      duration,
      ip,
      username,
      requestId: req.id,
      scope,
      issuedApiKeyId: req.issuedApiKey?.id,
    };

    if (config.debug) {
      const statusColor = res.statusCode >= 500 ? '\x1b[31m' : res.statusCode >= 400 ? '\x1b[33m' : res.statusCode >= 200 ? '\x1b[32m' : '\x1b[0m';
      logger.debug(`[log] ${statusColor}${res.statusCode}\x1b[0m ${req.method} ${path} ${duration}ms user=${username ?? '-'} ip=${ip} reqId=${req.id}`);
    }

    // Log 4xx/5xx to file logger for persistent tracking
    if (res.statusCode >= 500) {
      logger.error('HTTP 5xx error', logMeta);
    } else if (res.statusCode >= 400) {
      logger.warn('HTTP 4xx error', logMeta);
    }

    // The account's school (cached), or the school an admin was looking at.
    const account = req.user?.stableUid;
    const logAccount = account ?? signedIn?.stableUid;
    const school: Promise<string | null> = logAccount
      ? schoolOfUser(logAccount).catch(() => null)
      : Promise.resolve(req.adminScope?.schoolId ?? null);
    // An account's first request of the day (on this device kind) is the
    // Analytics page's evidence that it was active (services/accountDays.ts).
    if (account && res.statusCode < 400) {
      void school.then((schoolId) => noteAccountDay(account, req.headers['user-agent'], schoolId));
    }
    // A successful sign-in counts on that day too (the account's own figure).
    if (signedIn && res.statusCode < 300) {
      void school.then((schoolId) => noteSignIn(signedIn.stableUid, req.headers['user-agent'], schoolId));
    }

    // Batched, off the request's way (queueRow above).
    void school.then((schoolId) => queueRow({
        method: req.method,
        path: path.slice(0, 500),
        status: res.statusCode,
        duration,
        ip,
        stableUid: logAccount ?? null,
        username: username ? username.slice(0, 100) : null,
        userAgent: (req.headers['user-agent'] ?? '').slice(0, 500) || null,
        requestId: req.id,
        scope,
        apiKeyId: req.issuedApiKey?.id ?? null,
        // Never copy a route's error text into durable logs: validation errors
        // can include user-controlled input. Status plus request ID is enough
        // for support correlation without retaining that input.
        error: res.statusCode >= 500 ? 'server_error' : res.statusCode >= 400 ? 'client_error' : null,
        schoolId,
        createdAt: new Date(),
    }));
  });

  next();
}
