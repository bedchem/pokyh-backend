import { NextFunction, Request, Response, Router } from 'express';
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
import { learnRouter } from './learn';
import { config } from '../config';

const router = Router();

// Learn is served through the same-origin learn.pokyh.com BFF. A direct browser
// call is accepted only from explicitly configured Learn origins; server-to-
// server calls have no Origin header and are still protected by API key + JWT.
function requireLearnBrowserOrigin(req: Request, res: Response, next: NextFunction): void {
  // Learn has no SSE route, so credentials must never travel in URLs where
  // access logs, browser history, and referrers could retain them.
  if (typeof req.query['apiKey'] === 'string' || typeof req.query['token'] === 'string') {
    res.status(400).json({ error: 'Use request headers for Learn credentials' });
    return;
  }
  const origin = req.get('origin');
  if (!origin) return next();
  if (config.learnAllowedOrigins.includes(origin)) return next();
  res.status(403).json({ error: 'Learn browser origin is not allowed' });
}

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
// Pokyh Learn — catalog reads remain JWT-optional inside the router, while the
// shared API-key middleware above protects every Learn request.
router.use('/learn', requireLearnBrowserOrigin, learnRouter);

export { router as appRouter };
