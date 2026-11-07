import { config } from '../config';
import { logger } from '../utils/logger';
import type { ClassEvidence, ClassNote } from '../utils/accountClass';
import { readFetch } from './client';
import { extractChildStudentId, extractImageUrl, extractLoginName, extractPersonId, fetchAppData } from './appData';
import {
  accountKindOf,
  classDirectory,
  klasseById,
  klasseIdByName,
  lessonClassNames,
  majorityClassId,
  majorityClassName,
  ownClassCandidates,
  PERSON_TYPE,
  pickOwnClass,
  positiveId,
  weeklyClassElements,
  weeklyLessonClassIds,
  type AccountKind,
  type ClassSource,
  type WebUntisKlasse,
  type WebUntisStudentClass,
} from './accountClass';
import { readTimetableFilter } from './timetableFilter';
import { schoolBase, schoolCookieValue, type UntisSchool } from './schools';

// Whom a WebUntis sign-in acts for and which class the account belongs to,
// asked of WebUntis with the sign-in's own session. The rules themselves are
// pure (./accountClass.ts); what the account then gets is decided in
// ../utils/accountClass.ts (decideAccountClass, decideAccountRole).
//
// A student's class, in this order, each time only from the student's own
// record: what `authenticate` answered, WebUntis' own timetable set-up for
// them (pageconfig), their `getStudents` record, their app-data record, the
// class in a clear majority of their lessons (by id from the weekly
// timetable, else by name from the REST timetable), and last the one class
// the school's timetable picker offers them. Every id must be one of the
// school's classes when `getKlassen` can be read. Guardians, teachers and
// every other account have no class. Whatever stays open is "unknown":
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

