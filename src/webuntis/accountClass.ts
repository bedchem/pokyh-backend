// Which class a WebUntis sign-in belongs to, and whether it is a guardian's.
// Pure functions (no configuration, no I/O), tested on their own
// (tests/webuntisAccountClass.test.mjs). The lookups that feed them:
// ./accountResolver.ts.
//
// A class is only ever taken from what WebUntis says about the signed-in
// student themselves. Nothing is borrowed from another record, and an answer
// that leaves the class open leaves the account without one.

export interface WebUntisStudentClass {
  id?: unknown;
  klasseId?: unknown;
  classId?: unknown;
  klasse?: unknown;
  class?: unknown;
}

/** A class as `getKlassen` lists it. */
export interface WebUntisKlasse {
  id?: unknown;
  name?: unknown;
  longName?: unknown;
}

export const DEFAULT_PARENT_ROLE_TAGS = [
  'PARENT',
  'GUARDIAN',
  'LEGAL_GUARDIAN',
  'LEGALGUARDIAN',
  'ERZIEHUNGSBERECHTIGT',
  'ELTERNACCOUNT',
  'PARENT_ROLE',
  'PERSONTYPE_PARENT',
] as const;

/** The role names the app-data gives a student (`user.roles`), normalised. */
const STUDENT_ROLE_TAGS = new Set(['STUDENT', 'PUPIL', 'SCHUELER', 'SCHULER']);

/** WebUntis' person types, as `authenticate` answers them (`personType`). */
export const PERSON_TYPE = { TEACHER: 2, STUDENT: 5, PARENT: 12 } as const;

/**
 * What a sign-in is. Only a student has a class of their own; "unknown" is a
 * sign-in WebUntis did not say enough about this time.
 */
export type AccountKind = 'student' | 'parent' | 'other' | 'unknown';

function normalizedTag(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9]/gi, '')
    .toUpperCase();
}

function collectStrings(node: unknown, out: string[], depth = 0): void {
  if (depth > 8 || node == null) return;
  if (typeof node === 'string') {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const value of node) collectStrings(value, out, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) collectStrings(value, out, depth + 1);
  }
}

/** Whether the app-data carries a guardian marker (built-in ones plus `additionalRoleTags`). */
export function containsParentRoleTag(json: unknown, additionalRoleTags: readonly string[] = []): boolean {
  const markers = new Set([...DEFAULT_PARENT_ROLE_TAGS, ...additionalRoleTags].map(normalizedTag).filter(Boolean));
  const values: string[] = [];
  collectStrings(json, values);
  return values.some((value) => markers.has(normalizedTag(value)));
}

export function positiveId(value: unknown): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function child(node: unknown, key: string): unknown {
  return node && typeof node === 'object' && !Array.isArray(node) ? (node as Record<string, unknown>)[key] : undefined;
}

// The app-data's role list (`user.roles`: names, or objects with a name),
// normalised; empty when it has none.
function roleNames(json: unknown): string[] {
  const holders = [child(child(json, 'data'), 'user'), child(json, 'user'), child(json, 'data'), json];
  for (const holder of holders) {
    const roles = child(holder, 'roles');
    if (!Array.isArray(roles)) continue;
    return roles
      .map((role) => {
        if (typeof role === 'string') return role;
        const named = child(role, 'name') ?? child(role, 'role') ?? child(role, 'type');
        return typeof named === 'string' ? named : '';
      })
      .map(normalizedTag)
      .filter(Boolean);
  }
  return [];
}

/**
 * What the sign-in is, from `authenticate`'s person type and the app-data
 * (`appData` null when it could not be read).
 *
 * A guardian marker anywhere in the app-data makes a guardian, whatever the
 * person type says: some schools hand parents a login on their child's
 * student record, tagged "Elternaccount", which `authenticate` reports as a
 * student. For the same reason a student is only a student once the app-data
 * was read and shows no such marker.
 */
