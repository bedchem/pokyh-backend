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
