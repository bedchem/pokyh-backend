import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { readLimiter, writeLimiter } from '../middleware/rateLimiter';
import { resolveDishKey, resolveDishKeys, slugifyDishName } from '../utils/dishKey';
import { ForbiddenError } from '../utils/errors';
import { publishDishRatings, ratingsPayload, reclaimDishRatings, type DishRatingsPayload } from '../services/dishRatings';
import { publishDishComments } from '../services/dishComments';
import { menuContext } from '../services/schools';
import { cached } from '../services/cache';

const router = Router();

// Ratings are keyed by dish stableKey (a slug of nameDe), not by the internal
// UUID. That way a reset — which regenerates dish rows — never orphans a
// rating, and same-name dishes in Sommer/Winter share the same rating.
// They count per menu: a signed-in account rates in its own school's menu,
// and reads that menu's votes (services/schools.ts menuContext).

async function getDishRatingsData(menuId: string | null, dishKey: string, myStableUid: string | undefined): Promise<DishRatingsPayload> {
  // The votes of a dish are kept in the shared cache per menu; each request
  // picks its own vote out of them. Any vote drops the entry.
  const rows = menuId
    ? await cached(`dish-ratings:${menuId}:${dishKey}`, ['DishRating'], 120, () => prisma.dishRating.findMany({ where: { dishId: dishKey, menuId } }))
    : [];
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
  const { menuId } = await menuContext(req);

  const dishKey = await resolveDishKey(raw);
  const data = await getDishRatingsData(menuId, dishKey, stableUid);
  res.json(stableUid ? data : anonymizeRatings(data));
});

// POST /dish-ratings/batch — get ratings for multiple dishes
const batchSchema = z.object({
  dishIds: z.array(z.string().max(200)).min(1).max(100),
});

router.post('/batch', readLimiter, optionalAuth, async (req: Request, res: Response) => {
  const stableUid = req.user?.stableUid;
  const { dishIds } = batchSchema.parse(req.body);
  const { menuId } = await menuContext(req);

  // Resolve each incoming id → stableKey (one query for all); keep a reverse
  // map so we can echo the original id back to the client (backwards
  // compatible with older frontends).
  const keyByInput = await resolveDishKeys(dishIds);
  const uniqueKeys = [...new Set(keyByInput.values())];

  const rows = menuId
    ? await prisma.dishRating.findMany({ where: { menuId, dishId: { in: uniqueKeys } } })
    : [];

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
  const { menuId, schoolId } = await menuContext(req);
  if (!menuId) throw new ForbiddenError('Deine Schule hat keinen Mensaplan');

  // Prefer resolving via existing dish → its slug. If nothing matches and a
  // name is provided, fall back to slugifying the name so users can still rate
  // dishes that haven't been registered yet.
  let dishKey = await resolveDishKey(raw);
  if (!dishKey && name) dishKey = slugifyDishName(name);
  if (!dishKey) dishKey = raw.slice(0, 180); // last resort — echo back

  // Pull any earlier vote of this person (under an old stableUid) onto the
  // current one first, so the upsert changes it instead of adding a second.
  await reclaimDishRatings(stableUid, username);

  await prisma.dishRating.upsert({
    where: { dishId_stableUid: { dishId: dishKey, stableUid } },
    create: { dishId: dishKey, stableUid, username, stars, menuId, schoolId },
    update: { stars, username, menuId, schoolId },
  });

  // Every open app and browser — Android and web — gets the new numbers live,
  // and the dish's comments the voter's new stars beside their name.
  await publishDishRatings(menuId, dishKey);
  await publishDishComments(menuId, dishKey);

  res.json(await getDishRatingsData(menuId, dishKey, stableUid));
});

export { router as dishRatingsRouter };
