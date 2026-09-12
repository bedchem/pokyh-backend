import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual, createHash } from 'crypto';
import { config } from '../config';
import { prisma } from '../db';

// Pre-hash the configured API key for storage comparison
function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

// Constant-time string compare that also tolerates a length mismatch (unlike
// crypto.timingSafeEqual, which throws for unequal-length buffers).
function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  try {
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

// Admin-issued keys are additive: they are only consulted when the request
// does not present the static master key, and they never replace it. This
// keeps every existing integration working unchanged.
async function isValidIssuedKey(provided: string): Promise<boolean> {
  const keyHash = hashKey(provided);
  const record = await prisma.apiKey.findUnique({ where: { keyHash } });
  if (!record) return false;
  if (record.revokedAt) return false;
  if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) return false;
  return true;
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

  const keyHash = hashKey(provided);

  // Fast path: the static master key, unchanged from before. Checked first so
  // its behavior can never regress regardless of the DB-key path below.
  if (safeEquals(provided, config.apiKey)) {
    prisma.apiKey
      .updateMany({ where: { keyHash }, data: { lastUsedAt: new Date() } })
      .catch(() => { /* non-blocking, ignore errors */ });
    next();
    return;
  }

  // Fallback: an admin-issued key (expiry/revocation aware). Only reached on
  // static-key mismatch, so this is purely additive.
  isValidIssuedKey(provided)
    .then((valid) => {
      if (!valid) {
        res.status(403).json({ error: 'Invalid API key' });
        return;
      }
      prisma.apiKey
        .update({ where: { keyHash }, data: { lastUsedAt: new Date() } })
        .catch(() => { /* non-blocking, ignore errors */ });
      next();
    })
    .catch(() => {
      res.status(403).json({ error: 'Invalid API key' });
    });
}
