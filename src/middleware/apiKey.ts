import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual, createHash } from 'crypto';
import { config } from '../config';
import { prisma } from '../db';

// Pre-hash the configured API key for storage comparison
function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function apiKeyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Accept from header OR query param (for SSE/EventSource which can't set headers)
  const headerKey = req.headers['x-api-key'];
  const queryKey = req.query['apiKey'];
  const provided = (typeof headerKey === 'string' ? headerKey : null) ??
                   (typeof queryKey === 'string' ? queryKey : null);

  if (!provided) {
    res.status(401).json({ error: 'Missing X-API-Key header' });
    return;
  }

  // Timing-safe comparison against the configured API key
  const expected = Buffer.from(config.apiKey, 'utf8');
  const actual = Buffer.from(provided, 'utf8');

  let valid = false;
  if (actual.length === expected.length) {
    try {
      valid = timingSafeEqual(expected, actual);
    } catch {
      valid = false;
    }
  }

  if (!valid) {
    res.status(403).json({ error: 'Invalid API key' });
    return;
  }

  // Update lastUsedAt async, non-blocking — based on hash
  const keyHash = hashKey(provided);
  prisma.apiKey
    .updateMany({
      where: { keyHash },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {
      /* non-blocking, ignore errors */
    });

  next();
}
