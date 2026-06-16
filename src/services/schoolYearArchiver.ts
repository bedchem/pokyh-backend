import { prisma } from '../db';
import { logger } from '../utils/logger';
import { config } from '../config';

// Compute the school year label for a given date.
// School year runs from Aug 1 → Jul 31 of the following year.
// e.g. any date in 2025-08-01 .. 2026-07-31 → startYear=2025, label="2025/2026"
export function computeSchoolYear(date: Date): { startYear: number; label: string } {
  const year  = date.getFullYear();
  const month = date.getMonth() + 1; // 1-12
  // The rollover month is config-driven (default 8 = August).
  const startYear = month >= config.schoolYearRolloverMonth ? year : year - 1;
  return { startYear, label: `${startYear}/${startYear + 1}` };
}

export interface RolloverResult {
  label: string;
  usersArchived: number;
  classesArchived: number;
  todosArchived: number;
  remindersArchived: number;
}

// Performs the full school-year rollover atomically:
//   1. Snapshot non-admin users, classes, todos, reminders → archive tables
//   2. Delete the live rows (cascade removes class_members, reminder comments, etc.)
// Idempotent per startYear (throws if the year has already been rolled over).
export async function performRollover(note = ''): Promise<RolloverResult> {
  const now = new Date();
  const { startYear, label } = computeSchoolYear(now);

  // Guard: only one rollover per school year
  const existing = await prisma.schoolYear.findUnique({ where: { startYear } });
  if (existing) {
    throw new Error(`Rollover für Schuljahr ${label} wurde bereits am ${existing.rolledAt.toISOString()} durchgeführt`);
  }

  logger.info(`School year rollover starting for ${label}…`);

  // ── Read all live data in parallel ────────────────────────────────────────
  const [users, classMembersAll, classes, todos, reminders, comments, adminRecords] = await Promise.all([
    prisma.user.findMany(),
    prisma.classMember.findMany(),
    prisma.class.findMany(),
    prisma.todo.findMany(),
    prisma.reminder.findMany(),
    prisma.comment.findMany(),
    prisma.admin.findMany({ select: { stableUid: true } }),
  ]);

  const adminUids = new Set(adminRecords.map((a) => a.stableUid));
  const nonAdminUsers = users.filter((u) => !adminUids.has(u.stableUid));

  // ── Build lookup maps ─────────────────────────────────────────────────────
  const classMembersByClass = new Map<string, typeof classMembersAll>();
  const primaryClassByUser  = new Map<string, typeof classMembersAll[0]>();
  for (const cm of classMembersAll) {
    if (!classMembersByClass.has(cm.classId)) classMembersByClass.set(cm.classId, []);
    classMembersByClass.get(cm.classId)!.push(cm);
    if (!primaryClassByUser.has(cm.stableUid)) primaryClassByUser.set(cm.stableUid, cm);
  }

  const classNameMap = new Map(classes.map((c) => [c.id, c.name]));
  const classCodeMap = new Map(classes.map((c) => [c.id, c.code]));

  const commentsByReminder = new Map<string, typeof comments>();
  for (const c of comments) {
    if (!commentsByReminder.has(c.reminderId)) commentsByReminder.set(c.reminderId, []);
    commentsByReminder.get(c.reminderId)!.push(c);
  }

  const usernameByUid = new Map(users.map((u) => [u.stableUid, u.username]));

  // ── Atomic snapshot + delete ──────────────────────────────────────────────
  await prisma.$transaction(async (tx) => {
    const sy = await tx.schoolYear.create({ data: { label, startYear, rolledAt: now, note } });

    // 1. Archive non-admin users
    if (nonAdminUsers.length > 0) {
      await tx.archivedUser.createMany({
        data: nonAdminUsers.map((u) => {
          const cm = primaryClassByUser.get(u.stableUid);
          return {
            schoolYearId:       sy.id,
            stableUid:          u.stableUid,
            username:           u.username,
            role:               u.role,
            webuntisKlasseId:   u.webuntisKlasseId,
            webuntisKlasseName: u.webuntisKlasseName,
            classId:            cm?.classId ?? null,
            classCode:          cm ? (classCodeMap.get(cm.classId) ?? null) : null,
            className:          cm ? (classNameMap.get(cm.classId) ?? null) : null,
            createdAt:          u.createdAt,
          };
        }),
      });
    }

    // 2. Archive classes (with member snapshot)
    if (classes.length > 0) {
      await tx.archivedClass.createMany({
        data: classes.map((c) => {
          const members = classMembersByClass.get(c.id) ?? [];
          return {
            schoolYearId:     sy.id,
            originalId:       c.id,
            name:             c.name,
            code:             c.code,
            webuntisKlasseId: c.webuntisKlasseId,
            createdBy:        c.createdBy,
            createdByName:    c.createdByName,
            memberCount:      members.length,
            membersJson:      JSON.stringify(members.map((m) => ({
              stableUid: m.stableUid,
              username:  m.username,
              role:      m.role,
              joinedAt:  m.joinedAt.toISOString(),
            }))),
            createdAt:        c.createdAt,
          };
        }),
      });
    }

    // 3. Archive todos
    if (todos.length > 0) {
      await tx.archivedTodo.createMany({
        data: todos.map((t) => ({
          schoolYearId: sy.id,
          originalId:   t.id,
          stableUid:    t.stableUid,
          username:     usernameByUid.get(t.stableUid) ?? '',
          title:        t.title,
          details:      t.details,
          dueAt:        t.dueAt,
          done:         t.done,
          doneAt:       t.doneAt,
          archivedAt:   t.archivedAt,
          createdAt:    t.createdAt,
        })),
      });
    }

    // 4. Archive reminders (with embedded comments snapshot)
    if (reminders.length > 0) {
      await tx.archivedReminder.createMany({
        data: reminders.map((r) => ({
          schoolYearId:      sy.id,
          originalId:        r.id,
          classId:           r.classId,
          className:         classNameMap.get(r.classId) ?? '',
          title:             r.title,
          body:              r.body,
          remindAt:          r.remindAt,
          createdBy:         r.createdBy,
          createdByName:     r.createdByName,
          createdByUsername: r.createdByUsername,
          archivedAt:        r.archivedAt,
          commentsJson:      JSON.stringify((commentsByReminder.get(r.id) ?? []).map((c) => ({
            id:        c.id,
            stableUid: c.stableUid,
            username:  c.username,
            body:      c.body,
            createdAt: c.createdAt.toISOString(),
          }))),
          createdAt:         r.createdAt,
        })),
      });
    }

    // 5. Delete live data — FK cascade removes children automatically.
    //    Delete classes first → cascade: class_members, reminders, comments.
    //    Delete non-admin users → cascade: todos, refresh_tokens, push_subscriptions.
    await tx.class.deleteMany();
    if (adminUids.size > 0) {
      await tx.user.deleteMany({ where: { stableUid: { notIn: [...adminUids] } } });
    } else {
      await tx.user.deleteMany();
    }
    // DishRatings have no FK to User — orphaned entries are kept as historical data.

  }, { timeout: 180_000, maxWait: 30_000 });

  const result: RolloverResult = {
    label,
    usersArchived:     nonAdminUsers.length,
    classesArchived:   classes.length,
    todosArchived:     todos.length,
    remindersArchived: reminders.length,
  };
  logger.info('School year rollover complete', { result });
  return result;
}

