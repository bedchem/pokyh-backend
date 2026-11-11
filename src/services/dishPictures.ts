import { config } from '../config';
import { ownsClusterWork } from '../cluster/hooks';
import { prisma } from '../db';
import { invalidateDishesCache } from '../utils/cache';
import { logger } from '../utils/logger';
import { MAX_FETCHED_BYTES, PictureError, toWebp } from '../utils/pictures';
import { BlockedAddressError, fetchBytes } from '../utils/safeFetch';

// A dish's picture lives in the database (dish_images), so every backup has
// it and nobody's browser fetches it from someone else's site. A picture that
// is only a link (a mensa.json names them, an administrator may paste one) is
// fetched once, checked and drawn anew as WebP (utils/pictures.ts), kept with
// the link it came from, and the dish then names its own copy. A link that
// fails stays a link and is tried again later, less and less often.
//
// A dish names its own copy by path only (/dishes/<id>/image?v=…), never with
// this server's address: a backup restored elsewhere still finds it. The
// public menu puts PUBLIC_BASE_URL in front (routes/dishes.ts).

/** A dish's own picture, by path: /dishes/<id>/image, with or without an address in front. */
const OWN_PICTURE = /^(?:https?:\/\/[^/?#]+)?\/dishes\/([^/?#]+)\/image(?:[?#].*)?$/i;

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return '';
  }
};

/** Where a dish's own picture is served (a path; the version makes clients load a new one). */
export function ownPictureUrl(dishId: string): string {
  return `/dishes/${encodeURIComponent(dishId)}/image?v=${Date.now()}`;
}

/** Whether `url` is a link to a picture somewhere else, which the server fetches. */
export function isLinkedPicture(url: string): boolean {
  return /^https?:\/\//i.test(url) && !OWN_PICTURE.test(url);
}

// Into the internal network only for the hosts the operator names in
// MENSA_PICTURE_INTERNAL_HOSTS (none by default): whoever may edit a dish can
// paste a link, so a link alone never opens the inside, not even on the host
// of the operator's own source.
function mayReachInternal(url: string): boolean {
  try {
    return config.mensaPictureInternalHosts.includes(new URL(url).host.toLowerCase());
  } catch {
    return false;
  }
}

interface Failure {
  failures: number;
  nextTry: number;
  error: string;
}

// The links that failed, per node (only one node fetches by itself).
const failed = new Map<string, Failure>();
const RETRY_FIRST_MS = 10 * 60 * 1000;
const RETRY_MAX_MS = 6 * 60 * 60 * 1000;

function fetchError(err: unknown): string {
  if (err instanceof PictureError) return err.message;
  if (err instanceof BlockedAddressError) return 'Die Adresse zeigt ins interne Netz';
  const text = err instanceof Error ? err.message : String(err);
  if (/status 404|status 410/.test(text)) return 'Das Bild gibt es dort nicht (mehr)';
  if (/status \d+/.test(text)) return `Der Server des Bildes antwortet mit ${text.match(/status (\d+)/)![1]}`;
  if (/too large/.test(text)) return 'Das Bild ist zu groß (höchstens 10 MB)';
  if (/timeout/.test(text)) return 'Der Server des Bildes antwortet nicht';
  if (/ENOTFOUND|EAI_AGAIN/.test(text)) return 'Den Server des Bildes gibt es nicht';
  return 'Das Bild konnte nicht geholt werden';
}

export type AdoptOutcome = { ok: true; dishes: number } | { ok: false; error: string };

/**
 * Fetches the picture of `url` and gives it to every dish that names this
 * link: its own copy, the link kept beside it. A dish that names another
 * picture by then keeps that one.
 */
export async function adoptPicture(url: string): Promise<AdoptOutcome> {
  if (!isLinkedPicture(url) || url.length > 1000) return { ok: false, error: 'Das ist kein Link zu einem Bild' };
  let picture;
  try {
    // On a host the operator opened the inside for, no redirect is followed:
    // it could lead the server on to any other address inside.
    const internal = mayReachInternal(url);
    const bytes = await fetchBytes(url, {
      publicOnly: !internal,
      maxBytes: MAX_FETCHED_BYTES,
      redirects: internal ? 0 : 3,
      accept: 'image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1',
    });
    picture = await toWebp(bytes);
  } catch (err) {
    const error = fetchError(err);
    const before = failed.get(url);
    const failures = (before?.failures ?? 0) + 1;
    failed.set(url, { failures, error, nextTry: Date.now() + Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (failures - 1)) });
    logger.warn('dish picture not taken over', { url: url.slice(0, 200), error, failures });
    return { ok: false, error };
  }
  failed.delete(url);

  const dishes = await prisma.dish.findMany({ where: { imageUrl: url }, select: { id: true } });
  let taken = 0;
  await prisma.$transaction(async (tx) => {
    for (const { id } of dishes) {
      // Only while it still names this link: an upload in between wins.
      const { count } = await tx.dish.updateMany({ where: { id, imageUrl: url }, data: { imageUrl: ownPictureUrl(id) } });
      if (count === 0) continue;
      await tx.dishImage.upsert({
        where: { dishId: id },
        create: { dishId: id, data: picture.data, mimeType: picture.mimeType, sourceUrl: url },
        update: { data: picture.data, mimeType: picture.mimeType, sourceUrl: url },
      });
      taken++;
    }
  });
  if (taken > 0) {
    invalidateDishesCache();
    logger.info('dish picture taken over', { url: url.slice(0, 200), dishes: taken, bytes: picture.data.length });
  }
  return { ok: true, dishes: taken };
}

