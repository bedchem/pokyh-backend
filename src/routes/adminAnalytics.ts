import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { requireAdmin } from '../middleware/requireAdmin';
import { TtlCache } from '../utils/cache';
import {
  LENGTH_BANDS,
  ONLINE_WINDOW_MS,
  USAGE_PLATFORMS,
  classifyUserAgent,
  dayAxis,
  localDayAndHour,
  platformOf,
  startOfLocalDay,
  weekdayOf,
  type UsagePlatform,
} from '../services/usageAnalytics';

// ─── GET /api/admin/analytics?days=7|30|90 ───────────────────────────────────
// Everything the admin Analytics page shows, as aggregates only: no row names
// a person. "iOS" and "Android" are the native apps; everything in a browser —
// phone or computer, tab or installed PWA — is "web". Two sources feed it:
//
//   usage_sessions  one row per visit from the web, iOS and Android apps
//                   (device, foreground time, screens) — every time-based figure.
//   request_logs    the user agent of signed-in requests — who uses which
//                   platform, including app versions that send no visits yet,
//                   for as far back as request-log retention reaches.
//
// The page is live (it refetches when the admin stream announces "analytics"),
// so the answer is cached for two seconds only — enough to fold the fetches of
// several open panels after one announcement into one computation, and shorter
// than the five seconds between two usage announcements (see adminLive.ts). The request-log scan is the one heavy query and
// changes slowly; it is cached on its own for longer.

const router = Router();

const RANGES = [7, 30, 90] as const;
const cache = new TtlCache<AnalyticsResponse>(2 * 1000);
const userAgentCache = new TtlCache<UaRow[]>(5 * 60 * 1000);

type UaRow = { uid: string; ua: string };

// Who used which user agent since `since` — the platform evidence from the
// request logs, for clients that report no visits (older app versions).
async function requestLogUserAgents(days: number, since: Date, fresh: boolean): Promise<UaRow[]> {
  const key = String(days);
  const cached = fresh ? undefined : userAgentCache.get(key);
  if (cached) return cached;
  const rows = await prisma.$queryRaw<UaRow[]>`
    SELECT stable_uid AS uid, user_agent AS ua
    FROM request_logs
    WHERE created_at >= ${since} AND stable_uid IS NOT NULL AND user_agent IS NOT NULL
    GROUP BY stable_uid, user_agent`;
  userAgentCache.set(key, rows);
  return rows;
}

type PlatformCounts = Record<UsagePlatform, number>;

interface AnalyticsResponse {
  generatedAt: string;
  timezone: string;
  days: number;
  axis: string[];
  live: { online: number; byPlatform: PlatformCounts };
  platforms: {
    total: number;
    byPlatform: PlatformCounts;
    // Seen in more than one of: iOS app, Android app, web.
    multiPlatform: number;
    // Web users by the device they browse on and by how they open the site.
    web: { mobile: number; desktop: number; pwa: number; browser: number };
    // How long request logs (and so their platform evidence) are kept.
    requestLogRetentionDays: number;
    visitRetentionDays: number;
  };
  time: {
    sessions: number;
    guestSessions: number;
    totalSeconds: number;
    avgSessionSeconds: number;
    medianSessionSeconds: number;
    longestSessionSeconds: number;
    avgDailySecondsPerUser: number;
    sessionsPerUserDay: number;
    screensPerSession: number;
    byPlatform: Record<UsagePlatform, { sessions: number; seconds: number; users: number }>;
    lengthBands: Array<{ label: string; sessions: number }>;
  };
  daily: Array<{
    dayKey: string;
    users: number;
    sessions: number;
    seconds: number;
    userSeconds: number;
    byPlatform: PlatformCounts;
    signups: number;
  }>;
  hours: Array<{ hour: number; sessions: number; seconds: number }>;
  weekdays: Array<{ weekday: number; sessions: number; avgUsers: number; seconds: number }>;
  engagement: {
    dau: number;
    wau: number;
    mau: number;
    visitUsers: number;
    activeUsers: number;
    avgDau: number;
    stickiness: number | null;
    newUsers: number;
    returningUsers: number;
    loyalUsers: number;
    activeDaysPerUser: number;
  };
  accounts: {
    total: number;
    students: number;
    parents: number;
    untis: number;
    local: number;
    newInRange: number;
    withPush: number;
    withLearn: number;
    admins: number;
    classes: number;
    oldestDays: number;
  };
  features: {
    todos: number;
    todosDone: number;
    reminders: number;
    reminderComments: number;
    dishComments: number;
    dishRatings: number;
    avgStars: number | null;
    learnAnswers: number;
    learnCorrect: number;
    learnMinutes: number;
    learnLearners: number;
    pageViews: number;
    downloads: number;
  };
  mensa: {
    topRated: { name: string; avg: number; ratings: number } | null;
    mostRated: { name: string; ratings: number } | null;
    mostCommented: { name: string; comments: number } | null;
    starBands: number[];
  };
  classes: Array<{ name: string; active: number; members: number }>;
  appVersions: Array<{ platform: UsagePlatform; version: string; users: number }>;
  pages: Array<{ page: string; views: number; users: number }>;
}

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'bigint') return Number(value);
  const n = Number(typeof value === 'object' ? String(value) : value);
  return Number.isFinite(n) ? n : 0;
}

