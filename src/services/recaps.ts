import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { cachedFor } from './cache';
import { hasUsageConsent } from './privacyConsent';
import { activityCutoffDay, mergeSignIns, SIGN_IN_PATHS } from './accountActivity';
import { signInDays, summarizeActivity, topPages } from './accountActivitySummary';
import { addDays, daysBetween, localDayAndHour, startOfLocalDay } from './usageAnalytics';
import { archiveInPeriod, archivedDaysOf, coveredPeriod, parseArchive, topPercent, type ArchivePart } from './recapRules';

// The POKYH part of a recap (GET /recaps/:id): what an account did in POKYH
// during the recap's period, read from what is stored anyway — like its
// profile's activity (services/accountActivity.ts), only for the period —
// and from what the school-year rollover keeps of a year that is over:
//
//   request_account_days   active days, devices, sign-ins (the running year)
//   usage_sessions         foreground time, hours (named only with consent)
//   frontend_activity_logs most opened screens (consent, REQUEST_LOG_RETENTION_DAYS)
//   archived_activity      a closed year: active days with sign-ins and time,
//                          its hours and devices
//   todos, reminders, comments, dish ratings — live and archived
//
// An account that came back after a rollover has a new stable id, so the
// archive is matched by its name as well. Its place in its school by active
// days comes from the same rows of everyone there (only "top n %", only among
// enough people). Nothing new is stored.

/** How long a school's ranking is reused: the figures move slowly. */
const RANK_CACHE_SECONDS = 15 * 60;

// The account's archived years within the period (security of the counting:
// services/recapRules.ts archiveInPeriod, tested on its own).
async function archivedPart(stableUid: string, username: string, from: string, to: string, cutoff: string): Promise<ArchivePart> {
  if (from >= cutoff) return archiveInPeriod([], from, to, cutoff);
  const rows = await prisma.archivedActivity.findMany({
    where: { OR: [{ stableUid }, ...(username ? [{ username }] : [])] },
    select: { summaryJson: true },
  });
  return archiveInPeriod(rows.map((r) => r.summaryJson), from, to, cutoff);
}

// Active days per account of one school in the period: the live rows of
// this node and the archive of the years already closed. Keyed by stable
// id; an archived row also carries its name, so the account itself can be
// told apart.
async function schoolActiveDays(schoolId: string, from: string, to: string, cutoff: string): Promise<Array<{ uid: string; username: string; days: number }>> {
  return cachedFor(`recap-rank:v2:${schoolId}:${from}:${to}:${cutoff}`, RANK_CACHE_SECONDS, async () => {
    const counts = new Map<string, { username: string; days: number }>();
    if (to >= cutoff) {
      const rows = await prisma.$queryRaw<Array<{ uid: string; days: bigint | number }>>(Prisma.sql`
        SELECT stable_uid AS uid, COUNT(DISTINCT day_key) AS days
        FROM request_account_days
        WHERE school_id = ${schoolId} AND day_key >= ${from} AND day_key <= ${to}
        GROUP BY stable_uid`);
      for (const r of rows) counts.set(r.uid, { username: '', days: Number(r.days) });
    }
    if (from < cutoff) {
      const archived = await prisma.archivedActivity.findMany({ select: { schoolYearId: true, stableUid: true, username: true, summaryJson: true } });
      if (archived.length > 0) {
        // The school of an archived account: as archived with it, else (an
        // account that stayed) as it is now.
        const [archivedUsers, liveUsers] = await Promise.all([
          prisma.archivedUser.findMany({ where: { stableUid: { in: archived.map((a) => a.stableUid) } }, select: { schoolYearId: true, stableUid: true, schoolId: true } }),
          prisma.user.findMany({ where: { stableUid: { in: archived.map((a) => a.stableUid) } }, select: { stableUid: true, schoolId: true } }),
        ]);
        const archivedSchool = new Map(archivedUsers.map((u) => [`${u.schoolYearId}:${u.stableUid}`, u.schoolId]));
        const liveSchool = new Map(liveUsers.map((u) => [u.stableUid, u.schoolId]));
        for (const a of archived) {
          const school = archivedSchool.get(`${a.schoolYearId}:${a.stableUid}`) ?? liveSchool.get(a.stableUid) ?? null;
          if (school !== schoolId) continue;
          const summary = parseArchive(a.summaryJson);
          if (!summary) continue;
          const days = archivedDaysOf(summary).filter(([day]) => day >= from && day <= to && day < cutoff).length;
          if (days === 0) continue;
          const entry = counts.get(a.stableUid) ?? { username: a.username, days: 0 };
          entry.days += days;
          if (!entry.username) entry.username = a.username;
          counts.set(a.stableUid, entry);
        }
      }
    }
    return [...counts.entries()].map(([uid, e]) => ({ uid, username: e.username, days: e.days }));
  });
}

