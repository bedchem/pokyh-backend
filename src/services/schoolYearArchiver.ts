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
// `target` overrides which school year is being closed; defaults to the current
// running year (`computeSchoolYear(now)`), which is what a manual rollover uses.
export async function performRollover(
  note = '',
  target?: { startYear: number; label: string },
): Promise<RolloverResult> {
  const now = new Date();
  const { startYear, label } = target ?? computeSchoolYear(now);

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

// Restores a previously archived school year back into the live tables and
// removes the archive (cascade-deletes the snapshot rows). This undoes a
// rollover. Restore is additive — records that already exist live (e.g. created
// after the rollover) are skipped — so it can be run safely.
//
// Note: login credentials are NOT recoverable. Password hashes, refresh tokens
// and push subscriptions are not part of the snapshot, so WebUntis users simply
// log back in and any manual-password accounts must have a new password set.
export interface RollbackResult {
  label: string;
  usersRestored: number;
  classesRestored: number;
  membersRestored: number;
  todosRestored: number;
  remindersRestored: number;
  commentsRestored: number;
}

export async function rollbackRollover(schoolYearId: string): Promise<RollbackResult> {
  const sy = await prisma.schoolYear.findUnique({ where: { id: schoolYearId } });
  if (!sy) throw new Error('Archiviertes Schuljahr nicht gefunden');

  // Only the most recently archived year may be rolled back — restoring an older
  // year into a newer live dataset would mix two cohorts together.
  const latest = await prisma.schoolYear.findFirst({ orderBy: { startYear: 'desc' } });
  if (latest && latest.id !== sy.id) {
    throw new Error(`Nur das zuletzt archivierte Schuljahr (${latest.label}) kann rückgängig gemacht werden`);
  }

  logger.info(`School year rollback starting for ${sy.label}…`);

  const [users, classes, todos, reminders] = await Promise.all([
    prisma.archivedUser.findMany({ where: { schoolYearId } }),
    prisma.archivedClass.findMany({ where: { schoolYearId } }),
    prisma.archivedTodo.findMany({ where: { schoolYearId } }),
    prisma.archivedReminder.findMany({ where: { schoolYearId } }),
  ]);

  interface MemberSnap { stableUid: string; username: string; role: string; joinedAt: string }
  interface CommentSnap { id: string; stableUid: string; username: string; body: string; createdAt: string }

  const result: RollbackResult = {
    label: sy.label,
    usersRestored: 0, classesRestored: 0, membersRestored: 0,
    todosRestored: 0, remindersRestored: 0, commentsRestored: 0,
  };

  await prisma.$transaction(async (tx) => {
    // 1. Users (credentials are not archived — restored as WebUntis accounts).
    if (users.length > 0) {
      const r = await tx.user.createMany({
        skipDuplicates: true,
        data: users.map((u) => ({
          stableUid:          u.stableUid,
          username:           u.username,
          role:               u.role,
          webuntisKlasseId:   u.webuntisKlasseId,
          webuntisKlasseName: u.webuntisKlasseName,
          createdAt:          u.createdAt,
        })),
      });
      result.usersRestored = r.count;
    }

    // 2. Classes + their member rows.
    if (classes.length > 0) {
      const rc = await tx.class.createMany({
        skipDuplicates: true,
        data: classes.map((c) => ({
          id:               c.originalId,
          name:             c.name,
          code:             c.code,
          webuntisKlasseId: c.webuntisKlasseId,
          createdBy:        c.createdBy,
          createdByName:    c.createdByName,
          createdAt:        c.createdAt,
        })),
      });
      result.classesRestored = rc.count;

      const members = classes.flatMap((c) =>
        (JSON.parse(c.membersJson) as MemberSnap[]).map((m) => ({
          classId:   c.originalId,
          stableUid: m.stableUid,
          username:  m.username,
          role:      m.role,
          joinedAt:  new Date(m.joinedAt),
        })),
      );
      if (members.length > 0) {
        const rm = await tx.classMember.createMany({ skipDuplicates: true, data: members });
        result.membersRestored = rm.count;
      }
    }

    // 3. Todos.
    if (todos.length > 0) {
      const rt = await tx.todo.createMany({
        skipDuplicates: true,
        data: todos.map((t) => ({
          id:         t.originalId,
          stableUid:  t.stableUid,
          title:      t.title,
          details:    t.details,
          dueAt:      t.dueAt,
          done:       t.done,
          doneAt:     t.doneAt,
          archivedAt: t.archivedAt,
          createdAt:  t.createdAt,
        })),
      });
      result.todosRestored = rt.count;
    }

    // 4. Reminders + their comments.
    if (reminders.length > 0) {
      const rr = await tx.reminder.createMany({
        skipDuplicates: true,
        data: reminders.map((r) => ({
          id:                r.originalId,
          classId:           r.classId,
          title:             r.title,
          body:              r.body,
          remindAt:          r.remindAt,
          createdBy:         r.createdBy,
          createdByName:     r.createdByName,
          createdByUsername: r.createdByUsername,
          archivedAt:        r.archivedAt,
          createdAt:         r.createdAt,
        })),
      });
      result.remindersRestored = rr.count;

      const comments = reminders.flatMap((r) =>
        (JSON.parse(r.commentsJson) as CommentSnap[]).map((c) => ({
          id:         c.id,
          reminderId: r.originalId,
          classId:    r.classId,
          stableUid:  c.stableUid,
          username:   c.username,
          body:       c.body,
          createdAt:  new Date(c.createdAt),
        })),
      );
      if (comments.length > 0) {
        const rcm = await tx.comment.createMany({ skipDuplicates: true, data: comments });
        result.commentsRestored = rcm.count;
      }
    }

    // 5. Drop the archive — cascade removes all archived_* rows for this year.
    await tx.schoolYear.delete({ where: { id: schoolYearId } });
  }, { timeout: 180_000, maxWait: 30_000 });

  logger.info('School year rollback complete', { result });
  return result;
}

// ─── Background checker ───────────────────────────────────────────────────────

// Auto-rollover fires throughout the configured rollover month (default: all of
// August, from the configured day onward) rather than only on the exact day, so
// short downtime around the 1st can't skip it. It always closes the school year
// that has just ended, and is idempotent: if that year was already archived —
// manually or by an earlier run — it does nothing.
async function checkAndRollover() {
  const now   = new Date();
  const month = now.getMonth() + 1;
  const day   = now.getDate();
  if (month !== config.schoolYearRolloverMonth || day < config.schoolYearRolloverDay) return;

  // We are in/after the rollover boundary, so computeSchoolYear(now) already
  // points at the NEW year — the year being closed is the previous one.
  const startYear = computeSchoolYear(now).startYear - 1;
  const label     = `${startYear}/${startYear + 1}`;

  const existing = await prisma.schoolYear.findUnique({ where: { startYear } });
  if (existing) return; // already archived (manually or by a prior auto-run)

  logger.info(`Auto-rollover triggered for ${label}`);
  try {
    await performRollover('Automatisch', { startYear, label });
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
