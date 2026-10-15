import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { isTokenRevoked } from '../utils/revokedTokens';

export interface JwtPayload {
  stableUid: string;
  username: string;
  klasseId: number;
  klasseName: string;
  role: string;
}

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  // Also allow token as query param (for EventSource / SSE connections)
  const queryToken = req.query['token'];
  if (typeof queryToken === 'string' && queryToken.length > 0) {
    return queryToken;
  }
  return null;
}

// `graceSeconds` accepts a token that expired up to that long ago; only
// tokenAccount below passes it.
function verifyToken(token: string, graceSeconds = 0): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret, { clockTolerance: graceSeconds }) as JwtPayload & jwt.JwtPayload;
    // Only a user session token is acceptable here. The admin panel signs its
    // own tokens with the same secret but without a stable user id; letting
    // one through would hand routes an undefined id, which a database filter
    // treats as "no filter at all".
    if (typeof decoded.stableUid !== 'string' || decoded.stableUid === ''
      || typeof decoded.username !== 'string' || decoded.username === '') {
      return null;
    }
    // Reject tokens issued before this user's session was revoked
    if (isTokenRevoked(decoded.stableUid, decoded.iat ?? 0)) return null;
    return {
      stableUid: decoded.stableUid,
      username: decoded.username,
      klasseId: decoded.klasseId,
      klasseName: decoded.klasseName,
      role: decoded.role ?? 'student',
    };
  } catch {
    return null;
  }
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const token = extractToken(req);

  if (!token) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  req.user = payload;
  next();
}

/**
 * The account behind a request's session token, also when that token expired
 * up to `graceSeconds` ago — otherwise checked like any other (signature, user
 * session, revocation). For counting visitors only, never for access: a
 * browser coming back after the token's hour sends it once before refreshing
 * it, and that page view is still this account's (services/webVisits.ts).
 */
export function tokenAccount(req: Request, graceSeconds: number): string | null {
  const token = extractToken(req);
  return token ? verifyToken(token, graceSeconds)?.stableUid ?? null : null;
}

export function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const token = extractToken(req);
  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      req.user = payload;
    }
  }
  next();
}
