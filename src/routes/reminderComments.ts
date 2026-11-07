import { Router, Request, Response } from 'express';
import { moderatesClass } from '../services/adminAccess';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { readLimiter, writeLimiter } from '../middleware/rateLimiter';
import { ForbiddenError, NotFoundError } from '../utils/errors';
import { sseManager } from '../services/sse';
import { cached } from '../services/cache';

const router = Router({ mergeParams: true });

async function getCommentsForReminder(reminderId: string) {
  return prisma.comment.findMany({
    where: { reminderId },
    orderBy: { createdAt: 'asc' },
  });
}

// The list goes to the open live streams of this reminderId — only when one is
// open, and after the answer: a write never waits for it.
function broadcastComments(reminderId: string): void {
  const channel = `reminderComments:${reminderId}`;
  if (sseManager.getClientCount(channel) === 0) return;
  void getCommentsForReminder(reminderId)
    .then((list) => sseManager.broadcast(channel, 'reminderComments', list))
    .catch(() => { /* the next write or reconnect sends it */ });
}

async function checkMembership(classId: string, stableUid: string): Promise<boolean> {
  const m = await prisma.classMember.findUnique({
    where: { classId_stableUid: { classId, stableUid } },
  });
  return m !== null;
}

// Parents have no reminders → no reminder comments either.
function assertNotParent(req: Request): void {
  if (req.user!.role === 'parent') {
    throw new ForbiddenError('Eltern-Accounts haben keinen Zugriff auf Erinnerungen');
  }
}

// GET /classes/:classId/reminders/:reminderId/comments
router.get('/', readLimiter, requireAuth, async (req: Request, res: Response) => {
  const classId = req.params['classId'] as string;
  const reminderId = req.params['reminderId'] as string;
  const { stableUid } = req.user!;

  assertNotParent(req);

  // Read together; nothing is answered before membership and reminder are checked.
  const [isMember, reminder, comments] = await Promise.all([
    checkMembership(classId, stableUid),
    prisma.reminder.findUnique({ where: { id: reminderId }, select: { classId: true } }),
    cached(`reminder-comments:${reminderId}`, ['Comment'], 120, () => getCommentsForReminder(reminderId)),
  ]);
  if (!isMember) {
    throw new ForbiddenError('You are not a member of this class');
  }
  if (!reminder || reminder.classId !== classId) throw new NotFoundError('Reminder not found');

  res.json(comments);
});

const bodySchema = z.object({ body: z.string().min(1).max(2000) });

// POST /classes/:classId/reminders/:reminderId/comments
router.post('/', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const classId = req.params['classId'] as string;
  const reminderId = req.params['reminderId'] as string;
  const { stableUid, username } = req.user!;

  assertNotParent(req);

  if (!(await checkMembership(classId, stableUid))) {
    throw new ForbiddenError('You are not a member of this class');
  }

  const reminder = await prisma.reminder.findUnique({ where: { id: reminderId } });
  if (!reminder || reminder.classId !== classId) throw new NotFoundError('Reminder not found');

  const { body } = bodySchema.parse(req.body);

  const comment = await prisma.comment.create({
    data: { reminderId, classId, stableUid, username, body },
  });

  broadcastComments(reminderId);
  res.status(201).json(comment);
});

// PATCH /classes/:classId/reminders/:reminderId/comments/:commentId
router.patch('/:commentId', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const classId = req.params['classId'] as string;
  const reminderId = req.params['reminderId'] as string;
  const commentId = req.params['commentId'] as string;
  const { stableUid } = req.user!;

  assertNotParent(req);

  if (!(await checkMembership(classId, stableUid))) {
    throw new ForbiddenError('You are not a member of this class');
  }

  const comment = await prisma.comment.findUnique({ where: { id: commentId } });
  if (!comment || comment.reminderId !== reminderId) throw new NotFoundError('Comment not found');
  if (comment.stableUid !== stableUid) throw new ForbiddenError('You can only edit your own comments');

  const { body } = bodySchema.parse(req.body);

  const updated = await prisma.comment.update({ where: { id: commentId }, data: { body } });

  broadcastComments(reminderId);
  res.json(updated);
});

// DELETE /classes/:classId/reminders/:reminderId/comments/:commentId
router.delete('/:commentId', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const classId = req.params['classId'] as string;
  const reminderId = req.params['reminderId'] as string;
  const commentId = req.params['commentId'] as string;
  const { stableUid } = req.user!;

  assertNotParent(req);

  if (!(await checkMembership(classId, stableUid))) {
    throw new ForbiddenError('You are not a member of this class');
  }

  const [comment, reminder] = await Promise.all([
    prisma.comment.findUnique({ where: { id: commentId } }),
    prisma.reminder.findUnique({ where: { id: reminderId }, select: { classId: true } }),
  ]);
  // The comment must be one of this reminder's, and the reminder one of this class's.
  if (!comment || comment.reminderId !== reminderId || !reminder || reminder.classId !== classId) {
    throw new NotFoundError('Comment not found');
  }

  const isAuthor = comment.stableUid === stableUid;
  if (!isAuthor && !(await moderatesClass(stableUid, req.user!.username, classId, 'comments.moderate'))) {
    throw new ForbiddenError('Only the author or an admin can delete this comment');
  }

  await prisma.comment.delete({ where: { id: commentId } });

  broadcastComments(reminderId);
  res.status(204).send();
});

export { router as reminderCommentsRouter };
