import type { Request } from 'express';
import { config } from '../config';
import { prisma } from '../db';
import { ForbiddenError } from '../utils/errors';
import { actorOf, adminTarget, assertMayManageAdmin, isOwner, sameName } from './adminAccess';
import { secondFactorMethods } from './adminSecondFactor';
import { audit } from './audit';
import { announceChange } from './adminLive';
import {
  hasSecondFactor,
  requirementChange,
  secondFactorRequired,
  secondFactorSetupPending,
  type FactorState,
} from '../security/adminSecondFactorPolicy';

/**
 * Login security of admin panel accounts: whether a second factor is
 * required (security/adminSecondFactorPolicy.ts has the rules), what is set
 * up, and the last panel login. Keyed by the admin login name.
 */

export type SecondFactorState = {
  required: boolean;
  // "account": set for this admin; "default": ADMIN_REQUIRE_SECOND_FACTOR.
  source: 'account' | 'default';
  factors: FactorState;
  // Signed in, but a second factor has to be set up before anything else.
  setupPending: boolean;
};

async function settingOf(username: string): Promise<boolean | null> {
  const row = await prisma.adminSecurity.findUnique({ where: { username }, select: { requireSecondFactor: true } });
  return row?.requireSecondFactor ?? null;
}

function stateFrom(username: string, setting: boolean | null, factors: FactorState): SecondFactorState {
  const owner = isOwner(username);
  const required = secondFactorRequired(setting, owner, config.adminRequireSecondFactor);
  return {
    required,
    source: owner || setting === null ? 'default' : 'account',
    factors,
    setupPending: secondFactorSetupPending(required, factors),
  };
}

export async function secondFactorState(username: string): Promise<SecondFactorState> {
  const [setting, factors] = await Promise.all([settingOf(username), secondFactorMethods(username)]);
  return stateFrom(username, setting, factors);
}

/**
 * Only whether the session must set up a second factor first. Runs on every
 * admin request, so the factors are only read when one is required.
 */
export async function secondFactorSetupNeeded(username: string): Promise<boolean> {
  const setting = await settingOf(username);
  if (!secondFactorRequired(setting, isOwner(username), config.adminRequireSecondFactor)) return false;
  return !hasSecondFactor(await secondFactorMethods(username));
}

export async function recordAdminLogin(username: string, method: string): Promise<void> {
  const now = new Date();
  const lastLoginMethod = method.slice(0, 40);
  await prisma.adminSecurity.upsert({
    where: { username },
    create: { username, lastLoginAt: now, lastLoginMethod },
    update: { lastLoginAt: now, lastLoginMethod },
  });
}

/** Sets (or with null resets to the default) whether `username` needs a second factor. */
export async function setSecondFactorRequirement(username: string, required: boolean | null, changedBy: string): Promise<void> {
  await prisma.adminSecurity.upsert({
    where: { username },
    create: { username, requireSecondFactor: required, changedBy },
    update: { requireSecondFactor: required, changedBy },
  });
}

/**
 * The panel's switch "Zweiter Faktor Pflicht" for one admin (null: back to
 * ADMIN_REQUIRE_SECOND_FACTOR). Another admin who may manage the target as a
 * whole (assertMayManageAdmin) may set it either way; an admin may only raise
 * their own; server owners follow the .env.
 */
export async function changeSecondFactorRequirement(req: Request, targetUsername: string, required: boolean | null): Promise<SecondFactorState> {
  const actor = actorOf(req);
  const self = sameName(actor.username, targetUsername);
  const check = requirementChange({ self, targetOwner: isOwner(targetUsername), required, installationDefault: config.adminRequireSecondFactor });
  if (check === 'owner') throw new ForbiddenError('Server-Admins (ADMIN_USERNAMES) folgen ADMIN_REQUIRE_SECOND_FACTOR in der .env');
  if (check === 'self-lower') throw new ForbiddenError('Die eigene Pflicht zum zweiten Faktor kann nur ein anderer Admin aufheben');
  const target = self ? { username: actor.username, schoolId: null } : await adminTarget(targetUsername);
  if (!self) await assertMayManageAdmin(req, target.username, target.schoolId);

  const before = await secondFactorState(target.username);
  await setSecondFactorRequirement(target.username, required, actor.username);
  const after = await secondFactorState(target.username);
  if (before.required !== after.required || before.source !== after.source) {
    audit(req, 'admin.second_factor.requirement', { type: 'admin', id: target.username },
      { required: after.required, source: after.source, before: before.required }, null);
    announceChange(['users', 'access']);
  }
  return after;
}

