import { schoolBase, schoolCookieValue, schoolLoginName, type UntisSchool } from './schools';

// Access to WebUntis with the signed-in person's own session.
//
// Every request carries the session cookie. REST endpoints additionally need a
// short-lived bearer token (minted from the cookie session via /api/token/new),
// and some services want the tenant and school-year headers the official web
// client sends. Classic endpoints that change data expect the session's CSRF
// token. All of that is resolved here so route handlers stay small, and kept
// per WebUntis session in this process's memory (never in Redis or MySQL:
// session tokens live only in the person's sealed cookie) so a page load
// doesn't mint a token per request.

export interface UntisSession {
  sessionId: string;
  /** Missing in sessions from before schools: the installation's default school. */
  school?: UntisSchool;
  bearerToken: string;
  studentId: number;
  klasseId: number;
  klasseName: string;
  username: string;
  personName?: string;
  personType?: number;
  isParent?: boolean;
  /** WebUntis profile-image URL, captured at login (the session is freshest then). */
  imageUrl?: string;
  loginAt?: number;
}

/** `https://<server>/WebUntis` of the session's school. */
export function untisBase(session: Pick<UntisSession, 'school'>): string {
  return schoolBase(session.school);
}

/** WebUntis login name of the session's school. */
export function untisSchool(session: Pick<UntisSession, 'school'>): string {
  return schoolLoginName(session.school);
}

export function cookieHeader(session: Pick<UntisSession, 'sessionId' | 'school'>): string {
  return `JSESSIONID=${session.sessionId}; schoolname="${schoolCookieValue(session.school)}"`;
}

/** Cookie + bearer headers of a session, for a plain request. */
export function sessionHeaders(session: UntisSession): Record<string, string> {
  return {
    Cookie: cookieHeader(session),
    Accept: 'application/json',
    ...(session.bearerToken ? { Authorization: `Bearer ${session.bearerToken}` } : {}),
  };
}

// ── Small per-session memory ────────────────────────────────────────────────

interface SessionMemo {
  token?: string;
  tokenExp?: number; // epoch ms
  schoolYearId?: number;
  csrf?: string;
  tenant?: string;
  touched: number;
}

const memo = new Map<string, SessionMemo>();
const MEMO_TTL_MS = 30 * 60 * 1000;

function entry(sessionId: string): SessionMemo {
  const now = Date.now();
  if (memo.size > 2_000) {
    for (const [key, value] of memo) if (now - value.touched > MEMO_TTL_MS) memo.delete(key);
  }
  let e = memo.get(sessionId);
  if (!e) {
    e = { touched: now };
    memo.set(sessionId, e);
  }
  e.touched = now;
  return e;
}

export function forgetSession(sessionId: string): void {
  memo.delete(sessionId);
}

