/**
 * Decisions of the admin panel login that need no database, kept here so they
 * are unit-tested on their own.
 */

/**
 * The password hashes that may open the admin panel for one account, in the
 * order they are tried.
 *
 * - A dedicated admin password (`npm run make-admin` / `set-admin-password`)
 *   is an explicit choice and then the only one accepted.
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
