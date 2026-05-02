import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { readLimiter, writeLimiter } from '../middleware/rateLimiter';
import { ForbiddenError, NotFoundError } from '../utils/errors';
import { sseManager } from '../services/sse';

const router = Router({ mergeParams: true });

async function getRemindersForClass(classId: string) {
  return prisma.reminder.findMany({
    where: { classId },
    orderBy: { remindAt: 'asc' },
  });
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

  const isMember = await checkMembership(classId, stableUid);
  if (!isMember) {
    throw new ForbiddenError('You are not a member of this class');
  }

  const reminders = await getRemindersForClass(classId);
  res.json(reminders);
});

// POST /classes/:classId/reminders
const createReminderSchema = z.object({
  title: z.string().min(1).max(500),
  body: z.string().max(10000).optional().default(''),
  remindAt: z.string().datetime(),
});

router.post('/', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const classId = req.params['classId'] as string;
  const { stableUid, username } = req.user!;

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

export { router as remindersRouter };
