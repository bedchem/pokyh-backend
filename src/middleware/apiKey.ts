import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual, createHash } from 'crypto';
import { config } from '../config';
import { prisma } from '../db';
import { hasApiKeyScope, requiredApiKeyScope } from '../security/apiKeyPolicy';
import { apiKeyLookupLimiter } from './rateLimiter';

declare global {
  namespace Express {
    interface Request {
      issuedApiKey?: { id: string; name: string };
    }
  }
}

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
async function findValidIssuedKey(provided: string): Promise<{ id: string; name: string; scopes: string; keyHash: string } | null> {
  const keyHash = hashKey(provided);
  const record = await prisma.apiKey.findUnique({
    where: { keyHash },
    select: { id: true, name: true, scopes: true, keyHash: true, revokedAt: true, expiresAt: true },
  });
  if (!record || record.revokedAt || (record.expiresAt && record.expiresAt.getTime() <= Date.now())) return null;
  return record;
}

export function apiKeyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Only the legacy SSE endpoint may carry a key in a query parameter because
  // EventSource cannot attach headers. All other routes reject it so secrets
  // never land in browser history, referrers, or copied URLs.
  const headerKey = req.headers['x-api-key'];
  const queryKey = req.query['apiKey'];
  if (!headerKey && typeof queryKey === 'string' && !req.path.startsWith('/sse')) {
    res.status(400).json({ error: 'Use X-API-Key header for this route' });
    return;
  }
  const provided = (typeof headerKey === 'string' ? headerKey : null) ??
                   (typeof queryKey === 'string' ? queryKey : null);

  if (!provided || provided.length > 512) {
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
  // static-key mismatch, so this is purely additive. Rate-limited first —
  // every request here (valid issued key or garbage) costs a DB round-trip,
  // and /learn/* traffic skips the global limiter entirely (see rateLimiter.ts).
  apiKeyLookupLimiter(req, res, (limiterErr?: unknown) => {
    if (limiterErr) { next(limiterErr); return; }
    if (res.headersSent) return; // limiter already responded 429

    findValidIssuedKey(provided)
      .then((record) => {
        if (!record) {
          res.status(403).json({ error: 'Invalid API key' });
          return;
        }
        const requiredScope = requiredApiKeyScope(req.method, req.path);
        if (!hasApiKeyScope(record.scopes, requiredScope)) {
          res.status(403).json({ error: 'API key is not permitted for this route' });
          return;
        }
        req.issuedApiKey = { id: record.id, name: record.name };
        prisma.apiKey
          .update({ where: { keyHash: record.keyHash }, data: { lastUsedAt: new Date() } })
          .catch(() => { /* non-blocking, ignore errors */ });
        next();
      })
      .catch(() => {
        res.status(403).json({ error: 'Invalid API key' });
      });
  });
}
