import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { ADMIN_AUDIENCE, adminTokensValidFrom } from '../services/adminLogin';
import { config } from '../config';
import { prisma } from '../db';
import { can, isGlobalOnly, type Access, type Permission } from '../security/permissions';
import { loadAccess } from '../services/adminAccess';
import { secondFactorSetupNeeded } from '../services/adminSecurity';
import { SCHOOL_ID_PATTERN, schoolById } from '../services/schools';

export interface AdminJwtPayload {
  role: string;
  sub: string;
  username: string;
  iat?: number;
  exp?: number;
}

// The school a scoped admin request is about: a school id, or null for the
// whole installation (every school at once, global permissions only).
export interface AdminScope {
  schoolId: string | null;
}

// Extend Express Request to include adminUser
declare global {
  namespace Express {
    interface Request {
      adminUser?: AdminJwtPayload;
      // What this admin may do, read fresh for this request.
      adminAccess?: Access;
      // Set by requirePermission().
      adminScope?: AdminScope;
      // Set by allowDuringSecondFactorSetup() on the routes a session may use
      // before its required second factor is set up.
      allowSecondFactorSetup?: boolean;
      // This session still has to set up its required second factor.
      adminSecondFactorSetupPending?: boolean;
    }
  }
}

// The panel names the school it is looking at in this header; links that
// cannot set headers (downloads) use ?school=. Absent: the global view.
export const SCHOOL_HEADER = 'x-pokyh-school';

function requestedSchool(req: Request): string | null {
  const header = req.headers[SCHOOL_HEADER];
  const value = typeof header === 'string' ? header : typeof req.query['school'] === 'string' ? req.query['school'] : '';
  return value.trim() === '' ? null : value.trim().toLowerCase();
}

// The panel sends its token as a header only (its live stream too, through
// fetch): a token in the address would land in browser history and proxy logs.
function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return null;
}

// A token this server signed for the panel: HS256 only, and no app token
// (those carry the app audience; older panel tokens none).
function verifyAdminToken(token: string): AdminJwtPayload & jwt.JwtPayload {
  const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as AdminJwtPayload & jwt.JwtPayload;
  const aud = payload.aud;
  if (aud !== undefined && aud !== ADMIN_AUDIENCE) throw new Error('not a panel token');
  return payload;
}

// A bare `role: 'admin'` JWT claim is not, by itself, proof of current admin
// standing — it only proves the token was signed with our secret at issue
// time. Re-checks against the same two sources /auth/login accepts (an env-
// configured admin username, or a live Admin table row) on every request, so
// a revoked admin's still-valid token stops working immediately, and nothing
// that could ever accidentally persist "admin" into a user's mutable `role`
// column grants access on its own — matching CLAUDE.md's explicit "server-
// side Admin lookup, not a mutable JWT flag" requirement.
// A grant still waiting for its first login (one-time password not yet
// replaced) is not admin standing either: a token from an earlier admin
// period of the same account must not come back to life with it.
async function isCurrentlyAdmin(username: string): Promise<boolean> {
  if (config.adminUsernames.includes(username)) return true;
  const user = await prisma.user.findUnique({ where: { username }, select: { stableUid: true } });
  if (!user) return false;
  const record = await prisma.admin.findUnique({ where: { stableUid: user.stableUid }, select: { mustChangePassword: true } });
  return record !== null && !record.mustChangePassword;
}

/**
 * Whether the request carries an admin token this server signed (signature,
 * expiry and the admin claim only; standing and rights are requireAdmin's).
 * Decides before any body is read whether a large one may be (index.ts):
 * nobody without such a token can make the server parse megabytes.
 */
