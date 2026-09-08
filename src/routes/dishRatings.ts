import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { readLimiter, writeLimiter } from '../middleware/rateLimiter';
import { sseManager } from '../services/sse';
import { resolveDishKey, slugifyDishName } from '../utils/dishKey';

const router = Router();

// Ratings are keyed by dish stableKey (a slug of nameDe), not by the internal
// UUID. That way a reset — which regenerates dish rows — never orphans a
// rating, and same-name dishes in Sommer/Winter share the same rating.

async function getDishRatingsData(dishKey: string, myStableUid: string) {
  const rows = await prisma.dishRating.findMany({ where: { dishId: dishKey } });
  const ratings: Record<string, number> = {};
  let myRating: number | null = null;

  for (const row of rows) {
    ratings[row.stableUid] = row.stars;
    if (row.stableUid === myStableUid) {
      myRating = row.stars;
    }
  }

  return { ratings, myRating };
}

// GET /dish-ratings/:dishId
router.get('/:dishId', readLimiter, requireAuth, async (req: Request, res: Response) => {
  const raw = req.params['dishId'] as string;
  const { stableUid } = req.user!;

  const dishKey = await resolveDishKey(raw);
  const data = await getDishRatingsData(dishKey, stableUid);
  res.json(data);
});

// POST /dish-ratings/batch — get ratings for multiple dishes
const batchSchema = z.object({
  dishIds: z.array(z.string()).min(1).max(100),
});

router.post('/batch', readLimiter, requireAuth, async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  const { dishIds } = batchSchema.parse(req.body);

  // Resolve each incoming id → stableKey; keep a reverse map so we can echo the
  // original id back to the client (backwards compatible with older frontends).
  const keyByInput = new Map<string, string>();
  for (const id of dishIds) keyByInput.set(id, await resolveDishKey(id));
  const uniqueKeys = [...new Set(keyByInput.values())];

  const rows = await prisma.dishRating.findMany({
    where: { dishId: { in: uniqueKeys } },
  });

  const byKey = new Map<string, { ratings: Record<string, number>; myRating: number | null }>();
  for (const k of uniqueKeys) byKey.set(k, { ratings: {}, myRating: null });
  for (const row of rows) {
    const entry = byKey.get(row.dishId);
    if (!entry) continue;
    entry.ratings[row.stableUid] = row.stars;
    if (row.stableUid === stableUid) entry.myRating = row.stars;
  }

  const result: Record<string, { ratings: Record<string, number>; myRating: number | null }> = {};
  for (const [inputId, key] of keyByInput) {
    const entry = byKey.get(key) ?? { ratings: {}, myRating: null };
    result[inputId] = entry;
  }

  res.json(result);
});

// POST /dish-ratings/:dishId — rate a dish (upsert)
const rateSchema = z.object({
  stars: z.number().int().min(1).max(5),
  name: z.string().max(500).optional(),
  imageUrl: z.string().max(1000).optional(),
});

router.post('/:dishId', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const raw = req.params['dishId'] as string;
  const { stableUid } = req.user!;
  const { stars, name } = rateSchema.parse(req.body);

  // Prefer resolving via existing dish → its slug. If nothing matches and a
  // name is provided, fall back to slugifying the name so users can still rate
  // dishes that haven't been registered yet.
  let dishKey = await resolveDishKey(raw);
  if (!dishKey && name) dishKey = slugifyDishName(name);
  if (!dishKey) dishKey = raw; // last resort — echo back

  await prisma.dishRating.upsert({
    where: { dishId_stableUid: { dishId: dishKey, stableUid } },
    create: { dishId: dishKey, stableUid, stars },
    update: { stars },
  });

  const data = await getDishRatingsData(dishKey, stableUid);
  // Broadcast on BOTH channels so old frontends (subscribing by the raw id
  // they last saw) still get updates alongside new frontends (using the key).
  sseManager.broadcast(`dishRatings:${dishKey}`, 'dishRatings', data);
  if (raw !== dishKey) sseManager.broadcast(`dishRatings:${raw}`, 'dishRatings', data);

  res.json(data);
});

export { router as dishRatingsRouter };
