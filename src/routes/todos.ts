import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { readLimiter, writeLimiter } from '../middleware/rateLimiter';
import { ForbiddenError, NotFoundError } from '../utils/errors';
import { sseManager } from '../services/sse';

const router = Router({ mergeParams: true });

function broadcastTodos(stableUid: string, todos: unknown[]): void {
  sseManager.broadcast(`todos:${stableUid}`, 'todos', todos);
}

async function getTodosForUser(stableUid: string) {
  return prisma.todo.findMany({
    where: { stableUid },
    orderBy: { createdAt: 'asc' },
  });
}

// GET /users/:username/todos
router.get('/', readLimiter, requireAuth, async (req: Request, res: Response) => {
  const username = req.params['username'] as string;

  // Must be same user
  if (req.user!.username !== username) {
    throw new ForbiddenError('You can only access your own todos');
  }

  const todos = await getTodosForUser(req.user!.stableUid);
  res.json(todos);
});

// POST /users/:username/todos
const createTodoSchema = z.object({
  title: z.string().min(1).max(500),
  details: z.string().max(10000).optional().default(''),
  dueAt: z.string().datetime().optional().nullable(),
});

router.post('/', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const username = req.params['username'] as string;

  if (req.user!.username !== username) {
    throw new ForbiddenError('You can only create todos for yourself');
  }

  const body = createTodoSchema.parse(req.body);
  const { stableUid } = req.user!;

  const todo = await prisma.todo.create({
    data: {
      stableUid,
      title: body.title,
      details: body.details ?? '',
      dueAt: body.dueAt ? new Date(body.dueAt) : null,
    },
  });

  // Broadcast updated list
  const todos = await getTodosForUser(stableUid);
  broadcastTodos(stableUid, todos);

  res.status(201).json(todo);
});

// PATCH /users/:username/todos/:todoId
const updateTodoSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  details: z.string().max(10000).optional(),
  dueAt: z.string().datetime().optional().nullable(),
  done: z.boolean().optional(),
  doneAt: z.string().datetime().optional().nullable(),
});

router.patch('/:todoId', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const username = req.params['username'] as string;
  const todoId = req.params['todoId'] as string;

  if (req.user!.username !== username) {
    throw new ForbiddenError('You can only update your own todos');
  }

  const { stableUid } = req.user!;

  const existing = await prisma.todo.findUnique({ where: { id: todoId } });
  if (!existing || existing.stableUid !== stableUid) {
    throw new NotFoundError('Todo not found');
  }

  const body = updateTodoSchema.parse(req.body);

  const updated = await prisma.todo.update({
    where: { id: todoId },
    data: {
      ...(body.title !== undefined && { title: body.title }),
      ...(body.details !== undefined && { details: body.details }),
      ...(body.dueAt !== undefined && { dueAt: body.dueAt ? new Date(body.dueAt) : null }),
      ...(body.done !== undefined && { done: body.done }),
      ...(body.doneAt !== undefined && { doneAt: body.doneAt ? new Date(body.doneAt) : null }),
    },
  });

  const todos = await getTodosForUser(stableUid);
  broadcastTodos(stableUid, todos);

  res.json(updated);
});

// DELETE /users/:username/todos/:todoId
router.delete('/:todoId', writeLimiter, requireAuth, async (req: Request, res: Response) => {
  const username = req.params['username'] as string;
  const todoId = req.params['todoId'] as string;

  if (req.user!.username !== username) {
    throw new ForbiddenError('You can only delete your own todos');
  }

  const { stableUid } = req.user!;

  const existing = await prisma.todo.findUnique({ where: { id: todoId } });
  if (!existing || existing.stableUid !== stableUid) {
    throw new NotFoundError('Todo not found');
  }

  await prisma.todo.delete({ where: { id: todoId } });

  const todos = await getTodosForUser(stableUid);
  broadcastTodos(stableUid, todos);

  res.status(204).send();
});

export { router as todosRouter };
