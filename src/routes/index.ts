import { Router } from 'express';
import { apiKeyMiddleware } from '../middleware/apiKey';
import { authRouter } from './auth';
import { usersRouter } from './users';
import { todosRouter } from './todos';
import { classesRouter } from './classes';
import { remindersRouter } from './reminders';
import { reminderCommentsRouter } from './reminderComments';
import { dishRatingsRouter } from './dishRatings';
import { dishCommentsRouter } from './dishComments';
import { dishesRouter } from './dishes';
import { sseRouter } from './sse';
import { adminRouter } from './admin';
import { subjectImagesRouter } from './subjectImages';
import { activityLogRouter } from './activityLog';
import { pushRouter } from './push';

const router = Router();

// Admin routes — no API key required (same-origin, JWT-protected)
router.use('/api/admin', adminRouter);

// Public dish catalog — no API key required (read-only menu data)
router.use('/dishes', dishesRouter);

// Apply API key check to all other routes
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
// Reminder comments nested under reminders
router.use('/classes/:classId/reminders/:reminderId/comments', reminderCommentsRouter);
// Dish ratings
router.use('/dish-ratings', dishRatingsRouter);
// Dish comments
router.use('/dish-comments', dishCommentsRouter);
// SSE
router.use('/sse', sseRouter);
// Subject images (GET /:subject is API-key only; list/PUT/DELETE need auth — handled in router)
router.use('/subject-images', subjectImagesRouter);
// Frontend activity tracking
router.use('/activity-log', activityLogRouter);
// Push notification registration
router.use('/push', pushRouter);

export { router as appRouter };
