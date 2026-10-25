import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { cachedFor } from './cache';
import { hasUsageConsent } from './privacyConsent';
import { activityCutoffDay, mergeSignIns, SIGN_IN_PATHS } from './accountActivity';
import { signInDays, summarizeActivity, topPages } from './accountActivitySummary';
import { addDays, daysBetween, localDayAndHour, startOfLocalDay } from './usageAnalytics';
import { coveredPeriod, topPercent } from './recapRules';

// The POKYH part of a recap (GET /recaps/:id): what an account did in POKYH
// during the recap's period, read from what is stored anyway — like its
// profile's activity (services/accountActivity.ts), only for the period:
//
//   request_account_days   active days, devices, sign-ins
//   usage_sessions         foreground time, hours (named only with consent)
//   frontend_activity_logs most opened screens (consent, REQUEST_LOG_RETENTION_DAYS)
//   archived_activity      days of a school year already archived
//   todos, reminders, comments, dish ratings  what the account made then
//
// and its place in its school by active days, from the same rows of everyone
// there (only "top n %", only among enough people). Nothing new is stored.

/** How long a school's ranking is reused: the figures move slowly. */
const RANK_CACHE_SECONDS = 15 * 60;

interface ArchivedDays {
  days?: unknown;
}

// Active days of archived school years, as [day, sign-ins, seconds], for
// days before `cutoff` (their live rows are gone). An account that came back
// after the rollover has a new stable id, so the archive is matched by name too.
async function archivedDays(stableUid: string, username: string, from: string, to: string, cutoff: string): Promise<Array<[string, number, number]>> {
  if (from >= cutoff) return [];
  const rows = await prisma.archivedActivity.findMany({
    where: { OR: [{ stableUid }, ...(username ? [{ username }] : [])] },
    select: { summaryJson: true },
  });
  const out = new Map<string, [string, number, number]>();
  for (const row of rows) {
    let parsed: ArchivedDays;
    try {
      parsed = JSON.parse(row.summaryJson) as ArchivedDays;
    } catch {
      continue;
    }
    if (!Array.isArray(parsed.days)) continue;
    for (const entry of parsed.days) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
      const day = entry[0];
      if (day < from || day > to || day >= cutoff) continue;
      out.set(day, [day, Number(entry[1]) || 0, Number(entry[2]) || 0]);
    }
  }
  return [...out.values()];
}

// Active days per account of one school in the period (the request rows of
// this node, like the profile's activity).
async function schoolActiveDays(schoolId: string, from: string, to: string): Promise<Array<{ uid: string; days: number }>> {
  return cachedFor(`recap-rank:${schoolId}:${from}:${to}`, RANK_CACHE_SECONDS, async () => {
    const rows = await prisma.$queryRaw<Array<{ uid: string; days: bigint | number }>>(Prisma.sql`
      SELECT stable_uid AS uid, COUNT(DISTINCT day_key) AS days
      FROM request_account_days
      WHERE school_id = ${schoolId} AND day_key >= ${from} AND day_key <= ${to}
      GROUP BY stable_uid`);
    return rows.map((r) => ({ uid: r.uid, days: Number(r.days) }));
  });
}

// The dish the account liked most in the period: its best rating, the
// newest of equal ones.
async function favouriteDish(stableUid: string, since: Date, until: Date) {
  const best = await prisma.dishRating.findFirst({
    where: { stableUid, updatedAt: { gte: since, lt: until } },
    orderBy: [{ stars: 'desc' }, { updatedAt: 'desc' }],
    select: { dishId: true, stars: true },
  });
  if (!best || best.stars < 4) return null;
  const dish = await prisma.dish.findFirst({
    where: { stableKey: best.dishId },
    orderBy: { date: 'desc' },
    select: { nameDe: true, nameIt: true, nameEn: true },
  });
  return dish ? { name: { de: dish.nameDe, it: dish.nameIt || dish.nameDe, en: dish.nameEn || dish.nameDe }, stars: best.stars } : null;
}

