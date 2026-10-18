import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createHash, createHmac } from 'crypto';
import type { Admin, User } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../db';
import { logger } from '../utils/logger';
import { UnauthorizedError, ValidationError } from '../utils/errors';
import {
  ADMIN_SETUP_WINDOW_MS,
  adminPasswordHashes,
  adminPasswordKind,
  adminSetupLapsed,
  matchEnvAdmin,
  mayViewOneTimePassword,
  type AdminPasswordKind,
} from '../security/adminLogin';
import { openSecret, sealSecret } from '../security/totp';
import { clearSecondFactors } from './adminSecondFactor';
import { clearAdminSecurity } from './adminSecurity';
import { announceChange } from './adminLive';

/**
 * Who may open the admin panel and with which password — shared by the
 * password login, the passkey login, the re-authentication before a new
 * passkey is added and the password change in the panel settings.
 */

export type AdminAccount = {
  // The login name exactly as stored / configured; the admin JWT carries it
  // and requireAdmin looks it up again on every request.
  username: string;
  user: User | null;
  adminRecord: Admin | null;
  isEnvAdmin: boolean;
};

export type AdminLookup =
  | { ok: true; account: AdminAccount }
  | { ok: false; reason: 'no-account' | 'not-admin' };

async function findUser(username: string): Promise<User | null> {
  const exact = await prisma.user.findUnique({ where: { username } });
  if (exact) return exact;
  // Accounts made in the panel or through WebUntis are stored lower-case.
  const lower = username.toLowerCase();
  return lower === username ? null : prisma.user.findUnique({ where: { username: lower } });
}

export async function findAdminAccount(input: string): Promise<AdminLookup> {
  const typed = input.trim();
  if (!typed) return { ok: false, reason: 'no-account' };
  const user = await findUser(typed);
  let adminRecord = user ? await prisma.admin.findUnique({ where: { stableUid: user.stableUid } }) : null;
  // A grant whose first login did not happen in time is gone, even before the
  // periodic sweep gets to it.
  if (adminRecord && adminSetupLapsed(adminRecord, new Date())) {
    await expireLapsedAdminSetups();
    adminRecord = null;
  }
  const envName = matchEnvAdmin(user?.username ?? typed, config.adminUsernames);
  if (adminRecord) return { ok: true, account: { username: user!.username, user, adminRecord, isEnvAdmin: envName !== null } };
  // The configured spelling, so requireAdmin's env check matches it again.
  if (envName) return { ok: true, account: { username: envName, user, adminRecord: null, isEnvAdmin: true } };
  return { ok: false, reason: user ? 'not-admin' : 'no-account' };
}

export type PasswordCheck = 'ok' | 'wrong' | 'no-password';

export async function checkAdminPassword(account: AdminAccount, password: string): Promise<PasswordCheck> {
  const hashes = adminPasswordHashes({
    adminHash: account.adminRecord?.passwordHash,
    userHash: account.user?.passwordHash,
    sharedHash: config.adminPasswordHash,
  });
  if (hashes.length === 0) return 'no-password';
  for (const hash of hashes) {
    if (await bcrypt.compare(password, hash)) return 'ok';
  }
  return 'wrong';
}

export function adminPasswordKindOf(account: AdminAccount): AdminPasswordKind {
  return adminPasswordKind({
    hasAccount: account.user !== null,
    hasAdminRecord: account.adminRecord !== null,
    adminHash: account.adminRecord?.passwordHash,
    isUntisUser: account.user?.isUntisUser,
  });
}

/**
 * Replaces the password adminPasswordKindOf() names. The caller has checked
 * the current password; a configured password is not changed here.
 */