/** What a verified session already fetched (webuntis/sessionIdentity.ts): not asked for twice. */
export interface Prefetched {
  appData: unknown;
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
  /**
   * The pupil's record the sign-in is on (a pupil's own, or a parent's login
   * on the child's), for spotting two accounts on one record; 0 for every
   * other sign-in (WebUntis numbers each kind of person on its own).
   */
  studentRecordId: number;
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

// A GET answered with JSON, or null (refused, HTML login page, no answer).
async function getJson(url: string, headers: Record<string, string>, timeoutMs = 8_000): Promise<unknown> {
  try {
    const r = await readFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const text = await r.text();
    if (!text || text.trimStart().startsWith('<')) return null;
    return JSON.parse(text) as unknown;
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
 * Reads the samples' weeks (this week first, then the rest at once, nearest
 * first) until `decide` finds the answer in the lessons collected so far.
 */
async function sampleWeeks<L, R>(read: (day: Date) => Promise<L[]>, decide: (lessons: L[]) => R | null): Promise<R | null> {
  const [current, ...rest] = timetableSamples(new Date());
  const lessons = await read(current);
  const fromThisWeek = decide(lessons);
  if (fromThisWeek) return fromThisWeek;
  for (const pending of rest.map(read)) {
    lessons.push(...(await pending));
    const found = decide(lessons);
    if (found) return found;
  }
  return null;
}

/**
 * The pupil's class from their weekly timetable (`public/timetable/weekly/
 * data`): the class id in a clear majority of their lessons. The answer
 * names its classes too, so no list is needed for the name; with
 * `getKlassen` read, the id must be one of its classes.
 */
async function classFromWeeklyTimetable(
  base: string,
  cookie: string,
  personId: number,
  klassen: readonly WebUntisKlasse[] | null,
  seen: WebUntisKlasse[],
): Promise<{ id: number; name: string } | null> {
  const read = async (day: Date): Promise<number[][]> => {
    const json = await getJson(
      `${base}/api/public/timetable/weekly/data?elementType=${PERSON_TYPE.STUDENT}&elementId=${personId}&date=${isoDay(day)}&formatId=1`,
      { Cookie: cookie, Accept: 'application/json' },
    );
    if (json === null) return [];
    seen.push(...weeklyClassElements(json));
    return weeklyLessonClassIds(json, personId);
  };
  return sampleWeeks(read, (lessons) => {
    const id = majorityClassId(lessons);
    if (id === 0) return null;
    if (klassen !== null) return klasseById(klassen, id);
    return { id, name: klasseById(seen, id)?.name ?? '' };
  });
}

/**
 * The student's class from their REST timetable: the class in a clear
 * majority of their lessons (majorityClassName), by name, mapped to an id
 * through the classes known (`directory`).
 */
async function classFromTimetable(base: string, headers: Record<string, string>, studentId: number, directory: readonly WebUntisKlasse[]): Promise<{ id: number; name: string } | null> {
  if (studentId <= 0 || directory.length === 0) return null;
  const read = async (day: Date): Promise<string[][]> => {
    const start = isoDay(day);
    const end = isoDay(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 5));
    const json = await getJson(
      `${base}/api/rest/view/v1/timetable/entries?start=${start}&end=${end}&format=1&resourceType=STUDENT&resources=${studentId}&periodTypes=&timetableType=MY_TIMETABLE&layout=START_TIME`,
      headers,
    );
    return json === null ? [] : lessonClassNames(json);
  };
  return sampleWeeks(read, (lessons) => {
    const name = majorityClassName(lessons);
    const id = name ? klasseIdByName(directory, name) : 0;
    return id > 0 ? klasseById(directory, id) : null;
  });
}

interface ClassLookup {
  evidence: ClassEvidence;
  source?: ClassSource;
  rejected: ClassSource[];
}

/** The signed-in student's own class, from the sources above in their order. */
async function ownClass(
  signIn: SignInToResolve,
  personId: number,
  students: readonly WebUntisStudentClass[],
  appJson: unknown,
  klassen: readonly WebUntisKlasse[] | null,
  pageConfig: unknown,
  pickerClasses: () => Promise<WebUntisKlasse[] | null>,
  headers: () => Promise<Record<string, string>>,
): Promise<ClassLookup> {
  if (personId <= 0) return { evidence: { kind: 'unknown', note: 'no_class_found' }, rejected: [] };
  const found = (picked: { id: number; name: string }, source: ClassSource, rejected: ClassSource[]): ClassLookup => ({
    evidence: { kind: 'class', klasseId: picked.id, klasseName: picked.name, source }, source, rejected,
  });

  const candidates = ownClassCandidates(personId, { personId: signIn.studentId, klasseId: signIn.klasseId }, students, appJson, pageConfig);
  // The picker's classes only name a class when `getKlassen` was unread.
  const { picked, rejected } = pickOwnClass(candidates, klassen, klassen === null && candidates.length > 0 ? (await pickerClasses()) ?? [] : []);
  if (picked) return found(picked, picked.source, rejected);
  const picker = await pickerClasses();

  const weeklySeen: WebUntisKlasse[] = [];
  const fromWeekly = await classFromWeeklyTimetable(signIn.base, signIn.cookie, personId, klassen, weeklySeen);
  if (fromWeekly) return found(fromWeekly, 'weekly-data', rejected);

  const directory = classDirectory(klassen, picker, weeklySeen.length ? weeklySeen : null) ?? [];
  const fromTimetable = await classFromTimetable(signIn.base, await headers(), personId, directory);
  if (fromTimetable) return found(fromTimetable, 'timetable', rejected);

  // Last: a school that lets its pupils see just one class's timetable
  // offers them their own.
  if (picker && picker.length === 1) {
    const only = klassen !== null ? klasseById(klassen, positiveId(picker[0].id)) : { id: positiveId(picker[0].id), name: String(picker[0].name ?? '') };
    if (only && only.id > 0) return found(only, 'filter-single', rejected);
  }
  const note: ClassNote = rejected.length > 0 ? 'candidate_rejected' : 'no_class_found';
  return { evidence: { kind: 'unknown', note }, rejected };
}

/**
 * Whom a new sign-in acts for, what it is, and the account's class. The
 * app-data is read where the WebUntis session is freshest (also the most
 * reliable moment for the profile-picture URL), capped so a slow answer never
 * stalls the sign-in; without it a student cannot be told from a parent's
 * login on the child's record, and the class stays open.
 */
export async function resolveAccount(signIn: SignInToResolve, prefetched?: Prefetched): Promise<ResolvedAccount> {
  const { base, school, sessionId, cookie, username, personType } = signIn;
  const today = isoDay(new Date());

  const appDataRequest: Promise<{ ok: true; json: unknown } | { ok: false; status: number }> = prefetched
    ? Promise.resolve(prefetched.appData != null ? { ok: true as const, json: prefetched.appData } : { ok: false as const, status: 0 })
    : signIn.bearer.then((bearerToken) => {
      let timer: NodeJS.Timeout | undefined;
      return Promise.race([
        fetchAppData({ sessionId, school, bearerToken, studentId: signIn.studentId, klasseId: signIn.klasseId, klasseName: '', username })
          .catch(() => ({ ok: false as const, status: 0 })),
        new Promise<{ ok: false; status: number }>((resolve) => { timer = setTimeout(() => resolve({ ok: false, status: 0 }), 8_000); }),
      ]).finally(() => clearTimeout(timer));
    });
  const [bearer, klassen, studentList, appData, pageConfig] = await Promise.all([
    signIn.bearer,
    rpcList<WebUntisKlasse>(base, school, cookie, 'getKlassen'),
    rpcList<WebUntisStudentClass>(base, school, cookie, 'getStudents'),
    appDataRequest,
    getJson(`${base}/api/public/timetable/weekly/pageconfig?type=${PERSON_TYPE.STUDENT}&date=${today}`, { Cookie: cookie, Accept: 'application/json' }),
  ]);
  const students = studentList ?? [];
  const appJson = appData.ok ? appData.json : null;
  const headers = async (): Promise<Record<string, string>> => ({ Cookie: cookie, Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) });

