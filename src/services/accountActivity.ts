import { prisma } from '../db';
import { config } from '../config';
import { hasUsageConsent } from './privacyConsent';
import { dayAxis, daysBetween, localDayAndHour, startOfLocalDay } from './usageAnalytics';
import { archiveSummary, schoolYearStartKey, signInDays, summarizeActivity, topPages } from './accountActivitySummary';

// An account's own activity, for its profile in the apps (GET /users/me/activity):
// on which days it used Pokyh, how often it signed in, and — only where the
// account consented to the usage statistics — how long. Nothing here is new
// data; it is read from what is stored anyway and only ever shown to the
// account itself:
//
//   request_account_days   active days, device kind, sign-ins per day (the running school year, see config.accountActivitySchoolYear)
//   request_logs           successful sign-ins of the last REQUEST_LOG_RETENTION_DAYS (from before sign-ins were counted per day)
//   usage_sessions         foreground time, visits, screens, start hour (named only with consent)
//   frontend_activity_logs page views of the website (named only with consent, REQUEST_LOG_RETENTION_DAYS)
//   todos, reminders, comments, dish ratings  what the account created
//
// At the school-year rollover the year is archived per account
// (archived_activity, yearSummaries below) and its rows are deleted.

/** Days the profile grid covers when the activity is not kept for the school year: 14 weeks. */
export const ACTIVITY_WINDOW_DAYS = 98;

export const SIGN_IN_PATHS = ['/auth/login', '/auth/register'];

/** First day of the running school year in the analytics timezone. */
export function schoolYearStart(now = new Date()): string {
  const today = localDayAndHour(now, config.usageAnalytics.timezone).dayKey;
  return schoolYearStartKey(today, config.schoolYearRolloverMonth, config.schoolYearRolloverDay);
}

/**
 * The first day whose activity rows are kept: the start of the running school
 * year — but the year before stays until its rollover has archived it, so
 * nothing is deleted before the archive has it.
 */
export async function activityCutoffDay(now = new Date()): Promise<string> {
  const start = schoolYearStart(now);
  const startYear = Number(start.slice(0, 4));
  const archived = await prisma.schoolYear.findUnique({ where: { startYear: startYear - 1 }, select: { id: true } });
  return archived ? start : `${startYear - 1}${start.slice(4)}`;
}

/** The days the profile shows: the school year so far, or the last 14 weeks. */
function activityDays(now: Date): string[] {
  const tz = config.usageAnalytics.timezone;
  if (!config.accountActivitySchoolYear) return dayAxis(ACTIVITY_WINDOW_DAYS, tz, now);
  const today = localDayAndHour(now, tz).dayKey;
  return daysBetween(schoolYearStart(now), today).slice(-366);
}

/** Sign-ins per day: the counted ones, or the request logs where those are more (days from before counting). */
function mergeSignIns(counted: string[], logged: string[]): string[] {
  const perDay = (keys: string[]) => keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());
  const a = perDay(counted);
  const b = perDay(logged);
  const out: string[] = [];
  for (const day of new Set([...a.keys(), ...b.keys()])) {
    const n = Math.max(a.get(day) ?? 0, b.get(day) ?? 0);
    for (let i = 0; i < n; i += 1) out.push(day);
  }
  return out;
}

export async function loadAccountActivity(stableUid: string, now = new Date()) {
  const tz = config.usageAnalytics.timezone;
  const days = activityDays(now);
  const firstDay = days[0]!;
  const since = startOfLocalDay(firstDay, tz);

  const [user, consent, accountDays, signInRows] = await Promise.all([
    prisma.user.findUnique({ where: { stableUid }, select: { createdAt: true } }),
    hasUsageConsent(stableUid),
    prisma.requestAccountDay.findMany({
      where: { stableUid, dayKey: { gte: firstDay } },
      select: { dayKey: true, device: true, client: true, signIns: true },
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
      // Kept for the running school year and archived at its end.
      schoolYear: config.accountActivitySchoolYear,
      pages: config.requestLogRetentionDays,
    },
    usageConsent: consent,
    memberSince: user?.createdAt.toISOString() ?? null,
    ...summarizeActivity({
      days,
      accountDays,
      sessions,
      signIns: mergeSignIns(signInDays(accountDays), signInRows.map((r) => localDayAndHour(r.createdAt, tz).dayKey)),
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

export interface YearSummary {
  activeDays: number;
  logins: number;
  activeSeconds: number;
  summaryJson: string;
}

/**
 * Each account's school year (`from` … `to`, both included) in figures, for
 * the archive at the rollover: active days and sign-ins from
 * request_account_days, foreground time from its named visits (consent only).
 * Accounts without any activity are left out.
 */
export async function yearSummaries(stableUids: string[], from: string, to: string): Promise<Map<string, YearSummary>> {
  const out = new Map<string, YearSummary>();
  if (stableUids.length === 0) return out;
  const days = daysBetween(from, to);
  const uids = new Set(stableUids);
  const [accountDays, sessions] = await Promise.all([
    prisma.requestAccountDay.findMany({
      where: { dayKey: { gte: from, lte: to } },
      select: { stableUid: true, dayKey: true, device: true, client: true, signIns: true },
    }),
    prisma.usageSession.findMany({
      where: { stableUid: { not: null }, dayKey: { gte: from, lte: to } },
      select: { stableUid: true, dayKey: true, startHour: true, activeSeconds: true, screens: true },
    }),
  ]);
  const group = <T extends { stableUid: string | null }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const row of rows) {
      if (!row.stableUid || !uids.has(row.stableUid)) continue;
      if (!m.has(row.stableUid)) m.set(row.stableUid, []);
      m.get(row.stableUid)!.push(row);
    }
    return m;
  };
  const daysBy = group(accountDays);
  const sessionsBy = group(sessions);
  for (const uid of uids) {
    const own = daysBy.get(uid) ?? [];
    const visits = sessionsBy.get(uid) ?? [];
    if (own.length === 0 && visits.length === 0) continue;
    const summary = summarizeActivity({ days, accountDays: own, sessions: visits, signIns: signInDays(own) });
    out.set(uid, {
      activeDays: summary.totals.activeDays,
      logins: summary.totals.logins,
      activeSeconds: summary.totals.activeSeconds,
      summaryJson: JSON.stringify(archiveSummary(summary, from, to)),
    });
  }
  return out;
}
