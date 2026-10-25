// Rights added to the catalog (./permissions.ts) after administrators were
// granted theirs. A grant stores its permission list, so a new right reaches
// nobody by itself — not even a Global-Admin, whose list was "everything" on
// the day it was made. Each upgrade here runs once (services/multiSchool.ts,
// marked in app_migrations) and adds the new rights to the grants that would
// have held them: every grant made from a preset that holds all rights of its
// scope, and every grant that holds the right the new one belongs with.
// Pure, tested on its own (tests/permissions.test.mjs).

import { isGlobalOnly, isPermission, type Permission } from './permissions';

export interface PermissionUpgrade {
  /** Its row in app_migrations. */
  id: string;
  /** The rights it adds. */
  added: readonly Permission[];
  /** A grant holding the first right also gets the second. */
  follows: ReadonlyArray<readonly [Permission, Permission]>;
}

export const PERMISSION_UPGRADES: readonly PermissionUpgrade[] = [
  {
    id: 'admin-grants-recaps-v1',
    added: ['recaps.view', 'recaps.manage'],
    follows: [
      ['popups.view', 'recaps.view'],
      ['popups.manage', 'recaps.view'],
      ['popups.manage', 'recaps.manage'],
    ],
  },
];

/** Presets that stand for every right of their scope. */
const EVERYTHING = new Set(['global_admin', 'school_admin']);

/**
 * The grant's permission list after an upgrade, or null when nothing
 * changes. A school grant never gains a global-only right.
 */
export function upgradeGrant(
  grant: { scope: string; preset: string; permissions: readonly string[] },
  upgrade: PermissionUpgrade,
  globalScope = 'global',
): string[] | null {
  const held = new Set(grant.permissions);
  const fits = (p: Permission) => grant.scope === globalScope || !isGlobalOnly(p);
  const add = new Set<Permission>();
  if (EVERYTHING.has(grant.preset)) for (const p of upgrade.added) if (fits(p)) add.add(p);
  for (const [from, to] of upgrade.follows) if (held.has(from) && fits(to)) add.add(to);
  const missing = [...add].filter((p) => isPermission(p) && !held.has(p));
  return missing.length > 0 ? [...grant.permissions, ...missing] : null;
}
