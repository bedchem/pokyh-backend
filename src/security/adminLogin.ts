/**
 * Decisions of the admin panel login that need no database, kept here so they
 * are unit-tested on their own.
 */

/**
 * The password hashes that may open the admin panel for one account, in the
 * order they are tried.
 *
 * - A dedicated admin password (`npm run make-admin` / `set-admin-password`,
 *   or the one-time password of a WebUntis account made admin) is an explicit
 *   choice and then the only one accepted.
 * - Otherwise the account's own Pokyh password counts — what an admin made in
 *   the panel ("Admin vergeben" + "Passwort setzen") actually logs in with.
 * - The shared ADMIN_PASSWORD_HASH keeps working as before for every admin
 *   without a dedicated password.
 */
export function adminPasswordHashes(input: {
  adminHash: string | null | undefined;
  userHash: string | null | undefined;
  sharedHash: string | null | undefined;
}): string[] {
  if (input.adminHash) return [input.adminHash];
  return [input.userHash, input.sharedHash].filter((hash): hash is string => Boolean(hash));
}

/** How long a WebUntis account made admin has for its first login. */
export const ADMIN_SETUP_WINDOW_MS = 15 * 60 * 1000;

/**
 * Whether making this account an admin needs a one-time password: a WebUntis
 * account (or any account without a password of its own) has nothing the
 * panel could check — its WebUntis password is never used for the panel.
 */
export function grantNeedsOneTimePassword(user: { isUntisUser: boolean; hasPassword: boolean }): boolean {
  return user.isUntisUser || !user.hasPassword;
}

/**
 * Whether an admin can sign in to the panel at all. A WebUntis admin made
 * before one-time passwords existed has no password the panel accepts; it gets
 * a one-time password like a new grant.
 */
export function adminCanSignIn(input: {
  adminHash: string | null | undefined;
  mustChangePassword: boolean;
  needsOneTimePassword: boolean;
}): boolean {
  if (input.mustChangePassword) return false;
  return Boolean(input.adminHash) || !input.needsOneTimePassword;
}

/** A one-time password the granting admin types or generates. */
export function validOneTimePassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= 8 && password.length <= 100;
}

/**
 * Whether `viewer` may see a pending grant's one-time password again: only
 * the admin who granted it, only while the grant is pending and in time —
 * never the password the new admin chooses afterwards.
 */
export function mayViewOneTimePassword(
  admin: { mustChangePassword: boolean; setupExpiresAt: Date | null; oneTimePasswordEnc: string | null; grantedBy: string | null },
  viewer: string,
  now: Date,
): boolean {
  return admin.mustChangePassword
    && admin.oneTimePasswordEnc !== null
    && admin.grantedBy !== null
    && admin.grantedBy === viewer
    && admin.setupExpiresAt !== null
    && admin.setupExpiresAt.getTime() > now.getTime();
}

/** Whether a pending grant has lapsed: no first login before its deadline. */
export function adminSetupLapsed(
  admin: { mustChangePassword: boolean; setupExpiresAt: Date | null },
  now: Date,
): boolean {
  return admin.mustChangePassword && admin.setupExpiresAt !== null && admin.setupExpiresAt.getTime() <= now.getTime();
}

/**
 * Which password "Passwort ändern" in the panel settings changes — the one the
 * login above checks first — or why there is none to change here:
 *
 * - `admin`    the dedicated admin password (for a WebUntis admin, the one
 *              chosen after the one-time password; never the WebUntis password)
 * - `account`  the account's own Pokyh password (also its app login)
 * - `config`   an admin from ADMIN_USERNAMES without an admin record; the
 *              password comes from the server configuration
 */
export type AdminPasswordKind = 'admin' | 'account' | 'config';

export function adminPasswordKind(input: {
  hasAccount: boolean;
  hasAdminRecord: boolean;
  adminHash: string | null | undefined;
  isUntisUser: boolean | null | undefined;
}): AdminPasswordKind {
  if (input.adminHash) return 'admin';
  if (!input.hasAccount) return 'config';
  if (!input.isUntisUser) return 'account';
  return input.hasAdminRecord ? 'admin' : 'config';
}

/** The configured env admin name `username` refers to (case-insensitive), or null. */
export function matchEnvAdmin(username: string, envAdmins: readonly string[]): string | null {
  const wanted = username.trim().toLowerCase();
  return envAdmins.find((name) => name.toLowerCase() === wanted) ?? null;
}

/**
 * The WebAuthn relying party for a request from the admin panel: the origin
 * the browser shows and the domain (rpId) passkeys are bound to. A passkey
 * made under one domain only ever works under that domain — the browser and
 * the authenticator enforce it — so this only has to refuse origins that are
 * not plausible panel addresses: https, or plain http on this machine. With
 * `allowedOrigins` set (ADMIN_PASSKEY_ORIGINS), only those are accepted.
 */
export function passkeyRelyingParty(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): { origin: string; rpId: string } | null {
  if (!origin) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost')) return null;
  // WebAuthn does not accept IP addresses as relying party ids.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.startsWith('[')) return null;
  if (allowedOrigins.length > 0 && !allowedOrigins.includes(url.origin)) return null;
  return { origin: url.origin, rpId: url.hostname };
}
