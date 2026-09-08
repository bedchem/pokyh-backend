import https from 'https';
import http from 'http';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from './logger';

function fetchUrl(url: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'pokyh-backend/1.0' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('fetch timeout')); });
  });
}

function nameDeFrom(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const m = v as Record<string, string>;
    return m['de'] ?? m['it'] ?? m['en'] ?? Object.values(m)[0] ?? '';
  }
  return '';
}

// Fetch the configured mensa.json and return a map sourceId → nameDe. Used to
// recover the names of dishes whose rating/comment rows survive after the dish
// itself was deleted (typically by a "reset auf JSON"). Returns an empty map
// on network/parse failure — the migration then just skips those rows.
async function fetchSourceIdNameMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const raw = await fetchUrl(config.mensaImportUrl);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const menu = parsed['menu'] as Record<string, unknown> | undefined;
    const list = (menu?.['dishes'] ?? []) as Array<Record<string, unknown>>;
    for (const d of list) {
      const sid = d['id'] ? String(d['id']) : '';
      const name = nameDeFrom(d['name']);
      if (sid && name) map.set(sid, name);
    }
  } catch (err) {
    logger.warn('stableKey migration: JSON recovery skipped', { error: err instanceof Error ? err.message : String(err) });
  }
  return map;
}

// Normalise a German dish name into a stable, plan-independent key. Same name
// in Sommer and Winter → same key → shared ratings/comments.
const DIACRITICS_RE = new RegExp('[̀-ͯ]', 'g');