/** Forgets an admin's login security (admin standing ended); a new grant starts at the default. */
export async function clearAdminSecurity(username: string): Promise<void> {
  await prisma.adminSecurity.deleteMany({ where: { username } });
}

export type AdminSecuritySummary = {
  required: boolean;
  source: 'account' | 'default';
  totp: boolean;
  passkeys: number;
  lastLoginAt: string | null;
  lastLoginMethod: string | null;
};

/**
 * Login security of several admins at once, for the admin lists. A login
 * from before admin_security existed is taken from the audit trail.
 */
export async function adminSecuritySummaries(usernames: readonly string[]): Promise<Map<string, AdminSecuritySummary>> {
  const names = [...new Set(usernames.filter(Boolean))];
  const out = new Map<string, AdminSecuritySummary>();
  if (names.length === 0) return out;
  const [rows, totps, passkeys] = await Promise.all([
    prisma.adminSecurity.findMany({ where: { username: { in: names } } }),
    prisma.adminTotp.findMany({ where: { username: { in: names }, enabledAt: { not: null } }, select: { username: true } }),
    prisma.adminPasskey.groupBy({ by: ['username'], where: { username: { in: names } }, _count: { _all: true } }),
  ]);
  // Login names compare without case (the database does, and a server owner's
  // configured spelling may differ from the account's).
  const key = (name: string) => name.toLowerCase();
  const rowOf = new Map(rows.map((r) => [key(r.username), r]));
  const withTotp = new Set(totps.map((t) => key(t.username)));
  const passkeysOf = new Map(passkeys.map((p) => [key(p.username), p._count._all]));
  const missingLogin = names.filter((n) => !rowOf.get(key(n))?.lastLoginAt);
  const audited = missingLogin.length > 0
    ? await prisma.adminAuditEvent.groupBy({
        by: ['actor'],
        where: { action: 'admin.login', actor: { in: missingLogin } },
        _max: { createdAt: true },
      })
    : [];
  const auditedLogin = new Map(audited.map((a) => [key(a.actor), a._max.createdAt]));

  for (const username of names) {
    const row = rowOf.get(key(username));
    const passkeyCount = passkeysOf.get(key(username)) ?? 0;
    const factors = { totp: withTotp.has(key(username)), passkey: passkeyCount > 0 };
    const state = stateFrom(username, row?.requireSecondFactor ?? null, factors);
    const lastLoginAt = row?.lastLoginAt ?? auditedLogin.get(key(username)) ?? null;
    out.set(username, {
      required: state.required,
      source: state.source,
      totp: factors.totp,
      passkeys: passkeyCount,
      lastLoginAt: lastLoginAt?.toISOString() ?? null,
      lastLoginMethod: row?.lastLoginAt ? row.lastLoginMethod : null,
    });
  }
  return out;
}

/** When each account last signed in to the apps (sign-ins in the request logs, kept REQUEST_LOG_RETENTION_DAYS). */
export async function lastAppSignIns(stableUids: readonly string[], signInPaths: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(stableUids.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await prisma.requestLog.groupBy({
    by: ['stableUid'],
    where: { stableUid: { in: ids }, method: 'POST', path: { in: [...signInPaths] }, status: { lt: 300 } },
    _max: { createdAt: true },
  });
  const out = new Map<string, string>();
  for (const r of rows) if (r.stableUid && r._max.createdAt) out.set(r.stableUid, r._max.createdAt.toISOString());
  return out;
}
