import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '../db';

export interface AdminJwtPayload {
  role: string;
  sub: string;
  username: string;
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

// A bare `role: 'admin'` JWT claim is not, by itself, proof of current admin
// standing — it only proves the token was signed with our secret at issue
// time. Re-checks against the same two sources /auth/login accepts (an env-
// configured admin username, or a live Admin table row) on every request, so
// a revoked admin's still-valid token stops working immediately, and nothing
// that could ever accidentally persist "admin" into a user's mutable `role`
// column grants access on its own — matching CLAUDE.md's explicit "server-
// side Admin lookup, not a mutable JWT flag" requirement.
async function isCurrentlyAdmin(username: string): Promise<boolean> {
  if (config.adminUsernames.includes(username)) return true;
  const user = await prisma.user.findUnique({ where: { username }, select: { stableUid: true } });
  if (!user) return false;
  const record = await prisma.admin.findUnique({ where: { stableUid: user.stableUid }, select: { stableUid: true } });
  return record !== null;
}

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
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

  if (payload.role !== 'admin' || typeof payload.username !== 'string' || !payload.username) {
    res.status(403).json({ error: 'Forbidden: admin role required' });
    return;
  }

  if (!(await isCurrentlyAdmin(payload.username))) {
    res.status(403).json({ error: 'Forbidden: admin access has been revoked' });
    return;
  }

  req.adminUser = payload;
  next();
}
