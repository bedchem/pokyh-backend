import { createHash } from 'crypto';
import type { Request } from 'express';
import { prisma } from '../db';
import { config } from '../config';
import { matchEnvAdmin } from '../security/adminLogin';
import {
  GLOBAL_SCOPE,
  accessFrom,
  mayGrant,
  mayManageTarget,
  managesAdminsIn,
  normalizeGrant,
  presetByKey,
  presetFor,
  type Access,
  type Permission,
} from '../security/permissions';
import { ForbiddenError, NotFoundError, ValidationError } from '../utils/errors';
import { audit } from './audit';
import { announceChange } from './adminLive';
import { schoolById } from './schools';
import { listPresets } from './adminPresets';

// Loading and changing what administrators may do. The rules themselves are
// in security/permissions.ts; this module adds the database and the checks
// that need it (does the school exist, is the target an admin, whose school
// is the account in).
//
// Access is read from the database on every admin request, never cached: a
// revoked permission stops working with the next request, on every node.

export function grantId(username: string, scope: string): string {
  return createHash('sha256').update(`pokyh:admin-grant:${username.trim().toLowerCase()}|${scope}`).digest('hex');
}

export function isOwner(username: string): boolean {
  return matchEnvAdmin(username, config.adminUsernames) !== null;
}

export function parsePermissionList(text: string): string[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export async function loadAccess(username: string): Promise<Access> {
  if (isOwner(username)) return accessFrom(true, []);
  const grants = await prisma.adminGrant.findMany({ where: { username }, select: { scope: true, permissions: true } });
  return accessFrom(false, grants.map((g) => ({ scope: g.scope, permissions: parsePermissionList(g.permissions) })));
}

export interface GrantView {
  username: string;
  scope: string;
  preset: string;
  permissions: string[];
  grantedBy: string | null;
  updatedAt: string;
}

export async function grantsOf(username: string): Promise<GrantView[]> {
  const rows = await prisma.adminGrant.findMany({ where: { username }, orderBy: { scope: 'asc' } });
  return rows.map((g) => ({
    username: g.username,
    scope: g.scope,
    preset: g.preset,
    permissions: parsePermissionList(g.permissions),
    grantedBy: g.grantedBy,
    updatedAt: g.updatedAt.toISOString(),
  }));
}

// The admin account a grant is for: an Admin row behind a users row. Owners
// (ADMIN_USERNAMES) are managed in the .env, never here.
export async function adminTarget(username: string): Promise<{ username: string; stableUid: string; schoolId: string | null }> {
  if (isOwner(username)) throw new ForbiddenError('Server-Admins (ADMIN_USERNAMES) werden in der .env verwaltet, nicht im Panel');
  const user = await prisma.user.findUnique({ where: { username }, select: { username: true, stableUid: true, schoolId: true } });
  const admin = user ? await prisma.admin.findUnique({ where: { stableUid: user.stableUid }, select: { stableUid: true } }) : null;
  if (!user || !admin) throw new NotFoundError('Kein Admin-Konto mit diesem Namen');
  return user;
}

async function checkScope(scope: string): Promise<void> {
  if (scope === GLOBAL_SCOPE) return;
  if (!(await schoolById(scope))) throw new ValidationError('Unbekannte Schule');
}

export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export interface Actor {
  username: string;
  access: Access;
}

export function actorOf(req: Request): Actor {
  return { username: req.adminUser!.username, access: req.adminAccess! };
}

// Whether `actor` may hand rights in `scope` to an account of `accountSchool`:
// a school's admins only to that school's accounts; someone who manages
// global admins also to accounts of other schools (staff of several schools).
function mayReach(actor: Actor, scope: string, accountSchool: string | null): boolean {
  if (scope === GLOBAL_SCOPE) return true;
  if (managesAdminsIn(actor.access, GLOBAL_SCOPE)) return true;
  return accountSchool === scope;
}

export interface GrantRequest {
  scope: string;
  permissions: unknown[];
  preset?: string;
}

export function parseGrantRequest(value: unknown): GrantRequest | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v['scope'] !== 'string' || !Array.isArray(v['permissions'])) throw new ValidationError('Ungültige Rechte-Angabe');
  if (v['permissions'].length > 100) throw new ValidationError('Zu viele Rechte');
  return {
    scope: v['scope'].trim().toLowerCase(),
    permissions: v['permissions'],
    preset: typeof v['preset'] === 'string' ? v['preset'] : undefined,
  };
}

/**
 * The checks of setGrant that need no target account yet — for creating an
 * account and its rights in one step, so a refused grant creates nothing.
 */
export async function checkGrantRequest(req: Request, grant: GrantRequest, accountSchool: string | null): Promise<void> {
  const actor = actorOf(req);
  await checkScope(grant.scope);
  if (!mayReach(actor, grant.scope, accountSchool)) throw new ForbiddenError('Das Konto gehört zu einer anderen Schule');
  const normalized = normalizeGrant(grant.scope, grant.permissions);
  if (!normalized.ok) throw normalized.status === 400 ? new ValidationError(normalized.error) : new ForbiddenError(normalized.error);
  const allowed = mayGrant(actor.access, grant.scope, normalized.permissions);
  if (!allowed.ok) throw new ForbiddenError(allowed.error);
}

/**
 * Sets what `targetUsername` may do in `scope`. An empty list removes the
 * grant. Throws 403/400/404 with a message for the panel.
 */
