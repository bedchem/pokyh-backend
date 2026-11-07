import { createHash } from 'node:crypto';
import { TtlCache } from '../utils/cache';
import { jwtClaims, readFetch, tenantIdOf } from './client';
import { extractLoginName, extractPersonId, fetchAppData } from './appData';
import { schoolBase, schoolCookieValue, type UntisSchool } from './schools';
import { claimedLoginName, normalizedLoginName, sessionIdentity, type IdentityFailure } from './identity';

// Whose a WebUntis session is. The apps sign in to WebUntis on the phone and
// hand POKYH their session (POST /auth/login, the QR hand-over); the app's
// key is no secret (it ships in every app), so the session is the only proof
// of who signs in. A session counts for an account only when WebUntis itself
// names that account's login for it, and, where the school's WebUntis tenant
// is known, when the session belongs to that tenant: a session of another
// school can never stand for a same-named account here.
//
// The rules are pure (./identity.ts); verifySessionIdentity asks WebUntis
// with the session.

export { IDENTITY_FAILURES, claimedLoginName, normalizedLoginName, sessionIdentity } from './identity';
export type { IdentityCheck, IdentityFailure } from './identity';

export interface VerifiedSession {
  ok: true;
  /** The session's bearer token (REST endpoints). */
  bearer: string;
  /** The session's app-data, null when WebUntis gave none in time. */
  appData: unknown;
  /** The person the session acts as (0 when the app-data names none). */
  personId: number;
  /** The session's WebUntis tenant, '' when its token names none. */
  tenantId: string;
}

export type VerifyResult = VerifiedSession | { ok: false; code: IdentityFailure };

const SESSION_ID = /^[A-Za-z0-9._-]{8,200}$/;
const BEARER_TIMEOUT_MS = 6_000;
/** The whole app-data lookup (all candidate paths together). */
const APPDATA_BUDGET_MS = 8_000;

// A session already proven for an account answers again without asking
// WebUntis (an app that renews often, several requests at once). Three
// minutes: the bearer token kept with it stays valid that long.
const verified = new TtlCache<VerifiedSession>(3 * 60 * 1000, 5_000);
const cacheKey = (school: UntisSchool, sessionId: string, username: string) =>
  createHash('sha256').update(`${school.server}|${school.loginName.toLowerCase()}|${normalizedLoginName(username)}|${sessionId}`).digest('hex');

// Lookups in flight at once; more wait their turn. One sign-in costs WebUntis
// a handful of requests, so a burst of sign-ins (a school after an update)
// must not turn into a flood towards WebUntis.
const MAX_IN_FLIGHT = 16;
let inFlight = 0;
const waiting: Array<() => void> = [];
async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight++;
  try {
    return await work();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

type Bearer = { kind: 'ok'; token: string } | { kind: 'invalid' } | { kind: 'unavailable' };

/** A bearer token for the session; tells an ended session from WebUntis being unreachable. */
async function mintBearer(base: string, cookie: string): Promise<Bearer> {
  try {
    const r = await readFetch(`${base}/api/token/new`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(BEARER_TIMEOUT_MS) });
    const text = (await r.text()).trim();
    if (r.status >= 500) return { kind: 'unavailable' };
    if (!r.ok || text.startsWith('<')) return { kind: 'invalid' };
    const bare = text.replace(/^"|"$/g, '');
    return (bare.match(/\./g) ?? []).length === 2 ? { kind: 'ok', token: bare } : { kind: 'invalid' };
  } catch {
    return { kind: 'unavailable' };
  }
}

type AppDataLookup = { kind: 'ok'; json: unknown } | { kind: 'expired' } | { kind: 'none' } | { kind: 'timeout' };

async function appDataWithin(school: UntisSchool, sessionId: string, bearer: string, username: string): Promise<AppDataLookup> {
  const lookup = fetchAppData({ sessionId, school, bearerToken: bearer, studentId: 0, klasseId: 0, klasseName: '', username })
    .then((r): AppDataLookup => (r.ok ? { kind: 'ok', json: r.json } : r.expired ? { kind: 'expired' } : { kind: 'none' }))
    .catch((): AppDataLookup => ({ kind: 'none' }));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<AppDataLookup>((resolve) => { timer = setTimeout(() => resolve({ kind: 'timeout' }), APPDATA_BUDGET_MS); });
  try {
    return await Promise.race([lookup, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks WebUntis, with the session, whose it is, and accepts it only for
 * `username` (sessionIdentity). `expectedTenantId`: the school's WebUntis
 * tenant when POKYH knows it (services/schools.ts). Fails closed: WebUntis
 * not answering is `webuntis_unavailable`, never a pass.
 */
export async function verifySessionIdentity(
  school: UntisSchool,
  sessionId: string,
  username: string,
  expectedTenantId: string | null,
): Promise<VerifyResult> {
  if (!SESSION_ID.test(sessionId)) return { ok: false, code: 'untis_session_invalid' };
  const key = cacheKey(school, sessionId, username);
  const known = verified.get(key);
  if (known && (!expectedTenantId || known.tenantId === expectedTenantId)) return known;

  return withSlot(async (): Promise<VerifyResult> => {
    const base = schoolBase(school);
    const cookie = `JSESSIONID=${sessionId}; schoolname="${schoolCookieValue(school)}"`;
    const bearer = await mintBearer(base, cookie);
    if (bearer.kind === 'invalid') return { ok: false, code: 'untis_session_invalid' };
    if (bearer.kind === 'unavailable') return { ok: false, code: 'webuntis_unavailable' };

    const claims = jwtClaims(bearer.token);
    const tenantId = tenantIdOf(bearer.token) ?? '';
    const appData = await appDataWithin(school, sessionId, bearer.token, username);
    if (appData.kind === 'expired') return { ok: false, code: 'untis_session_invalid' };
    const json = appData.kind === 'ok' ? appData.json : null;
    const appLoginName = json ? extractLoginName(json) ?? '' : '';
    // Without an app-data in time, only the token can name the account; when
    // it does not either, WebUntis was too slow to tell (retry), not wrong.
    if (!appLoginName && appData.kind === 'timeout' && !claimedLoginName(claims)) return { ok: false, code: 'webuntis_unavailable' };

    const check = sessionIdentity({ username, appLoginName, claims, tenantId, expectedTenantId });
    if (!check.ok) return check;
    const result: VerifiedSession = { ok: true, bearer: bearer.token, appData: json, personId: json ? extractPersonId(json) : 0, tenantId };
    verified.set(key, result);
    return result;
  });
}

/** Forgets what was proven for a session (it ended, the account signed out). */
export function forgetVerifiedSession(school: UntisSchool, sessionId: string, username: string): void {
  verified.delete(cacheKey(school, sessionId, username));
}