export function accountKindOf(personType: unknown, appData: unknown, additionalParentTags: readonly string[] = []): AccountKind {
  const type = positiveId(personType);
  if (type === PERSON_TYPE.PARENT) return 'parent';
  if (appData != null && containsParentRoleTag(appData, additionalParentTags)) return 'parent';
  if (type > 0 && type !== PERSON_TYPE.STUDENT) return 'other';
  if (appData == null) return 'unknown';
  if (type === PERSON_TYPE.STUDENT) return 'student';
  // No person type (the sign-in form, a session taken over): the roles.
  const roles = roleNames(appData);
  if (roles.some((role) => STUDENT_ROLE_TAGS.has(role))) return 'student';
  return roles.length > 0 ? 'other' : 'unknown';
}

export function studentClassId(student: WebUntisStudentClass | undefined): number {
  if (!student) return 0;
  const klasse = student.klasse && typeof student.klasse === 'object' ? (student.klasse as { id?: unknown }).id : student.klasse;
  const nestedClass = student.class && typeof student.class === 'object' ? (student.class as { id?: unknown }).id : student.class;
  return positiveId(student.klasseId) || positiveId(student.classId) || positiveId(klasse) || positiveId(nestedClass);
}

/** Where a student's class was found (./accountResolver.ts). */
export type ClassSource = 'authenticate' | 'students' | 'app-data' | 'timetable';

/**
 * The ids WebUntis gives for the signed-in student's own class, most
 * authoritative first: what `authenticate` answered (for the person it signed
 * in, and only them), their own `getStudents` record, their own app-data
 * record. Never another student's: `authenticate` occasionally returns
 * klasseId=0, and a list holds everybody's classes.
 */
export function ownClassCandidates(
  personId: unknown,
  authenticated: { personId: unknown; klasseId: unknown },
  students: readonly WebUntisStudentClass[],
  appData: unknown,
): Array<{ source: ClassSource; id: number }> {
  const person = positiveId(personId);
  if (person === 0) return [];
  return [
    { source: 'authenticate' as const, id: positiveId(authenticated.personId) === person ? positiveId(authenticated.klasseId) : 0 },
    { source: 'students' as const, id: studentClassId(students.find((student) => positiveId(student.id) === person)) },
    { source: 'app-data' as const, id: appData != null ? findStudentClassIdInData(appData, person) : 0 },
  ].filter((candidate) => candidate.id > 0);
}

/**
 * The first candidate that is one of the school's classes, named as
 * `getKlassen` names it; an id that is none of them is no class (`rejected`).
 * `klassen` null: the list could not be read, and the first id WebUntis gave
 * stands, unnamed.
 */
export function pickOwnClass(
  candidates: ReadonlyArray<{ source: ClassSource; id: number }>,
  klassen: readonly WebUntisKlasse[] | null,
): { picked: { id: number; name: string; source: ClassSource } | null; rejected: ClassSource[] } {
  const rejected: ClassSource[] = [];
  for (const { source, id } of candidates) {
    if (klassen === null) return { picked: { id, name: '', source }, rejected };
    const klasse = klasseById(klassen, id);
    if (klasse) return { picked: { ...klasse, source }, rejected };
    rejected.push(source);
  }
  return { picked: null, rejected };
}

// Where the app-data keeps people: the user, their person record, a
// guardian's students. Lessons, permissions and the like are never searched:
// WebUntis numbers every kind of element on its own, so a lesson or a room
// can carry the very id the person has.
const PERSON_KEYS = new Set(['data', 'user', 'person', 'student', 'students', 'children']);

/** Class data on the person's own record in the app-data (`user.person`, `user.students[]`), or 0. */
export function findStudentClassIdInData(json: unknown, personId: unknown): number {
  const targetId = positiveId(personId);
  if (targetId === 0) return 0;
  let found = 0;
  function walk(node: unknown, depth: number): void {
    if (found > 0 || depth > 6 || node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const value of node) walk(value, depth + 1);
      return;
    }
    const value = node as Record<string, unknown>;
    const ids = [value.id, value.personId, value.studentId].map(positiveId);
    if (ids.includes(targetId)) {
      found = studentClassId(value);
      if (found > 0) return;
    }
    for (const [key, next] of Object.entries(value)) {
      if (PERSON_KEYS.has(key)) walk(next, depth + 1);
    }
  }
  walk(json, 0);
  return found;
}

