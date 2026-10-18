import type { Request } from 'express';
import { config } from '../config';
import { prisma } from '../db';
import { ForbiddenError } from '../utils/errors';
import { actorOf, adminTarget, assertMayManageAdmin, isOwner, sameName } from './adminAccess';
import { secondFactorMethods } from './adminSecondFactor';
import { audit } from './audit';
import { announceChange } from './adminLive';
import {
  loginSteps,
  missingFactors,
  requirementChange,
  requirementsFor,
  setupPending,
  type FactorKind,
  type FactorState,
  type Requirements,
} from '../security/adminSecondFactorPolicy';

/**
 * Login security of admin panel accounts: what is required (the
 * authenticator app always, a passkey per account; the rules are in
 * security/adminSecondFactorPolicy.ts), what is set up, and the last panel
 * login. Keyed by the admin login name.
 */

export type SecondFactorState = {
  required: Requirements;
  // Where the passkey requirement comes from: "account" (set in the panel) or
  // "default" (ADMIN_REQUIRE_PASSKEY).
  passkeySource: 'account' | 'default';
  factors: FactorState;
  // Required but not set up yet; while any is, only setting up opens.
  missing: FactorKind[];
  setupPending: boolean;
};

const serverRequirements = () => ({ totp: config.adminRequireSecondFactor, passkey: config.adminRequirePasskey });

async function passkeySettingOf(username: string): Promise<boolean | null> {
  const row = await prisma.adminSecurity.findUnique({ where: { username }, select: { requirePasskey: true } });
  return row?.requirePasskey ?? null;
}

function stateFrom(username: string, passkeySetting: boolean | null, factors: FactorState): SecondFactorState {
  const owner = isOwner(username);
  const required = requirementsFor(passkeySetting, owner, serverRequirements());
  const missing = missingFactors(required, factors);
  return {
    required,
    passkeySource: owner || passkeySetting === null ? 'default' : 'account',
    factors,
    missing,
    setupPending: setupPending(required, factors),
  };
}

export async function secondFactorState(username: string): Promise<SecondFactorState> {
  const [setting, factors] = await Promise.all([passkeySettingOf(username), secondFactorMethods(username)]);
  return stateFrom(username, setting, factors);
}

/**
 * Only whether the session must set something up first. Runs on every admin
 * request, so the factors are only read when something is required.
 */
export async function secondFactorSetupNeeded(username: string): Promise<boolean> {
  const required = requirementsFor(await passkeySettingOf(username), isOwner(username), serverRequirements());
  if (!required.totp && !required.passkey) return false;
  return setupPending(required, await secondFactorMethods(username));
}

/** The ways the login of `username` is confirmed after a correct password. */
export async function loginStepsFor(username: string): Promise<FactorState> {
  const state = await secondFactorState(username);
  return loginSteps(state.required, state.factors);
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

/** Sets (or with null resets to ADMIN_REQUIRE_PASSKEY) whether `username` needs a passkey. */
export async function setPasskeyRequirement(username: string, required: boolean | null, changedBy: string): Promise<void> {
  await prisma.adminSecurity.upsert({
    where: { username },
    create: { username, requirePasskey: required, changedBy },
    update: { requirePasskey: required, changedBy },
  });
}

/**
 * The panel's switch "Passkey Pflicht" for one admin (null: back to
 * ADMIN_REQUIRE_PASSKEY). Another admin who may manage the target as a whole
 * (assertMayManageAdmin) may set it either way; an admin may only raise their
 * own; server owners follow the .env. The authenticator app has no switch: it
 * is always required.
 */
export async function changePasskeyRequirement(req: Request, targetUsername: string, required: boolean | null): Promise<SecondFactorState> {
  const actor = actorOf(req);
  const self = sameName(actor.username, targetUsername);
  const check = requirementChange({ self, targetOwner: isOwner(targetUsername), required, serverDefault: config.adminRequirePasskey });
  if (check === 'owner') throw new ForbiddenError('Server-Admins (ADMIN_USERNAMES) folgen ADMIN_REQUIRE_PASSKEY in der .env');
  if (check === 'self-lower') throw new ForbiddenError('Die eigene Passkey-Pflicht kann nur ein anderer Admin aufheben');
  const target = self ? { username: actor.username, schoolId: null } : await adminTarget(targetUsername);
  if (!self) await assertMayManageAdmin(req, target.username, target.schoolId);

  const before = await secondFactorState(target.username);
  await setPasskeyRequirement(target.username, required, actor.username);
  const after = await secondFactorState(target.username);
  if (before.required.passkey !== after.required.passkey || before.passkeySource !== after.passkeySource) {
    audit(req, 'admin.passkey.requirement', { type: 'admin', id: target.username },
      { required: after.required.passkey, source: after.passkeySource, before: before.required.passkey }, null);
    announceChange(['users', 'access']);
  }
  return after;
}

/** Forgets an admin's login security (admin standing ended); a new grant starts at the default. */
export async function clearAdminSecurity(username: string): Promise<void> {
  await prisma.adminSecurity.deleteMany({ where: { username } });
}

export type AdminSecuritySummary = {
  totpRequired: boolean;
  passkeyRequired: boolean;
  passkeySource: 'account' | 'default';
  // Required but not set up.
  missing: FactorKind[];
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
    const state = stateFrom(username, row?.requirePasskey ?? null, factors);
    const lastLoginAt = row?.lastLoginAt ?? auditedLogin.get(key(username)) ?? null;
    out.set(username, {
      totpRequired: state.required.totp,
      passkeyRequired: state.required.passkey,
      passkeySource: state.passkeySource,
      missing: state.missing,
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