export function hasSignedAdminToken(req: Request): boolean {
  const token = extractToken(req);
  if (!token) return false;
  try {
    const payload = verifyAdminToken(token);
    return payload.role === 'admin' && typeof payload.username === 'string' && payload.username !== '';
  } catch {
    return false;
  }
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

  let payload: AdminJwtPayload & jwt.JwtPayload;
  try {
    payload = verifyAdminToken(token);
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  if (payload.role !== 'admin' || typeof payload.username !== 'string' || !payload.username) {
    res.status(403).json({ error: 'Forbidden: admin role required' });
    return;
  }

  // Standing, second factor and rights are read together: three independent
  // lookups, each still fresh on every request (nothing is remembered between
  // requests, so a revoked right stops at once).
  const [stillAdmin, setupPending, access, validFrom] = await Promise.all([
    isCurrentlyAdmin(payload.username),
    secondFactorSetupNeeded(payload.username),
    loadAccess(payload.username),
    adminTokensValidFrom(payload.username),
  ]);
  if (!stillAdmin) {
    res.status(403).json({ error: 'Forbidden: admin access has been revoked' });
    return;
  }
  // Issued before the account's password or a second factor changed.
  if (validFrom && (payload.iat ?? 0) < Math.floor(validFrom.getTime() / 1000)) {
    res.status(401).json({ error: 'Diese Anmeldung wurde beendet. Bitte melde dich neu an.', code: 'session_revoked' });
    return;
  }

  // A second factor is required but none is set up yet: the password opened
  // the panel only far enough to set one up (security/adminSecondFactorPolicy.ts).
  if (setupPending && !req.allowSecondFactorSetup) {
    res.status(403).json({
      error: 'Für dein Admin-Konto ist ein zweiter Faktor Pflicht. Richte zuerst eine Authenticator-App oder einen Passkey ein.',
      code: 'second_factor_setup_required',
    });
    return;
  }

  req.adminUser = payload;
  req.adminSecondFactorSetupPending = setupPending;
  req.adminAccess = access;
  next();
}

/**
 * Put before requireAdmin on the routes a session may use while it still has
 * to set up its required second factor: who am I, and setting one up.
 */
export function allowDuringSecondFactorSetup(req: Request, _res: Response, next: NextFunction): void {
  req.allowSecondFactorSetup = true;
  next();
}

/**
 * Allows the request only when the admin holds `permission` in the school
 * the panel names (header X-Pokyh-School), or — without one — globally,
 * across every school. Global-only permissions ignore the header. Sets
 * req.adminScope, which the route then uses to narrow every query and to
 * check every record it touches (see assertInScope).
 *
 * Must run after requireAdmin. Denies by default: no grant, no access.
 */
export function requirePermission(permission: Permission, { global = false }: { global?: boolean } = {}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const access = req.adminAccess;
    if (!access) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }
    // `global`: a view of the whole installation only — the permission must
    // hold across every school, whatever school the panel names.
    let schoolId: string | null = null;
    const requested = isGlobalOnly(permission) || global ? null : requestedSchool(req);
    if (requested !== null) {
      if (!SCHOOL_ID_PATTERN.test(requested)) {
        res.status(400).json({ error: 'Ungültige Schule' });
        return;
      }
      const school = await schoolById(requested);
      if (!school) {
        res.status(404).json({ error: 'Schule nicht gefunden' });
        return;
      }
      schoolId = school.id;
    }
    if (!can(access, permission, schoolId)) {
      res.status(403).json({
        error: schoolId ? 'Keine Berechtigung für diesen Bereich in dieser Schule' : 'Keine Berechtigung für diesen Bereich',
        code: 'forbidden',
        permission,
      });
      return;
    }
    req.adminScope = { schoolId };
    next();
  };
}

/** The school a scoped request is limited to, or null for every school. */
export function scopeSchool(req: Request): string | null {
  return req.adminScope?.schoolId ?? null;
}

/**
 * Whether a record of `recordSchool` is inside the request's scope. A
 * school-scoped request reaches only that school's records; the global view
 * (already checked for the permission across every school) reaches all.
 * Callers answer 404 rather than 403, so ids of other schools stay unknown.
 */
export function inScope(req: Request, recordSchool: string | null | undefined): boolean {
  const schoolId = scopeSchool(req);
  return schoolId === null || recordSchool === schoolId;
}

/** A Prisma `where` fragment narrowing a model with a schoolId column. */
export function schoolWhere(req: Request): { schoolId?: string } {
  const schoolId = scopeSchool(req);
  return schoolId === null ? {} : { schoolId };
}