export async function changeAdminPassword(account: AdminAccount, newPassword: string): Promise<void> {
  const kind = adminPasswordKindOf(account);
  const passwordHash = await bcrypt.hash(newPassword, config.bcryptRounds);
  if (kind === 'admin' && account.adminRecord) {
    await prisma.admin.update({ where: { stableUid: account.adminRecord.stableUid }, data: { passwordHash } });
  } else if (kind === 'account' && account.user) {
    await prisma.user.update({ where: { stableUid: account.user.stableUid }, data: { passwordHash } });
  } else {
    throw new Error(`admin password of kind "${kind}" cannot be changed in the panel`);
  }
}

export function issueAdminToken(username: string): string {
  return jwt.sign(
    { role: 'admin', sub: 'admin-panel', username },
    config.jwtSecret,
    { expiresIn: config.adminJwtExpiresIn } as jwt.SignOptions,
  );
}

// ─── One-time password of a WebUntis account made admin ─────────────────────
//
//   1. An admin grants admin to a WebUntis account and sets a one-time
//      password for it. The grant is pending for ADMIN_SETUP_WINDOW_MS.
//   2. The new admin signs in with it and must choose a password of their own
//      before the panel opens (the "setup ticket" step).
//   3. Without that first login in time, the grant lapses: the admin row —
//      and with it the one-time password — is removed.

/**
 * The admin row of a pending grant made by `grantedBy`; pass its
 * setupExpiresAt to scheduleSetupExpiry() once written.
 */
export async function pendingAdminFields(oneTimePassword: string, grantedBy: string) {
  return {
    canCreateClass: true,
    passwordHash: await bcrypt.hash(oneTimePassword, config.bcryptRounds),
    mustChangePassword: true,
    setupExpiresAt: new Date(Date.now() + ADMIN_SETUP_WINDOW_MS),
    oneTimePasswordEnc: sealSecret(oneTimePassword, config.jwtSecret),
    grantedBy,
  };
}

/** Makes `stableUid` a pending admin that signs in once with `oneTimePassword`. */
export async function grantAdminWithOneTimePassword(stableUid: string, oneTimePassword: string, grantedBy: string): Promise<Date> {
  const data = await pendingAdminFields(oneTimePassword, grantedBy);
  await prisma.admin.upsert({ where: { stableUid }, create: { stableUid, ...data }, update: data });
  scheduleSetupExpiry(data.setupExpiresAt);
  return data.setupExpiresAt;
}

/**
 * The one-time password of a pending grant, for the admin who granted it —
 * or null: someone else asks, the new admin has their own password by now,
 * or the grant lapsed or was revoked.
 */
export async function viewOneTimePassword(stableUid: string, viewer: string): Promise<{ password: string; setupExpiresAt: Date } | null> {
  const admin = await prisma.admin.findUnique({ where: { stableUid } });
  if (!admin || !mayViewOneTimePassword(admin, viewer, new Date())) return null;
  try {
    return { password: openSecret(admin.oneTimePasswordEnc!, config.jwtSecret), setupExpiresAt: admin.setupExpiresAt! };
  } catch {
    // Sealed under another JWT_SECRET: unreadable, like a lost password.
    return null;
  }
}