  // The person the sign-in answered with; when it named nobody (the sign-in
  // form, an app key, a session taken over), the app-data's.
  const personId = signIn.studentId > 0 ? signIn.studentId : appJson ? extractPersonId(appJson) : 0;
  const kind = accountKindOf(personType, appJson, config.webuntis.parentRoles, personId);
  const onStudentRecord = positiveId(personType) === PERSON_TYPE.STUDENT || (!personType && kind === 'student');

  // The classes WebUntis' timetable picker offers (read only when needed).
  let picker: Promise<WebUntisKlasse[] | null> | null = null;
  const pickerClasses = () => picker ??= (async () => {
    const monday = new Date();
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const end = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 5);
    const json = await getJson(
      `${base}/api/rest/view/v1/timetable/filter?resourceType=CLASS&timetableType=STANDARD&start=${isoDay(monday)}&end=${isoDay(end)}`,
      await headers(),
    );
    return json === null ? null : readTimetableFilter(json).map((c) => ({ id: c.id, name: c.name, longName: c.longName }));
  })();

  let studentId = personId;
  let evidence: ClassEvidence;
  let source: ClassSource | undefined;
  let rejected: ClassSource[] = [];
  if (kind === 'student') {
    ({ evidence, source, rejected } = await ownClass(signIn, personId, students, appJson, klassen, pageConfig, pickerClasses, headers));
  } else if (kind === 'parent') {
    // The child the guardian's session acts for: the app-data's students,
    // or the one record `getStudents` lists besides the guardian. Never
    // somebody picked from a longer list.
    const others = students.filter((entry) => positiveId(entry.id) > 0 && positiveId(entry.id) !== personId);
    const childId = (appJson ? extractChildStudentId(appJson, personId) : null) ?? (others.length === 1 ? positiveId(others[0].id) : 0);
    if (childId > 0) studentId = childId;
    evidence = { kind: 'none', note: 'role_parent' };
  } else if (kind === 'other') {
    evidence = { kind: 'none', note: 'not_student' };
  } else {
    const unreachable = !bearer && klassen === null && studentList === null && appJson === null;
    evidence = { kind: 'unknown', note: unreachable ? 'webuntis_unavailable' : 'appdata_unreadable' };
  }

  // Diagnostic without personal data: what the sign-in is and where its class came from.
  logger.info('[webuntis login] resolved', {
    school: school.loginName, personType, kind, studentsLen: students.length, klassen: klassen === null ? 'unread' : klassen.length,
    appData: appJson !== null, pageConfig: pageConfig !== null, hasStudent: studentId > 0, classEvidence: evidence.kind,
    classSource: source ?? null, classNote: evidence.kind === 'class' ? null : evidence.note,
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
    studentRecordId: onStudentRecord && personId > 0 ? personId : 0,
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
 * The same for a WebUntis session signed in elsewhere (the POKYH app's),
 * whose owner webuntis/sessionIdentity.ts verifySessionIdentity has already
 * proven: its bearer token and app-data are used as they are.
 */
export async function resolveVerifiedSession(
  school: UntisSchool,
  sessionId: string,
  username: string,
  verified: { bearer: string; appData: unknown },
): Promise<ResolvedAccount> {
  const base = schoolBase(school);
  const cookie = `JSESSIONID=${sessionId}; schoolname="${schoolCookieValue(school)}"`;
  return resolveAccount(
    { base, school, sessionId, cookie, username, studentId: 0, klasseId: 0, bearer: Promise.resolve(verified.bearer) },
    { appData: verified.appData },
  );
}
