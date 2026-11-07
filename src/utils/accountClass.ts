import type { AccountKind } from '../webuntis/accountClass';

// "none" is an account that is neither a student nor a parent — for example
// an administrator who is not part of a class. Only an admin sets it, and a
// WebUntis login keeps it (WebUntis itself only knows students and parents).
export type AccountRole = 'student' | 'parent' | 'none';

export interface AccountClassIdentity {
  klasseId: number;
  klasseName: string;
}

/**
 * The version of the rules that find a WebUntis account's class. Raising it
 * has every WebUntis account's class checked again once: until a sign-in
 * confirms a class under the new rules, the account has none
 * (services/classCheck.ts, routes/auth.ts completeWebUntisLogin).
 *
 * 2: admin role choices stick, guardians are told by their children, a class
 * comes from more of the pupil's own WebUntis records (docs/class-assignment.md).
 */
export const CLASS_CHECK_VERSION = 2;

/** Where a student's class was found (webuntis/accountResolver.ts); "kept": confirmed before, WebUntis did not tell this time. */
export type ClassSource = 'authenticate' | 'students' | 'app-data' | 'pageconfig' | 'weekly-data' | 'timetable' | 'filter-single' | 'kept';

/** Why an account has no class (shown in the admin panel). */
export type ClassNote =
  /** A parent's account: never in a class. */
  | 'role_parent'
  /** An account without a role (set by an admin). */
  | 'role_none'
  /** WebUntis says it is no pupil (a teacher, staff, …). */
  | 'not_student'
  /** The app-data could not be read, so a pupil could not be told from a parent's login. */
  | 'appdata_unreadable'
  /** A pupil, but none of their WebUntis records names a class. */
  | 'no_class_found'
  /** A class was named, but it is none of the school's classes. */
  | 'candidate_rejected'
  /** WebUntis did not answer. */
  | 'webuntis_unavailable'
  /** Another account of the school signs in on the same pupil's record: one of them is a parent's login; an admin decides. */
  | 'shared_person'
  /** WebUntis calls a parent's account a pupil (a login on the child's record): it stays a parent. */
  | 'student_record_on_parent'
  /** The sign-in brought no WebUntis session to ask with. */
  | 'no_session';

/** What WebUntis said about an account's class at a sign-in. */
export type ClassEvidence =
  /** WebUntis named the signed-in student's own class. */
  | { kind: 'class'; klasseId: number; klasseName: string; source: Exclude<ClassSource, 'kept'> }
  /** WebUntis made clear the account has no class (a guardian, a teacher, …). */
  | { kind: 'none'; note: ClassNote }
  /** WebUntis did not tell this time (no answer, nothing conclusive). */
  | { kind: 'unknown'; note: ClassNote };

/** The class an account has stored, and the rules version that confirmed it. */
export interface StoredAccountClass extends AccountClassIdentity {
  checkVersion: number;
}

export interface AccountClassDecision extends AccountClassIdentity {
  /** The rules version that confirmed this class (or that the account has none). */
  checkVersion: number;
  /** Whether WebUntis confirmed it at this sign-in. */
  confirmed: boolean;
  /** Where the class came from; null without one. */
  classSource: ClassSource | null;
  /** Why there is none; null with one. */
  classNote: ClassNote | null;
}

/** The stored role as one of the known roles; anything unknown counts as a student, as before. */
export function parseAccountRole(role: unknown): AccountRole {
  return role === 'parent' || role === 'none' ? role : 'student';
}

/** Whether accounts with this role belong to a Pokyh class (only students do). */
export function hasClassIdentity(role: string): boolean {
  return role !== 'parent' && role !== 'none';
}

/**
 * Parent and role-less accounts are identities of their own, not members of a
 * Pokyh class. Keep this normalization at the backend trust boundary so even a
 * caller that accidentally submits a child's WebUntis class cannot assign it
 * to such an account. A class without an id has no name either.
 */
export function normalizeAccountClass(
  role: AccountRole,
  klasseId: number,
  klasseName: string,
): AccountClassIdentity {
  if (!hasClassIdentity(role) || !Number.isInteger(klasseId) || klasseId <= 0) {
    return { klasseId: 0, klasseName: '' };
  }

  return { klasseId, klasseName: klasseName.trim() };
}

