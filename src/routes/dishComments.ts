import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { readLimiter, writeLimiter } from '../middleware/rateLimiter';
import { ForbiddenError, NotFoundError } from '../utils/errors';
import { sseManager } from '../services/sse';

const router = Router();

async function getCommentsForDish(dishId: string) {
  return prisma.dishComment.findMany({
    where: { dishId },
    orderBy: { createdAt: 'asc' },
  });
}

function broadcastDishComments(dishId: string, comments: unknown[]): void {
  sseManager.broadcast(`dishComments:${dishId}`, 'dishComments', comments);
}

const bodySchema = z.object({ body: z.string().min(1).max(2000) });

// GET /dish-comments/:dishId
router.get('/:dishId', readLimiter, requireAuth, async (req: Request, res: Response) => {
  res.json(await getCommentsForDish(req.params['dishId'] as string));
});

// POST /dish-comments/:dishId
router.post('/:dishId', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const dishId = req.params['dishId'] as string;
  const { stableUid, username } = req.user!;
  const { body } = bodySchema.parse(req.body);

  const comment = await prisma.dishComment.create({
    data: { dishId, stableUid, username, body },
  });

  broadcastDishComments(dishId, await getCommentsForDish(dishId));
  res.status(201).json(comment);
});

// PATCH /dish-comments/:dishId/:commentId
router.patch('/:dishId/:commentId', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const dishId = req.params['dishId'] as string;
  const commentId = req.params['commentId'] as string;
  const { stableUid } = req.user!;

  const comment = await prisma.dishComment.findUnique({ where: { id: commentId } });
  if (!comment || comment.dishId !== dishId) throw new NotFoundError('Comment not found');
  if (comment.stableUid !== stableUid) throw new ForbiddenError('You can only edit your own comments');

  const { body } = bodySchema.parse(req.body);
  const updated = await prisma.dishComment.update({ where: { id: commentId }, data: { body } });

  broadcastDishComments(dishId, await getCommentsForDish(dishId));
  res.json(updated);
});

// DELETE /dish-comments/:dishId/:commentId
router.delete('/:dishId/:commentId', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const dishId = req.params['dishId'] as string;
  const commentId = req.params['commentId'] as string;
  const { stableUid } = req.user!;

  const comment = await prisma.dishComment.findUnique({ where: { id: commentId } });
  if (!comment || comment.dishId !== dishId) throw new NotFoundError('Comment not found');

  const isOwner = comment.stableUid === stableUid;
  const admin = await prisma.admin.findUnique({ where: { stableUid } });

  if (!isOwner && !admin) throw new ForbiddenError('Only the author or an admin can delete this comment');

  await prisma.dishComment.delete({ where: { id: commentId } });

  broadcastDishComments(dishId, await getCommentsForDish(dishId));
  res.status(204).send();
});

export { router as dishCommentsRouter };
