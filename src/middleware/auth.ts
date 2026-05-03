import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { isTokenRevoked } from '../utils/revokedTokens';

export interface JwtPayload {
  stableUid: string;
  username: string;
  klasseId: number;
  klasseName: string;
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

function verifyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as JwtPayload & jwt.JwtPayload;
    // Reject tokens issued before this user's session was revoked
    if (isTokenRevoked(decoded.stableUid, decoded.iat ?? 0)) return null;
    return {
      stableUid: decoded.stableUid,
      username: decoded.username,
      klasseId: decoded.klasseId,
      klasseName: decoded.klasseName,
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
