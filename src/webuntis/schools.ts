import { config } from '../config';
import { cachedFor } from '../services/cache';
import { WEBUNTIS_SCHOOL_PATTERN } from '../services/schools';
import { readLoginOptions, type LoginOptions } from './loginOptions';

// The WebUntis school of a website sign-in: its login name ("lbs-brixen"),
// the WebUntis server it runs on ("lbs-brixen.webuntis.com") and its name as
// WebUntis lists it. The public school search of WebUntis finds all three.
//
// A server a client names is never trusted as a URL: only hosts under the
// configured WebUntis domains are accepted (WEBUNTIS_HOST_SUFFIXES), so no
// request can be pointed anywhere else. Sessions without a school use the
// installation's default school (WEBUNTIS_BASE / WEBUNTIS_SCHOOL).

export interface UntisSchool {
  loginName: string;
  server: string;
  name?: string;
}

export interface SchoolHit extends Required<UntisSchool> {
  address: string;
  /** WebUntis' numeric school id (stable key for lists). */
  id: number;
}

const DEFAULT_BASE = config.webuntisBase.replace(/\/$/, '');
const DEFAULT_LOGIN_NAME = config.webuntisSchool.trim() || 'lbs-brixen';
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function schoolAllowed(loginName: string): boolean {
  const allow = config.webuntis.schoolAllowlist;
  return allow.length === 0 || allow.includes(loginName.trim().toLowerCase());
}

/** A WebUntis host this API may talk to, normalised; '' when it is not one. */
export function allowedServer(value: unknown): string {
  if (typeof value !== 'string') return '';
  const host = value.trim().toLowerCase().replace(/^https:\/\//, '').replace(/[/?#].*$/, '');
  if (!host || host.length > 253 || !HOST.test(host)) return '';
  return config.webuntisHostSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)) ? host : '';
}

export function validLoginName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  return WEBUNTIS_SCHOOL_PATTERN.test(name) ? name : '';
}

