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
import { usageRouter } from './usage';
import { privacyRouter } from './privacy';
import { pushRouter } from './push';
import { popupsAdminRouter, popupsRouter } from './popups';
import { recapsAdminRouter, recapsRouter } from './recaps';
import { clusterAdminRouter } from './adminCluster';
import { analyticsAdminRouter } from './adminAnalytics';
import { adminSecurityRouter } from './adminSecurity';
import { adminAccessRouter } from './adminSchools';
import { adminMonitoringRouter } from './adminMonitoring';
import { adminSearchRouter } from './adminSearch';
import { clientErrorsRouter } from './clientErrors';
import { webuntisRouter } from './webuntis';

const router = Router();

// Admin routes — no API key required (same-origin, JWT-protected)
router.use('/api/admin/popups', popupsAdminRouter);
router.use('/api/admin/recaps', recapsAdminRouter);
router.use('/api/admin/cluster', clusterAdminRouter);
router.use('/api/admin/analytics', analyticsAdminRouter);
router.use('/api/admin', adminSecurityRouter);
router.use('/api/admin', adminAccessRouter);
router.use('/api/admin', adminMonitoringRouter);
router.use('/api/admin', adminSearchRouter);
router.use('/api/admin', adminRouter);

// Public dish catalog — no API key required (read-only menu data)
router.use('/dishes', dishesRouter);

// WebUntis for the website: reads are authenticated by the sealed session
// cookie alone (pictures and documents load straight into the page), writes
// need the API key as well — enforced inside the router.
router.use('/webuntis', webuntisRouter);

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
// Error reports of the web app and the apps (validated, scrubbed, no IP)
router.use('/client-errors', clientErrorsRouter);
// Foreground heartbeat behind the admin Analytics page (device kind and time only)
router.use('/usage', usageRouter);
// Privacy notice acknowledgement and the usage-statistics consent
router.use('/privacy', privacyRouter);
// Push notification registration
router.use('/push', pushRouter);
// Announcement popups (admin-authored, shown in the web and Android apps)
router.use('/popups', popupsRouter);
// Recaps (admin-made looks back at a period, opened by students as a story)
router.use('/recaps', recapsRouter);

export { router as appRouter };
