import { Router, Request, Response } from 'express';
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

function broadcastReminders(classId: string, reminders: unknown[]): void {
  sseManager.broadcast(`reminders:${classId}`, 'reminders', reminders);
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

  const isMember = await checkMembership(classId, stableUid);
  if (!isMember) {
    throw new ForbiddenError('You are not a member of this class');
  }

  const reminders = await cached(`reminders:${classId}`, ['Reminder'], 120, () => getRemindersForClass(classId));
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

  const reminders = await getRemindersForClass(classId);
  broadcastReminders(classId, reminders);

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

  // Check if creator or admin
  const isCreator = reminder.createdBy === stableUid;
  const admin = await prisma.admin.findUnique({ where: { stableUid } });
  const isAdmin = admin !== null;

  if (!isCreator && !isAdmin) {
    throw new ForbiddenError('Only the creator or an admin can delete this reminder');
  }

  await prisma.reminder.delete({ where: { id: reminderId } });

  const reminders = await getRemindersForClass(classId);
  broadcastReminders(classId, reminders);

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
  const admin = await prisma.admin.findUnique({ where: { stableUid } });
  if (!isCreator && admin === null) {
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

  const reminders = await getRemindersForClass(classId);
  broadcastReminders(classId, reminders);

  res.json(updated);
});

export { router as remindersRouter };
