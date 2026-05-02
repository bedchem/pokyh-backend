import { Router, Request, Response } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { sseLimiter } from '../middleware/rateLimiter';
import { ForbiddenError } from '../utils/errors';
import { sseManager } from '../services/sse';

const router = Router();

function setupSseConnection(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();
}

// GET /sse/todos — stream todo changes for authenticated user
router.get('/todos', sseLimiter, requireAuth, async (req: Request, res: Response) => {
  const { stableUid } = req.user!;

  setupSseConnection(res);

  const key = `todos:${stableUid}`;
  sseManager.addClient(key, res);

  // Send current todos on connect
  const todos = await prisma.todo.findMany({
    where: { stableUid },
    orderBy: { createdAt: 'asc' },
  });

  try {
    res.write(`event: todos\ndata: ${JSON.stringify(todos)}\n\n`);
  } catch {
    // Client already disconnected
    return;
  }
});

// GET /sse/reminders/:classId — stream reminder changes for a class
router.get('/reminders/:classId', sseLimiter, requireAuth, async (req: Request, res: Response) => {
  const classId = req.params['classId'] as string;
  const { stableUid } = req.user!;

  // Check membership
  const membership = await prisma.classMember.findUnique({
    where: { classId_stableUid: { classId, stableUid } },
  });

  if (!membership) {
    throw new ForbiddenError('You are not a member of this class');
  }

  setupSseConnection(res);

  const key = `reminders:${classId}`;
  sseManager.addClient(key, res);

  // Send current reminders on connect
  const reminders = await prisma.reminder.findMany({
    where: { classId },
    orderBy: { remindAt: 'asc' },
  });

  try {
    res.write(`event: reminders\ndata: ${JSON.stringify(reminders)}\n\n`);
  } catch {
    return;
  }
});

// GET /sse/dish-ratings/:dishId — stream dish rating changes
router.get('/dish-ratings/:dishId', sseLimiter, requireAuth, async (req: Request, res: Response) => {
  const dishId = req.params['dishId'] as string;
  const { stableUid } = req.user!;

  setupSseConnection(res);

  const key = `dishRatings:${dishId}`;
  sseManager.addClient(key, res);

  // Send current ratings on connect
  const rows = await prisma.dishRating.findMany({ where: { dishId } });
  const ratings: Record<string, number> = {};
  let myRating: number | null = null;

  for (const row of rows) {
    ratings[row.stableUid] = row.stars;
    if (row.stableUid === stableUid) {
      myRating = row.stars;
    }
  }

  try {
    res.write(`event: dishRatings\ndata: ${JSON.stringify({ ratings, myRating })}\n\n`);
  } catch {
    return;
  }
});

export { router as sseRouter };