export function slugifyDishName(name: string): string {
  const s = (name ?? '').toString();
  const stripped = s
    .toLowerCase()
    .normalize('NFD')
    .replace(DIACRITICS_RE, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Truncate to fit the VarChar(200) column with headroom.
  return stripped.slice(0, 180);
}

// Resolve whatever the client sent as "dishId" (may be an internal UUID from a
// pre-migration cache, or already the stable key) to the current stable key.
// Returns null when the id doesn't map to any known dish AND doesn't look like
// an already-migrated key (i.e. genuinely unknown).
export async function resolveDishKey(idOrKey: string): Promise<string> {
  if (!idOrKey) return '';
  // First: is it an internal UUID for an existing dish? Then use that dish's key.
  const byId = await prisma.dish.findUnique({ where: { id: idOrKey }, select: { stableKey: true, nameDe: true } });
  if (byId) {
    if (byId.stableKey) return byId.stableKey;
    // Legacy row not yet migrated — compute on the fly (and persist).
    const key = slugifyDishName(byId.nameDe);
    await prisma.dish.update({ where: { id: idOrKey }, data: { stableKey: key } }).catch(() => null);
    return key;
  }
  // Not a dish id → assume it's already a key (or a stale reference).
  return idOrKey;
}

// One-time bootstrap that populates stableKey on every dish and rewrites
// DishRating/DishComment.dishId columns from internal UUIDs to the stableKey.
// Idempotent: rows already using stableKey are skipped, duplicates that would
// violate the (dishId, stableUid) unique constraint are merged (highest star
// / newest updatedAt wins).
export async function migrateStableKeys(): Promise<{ dishes: number; ratings: number; comments: number; ratingConflicts: number }> {
  const dishes = await prisma.dish.findMany({ select: { id: true, nameDe: true, stableKey: true } });
  let dishesUpdated = 0;
  const idToKey = new Map<string, string>();
  for (const d of dishes) {
    const key = d.stableKey || slugifyDishName(d.nameDe);
    idToKey.set(d.id, key);
    if (!d.stableKey) {
      await prisma.dish.update({ where: { id: d.id }, data: { stableKey: key } });
      dishesUpdated++;
    }
  }
  const allKeys = new Set(idToKey.values());

  // Ratings: rewrite dishId if it currently equals an internal UUID.
  const ratings = await prisma.dishRating.findMany();
  let ratingsUpdated = 0;
  let ratingConflicts = 0;
  for (const r of ratings) {
    const newKey = idToKey.get(r.dishId);
    if (!newKey) {
      // r.dishId isn't a known dish UUID — leave it (already a key, or orphan).
      continue;
    }
    if (r.dishId === newKey) continue;
    try {
      await prisma.dishRating.update({
        where: { dishId_stableUid: { dishId: r.dishId, stableUid: r.stableUid } },
        data: { dishId: newKey },
      });
      ratingsUpdated++;
    } catch {
      // Same (stableUid, newKey) already exists (e.g. user rated both the
      // summer and winter variant of the same dish). Keep the higher star.
      ratingConflicts++;
      const existing = await prisma.dishRating.findUnique({
        where: { dishId_stableUid: { dishId: newKey, stableUid: r.stableUid } },
      });
      if (existing && r.stars > existing.stars) {
        await prisma.dishRating.update({
          where: { dishId_stableUid: { dishId: newKey, stableUid: r.stableUid } },
          data: { stars: r.stars },
        });
      }
      await prisma.dishRating.delete({
        where: { dishId_stableUid: { dishId: r.dishId, stableUid: r.stableUid } },
      });
    }
  }

  // Comments: cheaper — no composite unique constraint.
  const comments = await prisma.dishComment.findMany({ select: { id: true, dishId: true } });
  let commentsUpdated = 0;
  for (const c of comments) {
    const newKey = idToKey.get(c.dishId);
    if (!newKey || c.dishId === newKey) continue;
    await prisma.dishComment.update({ where: { id: c.id }, data: { dishId: newKey } });
    commentsUpdated++;
  }

  // Orphan recovery: ratings/comments whose dishId is neither an existing UUID
  // nor a known stableKey. These are typically legacy source ids (like "w6_mo")
  // whose dish row got deleted by a reset. Fetch the current mensa.json and try
  // to map source id → name → slug.
  const orphanRatings = ratings.filter((r) => !idToKey.has(r.dishId) && !allKeys.has(r.dishId));
  const orphanComments = comments.filter((c) => !idToKey.has(c.dishId) && !allKeys.has(c.dishId));
  let recoveredRatings = 0;
  let recoveredComments = 0;

  if (orphanRatings.length > 0 || orphanComments.length > 0) {
    const sourceMap = await fetchSourceIdNameMap();
    if (sourceMap.size > 0) {
      for (const r of orphanRatings) {
        const name = sourceMap.get(r.dishId);
        if (!name) continue;
        const newKey = slugifyDishName(name);
        if (!newKey) continue;
        try {
          await prisma.dishRating.update({
            where: { dishId_stableUid: { dishId: r.dishId, stableUid: r.stableUid } },
            data: { dishId: newKey },
          });
          recoveredRatings++;
        } catch {
          ratingConflicts++;
          const existing = await prisma.dishRating.findUnique({
            where: { dishId_stableUid: { dishId: newKey, stableUid: r.stableUid } },
          });
          if (existing && r.stars > existing.stars) {
            await prisma.dishRating.update({
              where: { dishId_stableUid: { dishId: newKey, stableUid: r.stableUid } },
              data: { stars: r.stars },
            });
          }
          await prisma.dishRating.delete({
            where: { dishId_stableUid: { dishId: r.dishId, stableUid: r.stableUid } },
          }).catch(() => null);
        }
      }
      for (const c of orphanComments) {
        const name = sourceMap.get(c.dishId);
        if (!name) continue;
        const newKey = slugifyDishName(name);
        if (!newKey) continue;
        await prisma.dishComment.update({ where: { id: c.id }, data: { dishId: newKey } });
        recoveredComments++;
      }
    }
  }

  const stillOrphaned =
    orphanRatings.length - recoveredRatings + (orphanComments.length - recoveredComments);
  if (dishesUpdated || ratingsUpdated || commentsUpdated || recoveredRatings || recoveredComments) {
    logger.info('stableKey migration', {
      dishes: dishesUpdated,
      ratings: ratingsUpdated,
      comments: commentsUpdated,
      recoveredRatings,
      recoveredComments,
      ratingConflicts,
      stillOrphaned,
    });
  }
  return {
    dishes: dishesUpdated,
    ratings: ratingsUpdated + recoveredRatings,
    comments: commentsUpdated + recoveredComments,
    ratingConflicts,
  };
}
