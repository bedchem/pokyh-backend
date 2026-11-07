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

async function getRemindersForClass(classId: string) {
  return prisma.reminder.findMany({
    where: { classId, archivedAt: null },
    orderBy: { remindAt: 'asc' },
  });
}

// Parents have no reminders — block them from the entire reminders surface.
function assertNotParent(req: Request): void {
  if (req.user!.role === 'parent') {
    throw new ForbiddenError('Eltern-Accounts haben keinen Zugriff auf Erinnerungen');
  }
}

// The list goes to the open live streams of this classId — only when one is
// open, and after the answer: a write never waits for it.
function broadcastReminders(classId: string): void {
  const channel = `reminders:${classId}`;
  if (sseManager.getClientCount(channel) === 0) return;
  void getRemindersForClass(classId)
    .then((list) => sseManager.broadcast(channel, 'reminders', list))
    .catch(() => { /* the next write or reconnect sends it */ });
}

async function checkMembership(classId: string, stableUid: string): Promise<boolean> {
  const membership = await prisma.classMember.findUnique({
    where: { classId_stableUid: { classId, stableUid } },
  });
  return membership !== null;
}

// GET /classes/:classId/reminders
router.get('/', readLimiter, requireAuth, async (req: Request, res: Response) => {
  const classId = req.params['classId'] as string;
  const { stableUid } = req.user!;

  assertNotParent(req);

  // Read together; nothing is answered before the membership is checked.
  const [isMember, reminders] = await Promise.all([
    checkMembership(classId, stableUid),
    cached(`reminders:${classId}`, ['Reminder'], 120, () => getRemindersForClass(classId)),
  ]);
  if (!isMember) {
    throw new ForbiddenError('You are not a member of this class');
  }
  res.json(reminders);
});

// POST /classes/:classId/reminders
const createReminderSchema = z.object({
  title: z.string().min(1).max(500),
  // Bounded by the column width (reminders.body is VARCHAR(5000)).
  body: z.string().max(5000).optional().default(''),
  remindAt: z.string().datetime(),
});

router.post('/', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const classId = req.params['classId'] as string;
  const { stableUid, username } = req.user!;

  assertNotParent(req);

  const isMember = await checkMembership(classId, stableUid);
  if (!isMember) {
    throw new ForbiddenError('You are not a member of this class');
  }

  const body = createReminderSchema.parse(req.body);

  const reminder = await prisma.reminder.create({
    data: {
      classId,
      title: body.title,
      body: body.body ?? '',
      remindAt: new Date(body.remindAt),
      createdBy: stableUid,
      createdByName: username,
      createdByUsername: username,
    },
  });

  broadcastReminders(classId);

  res.status(201).json(reminder);
});

// DELETE /classes/:classId/reminders/:reminderId
router.delete('/:reminderId', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const classId = req.params['classId'] as string;
  const reminderId = req.params['reminderId'] as string;
  const { stableUid } = req.user!;

  assertNotParent(req);

  const isMember = await checkMembership(classId, stableUid);
  if (!isMember) {
    throw new ForbiddenError('You are not a member of this class');
  }

  const reminder = await prisma.reminder.findUnique({ where: { id: reminderId } });
  if (!reminder || reminder.classId !== classId) {
    throw new NotFoundError('Reminder not found');
  }

  // The creator, or an admin with the right in this class's school.
  const isCreator = reminder.createdBy === stableUid;
  if (!isCreator && !(await moderatesClass(stableUid, req.user!.username, classId, 'classes.manage'))) {
    throw new ForbiddenError('Only the creator or an admin can delete this reminder');
  }

  await prisma.reminder.delete({ where: { id: reminderId } });

  broadcastReminders(classId);

  res.status(204).send();
});

// PATCH /classes/:classId/reminders/:reminderId — the creator (or an admin)
// changes the title, text or time; the whole class sees it at once (SSE).
const updateReminderSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  body: z.string().max(5000).optional(),
  remindAt: z.string().datetime().optional(),
});

router.patch('/:reminderId', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const classId = req.params['classId'] as string;
  const reminderId = req.params['reminderId'] as string;
  const { stableUid } = req.user!;

  assertNotParent(req);

  const isMember = await checkMembership(classId, stableUid);
  if (!isMember) {
    throw new ForbiddenError('You are not a member of this class');
  }

  const reminder = await prisma.reminder.findUnique({ where: { id: reminderId } });
  if (!reminder || reminder.classId !== classId) {
    throw new NotFoundError('Reminder not found');
  }

  const isCreator = reminder.createdBy === stableUid;
  if (!isCreator && !(await moderatesClass(stableUid, req.user!.username, classId, 'classes.manage'))) {
    throw new ForbiddenError('Only the creator or an admin can edit this reminder');
  }

  const body = updateReminderSchema.parse(req.body);
  const updated = await prisma.reminder.update({
    where: { id: reminderId },
    data: {
      ...(body.title !== undefined && { title: body.title }),
      ...(body.body !== undefined && { body: body.body }),
      ...(body.remindAt !== undefined && { remindAt: new Date(body.remindAt) }),
    },
  });

  broadcastReminders(classId);

  res.json(updated);
});

export { router as remindersRouter };