/**
 * The class a WebUntis account gets at a sign-in:
 *
 * - a parent or role-less account, or a sign-in WebUntis says has no class:
 *   none;
 * - an account sharing its pupil's record with an older account of the
 *   school (`sharedPerson`): none, until an admin says which one is the pupil;
 * - a class WebUntis named for the signed-in student: that one;
 * - WebUntis did not tell: the class it confirmed under the current rules
 *   before stays (a WebUntis hiccup must not drop a student from their
 *   class); any other stored class goes. When WebUntis answered and names
 *   no class, the account is checked and has none; when it did not answer,
 *   the account waits unassigned for a sign-in that confirms one.
 */
export function decideAccountClass(
  role: AccountRole,
  evidence: ClassEvidence,
  stored: StoredAccountClass | null,
  opts: { sharedPerson?: boolean } = {},
): AccountClassDecision {
  const none = (classNote: ClassNote, confirmed = true, checkVersion = CLASS_CHECK_VERSION): AccountClassDecision => ({
    klasseId: 0, klasseName: '', checkVersion, confirmed, classSource: null, classNote,
  });
  if (role === 'parent') return none('role_parent');
  if (role === 'none') return none('role_none');
  if (evidence.kind === 'none') return none(evidence.note);
  if (opts.sharedPerson) return none('shared_person');
  if (evidence.kind === 'class') {
    const named = normalizeAccountClass(role, evidence.klasseId, evidence.klasseName);
    if (named.klasseId > 0) {
      return { ...named, checkVersion: CLASS_CHECK_VERSION, confirmed: true, classSource: evidence.source, classNote: null };
    }
  }
  if (stored && stored.checkVersion === CLASS_CHECK_VERSION && stored.klasseId > 0) {
    return {
      ...normalizeAccountClass(role, stored.klasseId, stored.klasseName),
      checkVersion: CLASS_CHECK_VERSION, confirmed: false, classSource: 'kept', classNote: null,
    };
  }
  // WebUntis answered and names no class (nothing found, or none of the
  // school's): checked under these rules, nothing to wait for. WebUntis not
  // answering, or not telling a pupil from a parent: not checked yet.
  if (evidence.kind === 'unknown' && (evidence.note === 'no_class_found' || evidence.note === 'candidate_rejected')) {
    return none(evidence.note);
  }
  return none(evidence.kind === 'unknown' ? evidence.note : 'no_class_found', false, stored?.checkVersion ?? 0);
}

export interface StoredRole {
  role: string;
  roleLocked: boolean;
}

/**
 * The role a WebUntis sign-in gives the account (`stored` null: a new one),
 * from what WebUntis said it is (`kind`) and the app's own say (`claimed`):
 *
 * 1. an admin's choice (roleLocked) stays, whatever WebUntis says;
 * 2. "none" stays (only an admin sets it);
 * 3. a guardian WebUntis names is a parent;
 * 4. a pupil WebUntis names is a student — but a parent's account stays a
 *    parent: a parent's login on the child's record looks just like the
 *    child, and an account is never moved into a class automatically
 *    (note `student_record_on_parent`, an admin decides);
 * 5. WebUntis did not tell (or names neither): the stored role stays; a new
 *    account takes the app's say, which can only make it a parent.
 */
export function decideAccountRole(
  stored: StoredRole | null,
  kind: AccountKind,
  claimed: 'student' | 'parent' = 'student',
): { role: AccountRole; note: ClassNote | null } {
  if (stored?.roleLocked) return { role: parseAccountRole(stored.role), note: null };
  const current = stored ? parseAccountRole(stored.role) : null;
  if (current === 'none') return { role: 'none', note: null };
  if (kind === 'parent') return { role: 'parent', note: null };
  if (kind === 'student') {
    return current === 'parent' ? { role: 'parent', note: 'student_record_on_parent' } : { role: 'student', note: null };
  }
  if (current) return { role: current, note: null };
  return { role: claimed === 'parent' ? 'parent' : 'student', note: null };
}

export function mayJoinClass(role: string): boolean {
  return hasClassIdentity(role);
}
