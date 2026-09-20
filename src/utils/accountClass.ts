export type AccountRole = 'student' | 'parent';

export interface AccountClassIdentity {
  klasseId: number;
  klasseName: string;
}

/**
 * Parent accounts are identities of their own, not members of their child's
 * Pokyh class. Keep this normalization at the backend trust boundary so even a
 * caller that accidentally submits the child's WebUntis class cannot assign it
 * to the parent account.
 */
export function normalizeAccountClass(
  role: AccountRole,
  klasseId: number,
  klasseName: string,
): AccountClassIdentity {
  if (role === 'parent') {
    return { klasseId: 0, klasseName: '' };
  }

  return {
    klasseId: Number.isInteger(klasseId) && klasseId > 0 ? klasseId : 0,
    klasseName: klasseName.trim(),
  };
}

export function mayJoinClass(role: string): boolean {
  return role !== 'parent';
}
