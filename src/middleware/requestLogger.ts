import { Request, Response, NextFunction } from 'express';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';

// Paths to skip logging (health checks, static assets, admin panel HTML). The
// usage heartbeat arrives once a minute from every open app; logging each one
// would bury the real requests and keep IP/user agent for a ping that is
// meant to store neither.
const SKIP_PATHS = new Set(['/health', '/readyz', '/favicon.ico', '/usage/ping']);
const SKIP_PREFIXES = ['/admin/', '/admin'];

export function clientIp(req: Request): string {
  return (req.ip ?? req.socket.remoteAddress ?? 'unknown').slice(0, 45);
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

  // Feature segmentation: lets the admin Logs page filter by area without a
  // second logging pipeline (see GET /api/admin/logs's `scope` query param).
  const scope: 'learn' | 'core' = req.path.startsWith('/learn') ? 'learn' : 'core';

  res.on('finish', () => {
    const duration = Date.now() - start;
    // `req.ip` honours the operator's TRUST_PROXY setting: a forwarded
    // address is used only when it comes from a trusted proxy, so a caller
    // cannot choose the address that ends up in the logs. Bounded to the
    // column width so an unusual value can never make the insert fail.
    const ip = clientIp(req);

    const username = req.user?.username ?? req.adminUser?.username ?? req.adminUser?.role ?? null;
    const logMeta = {
      method: req.method,
      path: req.path,
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
      logger.debug(`[log] ${statusColor}${res.statusCode}\x1b[0m ${req.method} ${req.path} ${duration}ms user=${username ?? '-'} ip=${ip} reqId=${req.id}`);
    }

    // Log 4xx/5xx to file logger for persistent tracking
    if (res.statusCode >= 500) {
      logger.error('HTTP 5xx error', logMeta);
    } else if (res.statusCode >= 400) {
      logger.warn('HTTP 4xx error', logMeta);
    }

    // Non-blocking DB write — never fails silently
    prisma.requestLog.create({
      data: {
        method: req.method,
        path: req.path.slice(0, 500),
        status: res.statusCode,
        duration,
        ip,
        stableUid: req.user?.stableUid ?? null,
        username: username ? username.slice(0, 100) : null,
        userAgent: (req.headers['user-agent'] ?? '').slice(0, 500) || null,
        requestId: req.id,
        scope,
        apiKeyId: req.issuedApiKey?.id ?? null,
        // Never copy a route's error text into durable logs: validation errors
        // can include user-controlled input. Status plus request ID is enough
        // for support correlation without retaining that input.
        error: res.statusCode >= 500 ? 'server_error' : res.statusCode >= 400 ? 'client_error' : null,
      },
    }).catch((e) => {
      if (config.debug) logger.warn('[requestLogger] DB write failed', { message: e.message, requestId: req.id });
    });
  });

  next();
}
