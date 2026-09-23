import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { readLimiter, writeLimiter } from '../middleware/rateLimiter';
import { ForbiddenError, NotFoundError } from '../utils/errors';
import { sseManager } from '../services/sse';
import { resolveDishKey } from '../utils/dishKey';

const router = Router();

// Comments are keyed by dish stableKey — same rationale as dishRatings.

async function getCommentsForDish(dishKey: string) {
  return prisma.dishComment.findMany({
    where: { dishId: dishKey },
    orderBy: { createdAt: 'asc' },
  });
}

export function broadcastDishComments(dishKey: string, rawId: string, comments: unknown[]): void {
  sseManager.broadcast(`dishComments:${dishKey}`, 'dishComments', comments);
  if (rawId !== dishKey) sseManager.broadcast(`dishComments:${rawId}`, 'dishComments', comments);
}

const bodySchema = z.object({ body: z.string().min(1).max(2000) });

const DECOY_WORDS = [
  'Mensa', 'heute', 'wirklich', 'Essen', 'lecker', 'Portion', 'Soße', 'nochmal', 'eher', 'ganz',
  'warm', 'Beilage', 'gut', 'Nudeln', 'etwas', 'salzig', 'Nachschlag', 'okay', 'besser', 'als',
];
const DECOY_NAMES = ['Anonym', 'Gast', 'Jemand', 'Mensa-Fan'];

// Deterministic per comment so the guest view doesn't reshuffle on every fetch.
function decoyText(seed: string, length: number): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const words: string[] = [];
  let len = 0;
  while (len < length) {
    h = (h * 1103515245 + 12345) | 0;
    const word = DECOY_WORDS[Math.abs(h) % DECOY_WORDS.length];
    words.push(word);
    len += word.length + 1;
  }
  return words.join(' ');
}

// GET /dish-comments/:dishId — public read. Guests only get placeholders with
// the real count and timestamps; author and text stay behind the login.
router.get('/:dishId', readLimiter, optionalAuth, async (req: Request, res: Response) => {
  const raw = req.params['dishId'] as string;
  const key = await resolveDishKey(raw);
  const comments = await getCommentsForDish(key);
  if (req.user) {
    res.json(comments);
    return;
  }
  res.json(comments.map((c, i) => ({
    id: c.id,
    dishId: c.dishId,
    stableUid: '',
    username: DECOY_NAMES[i % DECOY_NAMES.length],
    body: decoyText(c.id, Math.min(c.body.length, 160)),
    createdAt: c.createdAt,
    updatedAt: c.createdAt,
  })));
});

// POST /dish-comments/:dishId
router.post('/:dishId', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const raw = req.params['dishId'] as string;
  const key = (await resolveDishKey(raw)) || raw;
  const { stableUid, username } = req.user!;
  const { body } = bodySchema.parse(req.body);

  const comment = await prisma.dishComment.create({
    data: { dishId: key, stableUid, username, body },
  });

  broadcastDishComments(key, raw, await getCommentsForDish(key));
  res.status(201).json(comment);
});

// PATCH /dish-comments/:dishId/:commentId
router.patch('/:dishId/:commentId', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const raw = req.params['dishId'] as string;
  const commentId = req.params['commentId'] as string;
  const { stableUid } = req.user!;
  const key = await resolveDishKey(raw);

  const comment = await prisma.dishComment.findUnique({ where: { id: commentId } });
  if (!comment || (comment.dishId !== key && comment.dishId !== raw)) throw new NotFoundError('Comment not found');
  if (comment.stableUid !== stableUid) throw new ForbiddenError('You can only edit your own comments');

  const { body } = bodySchema.parse(req.body);
  const updated = await prisma.dishComment.update({ where: { id: commentId }, data: { body } });

  broadcastDishComments(key, raw, await getCommentsForDish(key));
  res.json(updated);
});

// DELETE /dish-comments/:dishId/:commentId
router.delete('/:dishId/:commentId', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const raw = req.params['dishId'] as string;
  const commentId = req.params['commentId'] as string;
  const { stableUid } = req.user!;
  const key = await resolveDishKey(raw);

  const comment = await prisma.dishComment.findUnique({ where: { id: commentId } });
  if (!comment || (comment.dishId !== key && comment.dishId !== raw)) throw new NotFoundError('Comment not found');

  const isOwner = comment.stableUid === stableUid;
  const admin = await prisma.admin.findUnique({ where: { stableUid } });

  if (!isOwner && !admin) throw new ForbiddenError('Only the author or an admin can delete this comment');

  await prisma.dishComment.delete({ where: { id: commentId } });

  broadcastDishComments(key, raw, await getCommentsForDish(key));
  res.status(204).send();
});

export { router as dishCommentsRouter };
