import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { logger } from '../utils/logger';
import { GLOBAL_SCOPE, ALL_PERMISSIONS } from '../security/permissions';
import { PERMISSION_UPGRADES, upgradeGrant } from '../security/permissionUpgrades';
import { grantId, parsePermissionList } from './adminAccess';
import { DEFAULT_MENU_ID, defaultSchoolId, ensureDefaultSchool, invalidateMenus } from './schools';

// Bringing a database from the single-school era into schools — on every
// start, idempotent, never destructive:
//
//   1. The default school exists (WEBUNTIS_SCHOOL, services/schools.ts).
//   2. Every school-specific row without a school belongs to it: before
//      schools existed there was exactly one, so this is a statement of fact,
//      not a guess. Accounts gain no rights by it.
//   3. Every dish without a menu belongs to the default menu, and — once —
//      that menu is assigned to the default school, so the existing Mensa
//      keeps showing. A menu an administrator unassigns later stays so.
//   4. Once (migrateLegacyAdmins, below): every admin account that existed
//      before permissions becomes a global admin, as the owner decided —
//      they already had every right. Runs on one node of a cluster only.
//
// Steps 2 and 3 repeat on every start (cheap: indexed IS NULL lookups), so
// rows an older node writes during a rolling update are picked up too. The
// one-off backfills over large log tables are marked done in app_migrations.

const BATCH = 5_000;

async function marked(id: string): Promise<boolean> {
  return (await prisma.appMigration.findUnique({ where: { id }, select: { id: true } })) !== null;
}

async function mark(id: string, detail: string): Promise<void> {
  await prisma.appMigration.upsert({ where: { id }, create: { id, detail: detail.slice(0, 500) }, update: {} });
}

// Repeats a bounded UPDATE … LIMIT until nothing is left, so a large table
// is never locked in one long statement.
async function inBatches(statement: () => Prisma.Sql): Promise<number> {
  let total = 0;
  for (;;) {
    const n = Number(await prisma.$executeRaw(statement()));
    total += n;
    if (n < BATCH) return total;
  }
}

export async function migrateToSchools(): Promise<void> {
  const school = await ensureDefaultSchool();
  const id = school.id;
  const limit = Prisma.raw(String(BATCH));
  const counts: Record<string, number> = {};

  // ── Replicated, school-specific tables (every start) ─────────────────────
  counts['users'] = await inBatches(() => Prisma.sql`UPDATE users SET school_id = ${id} WHERE school_id IS NULL LIMIT ${limit}`);
  counts['classes'] = await inBatches(() => Prisma.sql`UPDATE classes SET school_id = ${id} WHERE school_id IS NULL LIMIT ${limit}`);
  counts['dishRatingsSchool'] = await inBatches(() => Prisma.sql`UPDATE dish_ratings SET school_id = ${id} WHERE school_id IS NULL LIMIT ${limit}`);
  counts['dishCommentsSchool'] = await inBatches(() => Prisma.sql`UPDATE dish_comments SET school_id = ${id} WHERE school_id IS NULL LIMIT ${limit}`);

  // ── Menus ────────────────────────────────────────────────────────────────
  const [unmenued] = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*) AS n FROM dishes WHERE menu_id IS NULL`;
  const [unmenuedVotes] = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT (SELECT COUNT(*) FROM dish_ratings WHERE menu_id IS NULL) + (SELECT COUNT(*) FROM dish_comments WHERE menu_id IS NULL) AS n`;
  if (Number(unmenued?.n ?? 0) > 0 || Number(unmenuedVotes?.n ?? 0) > 0) {
    await prisma.mensaMenu.upsert({
      where: { id: DEFAULT_MENU_ID },
      create: { id: DEFAULT_MENU_ID, name: `Mensa ${school.shortName || school.name}`.slice(0, 120), createdBy: 'system' },
      update: {},
    });
    counts['dishes'] = await inBatches(() => Prisma.sql`UPDATE dishes SET menu_id = ${DEFAULT_MENU_ID} WHERE menu_id IS NULL LIMIT ${limit}`);
    counts['dishRatingsMenu'] = await inBatches(() => Prisma.sql`UPDATE dish_ratings SET menu_id = ${DEFAULT_MENU_ID} WHERE menu_id IS NULL LIMIT ${limit}`);
    counts['dishCommentsMenu'] = await inBatches(() => Prisma.sql`UPDATE dish_comments SET menu_id = ${DEFAULT_MENU_ID} WHERE menu_id IS NULL LIMIT ${limit}`);
  }
  if (!(await marked('mensa-menus-v1'))) {
    // Also on a fresh installation: the default school starts with a menu
    // of its own, so the Mensa works without setting anything up.
    await prisma.mensaMenu.upsert({
      where: { id: DEFAULT_MENU_ID },
      create: { id: DEFAULT_MENU_ID, name: `Mensa ${school.shortName || school.name}`.slice(0, 120), createdBy: 'system' },
      update: {},
    });
    const assigned = await prisma.mensaMenuSchool.findUnique({ where: { schoolId: id }, select: { menuId: true } });
    if (!assigned) {
      await prisma.mensaMenuSchool.create({ data: { menuId: DEFAULT_MENU_ID, schoolId: id, assignedBy: 'system' } }).catch(() => undefined);
      invalidateMenus();
    }
    await mark('mensa-menus-v1', 'default menu assigned to the default school');
  }

  // ── Archives and node-local logs (once) ──────────────────────────────────
  if (!(await marked('school-backfill-v1'))) {
    counts['archivedUsers'] = await inBatches(() => Prisma.sql`UPDATE archived_users SET school_id = ${id} WHERE school_id IS NULL LIMIT ${limit}`);
    counts['archivedClasses'] = await inBatches(() => Prisma.sql`UPDATE archived_classes SET school_id = ${id} WHERE school_id IS NULL LIMIT ${limit}`);
    counts['requestLogs'] = await inBatches(() => Prisma.sql`UPDATE request_logs SET school_id = ${id} WHERE school_id IS NULL AND stable_uid IS NOT NULL LIMIT ${limit}`);
    // Rows from before request scopes existed are app traffic.
    counts['requestLogsScope'] = await inBatches(() => Prisma.sql`UPDATE request_logs SET scope = 'core' WHERE scope IS NULL AND stable_uid IS NOT NULL LIMIT ${limit}`);
    // The panel's own requests were logged like app traffic: a name without
    // an account is an admin token (an app user always has both).
    counts['requestLogsAdmin'] = await inBatches(() => Prisma.sql`
      UPDATE request_logs SET scope = 'admin'
      WHERE (scope = 'core' OR scope IS NULL) AND stable_uid IS NULL AND username IS NOT NULL LIMIT ${limit}`);
    counts['requestLogsScopeRest'] = await inBatches(() => Prisma.sql`UPDATE request_logs SET scope = 'core' WHERE scope IS NULL LIMIT ${limit}`);
    counts['activity'] = await inBatches(() => Prisma.sql`UPDATE frontend_activity_logs SET school_id = ${id} WHERE school_id IS NULL AND stable_uid IS NOT NULL LIMIT ${limit}`);
    counts['usageSessions'] = await inBatches(() => Prisma.sql`
      UPDATE usage_sessions SET school_id = ${id}
      WHERE school_id IS NULL AND (stable_uid IS NOT NULL OR visitor_key IS NOT NULL) LIMIT ${limit}`);
    counts['webVisits'] = await inBatches(() => Prisma.sql`UPDATE web_visits SET school_id = ${id} WHERE school_id IS NULL AND signed_in = 1 LIMIT ${limit}`);
    counts['classDays'] = Number(await prisma.$executeRaw`
      INSERT INTO usage_school_class_days (day_key, school_id, klasse, seconds, visits, people)
      SELECT day_key, ${id}, klasse, seconds, visits, people FROM usage_class_days
      ON DUPLICATE KEY UPDATE seconds = usage_school_class_days.seconds`);
    await mark('school-backfill-v1', `default school ${id}`);
  }

  const changed = Object.entries(counts).filter(([, n]) => n > 0);
  if (changed.length > 0) logger.info('Multi-school migration', { action: 'multi_school_migration', schoolId: id, ...Object.fromEntries(changed) });
}

