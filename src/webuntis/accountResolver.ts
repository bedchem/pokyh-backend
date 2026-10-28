import { config } from '../config';
import { logger } from '../utils/logger';
import type { ClassEvidence } from '../utils/accountClass';
import { readFetch } from './client';
import { extractChildStudentId, extractImageUrl, extractLoginName, extractPersonId, fetchAppData } from './appData';
import {
  accountKindOf,
  klasseById,
  klasseIdByName,
  lessonClassNames,
  majorityClassName,
  ownClassCandidates,
  pickOwnClass,
  positiveId,
  type AccountKind,
  type ClassSource,
  type WebUntisKlasse,
  type WebUntisStudentClass,
} from './accountClass';
import { schoolBase, schoolCookieValue, type UntisSchool } from './schools';

// Whom a WebUntis sign-in acts for and which class the account belongs to,
// asked of WebUntis with the sign-in's own session. The rules themselves are
// pure (./accountClass.ts); what the account then gets is decided in
// ../utils/accountClass.ts (decideAccountClass).
//
// A student's class, in this order, each time only from the student's own
// record: what `authenticate` answered, their `getStudents` record, their
// app-data record, the classes in a clear majority of their lessons. Every id
// must be one of the school's classes (`getKlassen`). Guardians, teachers
// and every other account have no class. Whatever stays open is "unknown":
// never a guess.

export interface SignInToResolve {
  base: string;
  school: UntisSchool;
  sessionId: string;
  cookie: string;
  username: string;
  /** What `authenticate` answered (0 and no person type when the sign-in went another way). */
  studentId: number;
  klasseId: number;
  personType?: number;
  /** The bearer token being minted for the session ('' when it failed). */
  bearer: Promise<string>;
}

