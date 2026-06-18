import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { sseManager } from './sse';

// Archives todos and reminders that have been expired (overdue, completed, or
// past their remind time) for longer than ARCHIVE_AFTER_HOURS. Archived items keep living in the
// database but disappear from every user/class API — only admins can view them.
export async function archiveExpiredItems(): Promise<void> {
  const cutoff = new Date(Date.now() - config.archiveAfterHours * 60 * 60 * 1000);

  // ── Todos: archived once either condition has held longer than the cutoff:
  //   • overdue   — dueAt set and older than the cutoff, or
  //   • completed — checked off (doneAt set) longer than the cutoff ago.
  const todosToArchive = await prisma.todo.findMany({
    where: {
      archivedAt: null,
      OR: [
        { dueAt: { not: null, lt: cutoff } },
        { done: true, doneAt: { not: null, lt: cutoff } },
      ],
    },
    select: { id: true, stableUid: true },
  });

  if (todosToArchive.length > 0) {
    const ids = todosToArchive.map((t) => t.id);
    const now = new Date();
    await prisma.todo.updateMany({ where: { id: { in: ids } }, data: { archivedAt: now } });

    // Push the now-shorter list to any connected clients so archived items vanish live.
    const affectedUids = [...new Set(todosToArchive.map((t) => t.stableUid))];
    for (const uid of affectedUids) {
      const todos = await prisma.todo.findMany({
        where: { stableUid: uid, archivedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      sseManager.broadcast(`todos:${uid}`, 'todos', todos);
    }
    logger.info(`Archive: ${ids.length} expired todos archived`);
  }

  // ── Reminders: remindAt older than the cutoff and not yet archived
  const remindersToArchive = await prisma.reminder.findMany({
    where: { archivedAt: null, remindAt: { lt: cutoff } },
    select: { id: true, classId: true },
  });

  if (remindersToArchive.length > 0) {
    const ids = remindersToArchive.map((r) => r.id);
    const now = new Date();
    await prisma.reminder.updateMany({ where: { id: { in: ids } }, data: { archivedAt: now } });

    const affectedClasses = [...new Set(remindersToArchive.map((r) => r.classId))];
    for (const classId of affectedClasses) {
      const reminders = await prisma.reminder.findMany({
        where: { classId, archivedAt: null },
        orderBy: { remindAt: 'asc' },
      });
      sseManager.broadcast(`reminders:${classId}`, 'reminders', reminders);
    }
    logger.info(`Archive: ${ids.length} expired reminders archived`);
  }
}

// Starts the periodic archiver. Runs once on boot (deferred, non-blocking) and
// then on the configured interval. Never throws — a failed run is logged only.
export function startArchiver(): void {
  const run = () => void archiveExpiredItems().catch((err) =>
    logger.warn(`Archive run failed: ${err instanceof Error ? err.message : String(err)}`),
  );
  // Defer the first run so it never delays server startup.
  setTimeout(run, 5000);
  setInterval(run, config.archiveCheckIntervalMs);
}
