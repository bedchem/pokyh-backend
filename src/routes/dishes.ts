import { Router, Request, Response } from 'express';
import { prisma } from '../db';
import { readLimiter } from '../middleware/rateLimiter';
import { dishesCacheKey } from '../utils/cache';
import { cached } from '../services/cache';
import { config } from '../config';
import { currentWeekMondayIso, isoAddDays } from '../utils/mensaRotate';
import { servedDishes } from '../utils/mensaSeason';
import { menuBreaks, publicDishes } from '../utils/mensaSchedule';
import { arrangeMenu, menuSchedule } from '../services/mensaSchedule';
import { slugifyDishName } from '../utils/dishKey';
import { logger } from '../utils/logger';
import { optionalAuth } from '../middleware/auth';
import { menuContext } from '../services/schools';

const router = Router();

// How far ahead a client is told about breaks: past the end of any plan cycle.
const BREAKS_AHEAD_DAYS = 200;

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
    // An uploaded picture is stored by its path until PUBLIC_BASE_URL says on
    // which address clients reach it; it is POKYH's own, not from another site.
    imageUrl: d.imageUrl.startsWith('/') ? `${config.publicBaseUrl}${d.imageUrl}` : d.imageUrl,
    ownImage: d.imageUrl.includes(`/dishes/${d.id}/image`),
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
// Every day is served from the plan of its season (utils/mensaSeason): on the
// dates the canteen's plans name, or with the clocks; so in the week before a
// switch "next week" already shows the other plan. A day the season's plan
// has no dishes for is served from the other plan.
// On cache miss the menu is also brought up to date without any admin action
// (services/mensaSchedule): by default each plan week lies in the week the
// canteen serves it (one rotation, every calendar week counted) and holidays,
// named in `breaks`, have no dishes; a menu set to manual keeps its dates and
// only has past weeks rolled to the end of their plan.
// Idempotent and no write when nothing has changed.
router.get('/', readLimiter, optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const { menuId } = await menuContext(req);
  // `available: false`: this school has no menu — the app shows no Mensa at
  // all rather than an empty week.
  if (!menuId) {
    res.json({ available: false, menu: { dishes: [] } });
    return;
  }
  // Shared through Redis (services/cache.ts); any write to what it is built
  // from drops it, the TTL makes sure past weeks move on even when nobody writes.
  const currentMonday = currentWeekMondayIso();
  const payload = await cached(dishesCacheKey(menuId, currentMonday), ['Dish', 'DishImage', 'MensaMenu', 'MensaMenuSchool', 'SchoolHolidays'], Math.max(1, Math.round(config.cacheTtlMs / 1000)), async () => {
    const schedule = await menuSchedule(menuId);
    try {
      await arrangeMenu(menuId, schedule);
    } catch (err) {
      // Moving weeks must not block serving the (possibly stale) menu.
      logger.warn('opportunistic menu arrangement failed', {
        mode: schedule.mode, error: err instanceof Error ? err.message : String(err),
      });
    }

    const dishes = await prisma.dish.findMany({
      where: { menuId },
      orderBy: [{ date: 'asc' }, { sortOrder: 'asc' }, { nameDe: 'asc' }],
    });
    if (schedule.mode === 'manual') {
      return { available: true, menu: { dishes: oncePerDay(servedDishes(dishes, schedule.season).map(dishToJson)) }, breaks: [] };
    }
    return {
      available: true,
      menu: { dishes: oncePerDay(publicDishes(dishes, currentMonday, schedule.dayOffOf, schedule.season).map(dishToJson)) },
      breaks: menuBreaks(schedule.dayOffOf, currentMonday, isoAddDays(currentMonday, BREAKS_AHEAD_DAYS)),
    };
  });
  // Briefly kept by the browser (the menu changes rarely; ratings come live).
  res.setHeader('Cache-Control', 'private, max-age=30, stale-while-revalidate=300');
  res.json(payload);
});

// The vegetarian menu sometimes has the main dish itself: a dish is served once
// a day, vegetarian when either of them is.
type DishJson = ReturnType<typeof dishToJson>;
function oncePerDay(list: DishJson[]): DishJson[] {
  const kept = new Map<string, DishJson>();
  for (const d of list) {
    const key = `${d.date}|${d.id}`;
    const first = kept.get(key);
    if (!first) {
      kept.set(key, d);
      continue;
    }
    if (d.isVegetarian && !first.isVegetarian) {
      first.isVegetarian = true;
      if (!first.tags.some((t) => t.toLowerCase() === 'vegetarisch')) first.tags.push('Vegetarisch');
    }
  }
  return [...kept.values()];
}

// GET /dishes/:id/image — serve an uploaded dish image (public, cacheable)
router.get('/:id/image', readLimiter, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params['id']);
  // The picture's date first: a browser that has it gets its 304 without the
  // picture being read from the database at all.
  const meta = await prisma.dishImage.findUnique({ where: { dishId: id }, select: { updatedAt: true, mimeType: true } });
  if (!meta) { res.status(404).end(); return; }
  const etag = `"${meta.updatedAt.getTime()}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
  const row = await prisma.dishImage.findUnique({ where: { dishId: id }, select: { data: true } });
  if (!row) { res.status(404).end(); return; }
  res.setHeader('Content-Type', meta.mimeType);
  res.setHeader('Content-Length', row.data.length);
  res.end(row.data);
});

export { router as dishesRouter };
