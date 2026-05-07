import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { readLimiter, writeLimiter } from '../middleware/rateLimiter';
import { ForbiddenError, NotFoundError } from '../utils/errors';
import { sseManager } from '../services/sse';

const router = Router({ mergeParams: true });

async function getCommentsForReminder(reminderId: string) {
  return prisma.comment.findMany({
    where: { reminderId },
    orderBy: { createdAt: 'asc' },
  });
}

function broadcastComments(reminderId: string, comments: unknown[]): void {
  sseManager.broadcast(`reminderComments:${reminderId}`, 'reminderComments', comments);
}

async function checkMembership(classId: string, stableUid: string): Promise<boolean> {
  const m = await prisma.classMember.findUnique({
    where: { classId_stableUid: { classId, stableUid } },
  });
  return m !== null;
}

// GET /classes/:classId/reminders/:reminderId/comments
router.get('/', readLimiter, requireAuth, async (req: Request, res: Response) => {
  const classId = req.params['classId'] as string;
  const reminderId = req.params['reminderId'] as string;
  const { stableUid } = req.user!;

  if (!(await checkMembership(classId, stableUid))) {
    throw new ForbiddenError('You are not a member of this class');
  }

  const reminder = await prisma.reminder.findUnique({ where: { id: reminderId } });
  if (!reminder || reminder.classId !== classId) throw new NotFoundError('Reminder not found');

  res.json(await getCommentsForReminder(reminderId));
});

const bodySchema = z.object({ body: z.string().min(1).max(2000) });

// POST /classes/:classId/reminders/:reminderId/comments
router.post('/', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const classId = req.params['classId'] as string;
  const reminderId = req.params['reminderId'] as string;
  const { stableUid, username } = req.user!;

  if (!(await checkMembership(classId, stableUid))) {
    throw new ForbiddenError('You are not a member of this class');
  }

  const reminder = await prisma.reminder.findUnique({ where: { id: reminderId } });
  if (!reminder || reminder.classId !== classId) throw new NotFoundError('Reminder not found');

  const { body } = bodySchema.parse(req.body);

  const comment = await prisma.comment.create({
    data: { reminderId, classId, stableUid, username, body },
  });

  broadcastComments(reminderId, await getCommentsForReminder(reminderId));
  res.status(201).json(comment);
});

// PATCH /classes/:classId/reminders/:reminderId/comments/:commentId
router.patch('/:commentId', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const classId = req.params['classId'] as string;
  const reminderId = req.params['reminderId'] as string;
  const commentId = req.params['commentId'] as string;
  const { stableUid } = req.user!;

  if (!(await checkMembership(classId, stableUid))) {
    throw new ForbiddenError('You are not a member of this class');
  }

  const comment = await prisma.comment.findUnique({ where: { id: commentId } });
  if (!comment || comment.reminderId !== reminderId) throw new NotFoundError('Comment not found');
  if (comment.stableUid !== stableUid) throw new ForbiddenError('You can only edit your own comments');

  const { body } = bodySchema.parse(req.body);

  const updated = await prisma.comment.update({ where: { id: commentId }, data: { body } });

  broadcastComments(reminderId, await getCommentsForReminder(reminderId));
  res.json(updated);
});

// DELETE /classes/:classId/reminders/:reminderId/comments/:commentId
router.delete('/:commentId', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const classId = req.params['classId'] as string;
  const reminderId = req.params['reminderId'] as string;
  const commentId = req.params['commentId'] as string;
  const { stableUid } = req.user!;

  if (!(await checkMembership(classId, stableUid))) {
    throw new ForbiddenError('You are not a member of this class');
  }

  const comment = await prisma.comment.findUnique({ where: { id: commentId } });
  if (!comment || comment.reminderId !== reminderId) throw new NotFoundError('Comment not found');

  const isOwner = comment.stableUid === stableUid;
  const admin = await prisma.admin.findUnique({ where: { stableUid } });

  if (!isOwner && !admin) throw new ForbiddenError('Only the author or an admin can delete this comment');

  await prisma.comment.delete({ where: { id: commentId } });

  broadcastComments(reminderId, await getCommentsForReminder(reminderId));
  res.status(204).send();
});

export { router as reminderCommentsRouter };
