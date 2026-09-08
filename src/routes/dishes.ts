import { Router, Request, Response } from 'express';
import { prisma } from '../db';
import { readLimiter } from '../middleware/rateLimiter';
import { dishesCache, currentSeason, dishesCacheKey } from '../utils/cache';
import { rotatePastWeeks } from '../utils/mensaRotate';
import { logger } from '../utils/logger';

const router = Router();

function dishToJson(d: {
  id: string;
  nameDe: string; nameIt: string; nameEn: string;
  descDe: string; descIt: string; descEn: string;
  imageUrl: string; category: string; tags: string;
  prepTime: number; calories: number; price: number;
  protein: number; fat: number; allergens: string;
  isVegetarian: boolean; isVegan: boolean; date: Date;
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

  return {
    id: d.id,
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
// Automatically serves the season-appropriate plan: April–October = summer,
// otherwise winter. On cache miss we also opportunistically rotate any past
// weeks to the end of the plan so the menu is always "rolling" without any
// admin action. The rotate is idempotent and no-op when nothing has expired.
router.get('/', readLimiter, async (_req: Request, res: Response): Promise<void> => {
  const season = currentSeason();
  const cacheKey = dishesCacheKey(season);
  const cached = dishesCache.get(cacheKey);
  if (cached !== undefined) {
    res.json(cached);
    return;
  }

  try {
    await rotatePastWeeks(season);
  } catch (err) {
    // Rotation failure must not block serving the (possibly stale) menu.
    logger.warn('opportunistic rotate failed', {
      season, error: err instanceof Error ? err.message : String(err),
    });
  }

  const dishes = await prisma.dish.findMany({
    where: { plan: season },
    orderBy: [{ date: 'asc' }, { sortOrder: 'asc' }, { nameDe: 'asc' }],
  });

  const payload = { menu: { dishes: dishes.map(dishToJson) } };
  dishesCache.set(cacheKey, payload);
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
