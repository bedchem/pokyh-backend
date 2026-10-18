import { prisma } from '../db';
import { config } from '../config';
import { hasUsageConsent } from './privacyConsent';
import { dayAxis, localDayAndHour, startOfLocalDay } from './usageAnalytics';
import { summarizeActivity, topPages } from './accountActivitySummary';

// An account's own activity, for its profile in the apps (GET /users/me/activity):
// on which days it used Pokyh, how often it signed in, and — only where the
// account consented to the usage statistics — how long. Nothing here is new
// data; it is read from what is stored anyway and only ever shown to the
// account itself:
//
//   request_account_days   active days and device kind (request logs, ≤ REQUEST_LOG_RETENTION_DAYS)
//   request_logs           successful sign-ins (POST /auth/login|register, see requestLogger)
//   usage_sessions         foreground time, visits, screens, start hour (named only with consent)
//   frontend_activity_logs page views of the website (named only with consent)
//   todos, reminders, comments, dish ratings  what the account created

/** Days the profile grid covers: 14 weeks. */
export const ACTIVITY_WINDOW_DAYS = 98;

export const SIGN_IN_PATHS = ['/auth/login', '/auth/register'];

export async function loadAccountActivity(stableUid: string, now = new Date()) {
  const tz = config.usageAnalytics.timezone;
  const days = dayAxis(ACTIVITY_WINDOW_DAYS, tz, now);
  const firstDay = days[0]!;
  const since = startOfLocalDay(firstDay, tz);

  const [user, consent, accountDays, signInRows] = await Promise.all([
    prisma.user.findUnique({ where: { stableUid }, select: { createdAt: true } }),
    hasUsageConsent(stableUid),
    prisma.requestAccountDay.findMany({
      where: { stableUid, dayKey: { gte: firstDay } },
      select: { dayKey: true, device: true, client: true },
    }),
    prisma.requestLog.findMany({
      where: { stableUid, method: 'POST', path: { in: SIGN_IN_PATHS }, status: { lt: 300 }, createdAt: { gte: since } },
      select: { createdAt: true },
    }),
  ]);

  // Rows that name the account exist only with its consent; without it there
  // is nothing to find, so the queries are skipped.
  const [sessions, pageViews] = consent
    ? await Promise.all([
        prisma.usageSession.findMany({
          where: { stableUid, dayKey: { gte: firstDay } },
          select: { dayKey: true, startHour: true, activeSeconds: true, screens: true },
        }),
        prisma.frontendActivityLog.findMany({
          where: { stableUid, event: 'page_view', createdAt: { gte: since } },
          select: { page: true },
          take: 5000,
        }),
      ])
    : [[], []];

  const [todosDone, todosOpen, reminders, comments, dishComments, ratings] = await Promise.all([
    prisma.todo.count({ where: { stableUid, done: true } }),
    prisma.todo.count({ where: { stableUid, done: false, archivedAt: null } }),
    prisma.reminder.count({ where: { createdBy: stableUid } }),
    prisma.comment.count({ where: { stableUid } }),
    prisma.dishComment.count({ where: { stableUid } }),
    prisma.dishRating.count({ where: { stableUid } }),
  ]);

  return {
    today: days[days.length - 1],
    from: firstDay,
    timezone: tz,
    retention: {
      activeDays: config.requestLogRetentionDays,
      usage: config.usageAnalytics.retentionDays,
    },
    usageConsent: consent,
    memberSince: user?.createdAt.toISOString() ?? null,
    ...summarizeActivity({
      days,
      accountDays,
      sessions,
      signIns: signInRows.map((r) => localDayAndHour(r.createdAt, tz).dayKey),
    }),
    pages: topPages(pageViews.map((p) => p.page)),
    created: {
      todosDone,
      todosOpen,
      reminders,
      comments: comments + dishComments,
      ratings,
    },
  };
}

export type AccountActivity = Awaited<ReturnType<typeof loadAccountActivity>>;