function decodeJwt(token?: string): Record<string, unknown> | null {
  const part = token?.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function jwtExpiry(token?: string): number | undefined {
  const exp = decodeJwt(token)?.exp;
  return typeof exp === 'number' ? exp * 1000 : undefined;
}

export function tenantIdOf(token?: string): string | undefined {
  const claim = decodeJwt(token)?.tenant_id;
  return claim != null && String(claim).trim() ? String(claim) : undefined;
}

/** True when WebUntis answered with its login page or an auth status. */
export function looksExpired(status: number, body: string): boolean {
  return status === 401 || body.trimStart().startsWith('<');
}

// ── Bearer token ────────────────────────────────────────────────────────────

async function mintToken(session: UntisSession): Promise<string | undefined> {
  try {
    const res = await fetch(`${untisBase(session)}/api/token/new`, {
      headers: { Cookie: cookieHeader(session), Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const text = (await res.text()).trim();
    if (!res.ok || text.startsWith('<')) return undefined;
    if (text.startsWith('{')) {
      const json = JSON.parse(text) as Record<string, unknown>;
      const tok = json.accessToken ?? json.token ?? json.access_token ?? json.jwt;
      return typeof tok === 'string' && tok ? tok : undefined;
    }
    const bare = text.replace(/^"|"$/g, '');
    return (bare.match(/\./g) ?? []).length === 2 ? bare : undefined;
  } catch {
    return undefined;
  }
}

/** A bearer token valid for at least another minute (minted fresh if needed). */
export async function bearerToken(session: UntisSession): Promise<string | undefined> {
  const e = entry(session.sessionId);
  const now = Date.now();
  if (e.token && e.tokenExp && e.tokenExp - now > 60_000) return e.token;

  const loginExp = jwtExpiry(session.bearerToken);
  if (!e.token && session.bearerToken && loginExp && loginExp - now > 60_000) {
    e.token = session.bearerToken;
    e.tokenExp = loginExp;
    return e.token;
  }

  const fresh = await mintToken(session);
  if (fresh) {
    e.token = fresh;
    e.tokenExp = jwtExpiry(fresh) ?? now + 5 * 60_000;
    return fresh;
  }
  return e.token ?? session.bearerToken ?? undefined;
}

// ── JSON-RPC ────────────────────────────────────────────────────────────────

export type RpcResult<T> = { ok: true; result: T } | { ok: false; expired: boolean; message?: string };

const RPC_AUTH_ERRORS = new Set([-8500, -8501, -8502, -8520]);

export async function rpc<T>(session: UntisSession, method: string, params: Record<string, unknown> = {}): Promise<RpcResult<T>> {
  try {
    const res = await fetch(`${untisBase(session)}/jsonrpc.do?school=${encodeURIComponent(untisSchool(session))}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(session) },
      body: JSON.stringify({ id: `pokyh-${method}`, method, params, jsonrpc: '2.0' }),
      signal: AbortSignal.timeout(12_000),
    });
    const text = await res.text();
    if (looksExpired(res.status, text)) return { ok: false, expired: true };
    const json = JSON.parse(text) as { result?: T; error?: { code?: number; message?: string } };
    if (json.error) {
      return { ok: false, expired: RPC_AUTH_ERRORS.has(Number(json.error.code)), message: json.error.message };
    }
    return { ok: true, result: json.result as T };
  } catch {
    return { ok: false, expired: false };
  }
}

/** Current school-year id (the `X-Webuntis-Api-School-Year-Id` header). */
export async function schoolYearId(session: UntisSession): Promise<number | undefined> {
  const e = entry(session.sessionId);
  if (e.schoolYearId) return e.schoolYearId;
  const r = await rpc<{ id?: number }>(session, 'getCurrentSchoolyear');
  if (r.ok && typeof r.result?.id === 'number') {
    e.schoolYearId = r.result.id;
    return e.schoolYearId;
  }
  return undefined;
}

/**
 * The session's CSRF token. WebUntis embeds it in the configuration of every
 * page it renders for the session; the official client sends it as
 * `X-CSRF-TOKEN` on every classic (non-REST) request that changes data.
 */
export async function csrfToken(session: UntisSession, force = false): Promise<string | undefined> {
  const e = entry(session.sessionId);
  if (e.csrf && !force) return e.csrf;
  try {
    const res = await fetch(`${untisBase(session)}/?school=${encodeURIComponent(untisSchool(session))}`, {
      headers: { Cookie: cookieHeader(session), Accept: 'text/html' },
      signal: AbortSignal.timeout(12_000),
    });
    const page = readPageConfig(await res.text());
    if (page.tenant) e.tenant = page.tenant;
    if (page.csrf) {
      e.csrf = page.csrf;
      return e.csrf;
    }
  } catch {
    /* handled below */
  }
  return undefined;
}

/** CSRF token and tenant id from the configuration WebUntis embeds in its pages. */
export function readPageConfig(html: string): { csrf?: string; tenant?: string } {
  return {
    csrf: html.match(/"csrfToken"\s*:\s*"([^"]+)"/)?.[1],
    tenant: html.match(/"tenantId"\s*:\s*"?([0-9A-Za-z-]+)"?/)?.[1],
  };
}

async function sessionTenant(session: UntisSession): Promise<string | undefined> {
  const e = entry(session.sessionId);
  if (e.tenant) return e.tenant;
  const fromToken = tenantIdOf(session.bearerToken);
  if (fromToken) return (e.tenant = fromToken);
  await csrfToken(session);
  return e.tenant;
}

// ── Requests ────────────────────────────────────────────────────────────────

export interface UntisResponse {
  status: number;
  ok: boolean;
  expired: boolean;
  text: string;
  json: unknown;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** JSON body (serialised and sent as application/json). */
  json?: unknown;
  /** Multipart body; fetch sets the boundary itself. */
  form?: FormData;
  /** Send bearer + tenant + school-year headers (REST endpoints). */
  rest?: boolean;
  /** Send the session's CSRF token (classic endpoints that change data). */
  csrf?: boolean;
  /**
   * Classic WebUntis endpoint (/api/classreg, /api/profile, …): cookie session
   * plus the CSRF token and Tenant-Id the official client adds to every write,
   * no bearer token.
   */
  classic?: boolean;
  timeoutMs?: number;
  accept?: string;
}

export async function untis(session: UntisSession, path: string, opts: RequestOptions = {}): Promise<UntisResponse> {
  const method = opts.method ?? (opts.json !== undefined || opts.form ? 'POST' : 'GET');
  const headers: Record<string, string> = {
    Cookie: cookieHeader(session),
    Accept: opts.accept ?? 'application/json',
  };

  if (opts.classic) {
    const [token, tenant] = await Promise.all([csrfToken(session), sessionTenant(session)]);
    if (token) headers['X-CSRF-TOKEN'] = token;
    if (tenant) headers['Tenant-Id'] = tenant;
  } else if (opts.rest !== false) {
    const [token, yearId] = await Promise.all([bearerToken(session), schoolYearId(session)]);
    if (token) headers.Authorization = `Bearer ${token}`;
    const tenant = tenantIdOf(token) ?? tenantIdOf(session.bearerToken);
    if (tenant) headers['Tenant-Id'] = tenant;
    if (yearId) headers['X-Webuntis-Api-School-Year-Id'] = String(yearId);
  }
  if (opts.csrf) {
    const token = await csrfToken(session);
    if (token) headers['X-CSRF-TOKEN'] = token;
  }

  let body: FormData | string | undefined;
  if (opts.form) body = opts.form;
  else if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }

  const res = await fetch(`${untisBase(session)}${path}`, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  const text = await res.text();
  const expired = looksExpired(res.status, text);
  let json: unknown = null;
  if (!expired && text) {
    try { json = JSON.parse(text); } catch { json = null; }
  }
  return { status: res.status, ok: res.ok && !expired, expired, text, json };
}

/**
 * A classic write (CSRF-protected). A 403 is what WebUntis answers to a stale
 * CSRF token, and nothing was written, so it is retried once with a fresh token.
 */
export async function untisClassicWrite(
  session: UntisSession,
  path: string,
  opts: { method: 'POST' | 'PUT' | 'DELETE'; json?: unknown; timeoutMs?: number },
): Promise<UntisResponse> {
  const first = await untis(session, path, { ...opts, classic: true });
  if (first.status !== 403) return first;
  await csrfToken(session, true);
  return untis(session, path, { ...opts, classic: true });
}

/** A plain GET with the session's cookie and bearer headers: status and body text. */
export async function untisGetText(session: UntisSession, path: string, timeoutMs = 15_000): Promise<{ status: number; ok: boolean; text: string }> {
  const res = await fetch(`${untisBase(session)}${path}`, { headers: sessionHeaders(session), signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, ok: res.ok, text: await res.text() };
}

export type GetResult =
  | { ok: true; json: unknown; path: string }
  | { ok: false; reason: 'expired' | 'none' };

/**
 * Tries each candidate path (read-only GET) and returns the first whose JSON
 * the `accept` predicate approves, so reads keep working across the differing
 * internal paths of WebUntis instances. Empty candidates and repeats are skipped.
 */
export async function firstWorkingGet(
  session: UntisSession,
  candidates: (string | undefined)[],
  accept: (json: unknown) => boolean,
): Promise<GetResult> {
  let sawExpired = false;
  const seen = new Set<string>();
  for (const p of candidates) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    try {
      const res = await untisGetText(session, p, 12_000);
      if (res.status === 401 || res.text.trimStart().startsWith('<')) { sawExpired = true; continue; }
      if (!res.ok) continue;
      let json: unknown;
      try { json = JSON.parse(res.text); } catch { continue; }
      if (accept(json)) return { ok: true, json, path: p };
    } catch { /* try the next candidate */ }
  }
  return { ok: false, reason: sawExpired ? 'expired' : 'none' };
}

/**
 * The human-readable reason WebUntis gives for a rejected request, in any of
 * the shapes its services use (`errorMessage`, `validationErrors`, `errors`).
 */
export function untisError(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const j = json as {
    errorMessage?: unknown;
    message?: unknown;
    validationErrors?: { errorMessage?: unknown }[];
    errors?: { title?: unknown; detail?: unknown; code?: unknown }[];
  };
  if (typeof j.errorMessage === 'string' && j.errorMessage.trim()) return j.errorMessage.trim();
  const validation = j.validationErrors
    ?.map((v) => (typeof v.errorMessage === 'string' ? v.errorMessage : ''))
    .filter(Boolean)
    .join(' ');
  if (validation) return validation;
  const first = j.errors?.[0];
  if (first) {
    const text = [first.title, first.detail].find((v) => typeof v === 'string' && v.trim());
    if (typeof text === 'string') return text.trim();
  }
  if (typeof j.message === 'string' && j.message.trim()) return j.message.trim();
  return undefined;
}

/** First error `code` of a WebUntis `{ errors: [{ code }] }` envelope. */
export function untisErrorCode(json: unknown): string | undefined {
  const code = (json as { errors?: { code?: unknown }[] } | null)?.errors?.[0]?.code;
  return code != null ? String(code) : undefined;
}
