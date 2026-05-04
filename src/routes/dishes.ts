import { Router, Request, Response } from 'express';
import { prisma } from '../db';
import { readLimiter } from '../middleware/rateLimiter';

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

  return {
    id: d.id,
    name: { de: d.nameDe, it: d.nameIt || d.nameDe, en: d.nameEn || d.nameDe },
    description: { de: d.descDe, it: d.descIt, en: d.descEn },
    imageUrl: d.imageUrl,
    category: d.category,
    tags,
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

// GET /dishes — mensa.json-compatible response
router.get('/', readLimiter, async (_req: Request, res: Response): Promise<void> => {
  const dishes = await prisma.dish.findMany({
    orderBy: [{ date: 'asc' }, { sortOrder: 'asc' }, { nameDe: 'asc' }],
  });

  res.json({ menu: { dishes: dishes.map(dishToJson) } });
});

export { router as dishesRouter };