/** A school reference from a request body, validated; null when unusable. */
export function parseSchool(value: unknown): UntisSchool | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const loginName = validLoginName(v.loginName);
  const server = allowedServer(v.server);
  if (!loginName || !server || !schoolAllowed(loginName)) return null;
  const name = typeof v.name === 'string' ? v.name.replace(/[\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  return { loginName, server, ...(name ? { name } : {}) };
}

/** The installation's own school (sessions without a school belong to it). */
export function defaultSchool(): UntisSchool {
  return { loginName: DEFAULT_LOGIN_NAME, server: new URL(DEFAULT_BASE).host };
}

/** `https://<server>/WebUntis` of a school, or of the default school. */
export function schoolBase(school?: UntisSchool | null): string {
  const server = school ? allowedServer(school.server) : '';
  return server ? `https://${server}/WebUntis` : DEFAULT_BASE;
}

export function schoolLoginName(school?: UntisSchool | null): string {
  return (school && validLoginName(school.loginName)) || DEFAULT_LOGIN_NAME;
}

/** Value of WebUntis' `schoolname` cookie for a school. */
export function schoolCookieValue(school?: UntisSchool | null): string {
  return '_' + Buffer.from(schoolLoginName(school)).toString('base64');
}

// ── Sign-in options ─────────────────────────────────────────────────────────

// Kept an hour per school (public, and a school seldom changes how it signs
// in), so the sign-in page does not open a WebUntis session for every visitor.
// Failures are not kept.
const OPTIONS_TTL_SECONDS = 60 * 60;

/** How the school signs in (./loginOptions.ts); null when its page could not be read. */
export function schoolLoginOptions(school: UntisSchool): Promise<LoginOptions | null> {
  const key = `webuntis:login-options:${allowedServer(school.server)}:${schoolLoginName(school).toLowerCase()}`;
  return cachedFor(key, OPTIONS_TTL_SECONDS, async () => {
    try {
      const res = await fetch(`${schoolBase(school)}/?school=${encodeURIComponent(schoolLoginName(school))}`, {
        headers: { Accept: 'text/html' },
        signal: AbortSignal.timeout(8_000),
      });
      return res.ok ? readLoginOptions(await res.text()) : null;
    } catch {
      return null;
    }
  }, (options) => options !== null);
}

// ── Search ──────────────────────────────────────────────────────────────────

export type SearchResult =
  | { ok: true; schools: SchoolHit[] }
  | { ok: false; reason: 'too_many' | 'unavailable' };

// Place names as people type them, mapped to the form WebUntis lists them
// under. WebUntis' school search matches the school's own address, which in
// South Tyrol, Austria, Germany and Switzerland is usually in German: someone
// searching "Bolzano" or "Vienna" would otherwise find nothing. Used only
// when the search as typed finds no school.
const PLACE_ALIASES: Record<string, string> = {
  // South Tyrol (Italian → German)
  bolzano: 'bozen', bressanone: 'brixen', merano: 'meran', brunico: 'bruneck', vipiteno: 'sterzing',
  laives: 'leifers', appiano: 'eppan', caldaro: 'kaltern', silandro: 'schlanders', egna: 'neumarkt',
  chiusa: 'klausen', ortisei: 'st. ulrich', malles: 'mals', 'san candido': 'innichen', dobbiaco: 'toblach',
  renon: 'ritten', 'campo tures': 'sand in taufers', 'val badia': 'abtei', naturno: 'naturns',
  // Cities by their English, Italian or French names
  vienna: 'wien', vienne: 'wien', munich: 'münchen', 'monaco di baviera': 'münchen', cologne: 'köln',
  colonia: 'köln', zurich: 'zürich', zurigo: 'zürich', geneva: 'genf', ginevra: 'genf', genève: 'genf',
  berna: 'bern', berne: 'bern', lucerne: 'luzern', lucerna: 'luzern', basle: 'basel', basilea: 'basel',
  salisburgo: 'salzburg', nuremberg: 'nürnberg', norimberga: 'nürnberg', 'frankfurt am main': 'frankfurt',
};

const normaliseQuery = (query: string) => query.trim().toLowerCase().replace(/\s+/g, ' ');

/** Searches as typed; when nothing is found, once more by the local name of the place. */
export async function searchSchools(query: string): Promise<SearchResult> {
  const result = await searchOnce(query);
  const alias = result.ok && result.schools.length === 0 ? PLACE_ALIASES[normaliseQuery(query)] ?? null : null;
  return alias ? searchOnce(alias) : result;
}

// Answers are kept 10 minutes per query (public data, no person attached),
// so typing and retyping a name or many people of one school do not reach
// WebUntis each time. Failures are not kept.
const SEARCH_TTL_SECONDS = 10 * 60;

interface RawSchool {
  server?: unknown;
  displayName?: unknown;
  loginName?: unknown;
  address?: unknown;
  schoolId?: unknown;
}

function searchOnce(query: string): Promise<SearchResult> {
  const key = normaliseQuery(query);
  return cachedFor(`webuntis:school-search:${key}`, SEARCH_TTL_SECONDS, () => fetchSearch(key), (r) => r.ok || r.reason === 'too_many');
}

async function fetchSearch(key: string): Promise<SearchResult> {
  try {
    const res = await fetch(config.webuntis.schoolSearchUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ id: 'pokyh-school-search', method: 'searchSchool', params: [{ search: key }], jsonrpc: '2.0' }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    const json = (await res.json()) as { result?: { schools?: RawSchool[] }; error?: { code?: number } };
    // -6003: "too many results", the query is too general.
    if (json.error) return json.error.code === -6003 ? { ok: false, reason: 'too_many' } : { ok: false, reason: 'unavailable' };
    const schools: SchoolHit[] = [];
    for (const s of json.result?.schools ?? []) {
      const loginName = validLoginName(s.loginName);
      const server = allowedServer(s.server);
      if (!loginName || !server || !schoolAllowed(loginName)) continue;
      schools.push({
        id: Number(s.schoolId) || 0,
        loginName,
        server,
        name: (typeof s.displayName === 'string' && s.displayName.trim()) || loginName,
        address: typeof s.address === 'string' ? s.address.trim() : '',
      });
    }
    return { ok: true, schools: schools.slice(0, 50) };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
