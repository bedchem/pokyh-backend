// "none" is an account that is neither a student nor a parent — for example
// an administrator who is not part of a class. Only an admin sets it, and a
// WebUntis login keeps it (WebUntis itself only knows students and parents).
export type AccountRole = 'student' | 'parent' | 'none';

export interface AccountClassIdentity {
  klasseId: number;
  klasseName: string;
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
 * to such an account.
 */
export function normalizeAccountClass(
  role: AccountRole,
  klasseId: number,
  klasseName: string,
): AccountClassIdentity {
  if (!hasClassIdentity(role)) {
    return { klasseId: 0, klasseName: '' };
  }

  return {
    klasseId: Number.isInteger(klasseId) && klasseId > 0 ? klasseId : 0,
    klasseName: klasseName.trim(),
  };
}

export function mayJoinClass(role: string): boolean {
  return hasClassIdentity(role);
}