/** The links dishes name now, each once. */
async function linkedPictures(menuId?: string): Promise<string[]> {
  const rows = await prisma.dish.findMany({
    where: { imageUrl: { startsWith: 'http' }, ...(menuId ? { menuId } : {}) },
    select: { imageUrl: true },
    distinct: ['imageUrl'],
  });
  return rows.map((r) => r.imageUrl).filter(isLinkedPicture);
}

export interface AdoptRound {
  taken: number;
  failed: Array<{ url: string; error: string }>;
  /** Links still waiting, failed ones included. */
  left: number;
}

/**
 * Takes over the pictures dishes only link to: at most `max` links a round,
 * the ones that failed only when their next try is due (or `now`), and no new
 * one once `budgetMs` has passed (the rest waits for the next round).
 */
export async function adoptPictures({ max = 25, now = false, menuId, budgetMs = Infinity }: { max?: number; now?: boolean; menuId?: string; budgetMs?: number } = {}): Promise<AdoptRound> {
  const started = Date.now();
  const links = await linkedPictures(menuId);
  // Links no dish names any more are forgotten (a round over all menus knows them all).
  if (!menuId) for (const url of failed.keys()) if (!links.includes(url)) failed.delete(url);
  const due = links.filter((url) => now || (failed.get(url)?.nextTry ?? 0) <= Date.now()).slice(0, max);
  const round: AdoptRound = { taken: 0, failed: [], left: 0 };
  // Two at a time: polite to the sites, quick enough for a plan of 30.
  for (let i = 0; i < due.length && Date.now() - started < budgetMs; i += 2) {
    const results = await Promise.all(due.slice(i, i + 2).map(async (url) => ({ url, outcome: await adoptPicture(url) })));
    for (const { url, outcome } of results) {
      if (outcome.ok) round.taken += outcome.dishes;
      else round.failed.push({ url, error: outcome.error });
    }
  }
  round.left = (await linkedPictures(menuId)).length;
  return round;
}

export interface PictureStatus {
  /** Dishes with their picture in the database. */
  kept: number;
  /** Dishes that only link to a picture. */
  linked: number;
  /** Links that failed on this node, with why and when they are tried again. */
  failing: Array<{ url: string; error: string; nextTry: string }>;
}

export async function pictureStatus(menuId: string): Promise<PictureStatus> {
  const [kept, linkedRows] = await Promise.all([
    prisma.dish.count({ where: { menuId, imageUrl: { startsWith: '/dishes/' } } }),
    prisma.dish.findMany({ where: { menuId, imageUrl: { startsWith: 'http' } }, select: { imageUrl: true } }),
  ]);
  const linked = linkedRows.filter((r) => isLinkedPicture(r.imageUrl));
  const urls = new Set(linked.map((r) => r.imageUrl));
  const failing = [...failed.entries()].filter(([url]) => urls.has(url)).map(([url, f]) => ({ url, error: f.error, nextTry: new Date(f.nextTry).toISOString() }));
  return { kept, linked: linked.length, failing };
}

/**
 * Dishes that name their own picture with an address in front (as stored
 * before 2026-11-10) name it by path from now on. Idempotent.
 */
export async function ownPicturesByPath(): Promise<number> {
  const rows = (await prisma.dish.findMany({ where: { imageUrl: { contains: '/dishes/' } }, select: { id: true, imageUrl: true } }))
    .filter((row) => /^https?:\/\//i.test(row.imageUrl));
  if (rows.length === 0) return 0;
  const kept = new Set((await prisma.dishImage.findMany({ where: { dishId: { in: rows.map((r) => r.id) } }, select: { dishId: true } })).map((r) => r.dishId));
  let changed = 0;
  for (const row of rows) {
    const m = row.imageUrl.match(OWN_PICTURE);
    // Its own picture, kept here: never another server's path that looks alike.
    if (!m || !kept.has(row.id) || safeDecode(m[1]!) !== row.id) continue;
    const path = row.imageUrl.slice(row.imageUrl.indexOf('/dishes/'));
    const { count } = await prisma.dish.updateMany({ where: { id: row.id, imageUrl: row.imageUrl }, data: { imageUrl: path } });
    changed += count;
  }
  if (changed > 0) {
    invalidateDishesCache();
    logger.info('dish pictures named by path', { dishes: changed });
  }
  return changed;
}

let running = false;
let kicked: NodeJS.Timeout | null = null;

async function round(now = false): Promise<void> {
  if (running) return;
  running = true;
  try {
    await ownPicturesByPath();
    const r = await adoptPictures({ now });
    if (r.taken > 0 || r.failed.length > 0) logger.info('dish pictures round', { taken: r.taken, failed: r.failed.length, left: r.left });
  } catch (err) {
    logger.warn('dish pictures round failed', { error: err instanceof Error ? err.message : String(err) });
  } finally {
    running = false;
  }
}

/** A round soon, after new dishes came in (a pull, an import). */
export function kickPictures(): void {
  if (kicked) return;
  kicked = setTimeout(() => {
    kicked = null;
    void round();
  }, 2_000);
  kicked.unref?.();
}

const ROUND_EVERY_MS = 10 * 60 * 1000;
const FIRST_ROUND_MS = 30 * 1000;

/** Takes linked pictures over by itself: on the node that does the cluster's work. */
export function startDishPictures(): void {
  const run = () => {
    if (!ownsClusterWork('job:dish-pictures')) return;
    void round();
  };
  setTimeout(run, FIRST_ROUND_MS).unref?.();
  setInterval(run, ROUND_EVERY_MS).unref?.();
}