/**
 * Once per installation: every admin account from before permissions
 * existed gets a global grant with every permission (the owner's decision
 * on 2026-10-16 — they already had every right). Only while no grant exists
 * at all and the migration is not marked done, so it can never re-promote
 * an admin whose rights were reduced later, nor run again after a restore.
 * The caller runs it on one node of a cluster only (mayRunExclusiveJob).
 */
export async function migrateLegacyAdmins(): Promise<number> {
  const id = 'admin-grants-v1';
  if (await marked(id)) return 0;
  if ((await prisma.adminGrant.count()) > 0) {
    await mark(id, 'grants already present');
    return 0;
  }
  const admins = await prisma.admin.findMany({ select: { stableUid: true } });
  const users = admins.length > 0
    ? await prisma.user.findMany({ where: { stableUid: { in: admins.map((a) => a.stableUid) } }, select: { username: true } })
    : [];
  const permissions = JSON.stringify(ALL_PERMISSIONS);
  await prisma.$transaction([
    ...users.map((u) => prisma.adminGrant.upsert({
      where: { id: grantId(u.username, GLOBAL_SCOPE) },
      create: { id: grantId(u.username, GLOBAL_SCOPE), username: u.username, scope: GLOBAL_SCOPE, preset: 'global_admin', permissions, grantedBy: 'migration' },
      update: {},
    })),
    prisma.appMigration.upsert({ where: { id }, create: { id, detail: `${users.length} admin account(s) made global admins` }, update: {} }),
  ]);
  if (users.length > 0) {
    logger.info('Existing admin accounts became global admins', { action: 'admin_grants_migration', count: users.length });
  }
  return users.length;
}

/**
 * Rights added to the catalog later reach the grants that would have held
 * them (security/permissionUpgrades.ts) — each upgrade once, marked in
 * app_migrations, so a right an administrator takes away afterwards stays
 * away. Run after migrateLegacyAdmins, on one node of a cluster only.
 */
export async function migrateNewPermissions(): Promise<number> {
  let changed = 0;
  for (const upgrade of PERMISSION_UPGRADES) {
    if (await marked(upgrade.id)) continue;
    const grants = await prisma.adminGrant.findMany({ select: { id: true, scope: true, preset: true, permissions: true } });
    const updates = grants.flatMap((g) => {
      const next = upgradeGrant({ scope: g.scope, preset: g.preset, permissions: parsePermissionList(g.permissions) }, upgrade, GLOBAL_SCOPE);
      return next ? [prisma.adminGrant.update({ where: { id: g.id }, data: { permissions: JSON.stringify(next) } })] : [];
    });
    await prisma.$transaction([
      ...updates,
      prisma.appMigration.upsert({ where: { id: upgrade.id }, create: { id: upgrade.id, detail: `${updates.length} grant(s) given ${upgrade.added.join(', ')}` }, update: {} }),
    ]);
    if (updates.length > 0) logger.info('New admin rights added to existing grants', { action: 'admin_grants_upgrade', upgrade: upgrade.id, count: updates.length });
    changed += updates.length;
  }
  return changed;
}

export { defaultSchoolId };
