import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { readLimiter, writeLimiter } from '../middleware/rateLimiter';
import { sseManager } from '../services/sse';

const router = Router();

async function getDishRatingsData(dishId: string, myStableUid: string) {
  const rows = await prisma.dishRating.findMany({ where: { dishId } });
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
  const dishId = req.params['dishId'] as string;
  const { stableUid } = req.user!;

  const data = await getDishRatingsData(dishId, stableUid);
  res.json(data);
});

// POST /dish-ratings/batch — get ratings for multiple dishes
const batchSchema = z.object({
  dishIds: z.array(z.string()).min(1).max(100),
});

router.post('/batch', readLimiter, requireAuth, async (req: Request, res: Response) => {
  const { stableUid } = req.user!;
  const { dishIds } = batchSchema.parse(req.body);

  const rows = await prisma.dishRating.findMany({
    where: { dishId: { in: dishIds } },
  });

  const result: Record<string, { ratings: Record<string, number>; myRating: number | null }> = {};

  for (const dishId of dishIds) {
    result[dishId] = { ratings: {}, myRating: null };
  }

  for (const row of rows) {
    if (!result[row.dishId]) {
      result[row.dishId] = { ratings: {}, myRating: null };
    }
    result[row.dishId].ratings[row.stableUid] = row.stars;
    if (row.stableUid === stableUid) {
      result[row.dishId].myRating = row.stars;
    }
  }

  res.json(result);
});

// POST /dish-ratings/:dishId — rate a dish (upsert)
const rateSchema = z.object({
  stars: z.number().int().min(1).max(5),
});

router.post('/:dishId', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const dishId = req.params['dishId'] as string;
  const { stableUid } = req.user!;
  const { stars } = rateSchema.parse(req.body);

  await prisma.dishRating.upsert({
    where: { dishId_stableUid: { dishId, stableUid } },
    create: { dishId, stableUid, stars },
    update: { stars },
  });

  const data = await getDishRatingsData(dishId, stableUid);
  sseManager.broadcast(`dishRatings:${dishId}`, 'dishRatings', data);

  res.json(data);
});

export { router as dishRatingsRouter };
