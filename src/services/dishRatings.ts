import { prisma } from '../db';
import { logger } from '../utils/logger';
import { sseManager } from './sse';

// One vote per person per dish. Votes are keyed by (dishId, stableUid), but a
// stableUid is not forever: a school-year rollover or a database rebuild
// deletes the user row, and the next login creates a fresh one. Without the
// helpers below the old vote stays counted yet no longer counts as "mine", so
// the user can rate again and the count grows by one each time.

export type DishRatingsPayload = { ratings: Record<string, number>; myRating: number | null };

type RatingRow = { dishId: string; stableUid: string; username: string | null; stars: number; updatedAt: Date };

export function ratingsPayload(rows: { stableUid: string; stars: number }[], viewerUid: string | undefined): DishRatingsPayload {
  const ratings: Record<string, number> = {};
  let myRating: number | null = null;
  for (const row of rows) {
    ratings[row.stableUid] = row.stars;
    if (viewerUid && row.stableUid === viewerUid) myRating = row.stars;
  }
  return { ratings, myRating };
}

// Push the current ratings of a dish to everyone listening — the dish's own
// stream and the all-dishes stream — each with their own myRating.
export async function publishDishRatings(dishKey: string): Promise<void> {
  const rows = await prisma.dishRating.findMany({ where: { dishId: dishKey }, select: { stableUid: true, stars: true } });
  sseManager.broadcastPerClient(`dishRatings:${dishKey}`, 'dishRatings', (uid) => ratingsPayload(rows, uid));
  sseManager.broadcastPerClient('dishRatings:all', 'dishRating', (uid) => ({ dishId: dishKey, ...ratingsPayload(rows, uid) }));
}

// Collapse the given rows onto `target` per dish: the newest vote wins, every
// other vote by the same person is removed. Returns [moved, removed].
async function collapseOnto(rows: RatingRow[], target: { stableUid: string; username: string }): Promise<[number, number]> {
  const byDish = new Map<string, RatingRow[]>();
  for (const r of rows) byDish.set(r.dishId, [...(byDish.get(r.dishId) ?? []), r]);

  let moved = 0;
  let removed = 0;
  for (const [dishId, list] of byDish) {
    const keeper = list.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
    const others = list.filter((r) => r !== keeper);
    if (others.length === 0 && keeper.stableUid === target.stableUid && keeper.username === target.username) continue;

    await prisma.$transaction(async (tx) => {
      for (const o of others) {
        await tx.dishRating.delete({ where: { dishId_stableUid: { dishId, stableUid: o.stableUid } } });
      }
      await tx.dishRating.update({
        where: { dishId_stableUid: { dishId, stableUid: keeper.stableUid } },
        // Keep updatedAt: it is what decides "newest vote" next time.
        data: { stableUid: target.stableUid, username: target.username, updatedAt: keeper.updatedAt },
      });
    });
    removed += others.length;
    if (keeper.stableUid !== target.stableUid) moved++;
  }
  return [moved, removed];
}

type UidName = { stableUid: string; username: string };

// Every (stableUid, username) pair the database still remembers, from every
// table that records both — so an account recreated with a new stableUid can
// be linked back to its old one even if it was never archived and never wrote
// a mensa comment. Pass a username to only look up that account.
async function historicUidNames(username?: string): Promise<UidName[]> {
  const by = username ? { username } : {};
  const nonEmpty = username ? { username } : { username: { not: '' } };
  const [archived, dishComments, comments, members, archivedTodos, requestLogs, activityLogs, reminders, archivedReminders] =
    await Promise.all([
      prisma.archivedUser.findMany({ where: by, select: { stableUid: true, username: true } }),
      prisma.dishComment.findMany({ where: by, select: { stableUid: true, username: true }, distinct: ['stableUid'] }),
      prisma.comment.findMany({ where: by, select: { stableUid: true, username: true }, distinct: ['stableUid'] }),
      prisma.classMember.findMany({ where: by, select: { stableUid: true, username: true }, distinct: ['stableUid'] }),
      prisma.archivedTodo.findMany({ where: nonEmpty, select: { stableUid: true, username: true }, distinct: ['stableUid'] }),
      prisma.requestLog.findMany({
        where: { stableUid: { not: null }, username: username ?? { not: null } },
        select: { stableUid: true, username: true },
        distinct: ['stableUid'],
      }),
      prisma.frontendActivityLog.findMany({
        where: { stableUid: { not: null }, username: username ?? { not: null } },
        select: { stableUid: true, username: true },
        distinct: ['stableUid'],
      }),
      prisma.reminder.findMany({
        where: { createdByUsername: username ?? { not: '' } },
        select: { createdBy: true, createdByUsername: true },
        distinct: ['createdBy'],
      }),
      prisma.archivedReminder.findMany({
        where: { createdByUsername: username ?? { not: '' } },
        select: { createdBy: true, createdByUsername: true },
        distinct: ['createdBy'],
      }),
    ]);

  const pairs: UidName[] = [...archived, ...dishComments, ...comments, ...members, ...archivedTodos];
  for (const r of [...requestLogs, ...activityLogs]) {
    if (r.stableUid && r.username) pairs.push({ stableUid: r.stableUid, username: r.username });
  }
  for (const r of [...reminders, ...archivedReminders]) {
    if (r.createdBy && r.createdByUsername) pairs.push({ stableUid: r.createdBy, username: r.createdByUsername });
  }
  return pairs.filter((p) => p.stableUid && p.username);
}

