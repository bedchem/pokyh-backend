import { Router, Request, Response } from 'express';
import { prisma } from '../db';
import { readLimiter } from '../middleware/rateLimiter';
import { dishesCacheKey } from '../utils/cache';
import { cached } from '../services/cache';
import { config } from '../config';
import { currentWeekMondayIso, rotatePastWeeks } from '../utils/mensaRotate';
import { servedDishes } from '../utils/mensaSeason';
import { slugifyDishName } from '../utils/dishKey';
import { logger } from '../utils/logger';
import { optionalAuth } from '../middleware/auth';
import { menuContext } from '../services/schools';

const router = Router();

function dishToJson(d: {
  id: string;
  nameDe: string; nameIt: string; nameEn: string;
  descDe: string; descIt: string; descEn: string;
  imageUrl: string; category: string; tags: string;
  prepTime: number; calories: number; price: number;
  protein: number; fat: number; allergens: string;
  isVegetarian: boolean; isVegan: boolean; date: Date;
  stableKey: string;
}) {
  let tags: string[] = [];
  let allergens: string[] = [];
  try { tags = JSON.parse(d.tags); } catch { /* ignore */ }
  try { allergens = JSON.parse(d.allergens); } catch { /* ignore */ }

  const normalizedTags = new Map<string, string>();
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const trimmed = tag.trim();
    if (!trimmed) continue;
    normalizedTags.set(trimmed.toLowerCase(), trimmed);
  }
  if (d.isVegetarian) normalizedTags.set('vegetarisch', 'Vegetarisch');
  if (d.isVegan) normalizedTags.set('vegan', 'Vegan');

  // Expose the stableKey as the public `id` so ratings/comments the frontend
  // sends land on a key that survives resets and is shared between Sommer and
  // Winter when the dish name matches. `internalId` remains available for the
  // image URL, which is looked up by the true PK.
  const publicId = d.stableKey || slugifyDishName(d.nameDe) || d.id;
  return {
    id: publicId,
    internalId: d.id,
    name: { de: d.nameDe, it: d.nameIt || d.nameDe, en: d.nameEn || d.nameDe },
    description: { de: d.descDe, it: d.descIt, en: d.descEn },
    imageUrl: d.imageUrl,
    category: d.category,
    tags: Array.from(normalizedTags.values()),
    prepTime: d.prepTime,
    calories: d.calories,
    price: d.price,
    protein: d.protein,
    fat: d.fat,
    allergens,
    isVegetarian: d.isVegetarian,
    isVegan: d.isVegan,
    date: d.date.toISOString().split('T')[0],
  };
}

// GET /dishes — mensa.json-compatible response (cached in-memory, TTL via env).
// The menu of one school: a signed-in account's own, a guest's ?school=
// (id or slug), or the default school's — what every client got before
// schools existed. A school without a menu gets an empty one.
// Every week is served from the plan of its season (utils/mensaSeason): summer
// from the switch to summer time, winter from the switch to winter time, so in
// the week before a switch "next week" already shows the other plan. A week
// the season's plan has no dishes for is served from the other plan. On cache
// miss we also opportunistically rotate any past weeks of both plans to their
// end so the menu is always "rolling" without any admin action. The rotate is
// idempotent and no-op when nothing has expired.
router.get('/', readLimiter, optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const { menuId } = await menuContext(req);
  // `available: false`: this school has no menu — the app shows no Mensa at
  // all rather than an empty week.
  if (!menuId) {
    res.json({ available: false, menu: { dishes: [] } });
    return;
  }
  // Shared through Redis (services/cache.ts); any dish write drops it, the
  // TTL makes sure past weeks are rotated even when nobody writes.
  const payload = await cached(dishesCacheKey(menuId, currentWeekMondayIso()), ['Dish', 'DishImage'], Math.max(1, Math.round(config.cacheTtlMs / 1000)), async () => {
    for (const season of ['summer', 'winter'] as const) {
      try {
        await rotatePastWeeks(menuId, season);
      } catch (err) {
        // Rotation failure must not block serving the (possibly stale) menu.
        logger.warn('opportunistic rotate failed', {
          season, error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const dishes = await prisma.dish.findMany({
      where: { menuId },
      orderBy: [{ date: 'asc' }, { sortOrder: 'asc' }, { nameDe: 'asc' }],
    });
    return { available: true, menu: { dishes: servedDishes(dishes).map(dishToJson) } };
  });
  res.json(payload);
});

// GET /dishes/:id/image — serve an uploaded dish image (public, cacheable)
router.get('/:id/image', readLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  const row = await prisma.dishImage.findUnique({ where: { dishId: id } });
  if (!row) { res.status(404).end(); return; }
  const etag = `"${row.updatedAt.getTime()}"`;
  if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
  res.setHeader('ETag', etag);
  res.setHeader('Content-Type', row.mimeType);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.end(row.data);
});

export { router as dishesRouter };
