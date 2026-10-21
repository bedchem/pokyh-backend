import { prisma } from '../db';
import { sseManager } from './sse';
import { withStars } from '../utils/commentStars';

// Dish comments are shown per menu: the schools sharing a menu share its
// comment threads; another menu's dish of the same name is another thread.

export function commentsStreamKey(menuId: string | null, dishKey: string): string {
  return `dishComments:${menuId ?? 'none'}:${dishKey}`;
}

// Each comment comes with its author's stars for the dish (utils/commentStars.ts).
export async function commentsForDish(menuId: string | null, dishKey: string) {
  const [comments, votes] = await Promise.all([
    prisma.dishComment.findMany({
      where: { dishId: dishKey, menuId },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.dishRating.findMany({
      where: { dishId: dishKey, menuId },
      select: { stableUid: true, username: true, schoolId: true, stars: true },
    }),
  ]);
  return withStars(comments, votes);
}

// Pushes a dish's current comments to everyone watching it.
export async function publishDishComments(menuId: string | null, dishKey: string): Promise<void> {
  const key = commentsStreamKey(menuId, dishKey);
  if (sseManager.getClientCount(key) === 0) return;
  sseManager.broadcast(key, 'dishComments', await commentsForDish(menuId, dishKey));
}