// The dish the account liked most in the period: its best rating, the
// newest of equal ones. Ratings outlive a rollover; a new stable id finds
// them by name.
async function favouriteDish(who: Prisma.DishRatingWhereInput, inPeriod: Prisma.DishRatingWhereInput) {
  const best = await prisma.dishRating.findFirst({
    where: { AND: [who, inPeriod] },
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

interface ArchivedComment { stableUid?: unknown; username?: unknown; createdAt?: unknown }

// Comments under reminders of closed years (kept inside the archived reminder).
async function archivedComments(stableUid: string, username: string, since: Date, until: Date): Promise<number> {
  const rows = await prisma.archivedReminder.findMany({
    where: { OR: [{ commentsJson: { contains: stableUid } }, ...(username ? [{ commentsJson: { contains: username } }] : [])] },
    select: { commentsJson: true },
    take: 5000,
  });
  let n = 0;
  for (const row of rows) {
    let list: ArchivedComment[];
    try {
      list = JSON.parse(row.commentsJson) as ArchivedComment[];
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      if (c.stableUid !== stableUid && (!username || c.username !== username)) continue;
      const at = typeof c.createdAt === 'string' ? Date.parse(c.createdAt) : NaN;
      if (at >= since.getTime() && at < until.getTime()) n += 1;
    }
  }
  return n;
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
  const cutoff = await activityCutoffDay(now);
  // From which day the live rows are kept; days before it only the archive knows.
  const kept = { liveFrom: cutoff, archive: false };
  if (!covered) return { covered: null, usageConsent: consent, memberSince: user?.createdAt.toISOString() ?? null, kept };

  const { stableUid, username } = account;
  const days = daysBetween(covered.from, covered.to);
  const since = startOfLocalDay(covered.from, tz);
  const until = startOfLocalDay(addDays(covered.to, 1), tz);

  const [accountDays, signInRows, archive] = await Promise.all([
    prisma.requestAccountDay.findMany({
      where: { stableUid, dayKey: { gte: covered.from, lte: covered.to } },
      select: { dayKey: true, device: true, client: true, signIns: true },
    }),
    prisma.requestLog.findMany({
      where: { stableUid, method: 'POST', path: { in: SIGN_IN_PATHS }, status: { lt: 300 }, createdAt: { gte: since, lt: until } },
      select: { createdAt: true },
    }),
    archivedPart(stableUid, username, covered.from, covered.to, cutoff),
  ]);
  kept.archive = archive.found;
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
    archived: archive.days,
  });
  // The archived years' hours and devices next to the live ones.
  const hours = summary.hours.map((v, h) => v + (archive.hours[h] ?? 0));
  const platforms = {
    phone: summary.platforms.phone + archive.platforms.phone,
    desktop: summary.platforms.desktop + archive.platforms.desktop,
    app: summary.platforms.app + archive.platforms.app,
    web: summary.platforms.web + archive.platforms.web,
  };
  const active = summary.days.filter((d) => d.active);
  // The day with the most time in POKYH, or (without the time) the most sign-ins.
  const busiest = active.reduce<(typeof active)[number] | null>((best, d) => {
    if (!best) return d;
    const score = (x: typeof d) => x.activeSeconds * 1000 + x.logins;
    return score(d) > score(best) ? d : best;
  }, null);

  const created = { createdAt: { gte: since, lt: until } };
  const byName = username ? [{ username }] : [];
  const ratingWho: Prisma.DishRatingWhereInput = { OR: [{ stableUid }, ...byName] };
  const ratingInPeriod: Prisma.DishRatingWhereInput = { OR: [{ createdAt: { gte: since, lt: until } }, { updatedAt: { gte: since, lt: until } }] };
  const [todos, todosDone, archivedTodos, archivedTodosDone, reminders, archivedReminders, comments, oldComments, dishComments, ratings, dish] = await Promise.all([
    prisma.todo.count({ where: { stableUid, ...created } }),
    prisma.todo.count({ where: { stableUid, done: true, doneAt: { gte: since, lt: until } } }),
    prisma.archivedTodo.count({ where: { OR: [{ stableUid }, ...byName], ...created } }),
    prisma.archivedTodo.count({ where: { OR: [{ stableUid }, ...byName], done: true, doneAt: { gte: since, lt: until } } }),
    prisma.reminder.count({ where: { createdBy: stableUid, ...created } }),
    prisma.archivedReminder.count({ where: { OR: [{ createdBy: stableUid }, ...(username ? [{ createdByUsername: username }] : [])], ...created } }),
    prisma.comment.count({ where: { stableUid, ...created } }),
    archivedComments(stableUid, username, since, until),
    prisma.dishComment.count({ where: { OR: [{ stableUid }, ...byName], ...created } }),
    prisma.dishRating.count({ where: { AND: [ratingWho, ratingInPeriod] } }),
    favouriteDish(ratingWho, ratingInPeriod),
  ]);

  let rank: { topPercent: number; group: number } | null = null;
  if (account.schoolId && summary.totals.activeDays > 0) {
    const school = await schoolActiveDays(account.schoolId, covered.from, covered.to, cutoff);
    // Everyone else: not this account, live or archived under its name.
    const others = school.filter((r) => r.uid !== stableUid && !(username && r.username === username)).map((r) => r.days);
    const top = topPercent(summary.totals.activeDays, others);
    if (top !== null) rank = { topPercent: top, group: others.length + 1 };
  }

  return {
    covered,
    usageConsent: consent,
    memberSince: user?.createdAt.toISOString() ?? null,
    kept,
    totals: {
      activeDays: summary.totals.activeDays,
      logins: summary.totals.logins,
      activeSeconds: summary.totals.activeSeconds,
      visits: summary.totals.visits,
      screens: summary.totals.screens,
      longestStreak: summary.totals.longestStreak,
    },
    weekdays: summary.weekdays,
    hours,
    platforms,
    firstDay: active[0]?.date ?? null,
    busiestDay: busiest ? { date: busiest.date, activeSeconds: busiest.activeSeconds, logins: busiest.logins } : null,
    pages: topPages(pageViews.map((p) => p.page), 3),
    created: {
      todos: todos + archivedTodos,
      todosDone: todosDone + archivedTodosDone,
      reminders: reminders + archivedReminders,
      comments: comments + oldComments + dishComments,
      ratings,
    },
    favouriteDish: dish,
    rank,
  };
}

export type RecapPokyhFigures = Awaited<ReturnType<typeof recapPokyhFigures>>;