export interface ResolvedAccount {
  kind: AccountKind;
  /** Whom the WebUntis session acts for: the student themselves, or a guardian's child. */
  studentId: number;
  /** The account's own class (only a student has one). */
  evidence: ClassEvidence;
  isParent: boolean;
  /** '' when the app-data shows no picture; undefined when it could not be read. */
  imageUrl?: string;
  /** The login name the app-data shows, lower case; '' when it shows none or could not be read. */
  loginName: string;
}

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// A JSON-RPC list (getKlassen, getStudents): the list, or null when WebUntis
// gave none (refused, no answer). An empty list is an answer.
async function rpcList<T>(base: string, school: UntisSchool, cookie: string, method: string): Promise<T[] | null> {
  try {
    const r = await readFetch(`${base}/jsonrpc.do?school=${encodeURIComponent(school.loginName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ id: `pokyh-${method}`, method, params: {}, jsonrpc: '2.0' }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await r.json()) as { result?: unknown };
    return Array.isArray(json.result) ? (json.result as T[]) : null;
  } catch {
    return null;
  }
}

// The days whose week is sampled, nearest first: this week, then the 15th
// of every school month. At block-teaching schools whole weeks are free, and
// the weeks nearest today say most about the class of today. The school year
// is archived on August 1, so August already samples the coming September
// instead of last year's class.
function timetableSamples(now: Date): Date[] {
  const startYear = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  const months: Date[] = [];
  for (const m of [9, 10, 11, 12]) months.push(new Date(startYear, m - 1, 15));
  for (const m of [1, 2, 3, 4, 5, 6]) months.push(new Date(startYear + 1, m - 1, 15));
  months.sort((a, b) => Math.abs(a.getTime() - now.getTime()) - Math.abs(b.getTime() - now.getTime()));
  return [now, ...months];
}

/**
 * The student's class from their own timetable: the class in a clear
 * majority of their lessons (majorityClassName), read week by week, nearest
 * first, until the lessons so far are conclusive. Null when they never are.
 */
async function classFromTimetable(base: string, headers: Record<string, string>, studentId: number, klassen: readonly WebUntisKlasse[]): Promise<{ id: number; name: string } | null> {
  if (studentId <= 0 || klassen.length === 0) return null;

  const lessonsOf = async (day: Date): Promise<string[][]> => {
    const start = isoDay(day);
    const end = isoDay(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 5));
    const url = `${base}/api/rest/view/v1/timetable/entries?start=${start}&end=${end}&format=1&resourceType=STUDENT&resources=${studentId}&periodTypes=&timetableType=MY_TIMETABLE&layout=START_TIME`;
    try {
      const r = await readFetch(url, { headers, signal: AbortSignal.timeout(8_000) });
      if (!r.ok) return [];
      const text = await r.text();
      if (text.trimStart().startsWith('<')) return [];
      return lessonClassNames(JSON.parse(text));
    } catch {
      return [];
    }
  };

  const decide = (lessons: string[][]) => {
    const name = majorityClassName(lessons);
    const id = name ? klasseIdByName(klassen, name) : 0;
    return id > 0 ? klasseById(klassen, id) : null;
  };

  // This week alone first; the weeks across the year then all at once, read
  // nearest first.
  const [current, ...rest] = timetableSamples(new Date());
  const lessons = await lessonsOf(current);
  const fromThisWeek = decide(lessons);
  if (fromThisWeek) return fromThisWeek;
  for (const pending of rest.map(lessonsOf)) {
    lessons.push(...(await pending));
    const found = decide(lessons);
    if (found) return found;
  }
  return null;
}

/** The signed-in student's own class (ownClassCandidates, pickOwnClass), else from their timetable. */
async function ownClass(
  signIn: SignInToResolve,
  personId: number,
  students: readonly WebUntisStudentClass[],
  appJson: unknown,
  klassen: readonly WebUntisKlasse[] | null,
  headers: () => Promise<Record<string, string>>,
): Promise<{ evidence: ClassEvidence; source?: ClassSource; rejected: ClassSource[] }> {
  if (personId <= 0) return { evidence: { kind: 'unknown' }, rejected: [] };
  const candidates = ownClassCandidates(personId, { personId: signIn.studentId, klasseId: signIn.klasseId }, students, appJson);
  const { picked, rejected } = pickOwnClass(candidates, klassen);
  if (picked) return { evidence: { kind: 'class', klasseId: picked.id, klasseName: picked.name }, source: picked.source, rejected };

  // The timetable names classes only, so it needs the school's class list.
  if (klassen && klassen.length > 0) {
    const fromTimetable = await classFromTimetable(signIn.base, await headers(), personId, klassen);
    if (fromTimetable) return { evidence: { kind: 'class', klasseId: fromTimetable.id, klasseName: fromTimetable.name }, source: 'timetable', rejected };
  }
  return { evidence: { kind: 'unknown' }, rejected };
}

/**
 * Whom a new sign-in acts for, what it is, and the account's class. The
 * app-data is read where the WebUntis session is freshest (also the most
 * reliable moment for the profile-picture URL), capped so a slow answer never
 * stalls the sign-in; without it a student cannot be told from a parent's
 * login on the child's record, and the class stays open.
 */
export async function resolveAccount(signIn: SignInToResolve): Promise<ResolvedAccount> {
  const { base, school, sessionId, cookie, username, personType } = signIn;

  const [bearer, klassen, studentList, appData] = await Promise.all([
    signIn.bearer,
    rpcList<WebUntisKlasse>(base, school, cookie, 'getKlassen'),
    rpcList<WebUntisStudentClass>(base, school, cookie, 'getStudents'),
    signIn.bearer.then((bearerToken) => Promise.race([
      fetchAppData({ sessionId, school, bearerToken, studentId: signIn.studentId, klasseId: signIn.klasseId, klasseName: '', username })
        .catch(() => ({ ok: false as const, status: 0 })),
      new Promise<{ ok: false; status: number }>((resolve) => setTimeout(() => resolve({ ok: false, status: 0 }), 5_000)),
    ])),
  ]);
  const students = studentList ?? [];
  const appJson = appData.ok ? appData.json : null;
  const headers = async (): Promise<Record<string, string>> => ({ Cookie: cookie, Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) });

  // The person the sign-in answered with; when it named nobody (the sign-in
  // form, an app key, a session taken over), the app-data's.
  const personId = signIn.studentId > 0 ? signIn.studentId : appJson ? extractPersonId(appJson) : 0;
  const kind = accountKindOf(personType, appJson, config.webuntis.parentRoles);

  let studentId = personId;
  let evidence: ClassEvidence;
  let source: ClassSource | undefined;
  let rejected: ClassSource[] = [];
  if (kind === 'student') {
    ({ evidence, source, rejected } = await ownClass(signIn, personId, students, appJson, klassen, headers));
  } else if (kind === 'parent') {
    // The child the guardian's session acts for: the app-data's students,
    // or the one record `getStudents` lists besides the guardian. Never
    // somebody picked from a longer list.
    const others = students.filter((entry) => positiveId(entry.id) > 0 && positiveId(entry.id) !== personId);
    const childId = (appJson ? extractChildStudentId(appJson, personId) : null) ?? (others.length === 1 ? positiveId(others[0].id) : 0);
    if (childId > 0) studentId = childId;
    evidence = { kind: 'none' };
  } else if (kind === 'other') {
    evidence = { kind: 'none' };
  } else {
    evidence = { kind: 'unknown' };
  }

  // Diagnostic without personal data: what the sign-in is and where its class came from.
  logger.info('[webuntis login] resolved', {
    school: school.loginName, personType, kind, studentsLen: students.length, klassen: klassen === null ? 'unread' : klassen.length,
    appData: appJson !== null, hasStudent: studentId > 0, classEvidence: evidence.kind, classSource: source ?? null,
    ...(rejected.length ? { rejectedSources: rejected } : {}),
  });

  const isParent = kind === 'parent';
  return {
    kind,
    studentId,
    evidence,
    isParent,
    imageUrl: appJson ? (extractImageUrl(appJson, isParent) ?? '') : undefined,
    loginName: appJson ? (extractLoginName(appJson) ?? '').toLowerCase() : '',
  };
}

/** A bearer token for a WebUntis session ('' when WebUntis gives none). */
export function mintBearer(base: string, cookie: string): Promise<string> {
  return readFetch(`${base}/api/token/new`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(10_000) })
    .then((r) => r.text())
    .then((tok) => ((tok.match(/\./g) ?? []).length === 2 ? tok.trim() : ''))
    .catch(() => '');
}

/**
 * The same for a WebUntis session signed in elsewhere (the POKYH app's): only
 * the session is known, so the app-data names the person. Its class only
 * counts for `username` when the app-data shows that login (or none, as with
 * a session taken over by the QR sign-in).
 */
export async function resolveSession(school: UntisSchool, sessionId: string, username: string): Promise<ResolvedAccount> {
  const base = schoolBase(school);
  const cookie = `JSESSIONID=${sessionId}; schoolname="${schoolCookieValue(school)}"`;
  const resolved = await resolveAccount({ base, school, sessionId, cookie, username, studentId: 0, klasseId: 0, bearer: mintBearer(base, cookie) });
  if (resolved.loginName && resolved.loginName !== username.toLowerCase()) {
    logger.warn('[webuntis login] session belongs to another account', { school: school.loginName });
    return { ...resolved, kind: 'unknown', evidence: { kind: 'unknown' }, isParent: false };
  }
  return resolved;
}