export async function setGrant(
  req: Request,
  targetUsername: string,
  scope: string,
  requested: readonly unknown[],
  presetKey?: string,
): Promise<GrantView | null> {
  const actor = actorOf(req);
  if (sameName(actor.username, targetUsername)) throw new ForbiddenError('Die eigenen Rechte kann nur ein anderer Admin ändern');
  await checkScope(scope);
  const target = await adminTarget(targetUsername);
  if (!mayReach(actor, scope, target.schoolId)) throw new ForbiddenError('Das Konto gehört zu einer anderen Schule');

  const normalized = normalizeGrant(scope, requested);
  if (!normalized.ok) throw normalized.status === 400 ? new ValidationError(normalized.error) : new ForbiddenError(normalized.error);
  const allowed = mayGrant(actor.access, scope, normalized.permissions);
  if (!allowed.ok) throw new ForbiddenError(allowed.error);
  const targetAccess = await loadAccess(target.username);
  const manage = mayManageTarget(actor.access, targetAccess, scope);
  if (!manage.ok) throw new ForbiddenError(manage.error);

  const id = grantId(target.username, scope);
  const before = await prisma.adminGrant.findUnique({ where: { id } });
  const beforeList = before ? parsePermissionList(before.permissions) : [];
  const permissions: Permission[] = allowed.permissions;

  let view: GrantView | null = null;
  if (permissions.length === 0) {
    await prisma.adminGrant.deleteMany({ where: { id } });
  } else {
    // The preset the grant was made from, when it still matches it exactly
    // (built-in and own presets alike); otherwise whichever one it matches.
    const presets = await listPresets();
    const matched = presetFor(scope, permissions, presets);
    const chosen = presetKey ? presetByKey(presetKey, presets) : undefined;
    const fits = chosen !== undefined && (chosen.scope === 'global') === (scope === GLOBAL_SCOPE)
      && chosen.permissions.length === permissions.length && chosen.permissions.every((p) => permissions.includes(p));
    const preset = fits ? chosen.key : matched;
    const row = await prisma.adminGrant.upsert({
      where: { id },
      create: { id, username: target.username, scope, preset, permissions: JSON.stringify(permissions), grantedBy: actor.username },
      update: { preset, permissions: JSON.stringify(permissions), grantedBy: actor.username },
    });
    view = {
      username: row.username,
      scope: row.scope,
      preset: row.preset,
      permissions,
      grantedBy: row.grantedBy,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  const added = permissions.filter((p) => !beforeList.includes(p));
  const removed = beforeList.filter((p) => !(permissions as string[]).includes(p));
  if (added.length > 0 || removed.length > 0) {
    audit(req, permissions.length === 0 ? 'admin.grant.remove' : 'admin.grant.set', { type: 'admin', id: target.username },
      { scope, preset: view?.preset ?? null, added, removed }, scope === GLOBAL_SCOPE ? null : scope);
    announceChange(['access', 'users']);
  }
  return view;
}

/**
 * Removes every grant of an admin account. Used when the admin standing
 * itself ends (revoke, account deleted, setup lapsed) so that a later new
 * grant never brings old rights back.
 */
export async function clearGrants(username: string): Promise<number> {
  const { count } = await prisma.adminGrant.deleteMany({ where: { username } });
  if (count > 0) announceChange(['access']);
  return count;
}

/**
 * May the request's admin remove `targetUsername`'s admin standing? Only with
 * every one of the target's rights, in every scope the target holds them —
 * and, for an admin without any grant, the right to manage admins in the
 * account's school.
 */
export async function assertMayRemoveAdmin(req: Request, targetUsername: string, targetSchool: string | null): Promise<void> {
  if (sameName(actorOf(req).username, targetUsername)) throw new ForbiddenError('Die eigene Admin-Berechtigung kann nur ein anderer Admin entziehen');
  await assertMayManageAdmin(req, targetUsername, targetSchool);
}

/**
 * May the request's admin manage `targetUsername` as a whole (remove them,
 * change their login security)? Only with every one of the target's rights,
 * in every scope they hold them, and never a server owner.
 */
export async function assertMayManageAdmin(req: Request, targetUsername: string, targetSchool: string | null): Promise<void> {
  const actor = actorOf(req);
  if (isOwner(targetUsername)) throw new ForbiddenError('Server-Admins (ADMIN_USERNAMES) werden in der .env verwaltet, nicht im Panel');
  const target = await loadAccess(targetUsername);
  const scopes = [...(target.global.size > 0 ? [GLOBAL_SCOPE] : []), ...target.schools.keys()];
  for (const scope of scopes) {
    const check = mayManageTarget(actor.access, target, scope);
    if (!check.ok) throw new ForbiddenError(check.error);
  }
  if (scopes.length === 0) {
    const scope = targetSchool ?? GLOBAL_SCOPE;
    if (!managesAdminsIn(actor.access, scope) && !managesAdminsIn(actor.access, GLOBAL_SCOPE)) {
      throw new ForbiddenError('Keine Berechtigung, Admins dieser Schule zu verwalten');
    }
  }
}

/**
 * May the request's admin make an account of `accountSchool` an admin at
 * all (before any grant is given)?
 */
export function assertMayAppointAdmin(req: Request, accountSchool: string | null): void {
  const actor = actorOf(req);
  if (managesAdminsIn(actor.access, GLOBAL_SCOPE)) return;
  if (accountSchool && managesAdminsIn(actor.access, accountSchool)) return;
  throw new ForbiddenError('Keine Berechtigung, Admins dieser Schule zu ernennen');
}