function zeroPlatforms(): PlatformCounts {
  return { ios: 0, android: 0, web: 0, other: 0 };
}

function asPlatform(value: unknown): UsagePlatform {
  return (USAGE_PLATFORMS as readonly unknown[]).includes(value) ? value as UsagePlatform : 'other';
}

// The SQL twin of platformOf(): native apps by their device, everything else web.
const PLATFORM_SQL = Prisma.raw("CASE WHEN client <> 'app' THEN 'web' WHEN device IN ('ios', 'android') THEN device ELSE 'other' END");

// "/de/timetable" and "/it/timetable" are the same screen.
function normalisePage(page: string): string {
  const path = page.split('?')[0]?.split('#')[0] ?? '';
  const stripped = path.replace(/^\/(de|it|en|lld)(?=\/|$)/, '') || '/';
  // Ids in a path ("/messages/123") would split one screen into many rows.
  return stripped.replace(/\/[0-9a-f-]{6,}(?=\/|$)/gi, '/:id').replace(/\/\d+(?=\/|$)/g, '/:id');
}

function round(value: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

async function buildAnalytics(days: number, fresh: boolean): Promise<AnalyticsResponse> {
  const tz = config.usageAnalytics.timezone;
  const now = new Date();
  const axis = dayAxis(days, tz, now);
  const fromKey = axis[0]!;
  const todayKey = axis[axis.length - 1]!;
  const since = startOfLocalDay(fromKey, tz);
  const weekKey = dayAxis(7, tz, now)[0]!;
  const monthKey = dayAxis(30, tz, now)[0]!;
  const onlineSince = new Date(now.getTime() - ONLINE_WINDOW_MS);

  type DailyRow = { dayKey: string; platform: string; sessions: bigint; users: bigint; seconds: unknown; userSeconds: unknown };
  type DayTotalRow = { dayKey: string; users: bigint; sessions: bigint; seconds: unknown; userSeconds: unknown };
  type MixRow = { device: string; client: string; sessions: bigint; users: bigint; guests: unknown; seconds: unknown; screens: unknown; longest: unknown };
  type TripleRow = { uid: string; device: string; client: string };
  type HourRow = { hour: number; sessions: bigint; seconds: unknown };
  type BandRow = { band: number; sessions: bigint };
  type OnlineRow = { platform: string; visitors: bigint };
  type CountRow = { n: bigint };
  type VersionRow = { device: string; version: string; users: bigint };
  type PageRow = { page: string; views: bigint; users: bigint };
  type UserActiveDaysRow = { uid: string; activeDays: bigint };
  type DishAggRow = { dishId: string; n: bigint; avgStars: unknown };
  type StarRow = { stars: number; n: bigint };

  const [
    dailyRows,
    dayTotals,
    mixRows,
    triples,
    uaRows,
    hourRows,
    bandRows,
    onlineRows,
    [dauRow],
    [wauRow],
    [mauRow],
    versionRows,
    pageRows,
    activeDayRows,
    users,
    pushRows,
    learnProfiles,
    admins,
    classCount,
    features,
    learnAgg,
    learnLearners,
    eventRows,
    topRatedRows,
    mostRatedRows,
    mostCommentedRows,
    starRows,
    avgStarsAgg,
  ] = await Promise.all([
    prisma.$queryRaw<DailyRow[]>`
      SELECT day_key AS dayKey, ${PLATFORM_SQL} AS platform, COUNT(*) AS sessions, COUNT(DISTINCT stable_uid) AS users,
             SUM(active_seconds) AS seconds,
             SUM(CASE WHEN stable_uid IS NULL THEN 0 ELSE active_seconds END) AS userSeconds
      FROM usage_sessions WHERE day_key >= ${fromKey}
      GROUP BY day_key, platform`,
    prisma.$queryRaw<DayTotalRow[]>`
      SELECT day_key AS dayKey, COUNT(DISTINCT stable_uid) AS users, COUNT(*) AS sessions,
             SUM(active_seconds) AS seconds,
             SUM(CASE WHEN stable_uid IS NULL THEN 0 ELSE active_seconds END) AS userSeconds
      FROM usage_sessions WHERE day_key >= ${fromKey}
      GROUP BY day_key`,
    prisma.$queryRaw<MixRow[]>`
      SELECT device, client, COUNT(*) AS sessions, COUNT(DISTINCT stable_uid) AS users,
             SUM(CASE WHEN stable_uid IS NULL THEN 1 ELSE 0 END) AS guests,
             SUM(active_seconds) AS seconds, SUM(screens) AS screens, MAX(active_seconds) AS longest
      FROM usage_sessions WHERE day_key >= ${fromKey}
      GROUP BY device, client`,
    prisma.$queryRaw<TripleRow[]>`
      SELECT DISTINCT stable_uid AS uid, device, client
      FROM usage_sessions WHERE day_key >= ${fromKey} AND stable_uid IS NOT NULL`,
    requestLogUserAgents(days, since, fresh),
    prisma.$queryRaw<HourRow[]>`
      SELECT start_hour AS hour, COUNT(*) AS sessions, SUM(active_seconds) AS seconds
      FROM usage_sessions WHERE day_key >= ${fromKey}
      GROUP BY start_hour`,
    prisma.$queryRaw<BandRow[]>`
      SELECT CASE
               WHEN active_seconds < ${Prisma.raw(String(LENGTH_BANDS[0]!.maxSeconds))} THEN 0
               WHEN active_seconds < ${Prisma.raw(String(LENGTH_BANDS[1]!.maxSeconds))} THEN 1
               WHEN active_seconds < ${Prisma.raw(String(LENGTH_BANDS[2]!.maxSeconds))} THEN 2
               WHEN active_seconds < ${Prisma.raw(String(LENGTH_BANDS[3]!.maxSeconds))} THEN 3
               ELSE 4
             END AS band, COUNT(*) AS sessions
      FROM usage_sessions WHERE day_key >= ${fromKey}
      GROUP BY band`,
    prisma.$queryRaw<OnlineRow[]>`
      SELECT ${PLATFORM_SQL} AS platform, COUNT(DISTINCT COALESCE(stable_uid, id)) AS visitors
      FROM usage_sessions WHERE last_seen_at >= ${onlineSince}
      GROUP BY platform`,
    prisma.$queryRaw<CountRow[]>`SELECT COUNT(DISTINCT stable_uid) AS n FROM usage_sessions WHERE day_key = ${todayKey}`,
    prisma.$queryRaw<CountRow[]>`SELECT COUNT(DISTINCT stable_uid) AS n FROM usage_sessions WHERE day_key >= ${weekKey}`,
    prisma.$queryRaw<CountRow[]>`SELECT COUNT(DISTINCT stable_uid) AS n FROM usage_sessions WHERE day_key >= ${monthKey}`,
    prisma.$queryRaw<VersionRow[]>`
      SELECT device, app_version AS version, COUNT(DISTINCT COALESCE(stable_uid, id)) AS users
      FROM usage_sessions
      WHERE day_key >= ${fromKey} AND client = 'app' AND app_version <> ''
      GROUP BY device, app_version ORDER BY users DESC LIMIT 12`,
    prisma.$queryRaw<PageRow[]>`
      SELECT page, COUNT(*) AS views, COUNT(DISTINCT stable_uid) AS users
      FROM frontend_activity_logs
      WHERE event = 'page_view' AND created_at >= ${since} AND page IS NOT NULL
      GROUP BY page ORDER BY views DESC LIMIT 60`,
    prisma.$queryRaw<UserActiveDaysRow[]>`
      SELECT stable_uid AS uid, COUNT(DISTINCT day_key) AS activeDays
      FROM usage_sessions WHERE day_key >= ${fromKey} AND stable_uid IS NOT NULL
      GROUP BY stable_uid`,
    prisma.user.findMany({
      select: { stableUid: true, role: true, isUntisUser: true, webuntisKlasseName: true, createdAt: true },
    }),
    prisma.$queryRaw<CountRow[]>`SELECT COUNT(DISTINCT stable_uid) AS n FROM push_subscriptions`,
    prisma.learnProfile.count(),
    prisma.admin.count(),
    prisma.class.count(),
    Promise.all([
      prisma.todo.count({ where: { createdAt: { gte: since } } }),
      prisma.todo.count({ where: { createdAt: { gte: since }, done: true } }),
      prisma.reminder.count({ where: { createdAt: { gte: since } } }),
      prisma.comment.count({ where: { createdAt: { gte: since } } }),
      prisma.dishComment.count({ where: { createdAt: { gte: since } } }),
      prisma.dishRating.count({ where: { updatedAt: { gte: since } } }),
    ]),
    prisma.learnActivityDaily.aggregate({
      where: { dayKey: { gte: fromKey } },
      _sum: { answerCount: true, correctCount: true, durationMs: true },
    }),
    prisma.$queryRaw<CountRow[]>`SELECT COUNT(DISTINCT stable_uid) AS n FROM learn_activity_daily WHERE day_key >= ${fromKey}`,
    prisma.$queryRaw<Array<{ event: string; n: bigint }>>`
      SELECT event, COUNT(*) AS n FROM frontend_activity_logs
      WHERE created_at >= ${since} GROUP BY event`,
    // Mensa records over all time: a dish's ratings outlive the range.
    prisma.$queryRaw<DishAggRow[]>`
      SELECT dish_id AS dishId, COUNT(*) AS n, AVG(stars) AS avgStars FROM dish_ratings
      GROUP BY dish_id HAVING COUNT(*) >= 3 ORDER BY avgStars DESC, n DESC LIMIT 1`,
    prisma.$queryRaw<DishAggRow[]>`
      SELECT dish_id AS dishId, COUNT(*) AS n, AVG(stars) AS avgStars FROM dish_ratings
      GROUP BY dish_id ORDER BY n DESC LIMIT 1`,
    prisma.$queryRaw<DishAggRow[]>`
      SELECT dish_id AS dishId, COUNT(*) AS n, NULL AS avgStars FROM dish_comments
      GROUP BY dish_id ORDER BY n DESC LIMIT 1`,
    prisma.$queryRaw<StarRow[]>`SELECT stars, COUNT(*) AS n FROM dish_ratings GROUP BY stars`,
    prisma.dishRating.aggregate({ _avg: { stars: true } }),
  ]);

  // ── Platforms: visits and request logs together ──────────────────────────
  const perPlatform = new Map<UsagePlatform, Set<string>>(USAGE_PLATFORMS.map((p) => [p, new Set<string>()]));
  const web = { mobile: new Set<string>(), desktop: new Set<string>(), pwa: new Set<string>(), browser: new Set<string>() };
  const addUse = (uid: string, device: string, client: string) => {
    const platform = platformOf(device, client);
    perPlatform.get(platform)!.add(uid);
    if (platform !== 'web') return;
    if (device === 'ios' || device === 'android') web.mobile.add(uid);
    else if (device === 'desktop') web.desktop.add(uid);
    if (client === 'pwa') web.pwa.add(uid);
    else if (client === 'browser') web.browser.add(uid);
  };
  for (const row of triples) addUse(row.uid, row.device, row.client);
  // A user agent cannot tell an installed website from a browser tab, so log
  // rows only ever say "web" — enough for the platform, not for PWA/browser.
  for (const row of uaRows) {
    const kind = classifyUserAgent(row.ua);
    if (kind) addUse(row.uid, kind.device, kind.client);
  }
  const activeUids = new Set<string>();
  const platformsPerUser = new Map<string, number>();
  for (const [, uids] of perPlatform) {
    for (const uid of uids) {
      activeUids.add(uid);
      platformsPerUser.set(uid, (platformsPerUser.get(uid) ?? 0) + 1);
    }
  }
  const byPlatform = Object.fromEntries(USAGE_PLATFORMS.map((p) => [p, perPlatform.get(p)!.size])) as PlatformCounts;

  // ── Time (visits only: that is where time is measured) ───────────────────
  const timeByPlatform = Object.fromEntries(USAGE_PLATFORMS.map((p) => [p, { sessions: 0, seconds: 0, users: 0 }])) as AnalyticsResponse['time']['byPlatform'];
  let sessions = 0;
  let guestSessions = 0;
  let totalSeconds = 0;
  let totalScreens = 0;
  let longest = 0;
  for (const row of mixRows) {
    const platform = platformOf(row.device, row.client);
    timeByPlatform[platform].sessions += num(row.sessions);
    timeByPlatform[platform].seconds += num(row.seconds);
    sessions += num(row.sessions);
    guestSessions += num(row.guests);
    totalSeconds += num(row.seconds);
    totalScreens += num(row.screens);
    longest = Math.max(longest, num(row.longest));
  }
  const visitUsersByPlatform = new Map<UsagePlatform, Set<string>>();
  for (const row of triples) {
    const platform = platformOf(row.device, row.client);
    if (!visitUsersByPlatform.has(platform)) visitUsersByPlatform.set(platform, new Set());
    visitUsersByPlatform.get(platform)!.add(row.uid);
  }
  for (const p of USAGE_PLATFORMS) timeByPlatform[p].users = visitUsersByPlatform.get(p)?.size ?? 0;

  let median = 0;
  if (sessions > 0) {
    // The offset is a count computed here, never input; inlined because some
    // drivers bind a placeholder in LIMIT/OFFSET as a non-integer type.
    const offset = Prisma.raw(String(Math.max(0, Math.floor((sessions - 1) / 2))));
    const [row] = await prisma.$queryRaw<Array<{ s: number }>>`
      SELECT active_seconds AS s FROM usage_sessions WHERE day_key >= ${fromKey}
      ORDER BY active_seconds LIMIT 1 OFFSET ${offset}`;
    median = num(row?.s);
  }

  // ── Days ──────────────────────────────────────────────────────────────────
  const signupsByDay = new Map<string, number>();
  let newInRange = 0;
  const createdAtByUid = new Map<string, Date>();
  for (const user of users) {
    createdAtByUid.set(user.stableUid, user.createdAt);
    if (user.createdAt >= since) {
      newInRange += 1;
      const { dayKey } = localDayAndHour(user.createdAt, tz);
      signupsByDay.set(dayKey, (signupsByDay.get(dayKey) ?? 0) + 1);
    }
  }
  const totalsByDay = new Map(dayTotals.map((row) => [row.dayKey, row]));
  const platformsByDay = new Map<string, PlatformCounts>();
  for (const row of dailyRows) {
    if (!platformsByDay.has(row.dayKey)) platformsByDay.set(row.dayKey, zeroPlatforms());
    platformsByDay.get(row.dayKey)![asPlatform(row.platform)] += num(row.users);
  }
  const daily = axis.map((dayKey) => {
    const total = totalsByDay.get(dayKey);
    return {
      dayKey,
      users: num(total?.users),
      sessions: num(total?.sessions),
      seconds: num(total?.seconds),
      userSeconds: num(total?.userSeconds),
      byPlatform: platformsByDay.get(dayKey) ?? zeroPlatforms(),
      signups: signupsByDay.get(dayKey) ?? 0,
    };
  });
  const userDays = daily.reduce((sum, d) => sum + d.users, 0);
  const userSeconds = daily.reduce((sum, d) => sum + d.userSeconds, 0);

  const hourMap = new Map(hourRows.map((row) => [num(row.hour), row]));
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    sessions: num(hourMap.get(hour)?.sessions),
    seconds: num(hourMap.get(hour)?.seconds),
  }));

  const weekdays = Array.from({ length: 7 }, (_, weekday) => {
    const ofDay = daily.filter((d) => weekdayOf(d.dayKey) === weekday);
    return {
      weekday,
      sessions: ofDay.reduce((sum, d) => sum + d.sessions, 0),
      seconds: ofDay.reduce((sum, d) => sum + d.seconds, 0),
      avgUsers: ofDay.length > 0 ? round(ofDay.reduce((sum, d) => sum + d.users, 0) / ofDay.length) : 0,
    };
  });

  const bandMap = new Map(bandRows.map((row) => [num(row.band), num(row.sessions)]));
  const lengthBands = LENGTH_BANDS.map((band, i) => ({ label: band.label, sessions: bandMap.get(i) ?? 0 }));

  const online = zeroPlatforms();
  for (const row of onlineRows) online[asPlatform(row.platform)] += num(row.visitors);

  // ── Engagement ────────────────────────────────────────────────────────────
  const visitUsers = activeDayRows.length;
  let newUsers = 0;
  for (const uid of activeUids) {
    const created = createdAtByUid.get(uid);
    if (created && created >= since) newUsers += 1;
  }
  const activeDaysTotal = activeDayRows.reduce((sum, row) => sum + num(row.activeDays), 0);
  // "Loyal": active on at least half of the days in the range (at least 2).
  const loyalThreshold = Math.max(2, Math.ceil(axis.length / 2));
  const loyalUsers = activeDayRows.filter((row) => num(row.activeDays) >= loyalThreshold).length;
  const avgDau = userDays / axis.length;
  const mau = num(mauRow?.n);

  // ── Accounts and classes ──────────────────────────────────────────────────
  let students = 0;
  let parents = 0;
  let untis = 0;
  let oldest = now.getTime();
  const classMembers = new Map<string, { members: number; active: number }>();
  for (const user of users) {
    if (user.role === 'parent') parents += 1;
    else students += 1;
    if (user.isUntisUser) untis += 1;
    oldest = Math.min(oldest, user.createdAt.getTime());
    const name = user.webuntisKlasseName.trim();
    if (user.role !== 'parent' && name) {
      const entry = classMembers.get(name) ?? { members: 0, active: 0 };
      entry.members += 1;
      if (activeUids.has(user.stableUid)) entry.active += 1;
      classMembers.set(name, entry);
    }
  }
  const classes = [...classMembers.entries()]
    .map(([name, c]) => ({ name, active: c.active, members: c.members }))
    .filter((c) => c.active > 0)
    .sort((a, b) => b.active - a.active || b.members - a.members || a.name.localeCompare(b.name))
    .slice(0, 10);

  // ── Pages ─────────────────────────────────────────────────────────────────
  const pageMap = new Map<string, { views: number; users: number }>();
  for (const row of pageRows) {
    const page = normalisePage(row.page);
    const entry = pageMap.get(page) ?? { views: 0, users: 0 };
    entry.views += num(row.views);
    // Users can only be summed across localised variants as an upper bound;
    // the larger variant is the honest lower bound.
    entry.users = Math.max(entry.users, num(row.users));
    pageMap.set(page, entry);
  }
  const pages = [...pageMap.entries()]
    .map(([page, v]) => ({ page, ...v }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 10);

  // ── Mensa ─────────────────────────────────────────────────────────────────
  // Ratings and comments are keyed by a dish's stableKey (the same dish on
  // another day shares it); rows from before that migration by its id.
  const dishKeys = [topRatedRows[0]?.dishId, mostRatedRows[0]?.dishId, mostCommentedRows[0]?.dishId].filter((id): id is string => Boolean(id));
  const dishes = dishKeys.length > 0
    ? await prisma.dish.findMany({
      where: { OR: [{ stableKey: { in: dishKeys } }, { id: { in: dishKeys } }] },
      select: { id: true, stableKey: true, nameDe: true },
    })
    : [];
  const dishName = (key: string | undefined) => dishes.find((d) => d.stableKey === key || d.id === key)?.nameDe ?? null;
  const topRatedName = dishName(topRatedRows[0]?.dishId);
  const mostRatedName = dishName(mostRatedRows[0]?.dishId);
  const mostCommentedName = dishName(mostCommentedRows[0]?.dishId);
  const starBands = [1, 2, 3, 4, 5].map((stars) => num(starRows.find((row) => num(row.stars) === stars)?.n));

  const [todos, todosDone, reminders, reminderComments, dishComments, dishRatings] = features;
  const events = new Map(eventRows.map((row) => [row.event, num(row.n)]));

  return {
    generatedAt: now.toISOString(),
    timezone: tz,
    days,
    axis,
    live: { online: Object.values(online).reduce((a, b) => a + b, 0), byPlatform: online },
    platforms: {
      total: activeUids.size,
      byPlatform,
      multiPlatform: [...platformsPerUser.values()].filter((n) => n > 1).length,
      web: { mobile: web.mobile.size, desktop: web.desktop.size, pwa: web.pwa.size, browser: web.browser.size },
      requestLogRetentionDays: config.requestLogRetentionDays,
      visitRetentionDays: config.usageAnalytics.retentionDays,
    },
    time: {
      sessions,
      guestSessions,
      totalSeconds,
      avgSessionSeconds: sessions > 0 ? Math.round(totalSeconds / sessions) : 0,
      medianSessionSeconds: median,
      longestSessionSeconds: longest,
      avgDailySecondsPerUser: userDays > 0 ? Math.round(userSeconds / userDays) : 0,
      sessionsPerUserDay: userDays > 0 ? round((sessions - guestSessions) / userDays) : 0,
      screensPerSession: sessions > 0 ? round(totalScreens / sessions) : 0,
      byPlatform: timeByPlatform,
      lengthBands,
    },
    daily,
    hours,
    weekdays,
    engagement: {
      dau: num(dauRow?.n),
      wau: num(wauRow?.n),
      mau,
      visitUsers,
      activeUsers: activeUids.size,
      avgDau: round(avgDau),
      stickiness: mau > 0 ? round((daily.slice(-30).reduce((s, d) => s + d.users, 0) / Math.min(30, axis.length)) / mau, 3) : null,
      newUsers,
      returningUsers: Math.max(0, activeUids.size - newUsers),
      loyalUsers,
      activeDaysPerUser: visitUsers > 0 ? round(activeDaysTotal / visitUsers) : 0,
    },
    accounts: {
      total: users.length,
      students,
      parents,
      untis,
      local: users.length - untis,
      newInRange,
      withPush: num(pushRows[0]?.n),
      withLearn: learnProfiles,
      admins,
      classes: classCount,
      oldestDays: users.length > 0 ? Math.floor((now.getTime() - oldest) / 86_400_000) : 0,
    },
    features: {
      todos,
      todosDone,
      reminders,
      reminderComments,
      dishComments,
      dishRatings,
      avgStars: avgStarsAgg._avg.stars === null ? null : round(avgStarsAgg._avg.stars, 2),
      learnAnswers: num(learnAgg._sum.answerCount),
      learnCorrect: num(learnAgg._sum.correctCount),
      learnMinutes: Math.round(num(learnAgg._sum.durationMs) / 60_000),
      learnLearners: num(learnLearners[0]?.n),
      pageViews: events.get('page_view') ?? 0,
      downloads: events.get('download') ?? 0,
    },
    mensa: {
      topRated: topRatedRows[0] && topRatedName
        ? { name: topRatedName, avg: round(num(topRatedRows[0].avgStars), 2), ratings: num(topRatedRows[0].n) }
        : null,
      mostRated: mostRatedRows[0] && mostRatedName ? { name: mostRatedName, ratings: num(mostRatedRows[0].n) } : null,
      mostCommented: mostCommentedRows[0] && mostCommentedName
        ? { name: mostCommentedName, comments: num(mostCommentedRows[0].n) }
        : null,
      starBands,
    },
    classes,
    appVersions: versionRows.map((row) => ({ platform: platformOf(row.device, 'app'), version: row.version, users: num(row.users) })),
    pages,
  };
}

router.get('/', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const requested = Number(req.query['days']);
  const days = (RANGES as readonly number[]).includes(requested) ? requested : 30;
  const key = String(days);
  const fresh = req.query['fresh'] === '1';

  const cached = fresh ? undefined : cache.get(key);
  if (cached) {
    res.json(cached);
    return;
  }

  try {
    const result = await buildAnalytics(days, fresh);
    cache.set(key, result);
    res.json(result);
  } catch (err) {
    // A missing table (schema not yet applied) or a failed scan: an older
    // answer is better than none.
    const stale = cache.stale(key);
    if (stale) {
      res.json(stale);
      return;
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError || err instanceof Prisma.PrismaClientUnknownRequestError) {
      res.status(503).json({ error: 'Analytics are not available yet' });
      return;
    }
    throw err;
  }
});

export { router as analyticsAdminRouter };
