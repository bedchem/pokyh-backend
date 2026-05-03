import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface AdminJwtPayload {
  role: string;
  sub: string;
  iat?: number;
  exp?: number;
}

// Extend Express Request to include adminUser
declare global {
  namespace Express {
    interface Request {
      adminUser?: AdminJwtPayload;
    }
  }
}

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  const queryToken = req.query['token'];
  if (typeof queryToken === 'string' && queryToken.length > 0) {
    return queryToken;
  }
  return null;
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const token = extractToken(req);

  if (!token) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }

  let payload: AdminJwtPayload;
  try {
    payload = jwt.verify(token, config.jwtSecret) as AdminJwtPayload;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  if (payload.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden: admin role required' });
    return;
  }

  req.adminUser = payload;
  next();
}
