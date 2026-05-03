import { Request, Response, NextFunction } from 'express';
import { prisma } from '../db';
import { config } from '../config';

// Paths to skip logging (health checks, static assets, admin panel HTML)
const SKIP_PATHS = new Set(['/health', '/favicon.ico']);
const SKIP_PREFIXES = ['/admin/', '/admin'];

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

  res.on('finish', () => {
    const duration = Date.now() - start;
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
      req.socket.remoteAddress ??
      'unknown';

    if (config.debug) {
      const statusColor =
        res.statusCode >= 500 ? '\x1b[31m' :
        res.statusCode >= 400 ? '\x1b[33m' :
        res.statusCode >= 200 ? '\x1b[32m' : '\x1b[0m';
      console.log(
        `[log] ${statusColor}${res.statusCode}\x1b[0m ${req.method} ${req.path} ` +
        `${duration}ms user=${req.user?.username ?? req.adminUser?.role ?? '-'} ip=${ip}`
      );
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
        username: req.user?.username ?? null,
        userAgent: (req.headers['user-agent'] ?? '').slice(0, 500) || null,
        error:
          res.statusCode >= 400
            ? ((res as unknown as { locals: Record<string, string> }).locals?.errorMessage ?? null)
            : null,
      },
    }).catch((e) => {
      if (config.debug) console.error('[requestLogger] DB write failed:', e.message);
    });
  });

  next();
}
