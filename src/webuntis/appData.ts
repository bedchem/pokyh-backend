import { config } from '../config';
import { firstWorkingGet, untisGetText, type UntisSession } from './client';

// What WebUntis tells about the signed-in account itself: its app-data (person,
// guardian's children, permissions, profile picture) and whether it may
// report absences. Whether it is a guardian's and which class it belongs to:
// ./accountClass.ts, ./accountResolver.ts.
//
// The underlying WebUntis endpoints are internal and differ per instance;
// every path can be overridden in the environment (config.webuntis.paths).

const APPDATA_CANDIDATES = [
  config.webuntis.paths.appData,
  '/api/rest/view/v1/app/data',
  '/api/app/data',
  '/api/rest/view/v1/users/me/data',
  '/api/rest/view/v2/app/data',
];

type AppDataResult =
  | { ok: true; json: unknown }
  | { ok: false; expired?: boolean; status: number };

type Json = Record<string, unknown>;

// A nested value of untyped JSON (`at(j, 'data', 'user')`), undefined on the way.
function at(node: unknown, ...path: (string | number)[]): unknown {
  let current: unknown = node;
  for (const key of path) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Json)[key as string];
  }
  return current;
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

// The user object of the app-data, wherever this instance puts it.
const appUser = (json: unknown) => at(json, 'data', 'user') ?? at(json, 'user') ?? at(json, 'data') ?? json;

export function extractPersonName(json: unknown): string | undefined {
  const u = appUser(json);
  const p = at(u, 'person') ?? u;
  const dn = text(at(p, 'displayName')) ?? text(at(u, 'displayName')) ?? text(at(p, 'name'));
  if (dn) return dn;
  const fn = at(p, 'foreName') ?? at(p, 'firstName') ?? at(p, 'firstname');
  const ln = at(p, 'longName') ?? at(p, 'lastName') ?? at(p, 'lastname');
  const full = `${typeof fn === 'string' ? fn : ''} ${typeof ln === 'string' ? ln : ''}`.trim();
  return full || undefined;
}

// The account's login name (`user.name`), where the app-data gives it.
export function extractLoginName(json: unknown): string | undefined {
  const u = appUser(json);
  return text(at(u, 'name')) ?? text(at(u, 'loginName')) ?? text(at(u, 'userName'));
}

// The signed-in person's own id (`user.person.id`), or 0.
export function extractPersonId(json: unknown): number {
  const u = appUser(json);
  const id = Number(at(u, 'person', 'id') ?? at(u, 'personId'));
  return Number.isInteger(id) && id > 0 ? id : 0;
}

// The profile-picture URL in the app-data: for a guardian the child's
// (`user.students[0].imageUrl`), otherwise the person's (`user.person.imageUrl`).
// Most accounts have none; the website then shows initials.
export function extractImageUrl(json: unknown, isParent = false): string | undefined {
  const u = appUser(json);
  const candidates: unknown[] = [];
  if (isParent) candidates.push(at(u, 'students', 0, 'imageUrl'));
  candidates.push(at(u, 'person', 'imageUrl'), at(u, 'imageUrl'), at(json, 'data', 'user', 'person', 'imageUrl'));
  for (const c of candidates) {
    const url = text(c);
    if (url) return url;
  }
  return undefined;
}

// The name shown as the absence's subject: a guardian's child, otherwise the person.
export function extractAbsenceSubjectName(json: unknown): string | undefined {
  const students = at(json, 'data', 'user', 'students') ?? at(json, 'user', 'students') ?? at(json, 'students');
  if (Array.isArray(students)) {
    const name = at(students, 0, 'displayName');
    const n = name == null ? '' : String(name).trim();
    if (n) return n;
  }
  return extractPersonName(json);
}

// A guardian's child's student id from the app-data: the `students`/`children`
// arrays first (the canonical place), then student-like objects elsewhere.
export function extractChildStudentId(json: unknown, excludeId: number): number | null {
  const fromArrays: number[] = [];
  const heuristic: number[] = [];

  function pushId(value: unknown, sink: number[]): void {
    const id = Number(value);
    if (Number.isFinite(id) && id > 0 && id !== excludeId) sink.push(id);
  }

  function walk(node: unknown, depth = 0): void {
    if (depth > 8 || node == null) return;
    if (Array.isArray(node)) {
      for (const v of node) walk(v, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      const o = node as Record<string, unknown>;
      for (const key of ['students', 'children'] as const) {
        const arr = o[key];
        if (Array.isArray(arr)) {
          for (const child of arr) {
            if (child && typeof child === 'object') {
              const c = child as Record<string, unknown>;
              pushId(c.id ?? c.studentId ?? c.personId, fromArrays);
            }
          }
        }
      }
      const hasKlasse = o.klasseId != null || o.klasse != null || o.className != null || o.klasseName != null;
      const typeStr = String(o.type ?? o.role ?? o.personType ?? '').toUpperCase();
      if (hasKlasse || typeStr.includes('STUDENT') || typeStr === '5') {
        pushId(o.id ?? o.personId ?? o.studentId, heuristic);
      }
      for (const v of Object.values(o)) walk(v, depth + 1);
    }
  }
  walk(json);
  if (fromArrays.length) return fromArrays[0];
  return heuristic.length ? heuristic[0] : null;
}

function isObject(json: unknown): boolean {
  return !!json && typeof json === 'object' && !Array.isArray(json) && Object.keys(json as object).length > 0;
}

export async function fetchAppData(session: UntisSession): Promise<AppDataResult> {
  const result = await firstWorkingGet(session, APPDATA_CANDIDATES, isObject);
  if (result.ok) return { ok: true, json: result.json };
  return result.reason === 'expired' ? { ok: false, expired: true, status: 401 } : { ok: false, status: 404 };
}

const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

// WebUntis' own age-aware flag for "may create an absence" (`data.showCreateAbsence`
// in the absences envelope), the one the WebUntis page shows its button by:
// true for guardians and students of legal age, false for minors. The
// permission tokens in the app-data are no stand-in: minors hold them too.
// Null when unreadable.
export async function fetchAbsenceCreateFlag(session: UntisSession): Promise<boolean | null> {
  const d = ymd(new Date());
  const path = `${config.webuntis.paths.absences}?studentId=${session.studentId}&startDate=${d}&endDate=${d}&excuseStatusId=-1`;
  try {
    const r = await untisGetText(session, path, 12_000);
    if (r.status === 401 || r.text.trimStart().startsWith('<') || !r.ok) return null;
    const flag = (JSON.parse(r.text) as { data?: { showCreateAbsence?: unknown } })?.data?.showCreateAbsence;
    return typeof flag === 'boolean' ? flag : null;
  } catch {
    return null;
  }
}

/** The gate before any absence write: only WebUntis' own flag, closed when unreadable. */
export async function canReportAbsence(session: UntisSession): Promise<boolean> {
  if (config.webuntis.forceAbsenceReport) return true;
  return (await fetchAbsenceCreateFlag(session)) === true;
}
