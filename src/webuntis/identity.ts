// Whose a WebUntis session is: the pure rules (no I/O), tested on their own
// (tests/webuntisSessionIdentity.test.mjs). What asks WebUntis: ./sessionIdentity.ts.

export type IdentityFailure =
  | 'untis_session_invalid'
  | 'untis_identity_unverified'
  | 'account_mismatch'
  | 'tenant_mismatch'
  | 'webuntis_unavailable';

/** What each failure answers (status, German text the apps show as it is). */
export const IDENTITY_FAILURES: Record<IdentityFailure, { status: number; error: string }> = {
  untis_session_invalid: { status: 401, error: 'Die WebUntis-Anmeldung ist abgelaufen. Bitte melde dich erneut an.' },
  untis_identity_unverified: { status: 401, error: 'WebUntis hat nicht bestätigt, wem diese Anmeldung gehört. Bitte melde dich erneut an.' },
  account_mismatch: { status: 403, error: 'Diese WebUntis-Anmeldung gehört zu einem anderen Konto.' },
  tenant_mismatch: { status: 403, error: 'Diese WebUntis-Anmeldung gehört zu einer anderen Schule.' },
  webuntis_unavailable: { status: 503, error: 'WebUntis ist gerade nicht erreichbar. Bitte versuche es gleich noch einmal.' },
};

/** A login name as compared: Unicode-normalised, trimmed, lower case. */
export function normalizedLoginName(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : '';
}

const NAME_CLAIMS = ['username', 'user_name', 'userName', 'preferred_username', 'sub'] as const;

/**
 * The login name a WebUntis bearer token names, '' when none: the first
 * name-like claim that is not a bare number (some instances put the user's
 * numeric id into `sub`).
 */
export function claimedLoginName(claims: Record<string, unknown> | null | undefined): string {
  if (!claims) return '';
  for (const key of NAME_CLAIMS) {
    const value = claims[key];
    if (typeof value === 'string' && value.trim() && !/^\d+$/.test(value.trim())) return value.trim();
  }
  return '';
}

export type IdentityCheck =
  | { ok: true; loginName: string }
  | { ok: false; code: Exclude<IdentityFailure, 'untis_session_invalid' | 'webuntis_unavailable'> };

/**
 * Whether a session is `username`'s: the login name its app-data shows (or,
 * without one, the name its bearer token carries) must be `username`. With
 * the school's tenant known, the session's tenant must be that one, and a
 * session that names no tenant then proves nothing.
 */
export function sessionIdentity(input: {
  username: string;
  appLoginName?: string;
  claims?: Record<string, unknown> | null;
  tenantId?: string;
  expectedTenantId?: string | null;
}): IdentityCheck {
  const expected = input.expectedTenantId?.trim();
  if (expected) {
    const tenant = input.tenantId?.trim();
    if (!tenant) return { ok: false, code: 'untis_identity_unverified' };
    if (tenant !== expected) return { ok: false, code: 'tenant_mismatch' };
  }
  const named = normalizedLoginName(input.appLoginName) || normalizedLoginName(claimedLoginName(input.claims));
  if (!named) return { ok: false, code: 'untis_identity_unverified' };
  if (named !== normalizedLoginName(input.username)) return { ok: false, code: 'account_mismatch' };
  return { ok: true, loginName: named };
}

export type TenantBinding =
  | { ok: true; store: string | null; rebound: boolean }
  | { ok: false; code: 'tenant_mismatch' | 'untis_identity_unverified' };

/**
 * Whether a sign-in may act for an account bound to the WebUntis tenant
 * `bound` (null: not bound yet), and what to store. Many schools share a
 * WebUntis host, and a school's own tenant is known only after a sign-in
 * POKYH made itself; so every account keeps the tenant it first signed in
 * with, and an app's session of any other tenant is refused for it.
 *
 * `certain`: a session POKYH opened itself with the account's password or key
 * at its school. It is the school's own word: it binds an unbound account and
 * corrects a binding that differs (the caller then ends the other sessions).
 * `session`: the session's tenant, '' when its token names none.
 */
export function accountTenant(bound: string | null, session: string, certain: boolean): TenantBinding {
  const stored = bound?.trim() || null;
  const tenant = session.trim();
  if (!tenant) {
    if (stored && !certain) return { ok: false, code: 'untis_identity_unverified' };
    return { ok: true, store: null, rebound: false };
  }
  if (!stored) return { ok: true, store: tenant, rebound: false };
  if (stored === tenant) return { ok: true, store: null, rebound: false };
  if (!certain) return { ok: false, code: 'tenant_mismatch' };
  return { ok: true, store: tenant, rebound: true };
}