// The exact moment a grant lapses, on the node that made it; the periodic
// sweep covers restarts and the other nodes.
export function scheduleSetupExpiry(at: Date): void {
  const timer = setTimeout(() => {
    expireLapsedAdminSetups().catch((err) => {
      logger.warn('Admin setup expiry failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }, Math.max(0, at.getTime() - Date.now()) + 1000);
  timer.unref();
}

/** Removes every pending grant past its deadline. Idempotent on every node. */
export async function expireLapsedAdminSetups(): Promise<number> {
  const now = new Date();
  const lapsed = await prisma.admin.findMany({
    where: { mustChangePassword: true, setupExpiresAt: { lte: now } },
    select: { stableUid: true },
  });
  let removed = 0;
  for (const { stableUid } of lapsed) {
    // Re-checked in the delete itself: a first login or a new grant that
    // landed in between keeps the row.
    const { count } = await prisma.admin.deleteMany({
      where: { stableUid, mustChangePassword: true, setupExpiresAt: { lte: now } },
    });
    if (count === 0) continue;
    removed += 1;
    const user = await prisma.user.findUnique({ where: { stableUid }, select: { username: true } });
    if (user) {
      await clearSecondFactors(user.username);
      await clearAdminSecurity(user.username);
      // The rights that came with the grant go with it, so a later new grant
      // starts from nothing.
      await prisma.adminGrant.deleteMany({ where: { username: user.username } });
    }
    logger.info('Admin grant lapsed: no first login within the setup window', {
      action: 'admin_setup_expired', targetUid: stableUid, username: user?.username ?? null,
    });
  }
  if (removed > 0) announceChange(['users']);
  return removed;
}

// Time to choose the new password once signed in with the one-time password.
const SETUP_TICKET_SECONDS = 10 * 60;

function setupTicketKey(): string {
  return createHmac('sha256', config.jwtSecret).update('pokyh-admin-password-setup-v1').digest('hex');
}

// Ties a ticket to one one-time password: a new grant voids older tickets.
function fingerprint(hash: string): string {
  return createHash('sha256').update(hash).digest('hex').slice(0, 32);
}

/**
 * After a correct one-time password: a ticket for choosing the new password.
 * Signing in in time counts as signed in, so the deadline moves out to the
 * end of the ticket — the person typing their new password is not cut off.
 */
export async function beginPasswordSetup(account: AdminAccount): Promise<string> {
  const record = account.adminRecord!;
  const ticketEnd = new Date(Date.now() + SETUP_TICKET_SECONDS * 1000);
  if (!record.setupExpiresAt || record.setupExpiresAt < ticketEnd) {
    await prisma.admin.updateMany({
      where: { stableUid: record.stableUid, mustChangePassword: true, passwordHash: record.passwordHash },
      data: { setupExpiresAt: ticketEnd },
    });
  }
  return jwt.sign(
    { purpose: 'admin-password-setup', username: account.username, fp: fingerprint(record.passwordHash!) },
    setupTicketKey(),
    { expiresIn: SETUP_TICKET_SECONDS, audience: 'admin-password-setup' },
  );
}

/** Sets the new admin's own password and ends the pending state. Returns the login name. */
export async function finishPasswordSetup(ticket: string, newPassword: string): Promise<string> {
  const expired = 'Die Anmeldung ist abgelaufen — bitte nochmal mit dem Einmal-Passwort anmelden';
  let claims: { purpose?: string; username?: string; fp?: string };
  try {
    claims = jwt.verify(ticket, setupTicketKey(), { audience: 'admin-password-setup' }) as typeof claims;
  } catch {
    throw new UnauthorizedError(expired);
  }
  if (claims.purpose !== 'admin-password-setup' || !claims.username || !claims.fp) throw new UnauthorizedError(expired);

  const lookup = await findAdminAccount(claims.username);
  const record = lookup.ok ? lookup.account.adminRecord : null;
  if (!lookup.ok || !record?.mustChangePassword || !record.passwordHash || fingerprint(record.passwordHash) !== claims.fp) {
    throw new UnauthorizedError(expired);
  }
  if (await bcrypt.compare(newPassword, record.passwordHash)) {
    throw new ValidationError('Bitte ein anderes Passwort als das Einmal-Passwort wählen');
  }

  const passwordHash = await bcrypt.hash(newPassword, config.bcryptRounds);
  const { count } = await prisma.admin.updateMany({
    where: { stableUid: record.stableUid, mustChangePassword: true, passwordHash: record.passwordHash },
    // The one-time password is gone for good, also for the granting admin.
    data: { passwordHash, mustChangePassword: false, setupExpiresAt: null, oneTimePasswordEnc: null },
  });
  if (count === 0) throw new UnauthorizedError(expired);
  announceChange(['users']);
  return lookup.account.username;
}
