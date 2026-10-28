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
 */
export const CLASS_CHECK_VERSION = 1;

/** What WebUntis said about an account's class at a sign-in. */
export type ClassEvidence =
  /** WebUntis named the signed-in student's own class. */
  | { kind: 'class'; klasseId: number; klasseName: string }
  /** WebUntis made clear the account has no class (a guardian, a teacher, …). */
  | { kind: 'none' }
  /** WebUntis did not tell this time (no answer, nothing conclusive). */
  | { kind: 'unknown' };

/** The class an account has stored, and the rules version that confirmed it. */
export interface StoredAccountClass extends AccountClassIdentity {
  checkVersion: number;
}

export interface AccountClassDecision extends AccountClassIdentity {
  /** The rules version that confirmed this class (or that the account has none). */
  checkVersion: number;
  /** Whether WebUntis confirmed it at this sign-in. */
  confirmed: boolean;
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
 * - a class WebUntis named for the signed-in student: that one;
 * - WebUntis did not tell: the class it confirmed under the current rules
 *   before stays (a WebUntis hiccup must not drop a student from their
 *   class); any other stored class goes, and the account waits unassigned
 *   for a sign-in that confirms one.
 */
export function decideAccountClass(
  role: AccountRole,
  evidence: ClassEvidence,
  stored: StoredAccountClass | null,
): AccountClassDecision {
  if (!hasClassIdentity(role) || evidence.kind === 'none') {
    return { klasseId: 0, klasseName: '', checkVersion: CLASS_CHECK_VERSION, confirmed: true };
  }
  if (evidence.kind === 'class') {
    const named = normalizeAccountClass(role, evidence.klasseId, evidence.klasseName);
    if (named.klasseId > 0) return { ...named, checkVersion: CLASS_CHECK_VERSION, confirmed: true };
  }
  if (stored && stored.checkVersion === CLASS_CHECK_VERSION && stored.klasseId > 0) {
    return { ...normalizeAccountClass(role, stored.klasseId, stored.klasseName), checkVersion: CLASS_CHECK_VERSION, confirmed: false };
  }
  return { klasseId: 0, klasseName: '', checkVersion: stored?.checkVersion ?? 0, confirmed: false };
}

/**
 * The role a WebUntis sign-in gives the account. "none" is an admin's choice
 * and survives every sign-in. What WebUntis confirmed is taken as it is; a
 * role nobody could confirm (an app's own say, an inconclusive answer) may
 * make an account a parent, never a parent a student.
 */
export function decideAccountRole(stored: string | null | undefined, role: 'student' | 'parent', confirmed: boolean): AccountRole {
  if (stored === 'none') return 'none';
  if (confirmed) return role;
  return role === 'parent' || stored === 'parent' ? 'parent' : 'student';
}

export function mayJoinClass(role: string): boolean {
  return hasClassIdentity(role);
}
