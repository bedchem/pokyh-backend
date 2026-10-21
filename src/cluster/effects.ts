import { prisma } from '../db';
import { logger } from '../utils/logger';
import { invalidateDishesCache } from '../utils/cache';
import { invalidateSqlTables } from '../services/cache';
import { noteTokenRevocation } from '../utils/revokedTokens';
import { publishDishRatings } from '../services/dishRatings';
import { publishDishComments } from '../services/dishComments';
import { sseManager } from '../services/sse';

// What a locally handled request does besides writing its rows — pushing a
// live update to connected clients, dropping a cache — also has to happen on
// the nodes that merely receive those rows. This module maps an applied
// change back to those side effects, so a browser connected to one node sees
// a change made through another node just as quickly.
//
// Effects are collected per batch and de-duplicated: a hundred received
// to-dos of one user still produce a single list update.

type Row = Record<string, unknown> | null;

const pending = {
  todoUsers: new Set<string>(),
  reminderClasses: new Set<string>(),
  commentReminders: new Set<string>(),
  ratedDishes: new Set<string>(),
  commentedDishes: new Set<string>(),
  dishes: false,
  // Every table a batch changed: their cached answers (services/cache.ts) go.
  tables: new Set<string>(),
};

function collect(target: Set<string>, column: string, ...rows: Row[]): void {
  for (const row of rows) {
    const value = row?.[column];
    if (typeof value === 'string' && value) target.add(value);
  }
}

// A dish's votes and comments live per menu: "<menu id>|<dish key>".
function collectDish(target: Set<string>, ...rows: Row[]): void {
  for (const row of rows) {
    const dish = row?.['dish_id'];
    const menu = row?.['menu_id'];
    if (typeof dish === 'string' && dish) target.add(`${typeof menu === 'string' ? menu : ''}|${dish}`);
  }
}

function splitDish(value: string): [string | null, string] {
  const cut = value.indexOf('|');
  const menu = value.slice(0, cut);
  return [menu === '' ? null : menu, value.slice(cut + 1)];
}

export function queueEffect(table: string, before: Row, after: Row): void {
  pending.tables.add(table);
  switch (table) {
    case 'todos':
      collect(pending.todoUsers, 'stable_uid', before, after);
      break;
    case 'reminders':
      collect(pending.reminderClasses, 'class_id', before, after);
      break;
    case 'comments':
      collect(pending.commentReminders, 'reminder_id', before, after);
      break;
    case 'dish_ratings':
      collectDish(pending.ratedDishes, before, after);
      break;
    case 'dish_comments':
      collectDish(pending.commentedDishes, before, after);
      break;
    case 'dishes':
    case 'dish_images':
      pending.dishes = true;
      break;
    case 'token_revocations': {
      const uid = after?.['stable_uid'];
      const at = after?.['revoked_at'];
      if (typeof uid === 'string' && at instanceof Date) noteTokenRevocation(uid, at);
      break;
    }
    default:
      break;
  }
}

function take(set: Set<string>): string[] {
  const values = [...set];
  set.clear();
  return values;
}

async function run(): Promise<void> {
  if (pending.tables.size) await invalidateSqlTables(take(pending.tables));
  if (pending.dishes) {
    pending.dishes = false;
    invalidateDishesCache();
  }

  // The payloads below deliberately mirror what the corresponding routes
  // broadcast, and are only built when somebody is actually listening.
  for (const uid of take(pending.todoUsers)) {
    const key = `todos:${uid}`;
    if (sseManager.getClientCount(key) === 0) continue;
    const todos = await prisma.todo.findMany({ where: { stableUid: uid, archivedAt: null }, orderBy: { createdAt: 'asc' } });
    sseManager.broadcast(key, 'todos', todos);
  }
  for (const classId of take(pending.reminderClasses)) {
    const key = `reminders:${classId}`;
    if (sseManager.getClientCount(key) === 0) continue;
    const reminders = await prisma.reminder.findMany({ where: { classId, archivedAt: null }, orderBy: { remindAt: 'asc' } });
    sseManager.broadcast(key, 'reminders', reminders);
  }
  for (const reminderId of take(pending.commentReminders)) {
    const key = `reminderComments:${reminderId}`;
    if (sseManager.getClientCount(key) === 0) continue;
    const comments = await prisma.comment.findMany({ where: { reminderId }, orderBy: { createdAt: 'asc' } });
    sseManager.broadcast(key, 'reminderComments', comments);
  }
  for (const value of take(pending.ratedDishes)) {
    const [menuId, dishKey] = splitDish(value);
    await publishDishRatings(menuId, dishKey);
  }
  for (const value of take(pending.commentedDishes)) {
    const [menuId, dishKey] = splitDish(value);
    await publishDishComments(menuId, dishKey);
  }
}

let scheduled = false;

// Runs the collected effects shortly after the current batch, never inside it:
// a failing notification must not affect the data that was just stored.
export function flushEffects(): void {
  if (scheduled) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    run().catch((err) => {
      logger.warn('Cluster follow-up notification failed', {
        action: 'cluster_effect_failed',
        message: err instanceof Error ? err.message.split('\n')[0] : String(err),
      });
    });
  });
}