export async function recapPokyhFigures(
  account: { stableUid: string; username: string; schoolId: string | null },
  periodFrom: string,
  periodTo: string,
  now = new Date(),
) {
  const tz = config.usageAnalytics.timezone;
  const today = localDayAndHour(now, tz).dayKey;
  const covered = coveredPeriod(periodFrom, periodTo, today);
  const consent = await hasUsageConsent(account.stableUid);
  const user = await prisma.user.findUnique({ where: { stableUid: account.stableUid }, select: { createdAt: true } });
  if (!covered) return { covered: null, usageConsent: consent, memberSince: user?.createdAt.toISOString() ?? null };

  const { stableUid } = account;
  const days = daysBetween(covered.from, covered.to);
  const since = startOfLocalDay(covered.from, tz);
  const until = startOfLocalDay(addDays(covered.to, 1), tz);
  const cutoff = await activityCutoffDay(now);

  const [accountDays, signInRows, archived] = await Promise.all([
    prisma.requestAccountDay.findMany({
      where: { stableUid, dayKey: { gte: covered.from, lte: covered.to } },
      select: { dayKey: true, device: true, client: true, signIns: true },
    }),
    prisma.requestLog.findMany({
      where: { stableUid, method: 'POST', path: { in: SIGN_IN_PATHS }, status: { lt: 300 }, createdAt: { gte: since, lt: until } },
      select: { createdAt: true },
    }),
    archivedDays(stableUid, account.username, covered.from, covered.to, cutoff),
  ]);
  const [sessions, pageViews] = consent
    ? await Promise.all([
        prisma.usageSession.findMany({
          where: { stableUid, dayKey: { gte: covered.from, lte: covered.to } },
          select: { dayKey: true, startHour: true, activeSeconds: true, screens: true },
        }),
        prisma.frontendActivityLog.findMany({
          where: { stableUid, event: 'page_view', createdAt: { gte: since, lt: until } },
          select: { page: true },
          take: 20_000,
        }),
      ])
    : [[], []];

  const summary = summarizeActivity({
    days,
    accountDays,
    sessions,
    signIns: mergeSignIns(signInDays(accountDays), signInRows.map((r) => localDayAndHour(r.createdAt, tz).dayKey)),
    archived,
  });
  const active = summary.days.filter((d) => d.active);
  // The day with the most time in POKYH, or (without the time) the most sign-ins.
  const busiest = active.reduce<(typeof active)[number] | null>((best, d) => {
    if (!best) return d;
    const score = (x: typeof d) => x.activeSeconds * 1000 + x.logins;
    return score(d) > score(best) ? d : best;
  }, null);

  const created = { createdAt: { gte: since, lt: until } };
  const [todos, todosDone, reminders, comments, dishComments, ratings, dish] = await Promise.all([
    prisma.todo.count({ where: { stableUid, ...created } }),
    prisma.todo.count({ where: { stableUid, done: true, doneAt: { gte: since, lt: until } } }),
    prisma.reminder.count({ where: { createdBy: stableUid, ...created } }),
    prisma.comment.count({ where: { stableUid, ...created } }),
    prisma.dishComment.count({ where: { stableUid, ...created } }),
    prisma.dishRating.count({ where: { stableUid, updatedAt: { gte: since, lt: until } } }),
    favouriteDish(stableUid, since, until),
  ]);

  let rank: { topPercent: number; group: number } | null = null;
  if (account.schoolId && summary.totals.activeDays > 0) {
    const school = await schoolActiveDays(account.schoolId, covered.from, covered.to);
    const others = school.filter((r) => r.uid !== stableUid).map((r) => r.days);
    // The ranking counts the live rows only, as everyone else's.
    const mine = school.find((r) => r.uid === stableUid)?.days ?? 0;
    const top = topPercent(mine, others);
    if (top !== null) rank = { topPercent: top, group: others.length + 1 };
  }

  return {
    covered,
    usageConsent: consent,
    memberSince: user?.createdAt.toISOString() ?? null,
    totals: {
      activeDays: summary.totals.activeDays,
      logins: summary.totals.logins,
      activeSeconds: summary.totals.activeSeconds,
      visits: summary.totals.visits,
      screens: summary.totals.screens,
      longestStreak: summary.totals.longestStreak,
    },
    weekdays: summary.weekdays,
    hours: summary.hours,
    platforms: summary.platforms,
    firstDay: active[0]?.date ?? null,
    busiestDay: busiest ? { date: busiest.date, activeSeconds: busiest.activeSeconds, logins: busiest.logins } : null,
    pages: topPages(pageViews.map((p) => p.page), 3),
    created: { todos, todosDone, reminders, comments: comments + dishComments, ratings },
    favouriteDish: dish,
    rank,
  };
}

export type RecapPokyhFigures = Awaited<ReturnType<typeof recapPokyhFigures>>;
