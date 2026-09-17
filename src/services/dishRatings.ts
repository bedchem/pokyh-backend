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

// Every stableUid this username has ever had, as far as the database remembers.
async function knownUidsFor(username: string): Promise<string[]> {
  const [archived, comments] = await Promise.all([
    prisma.archivedUser.findMany({ where: { username }, select: { stableUid: true } }),
    prisma.dishComment.findMany({ where: { username }, select: { stableUid: true }, distinct: ['stableUid'] }),
  ]);
  return [...new Set([...archived, ...comments].map((r) => r.stableUid))];
}

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
  const [users, archived, comments, rows] = await Promise.all([
    prisma.user.findMany({ select: { stableUid: true, username: true } }),
    prisma.archivedUser.findMany({ select: { stableUid: true, username: true, createdAt: true }, orderBy: { createdAt: 'asc' } }),
    prisma.dishComment.findMany({ select: { stableUid: true, username: true }, distinct: ['stableUid'] }),
    prisma.dishRating.findMany(),
  ]);

  const currentUidByName = new Map(users.map((u) => [u.username, u.stableUid]));
  const currentNameByUid = new Map(users.map((u) => [u.stableUid, u.username]));
  const historicNameByUid = new Map<string, string>();
  for (const a of archived) historicNameByUid.set(a.stableUid, a.username);
  for (const c of comments) historicNameByUid.set(c.stableUid, c.username);

  const byOwner = new Map<string, RatingRow[]>();
  for (const r of rows) {
    const owner = currentNameByUid.get(r.stableUid) ?? r.username ?? historicNameByUid.get(r.stableUid);
    if (!owner || !currentUidByName.has(owner)) continue; // account gone — the vote stays as history
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), r]);
  }

  let moved = 0;
  let removed = 0;
  for (const [username, list] of byOwner) {
    const [m, d] = await collapseOnto(list, { stableUid: currentUidByName.get(username)!, username });
    moved += m;
    removed += d;
  }
  if (moved || removed) logger.info('dish ratings reconciled', { moved, removedDuplicates: removed });
}
