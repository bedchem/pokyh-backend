import { Router } from 'express';
import { apiKeyMiddleware } from '../middleware/apiKey';
import { authRouter } from './auth';
import { usersRouter } from './users';
import { todosRouter } from './todos';
import { classesRouter } from './classes';
import { remindersRouter } from './reminders';
import { dishRatingsRouter } from './dishRatings';
import { sseRouter } from './sse';

const router = Router();

// Apply API key check to all routes
router.use(apiKeyMiddleware);

// Mount route groups
router.use('/auth', authRouter);
router.use('/users', usersRouter);
// Todos are nested: /users/:username/todos
router.use('/users/:username/todos', todosRouter);
// Classes
router.use('/classes', classesRouter);
// Reminders nested under classes
router.use('/classes/:classId/reminders', remindersRouter);
// Dish ratings
router.use('/dish-ratings', dishRatingsRouter);
// SSE
router.use('/sse', sseRouter);

export { router as appRouter };
