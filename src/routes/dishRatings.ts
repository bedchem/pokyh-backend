import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { readLimiter, writeLimiter } from '../middleware/rateLimiter';
import { resolveDishKey, slugifyDishName } from '../utils/dishKey';
import { publishDishRatings, ratingsPayload, reclaimDishRatings, type DishRatingsPayload } from '../services/dishRatings';

const router = Router();

// Ratings are keyed by dish stableKey (a slug of nameDe), not by the internal
// UUID. That way a reset — which regenerates dish rows — never orphans a
// rating, and same-name dishes in Sommer/Winter share the same rating.

async function getDishRatingsData(dishKey: string, myStableUid: string | undefined): Promise<DishRatingsPayload> {
  const rows = await prisma.dishRating.findMany({ where: { dishId: dishKey } });
  return ratingsPayload(rows, myStableUid);
}

// Guests may read ratings, but never see who rated: replace stableUids with
// positional keys so only the average and count can be derived.
function anonymizeRatings(data: DishRatingsPayload): DishRatingsPayload {
  const ratings: Record<string, number> = {};
  Object.values(data.ratings).forEach((stars, i) => { ratings[String(i)] = stars; });
  return { ratings, myRating: null };
}

// GET /dish-ratings/:dishId — public read; myRating only with a session
router.get('/:dishId', readLimiter, optionalAuth, async (req: Request, res: Response) => {
  const raw = req.params['dishId'] as string;
  const stableUid = req.user?.stableUid;

  const dishKey = await resolveDishKey(raw);
  const data = await getDishRatingsData(dishKey, stableUid);
  res.json(stableUid ? data : anonymizeRatings(data));
});

// POST /dish-ratings/batch — get ratings for multiple dishes
const batchSchema = z.object({
  dishIds: z.array(z.string()).min(1).max(100),
});

router.post('/batch', readLimiter, optionalAuth, async (req: Request, res: Response) => {
  const stableUid = req.user?.stableUid;
  const { dishIds } = batchSchema.parse(req.body);

  // Resolve each incoming id → stableKey; keep a reverse map so we can echo the
  // original id back to the client (backwards compatible with older frontends).
  const keyByInput = new Map<string, string>();
  for (const id of dishIds) keyByInput.set(id, await resolveDishKey(id));
  const uniqueKeys = [...new Set(keyByInput.values())];

  const rows = await prisma.dishRating.findMany({
    where: { dishId: { in: uniqueKeys } },
  });

  const rowsByKey = new Map<string, typeof rows>();
  for (const row of rows) rowsByKey.set(row.dishId, [...(rowsByKey.get(row.dishId) ?? []), row]);

  const result: Record<string, DishRatingsPayload> = {};
  for (const [inputId, key] of keyByInput) {
    const entry = ratingsPayload(rowsByKey.get(key) ?? [], stableUid);
    result[inputId] = stableUid ? entry : anonymizeRatings(entry);
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
  const { stableUid, username } = req.user!;
  const { stars, name } = rateSchema.parse(req.body);

  // Prefer resolving via existing dish → its slug. If nothing matches and a
  // name is provided, fall back to slugifying the name so users can still rate
  // dishes that haven't been registered yet.
  let dishKey = await resolveDishKey(raw);
  if (!dishKey && name) dishKey = slugifyDishName(name);
  if (!dishKey) dishKey = raw; // last resort — echo back

  // Pull any earlier vote of this person (under an old stableUid) onto the
  // current one first, so the upsert changes it instead of adding a second.
  await reclaimDishRatings(stableUid, username);

  await prisma.dishRating.upsert({
    where: { dishId_stableUid: { dishId: dishKey, stableUid } },
    create: { dishId: dishKey, stableUid, username, stars },
    update: { stars, username },
  });

  // Every open app and browser — Android and web — gets the new numbers live.
  await publishDishRatings(dishKey);

  res.json(await getDishRatingsData(dishKey, stableUid));
});

export { router as dishRatingsRouter };