// ─── Background checker ───────────────────────────────────────────────────────

async function checkAndRollover() {
  const now   = new Date();
  const month = now.getMonth() + 1;
  const day   = now.getDate();
  if (month !== config.schoolYearRolloverMonth || day !== config.schoolYearRolloverDay) return;

  const { startYear, label } = computeSchoolYear(now);
  const existing = await prisma.schoolYear.findUnique({ where: { startYear } });
  if (existing) return; // already done this year

  logger.info(`Auto-rollover triggered for ${label} (${config.schoolYearRolloverMonth}/${config.schoolYearRolloverDay})`);
  try {
    await performRollover('Automatisch');
  } catch (err) {
    logger.error('Auto school year rollover failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

export function startSchoolYearArchiver(): void {
  if (!config.schoolYearRolloverAuto) {
    logger.info('School year auto-rollover disabled (SCHOOL_YEAR_ROLLOVER_AUTO=false)');
    return;
  }
  // Slight delay so DB is definitely ready before first check
  setTimeout(() => void checkAndRollover().catch(() => {}), 15_000);
  setInterval(() => void checkAndRollover().catch(() => {}), config.schoolYearRolloverCheckIntervalMs);
  logger.info(`School year archiver started — checks every ${config.schoolYearRolloverCheckIntervalMs}ms`);
}
