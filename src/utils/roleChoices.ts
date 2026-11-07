import type { AccountRole } from './accountClass';

// The roles admins chose for accounts, read back from the audit trail
// (admin_audit_events): what services/classCheck.ts locks once, so that a
// choice made before roles could be locked sticks from now on. Pure, tested
// on its own (tests/roleChoices.test.mjs).

export interface RoleAuditRow {
  targetId: string;
  action: string;
  /** The event's detail, a small JSON object (services/audit.ts). */
  detail: string;
  createdAt: Date;
}

const ROLES = new Set<AccountRole>(['student', 'parent', 'none']);

function parsed(detail: string): Record<string, unknown> {
  try {
    const value = JSON.parse(detail) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Per account, the role its latest admin decision set: `user.role` (`to`;
 * `locked: false` is "back to WebUntis" and drops the choice) and
 * `user.create` with a parent or role-less account (a new student is no
 * decision: it follows WebUntis). Rows in any order; the latest wins.
 */
export function adminRoleChoices(rows: readonly RoleAuditRow[]): Map<string, AccountRole> {
  const choices = new Map<string, AccountRole>();
  const ordered = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const row of ordered) {
    if (!row.targetId) continue;
    const detail = parsed(row.detail);
    if (row.action === 'user.role') {
      if (detail.locked === false) {
        choices.delete(row.targetId);
        continue;
      }
      const to = detail.to;
      if (typeof to === 'string' && ROLES.has(to as AccountRole)) choices.set(row.targetId, to as AccountRole);
    } else if (row.action === 'user.create') {
      const role = detail.role;
      if (role === 'parent' || role === 'none') choices.set(row.targetId, role);
    }
  }
  return choices;
}

/** Whether an admin set this POKYH-only password (the audit has the account made with one, or a password set). */
export function adminSetPasswords(rows: readonly RoleAuditRow[]): Set<string> {
  const set = new Set<string>();
  for (const row of rows) {
    if (!row.targetId) continue;
    if (row.action === 'user.password') set.add(row.targetId);
    else if (row.action === 'user.create' && parsed(row.detail).local === true) set.add(row.targetId);
  }
  return set;
}