const classKey = (name: string) => name.trim().toLowerCase();

/**
 * The classes each lesson of a REST timetable lists
 * (days[].gridEntries[].position1..7[].current, type CLASS), by short name.
 */
export function lessonClassNames(json: unknown): string[][] {
  const days = child(json, 'days');
  if (!Array.isArray(days)) return [];
  const lessons: string[][] = [];
  for (const day of days) {
    const entries = child(day, 'gridEntries');
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const names = new Map<string, string>();
      for (let position = 1; position <= 7; position++) {
        const items = child(entry, `position${position}`);
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          const current = child(item, 'current');
          if (child(current, 'type') !== 'CLASS') continue;
          const shortName = child(current, 'shortName');
          const displayName = child(current, 'displayName');
          const name = typeof shortName === 'string' && shortName.trim() ? shortName : typeof displayName === 'string' ? displayName : '';
          if (name.trim()) names.set(classKey(name), name.trim());
        }
      }
      if (names.size > 0) lessons.push([...names.values()]);
    }
  }
  return lessons;
}

/** Below this many lessons with a class a timetable says nothing about the class. */
export const MIN_TIMETABLE_LESSONS = 2;

/**
 * The student's class from the classes their lessons list: the one class in
 * more than half of them, ahead of every other. A lesson shared with other
 * classes (sports, religion, electives) lists those too, so the first class
 * met is no answer. A timetable where two classes always come together, or
 * one with too few lessons, gives none (null).
 */
export function majorityClassName(lessons: readonly (readonly string[])[]): string | null {
  const counted = lessons.filter((names) => names.length > 0);
  if (counted.length < MIN_TIMETABLE_LESSONS) return null;
  const tally = new Map<string, { name: string; count: number }>();
  for (const names of counted) {
    const seen = new Set<string>();
    for (const name of names) {
      const key = classKey(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const entry = tally.get(key) ?? { name: name.trim(), count: 0 };
      entry.count += 1;
      tally.set(key, entry);
    }
  }
  const [first, second] = [...tally.values()].sort((a, b) => b.count - a.count);
  if (!first || first.count * 2 <= counted.length) return null;
  if (second && second.count === first.count) return null;
  return first.name;
}

/** The id of the one class `getKlassen` lists under this name (short name first, then long name); 0 when none or several. */
export function klasseIdByName(klassen: readonly WebUntisKlasse[], name: string): number {
  const key = classKey(name);
  if (!key) return 0;
  for (const field of ['name', 'longName'] as const) {
    const ids = new Set(
      klassen
        .filter((k) => typeof k[field] === 'string' && classKey(k[field] as string) === key)
        .map((k) => positiveId(k.id))
        .filter((id) => id > 0),
    );
    if (ids.size === 1) return [...ids][0];
    if (ids.size > 1) return 0;
  }
  return 0;
}

/** The class `getKlassen` lists under this id (with its short name), or null. */
export function klasseById(klassen: readonly WebUntisKlasse[], id: number): { id: number; name: string } | null {
  if (id <= 0) return null;
  const found = klassen.find((k) => positiveId(k.id) === id);
  if (!found) return null;
  const name = typeof found.name === 'string' && found.name.trim() ? found.name.trim() : typeof found.longName === 'string' ? found.longName.trim() : '';
  return { id, name };
}

/** A guardian's account has and stores no class; a class without an id has no name either. */
export function accountClassForRole(isParent: boolean, klasseId: number, klasseName: string): { klasseId: number; klasseName: string } {
  const id = isParent ? 0 : positiveId(klasseId);
  return { klasseId: id, klasseName: id > 0 ? klasseName.trim() : '' };
}