// Every stableUid this username has ever had, as far as the database remembers.
async function knownUidsFor(username: string): Promise<string[]> {
  return [...new Set((await historicUidNames(username)).map((p) => p.stableUid))];
}

// Usernames are compared case-insensitively: WebUntis logins are not
// consistently cased across the tables that recorded them.
const nameKey = (username: string) => username.trim().toLowerCase();

// Give a (possibly freshly recreated) account back its earlier votes. Called
// on login and before every vote, so a duplicate can never be created.
export async function reclaimDishRatings(stableUid: string, username: string): Promise<void> {
  const uids = await knownUidsFor(username);
  const rows = await prisma.dishRating.findMany({
    where: { OR: [{ stableUid }, { username }, { stableUid: { in: uids } }] },
  });
  // A row under an old uid that already belongs to another *current* account
  // is not ours — never steal it.
  const foreignUids = rows.some((r) => r.stableUid !== stableUid)
    ? new Set((await prisma.user.findMany({
        where: { stableUid: { in: [...new Set(rows.map((r) => r.stableUid))] }, NOT: { stableUid } },
        select: { stableUid: true },
      })).map((u) => u.stableUid))
    : new Set<string>();
  const mine = rows.filter((r) => !foreignUids.has(r.stableUid));
  if (mine.length === 0) return;

  const [moved, removed] = await collapseOnto(mine, { stableUid, username });
  if (moved || removed) {
    const dishKeys = new Set(mine.map((r) => r.dishId));
    await Promise.all([...dishKeys].map((k) => publishDishRatings(k)));
    logger.info('dish ratings reclaimed', { moved, removed });
  }
}

// Boot-time repair for votes orphaned before usernames were stored: map every
// known old stableUid to its username, move the votes to the account's current
// stableUid and drop the duplicate votes that the orphaning allowed.
export async function reconcileDishRatings(): Promise<void> {
  const [users, historic, rows] = await Promise.all([
    prisma.user.findMany({ select: { stableUid: true, username: true } }),
    historicUidNames(),
    prisma.dishRating.findMany(),
  ]);

  const currentUserByName = new Map(users.map((u) => [nameKey(u.username), u]));
  const currentNameByUid = new Map(users.map((u) => [u.stableUid, u.username]));
  const historicNameByUid = new Map<string, string>();
  for (const p of historic) historicNameByUid.set(p.stableUid, p.username);

  const byOwner = new Map<string, RatingRow[]>();
  let unresolved = 0;
  for (const r of rows) {
    const owner = currentNameByUid.get(r.stableUid) ?? r.username ?? historicNameByUid.get(r.stableUid);
    if (!owner || !currentUserByName.has(nameKey(owner))) {
      // No known account for this vote (or that account no longer exists) — it stays as history.
      unresolved++;
      continue;
    }
    const key = nameKey(owner);
    byOwner.set(key, [...(byOwner.get(key) ?? []), r]);
  }

  let moved = 0;
  let removed = 0;
  for (const [key, list] of byOwner) {
    const user = currentUserByName.get(key)!;
    const [m, d] = await collapseOnto(list, { stableUid: user.stableUid, username: user.username });
    moved += m;
    removed += d;
  }
  logger.info('dish ratings reconciled', { moved, removedDuplicates: removed, unresolved });
}
