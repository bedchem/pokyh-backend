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
  addDays,
  dayAxis,
  daysBetween,
  localDayAndHour,
  platformOf,
  startOfLocalDay,
  weekdayOf,
  type UsagePlatform,
} from '../services/usageAnalytics';

// ─── GET /api/admin/analytics?days=7|30|90 ───────────────────────────────────
// Everything the admin Analytics page shows. The page itself is aggregates;
// GET /people (below) lists the accounts behind one of its figures — only
// accounts that consented to the usage statistics; every other visit is
// anonymous and counted per day through its day-scoped visitor key. "iOS" and "Android" are the native apps; everything in a browser —
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
// than the five seconds between two usage announcements (see adminLive.ts).
// The request-log scan is the one heavy query and changes slowly; it is cached
// on its own for longer.

const router = Router();

const cache = new TtlCache<AnalyticsResponse>(2 * 1000);
const userAgentCache = new TtlCache<UaRow[]>(5 * 60 * 1000);

type UaRow = { uid: string; ua: string; lastAt: Date };

// Who used which user agent in [since, until) — the platform evidence from the
// request logs, for clients that report no visits (older app versions).
async function requestLogUserAgents(key: string, since: Date, until: Date, fresh: boolean): Promise<UaRow[]> {
  const cached = fresh ? undefined : userAgentCache.get(key);
  if (cached) return cached;
  const rows = await prisma.$queryRaw<UaRow[]>`
    SELECT stable_uid AS uid, user_agent AS ua, MAX(created_at) AS lastAt
    FROM request_logs
    WHERE created_at >= ${since} AND created_at < ${until} AND stable_uid IS NOT NULL AND user_agent IS NOT NULL
    GROUP BY stable_uid, user_agent`;
  userAgentCache.set(key, rows);
  return rows;
}

// ─── Periods ─────────────────────────────────────────────────────────────────
// The page offers the last 7, 30, 90 and 365 days, everything since Pokyh
// has data, and each calendar year. Every figure covers the local days
// [fromKey, toKey]; the "now" figures (online, today, 7 and 30 days) do not
// depend on it.

const RANGE_DAYS = [7, 30, 90, 365] as const;
const FIRST_YEAR = 2024;

interface Period {
  key: string;
  label: string;
  fromKey: string;
  toKey: string;
  axis: string[];
  since: Date;
  until: Date;
}

class BadPeriod extends Error {}

const earliestCache = new TtlCache<string>(10 * 60 * 1000);

// The first local day anything was recorded: a visit or an account.
async function earliestDayKey(tz: string): Promise<string | null> {
  const cached = earliestCache.get('earliest');
  if (cached) return cached;
  const [[visit], firstUser] = await Promise.all([
    prisma.$queryRaw<Array<{ k: string | null }>>`SELECT MIN(day_key) AS k FROM usage_sessions`,
    prisma.user.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
  ]);
  const candidates = [visit?.k ?? null, firstUser ? localDayAndHour(firstUser.createdAt, tz).dayKey : null]
    .filter((key): key is string => Boolean(key))
    .sort();
  const earliest = candidates[0] ?? null;
  if (earliest) earliestCache.set('earliest', earliest);
  return earliest;
}

async function resolvePeriod(query: Request['query']): Promise<Period> {
  const tz = config.usageAnalytics.timezone;
  const todayKey = localDayAndHour(new Date(), tz).dayKey;
  const raw = typeof query['range'] === 'string' ? query['range'] : typeof query['days'] === 'string' ? query['days'] : '30';
  let fromKey: string;
  let toKey = todayKey;
  let label: string;
  let key: string;
  if (/^\d{4}$/.test(raw)) {
    const year = Number(raw);
    if (year < FIRST_YEAR || year > Number(todayKey.slice(0, 4))) throw new BadPeriod('Unknown year');
    fromKey = `${raw}-01-01`;
    toKey = `${raw}-12-31` < todayKey ? `${raw}-12-31` : todayKey;
    label = `Jahr ${raw}`;
    key = raw;
  } else if (raw === 'all') {
    const earliest = await earliestDayKey(tz);
    fromKey = earliest && earliest < todayKey ? earliest : todayKey;
    label = 'Alltime';
    key = 'all';
  } else {
    const n = (RANGE_DAYS as readonly number[]).includes(Number(raw)) ? Number(raw) : 30;
    fromKey = dayAxis(n, tz)[0]!;
    label = n === 365 ? 'letzte 12 Monate' : `letzte ${n} Tage`;
    key = String(n);
  }
  return {
    key,
    label,
    fromKey,
    toKey,
    axis: daysBetween(fromKey, toKey),
    since: startOfLocalDay(fromKey, tz),
    until: startOfLocalDay(addDays(toKey, 1), tz),
  };
}

async function availableYears(tz: string): Promise<number[]> {
  const earliest = await earliestDayKey(tz);
  const current = Number(localDayAndHour(new Date(), tz).dayKey.slice(0, 4));
  const first = Math.max(FIRST_YEAR, earliest ? Number(earliest.slice(0, 4)) : current);
  return Array.from({ length: current - first + 1 }, (_, i) => current - i);
}

// Counts different people per day: a visit's day-scoped visitor key, or its
// account where an older row has no key.
const PERSON_SQL = Prisma.raw('COALESCE(visitor_key, stable_uid)');

type PlatformCounts = Record<UsagePlatform, number>;

interface AnalyticsResponse {
  generatedAt: string;
  timezone: string;
  period: { key: string; label: string; fromKey: string; toKey: string };
  availableYears: number[];
  days: number;
  axis: string[];
  live: { online: number; byPlatform: PlatformCounts };
  platforms: {
    // "accounts": different accounts in the period (server logs reach it);
    // "dailyAverage": different people per day, averaged over the days with
    // use (longer periods, which no per-account record covers).
    mode: 'accounts' | 'dailyAverage';
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
    // Accounts that consented to the personal usage statistics, that chose
    // "Nur notwendige" (refused), and that have not chosen yet.
    usageConsents: number;
    usageRefusals: number;
    usageUndecided: number;
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
  // The classes whose students spent the most time in Pokyh.
  classes: Array<{ name: string; seconds: number; users: number; sessions: number }>;
  appVersions: Array<{ platform: UsagePlatform; version: string; sessions: number }>;
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

function avgDauOf(daily: Array<{ users: number }>, daysWithUse: number): number {
  return daily.reduce((sum, d) => sum + d.users, 0) / Math.max(1, daysWithUse);
}

function round(value: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

async function buildAnalytics(period: Period, fresh: boolean): Promise<AnalyticsResponse> {
  const tz = config.usageAnalytics.timezone;
  const now = new Date();
  const { axis, fromKey, toKey, since, until } = period;
  const days = axis.length;
  const todayKey = localDayAndHour(now, tz).dayKey;
  const weekKey = dayAxis(7, tz, now)[0]!;
  const monthKey = dayAxis(30, tz, now)[0]!;
  const weekStart = startOfLocalDay(weekKey, tz);
  const monthStart = startOfLocalDay(monthKey, tz);
  const onlineSince = new Date(now.getTime() - ONLINE_WINDOW_MS);
  const identityFrom = dayAxis(config.usageAnalytics.retentionDays, tz, now)[0]!;
  // Different accounts can only be counted while the server logs reach back.
  const logsFrom = dayAxis(config.requestLogRetentionDays, tz, now)[0]!;
  const mode: AnalyticsResponse['platforms']['mode'] = fromKey >= logsFrom ? 'accounts' : 'dailyAverage';
  const inPeriod = Prisma.sql`day_key >= ${fromKey} AND day_key <= ${toKey}`;

  type DailyRow = { dayKey: string; platform: string; sessions: bigint; users: bigint; seconds: unknown; userSeconds: unknown };
  type DayTotalRow = { dayKey: string; users: bigint; sessions: bigint; seconds: unknown; userSeconds: unknown };
  type MixRow = { device: string; client: string; sessions: bigint; users: bigint; guests: unknown; seconds: unknown; screens: unknown; longest: unknown };
  type TripleRow = { uid: string; device: string; client: string };
  type HourRow = { hour: number; sessions: bigint; seconds: unknown };
  type BandRow = { band: number; sessions: bigint };
  type OnlineRow = { platform: string; visitors: bigint };
  type CountRow = { n: bigint };
  type VersionRow = { device: string; version: string; sessions: bigint };
  type UidRow = { uid: string };
  type DayCountRow = { dayKey: string; n: bigint };
  type WebRow = { mobile: bigint; desktop: bigint; pwa: bigint; browser: bigint };
  type PageRow = { page: string; views: bigint; users: bigint };
  type UserActiveDaysRow = { uid: string; activeDays: bigint };
  type DishAggRow = { dishId: string; n: bigint; avgStars: unknown };
  type StarRow = { stars: number; n: bigint };
  type ClassRow = { name: string; seconds: unknown; users: bigint; sessions: bigint };

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
    ,
    ,
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
    classRows,
    usageConsents,
    weekLogUids,
    monthLogUids,
    weekVisitUids,
    monthVisitUids,
    recentDau,
    webRows,
    usageRefusals,
  ] = await Promise.all([
    prisma.$queryRaw<DailyRow[]>`
      SELECT day_key AS dayKey, ${PLATFORM_SQL} AS platform, COUNT(*) AS sessions, COUNT(DISTINCT ${PERSON_SQL}) AS users,
             SUM(active_seconds) AS seconds,
             SUM(CASE WHEN ${PERSON_SQL} IS NULL THEN 0 ELSE active_seconds END) AS userSeconds
      FROM usage_sessions WHERE ${inPeriod}
      GROUP BY day_key, platform`,
    prisma.$queryRaw<DayTotalRow[]>`
      SELECT day_key AS dayKey, COUNT(DISTINCT ${PERSON_SQL}) AS users, COUNT(*) AS sessions,
             SUM(active_seconds) AS seconds,
             SUM(CASE WHEN ${PERSON_SQL} IS NULL THEN 0 ELSE active_seconds END) AS userSeconds
      FROM usage_sessions WHERE ${inPeriod}
      GROUP BY day_key`,
    prisma.$queryRaw<MixRow[]>`
      SELECT device, client, COUNT(*) AS sessions, COUNT(DISTINCT stable_uid) AS users,
             SUM(CASE WHEN ${PERSON_SQL} IS NULL THEN 1 ELSE 0 END) AS guests,
             SUM(active_seconds) AS seconds, SUM(screens) AS screens, MAX(active_seconds) AS longest
      FROM usage_sessions WHERE ${inPeriod}
      GROUP BY device, client`,
    prisma.$queryRaw<TripleRow[]>`
      SELECT DISTINCT stable_uid AS uid, device, client
      FROM usage_sessions WHERE ${inPeriod} AND stable_uid IS NOT NULL`,
    requestLogUserAgents(`page|${period.key}`, since, until, fresh),
    prisma.$queryRaw<HourRow[]>`
      SELECT start_hour AS hour, COUNT(*) AS sessions, SUM(active_seconds) AS seconds
      FROM usage_sessions WHERE ${inPeriod}
      GROUP BY start_hour`,
    prisma.$queryRaw<BandRow[]>`
      SELECT CASE
               WHEN active_seconds < ${Prisma.raw(String(LENGTH_BANDS[0]!.maxSeconds))} THEN 0
               WHEN active_seconds < ${Prisma.raw(String(LENGTH_BANDS[1]!.maxSeconds))} THEN 1
               WHEN active_seconds < ${Prisma.raw(String(LENGTH_BANDS[2]!.maxSeconds))} THEN 2
               WHEN active_seconds < ${Prisma.raw(String(LENGTH_BANDS[3]!.maxSeconds))} THEN 3
               ELSE 4
             END AS band, COUNT(*) AS sessions
      FROM usage_sessions WHERE ${inPeriod}
      GROUP BY band`,
    prisma.$queryRaw<OnlineRow[]>`
      SELECT ${PLATFORM_SQL} AS platform, COUNT(DISTINCT COALESCE(stable_uid, visitor_key, id)) AS visitors
      FROM usage_sessions WHERE last_seen_at >= ${onlineSince}
      GROUP BY platform`,
    prisma.$queryRaw<CountRow[]>`SELECT COUNT(DISTINCT ${PERSON_SQL}) AS n FROM usage_sessions WHERE day_key = ${todayKey}`,
    Promise.resolve([] as CountRow[]),
    Promise.resolve([] as CountRow[]),
    prisma.$queryRaw<VersionRow[]>`
      SELECT device, app_version AS version, COUNT(*) AS sessions
      FROM usage_sessions
      WHERE ${inPeriod} AND client = 'app' AND app_version <> ''
      GROUP BY device, app_version ORDER BY sessions DESC LIMIT 12`,
    prisma.$queryRaw<PageRow[]>`
      SELECT page, COUNT(*) AS views, COUNT(DISTINCT stable_uid) AS users
      FROM frontend_activity_logs
      WHERE event = 'page_view' AND created_at >= ${since} AND created_at < ${until} AND page IS NOT NULL
      GROUP BY page ORDER BY views DESC LIMIT 60`,
    prisma.$queryRaw<UserActiveDaysRow[]>`
      SELECT stable_uid AS uid, COUNT(DISTINCT day_key) AS activeDays
      FROM usage_sessions WHERE ${inPeriod} AND stable_uid IS NOT NULL
      GROUP BY stable_uid`,
    prisma.user.findMany({
      select: { stableUid: true, role: true, isUntisUser: true, webuntisKlasseName: true, createdAt: true },
    }),
    prisma.$queryRaw<CountRow[]>`SELECT COUNT(DISTINCT stable_uid) AS n FROM push_subscriptions`,
    prisma.learnProfile.count(),
    prisma.admin.count(),
    prisma.class.count(),
    Promise.all([
      prisma.todo.count({ where: { createdAt: { gte: since, lt: until } } }),
      prisma.todo.count({ where: { createdAt: { gte: since, lt: until }, done: true } }),
      prisma.reminder.count({ where: { createdAt: { gte: since, lt: until } } }),
      prisma.comment.count({ where: { createdAt: { gte: since, lt: until } } }),
      prisma.dishComment.count({ where: { createdAt: { gte: since, lt: until } } }),
      prisma.dishRating.count({ where: { updatedAt: { gte: since, lt: until } } }),
    ]),
    prisma.learnActivityDaily.aggregate({
      where: { dayKey: { gte: fromKey, lte: toKey } },
      _sum: { answerCount: true, correctCount: true, durationMs: true },
    }),
    prisma.$queryRaw<CountRow[]>`SELECT COUNT(DISTINCT stable_uid) AS n FROM learn_activity_daily WHERE day_key >= ${fromKey} AND day_key <= ${toKey}`,
    prisma.$queryRaw<Array<{ event: string; n: bigint }>>`
      SELECT event, COUNT(*) AS n FROM frontend_activity_logs
      WHERE created_at >= ${since} AND created_at < ${until} GROUP BY event`,
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
    prisma.$queryRaw<ClassRow[]>`
      SELECT u.webuntis_klasse_name AS name, SUM(s.active_seconds) AS seconds,
             COUNT(DISTINCT s.stable_uid) AS users, COUNT(*) AS sessions
      FROM usage_sessions s JOIN users u ON u.stable_uid = s.stable_uid
      WHERE s.day_key >= ${fromKey} AND s.day_key <= ${toKey} AND u.role <> 'parent' AND u.webuntis_klasse_name <> ''
      GROUP BY u.webuntis_klasse_name
      ORDER BY seconds DESC LIMIT 10`,
    prisma.privacyConsent.count({ where: { usageStats: true } }),
    // Accounts active in the last 7 and 30 days: the server logs (everyone)
    // and named visits, together.
    prisma.$queryRaw<UidRow[]>`SELECT DISTINCT stable_uid AS uid FROM request_logs WHERE created_at >= ${weekStart} AND stable_uid IS NOT NULL`,
    prisma.$queryRaw<UidRow[]>`SELECT DISTINCT stable_uid AS uid FROM request_logs WHERE created_at >= ${monthStart} AND stable_uid IS NOT NULL`,
    prisma.$queryRaw<UidRow[]>`SELECT DISTINCT stable_uid AS uid FROM usage_sessions WHERE day_key >= ${weekKey} AND stable_uid IS NOT NULL`,
    prisma.$queryRaw<UidRow[]>`SELECT DISTINCT stable_uid AS uid FROM usage_sessions WHERE day_key >= ${monthKey} AND stable_uid IS NOT NULL`,
    // People per day over the last 30 days, for "täglich da".
    prisma.$queryRaw<DayCountRow[]>`
      SELECT day_key AS dayKey, COUNT(DISTINCT ${PERSON_SQL}) AS n FROM usage_sessions
      WHERE day_key >= ${monthKey} GROUP BY day_key`,
    // Web visitors per day by device and how the site was opened, for the
    // per-day averages of long periods.
    prisma.$queryRaw<WebRow[]>`
      SELECT COUNT(DISTINCT CASE WHEN device IN ('ios', 'android') THEN ${PERSON_SQL} END) AS mobile,
             COUNT(DISTINCT CASE WHEN device = 'desktop' THEN ${PERSON_SQL} END) AS desktop,
             COUNT(DISTINCT CASE WHEN client = 'pwa' THEN ${PERSON_SQL} END) AS pwa,
             COUNT(DISTINCT CASE WHEN client = 'browser' THEN ${PERSON_SQL} END) AS browser
      FROM usage_sessions WHERE ${inPeriod} AND client <> 'app' GROUP BY day_key`,
    // A choice was made (it has a time) and it was no.
    prisma.privacyConsent.count({ where: { usageStats: false, usageStatsAt: { not: null } } }),
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
  const webCounts = { mobile: web.mobile.size, desktop: web.desktop.size, pwa: web.pwa.size, browser: web.browser.size };

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
      SELECT active_seconds AS s FROM usage_sessions WHERE ${inPeriod}
      ORDER BY active_seconds LIMIT 1 OFFSET ${offset}`;
    median = num(row?.s);
  }

  // ── Days ──────────────────────────────────────────────────────────────────
  const signupsByDay = new Map<string, number>();
  let newInRange = 0;
  const createdAtByUid = new Map<string, Date>();
  for (const user of users) {
    createdAtByUid.set(user.stableUid, user.createdAt);
    if (user.createdAt >= since && user.createdAt < until) {
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
  const daysWithUse = Math.max(1, daily.filter((d) => d.sessions > 0).length);

  const hourMap = new Map(hourRows.map((row) => [num(row.hour), row]));
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    sessions: num(hourMap.get(hour)?.sessions),
    seconds: num(hourMap.get(hour)?.seconds),
  }));

  const weekdays = Array.from({ length: 7 }, (_, weekday) => {
    const ofDay = daily.filter((d) => weekdayOf(d.dayKey) === weekday);
    // Averaged over the days with use: a long period starts before Pokyh did.
    const used = ofDay.filter((d) => d.sessions > 0);
    return {
      weekday,
      sessions: ofDay.reduce((sum, d) => sum + d.sessions, 0),
      seconds: ofDay.reduce((sum, d) => sum + d.seconds, 0),
      avgUsers: used.length > 0 ? round(used.reduce((sum, d) => sum + d.users, 0) / used.length) : 0,
    };
  });

  const bandMap = new Map(bandRows.map((row) => [num(row.band), num(row.sessions)]));
  const lengthBands = LENGTH_BANDS.map((band, i) => ({ label: band.label, sessions: bandMap.get(i) ?? 0 }));

  // Long periods: different people per day, averaged over the days with use.
  let platformTotal = activeUids.size;
  if (mode === 'dailyAverage') {
    for (const p of USAGE_PLATFORMS) byPlatform[p] = round(daily.reduce((sum, d) => sum + d.byPlatform[p], 0) / daysWithUse);
    platformTotal = round(avgDauOf(daily, daysWithUse));
    const average = (pick: (row: WebRow) => bigint) => round(webRows.reduce((sum, row) => sum + num(pick(row)), 0) / daysWithUse);
    webCounts.mobile = average((row) => row.mobile);
    webCounts.desktop = average((row) => row.desktop);
    webCounts.pwa = average((row) => row.pwa);
    webCounts.browser = average((row) => row.browser);
  }

  const online = zeroPlatforms();
  for (const row of onlineRows) online[asPlatform(row.platform)] += num(row.visitors);

  // ── Engagement ────────────────────────────────────────────────────────────
  const visitUsers = activeDayRows.length;
  let newUsers = 0;
  for (const uid of activeUids) {
    const created = createdAtByUid.get(uid);
    if (created && created >= since && created < until) newUsers += 1;
  }
  const activeDaysTotal = activeDayRows.reduce((sum, row) => sum + num(row.activeDays), 0);
  // "Loyal": active on at least half of the days with use (at least 2) —
  // counted where visits still name their account.
  const namedDaysWithUse = daily.filter((d) => d.dayKey >= identityFrom && d.sessions > 0).length;
  const loyalThreshold = Math.max(2, Math.ceil(namedDaysWithUse / 2));
  const loyalUsers = activeDayRows.filter((row) => num(row.activeDays) >= loyalThreshold).length;
  const avgDau = userDays / daysWithUse;
  const union = (a: UidRow[], b: UidRow[]) => new Set([...a, ...b].map((row) => row.uid)).size;
  // Today counts everyone (day keys), 7 and 30 days count accounts (server
  // logs and named visits); a longer window never shows fewer.
  const dau = num(dauRow?.n);
  const wau = Math.max(dau, union(weekLogUids, weekVisitUids));
  const mau = Math.max(wau, union(monthLogUids, monthVisitUids));
  const recentAvgDau = recentDau.length > 0 ? recentDau.reduce((sum, row) => sum + num(row.n), 0) / 30 : 0;

  // ── Accounts and classes ──────────────────────────────────────────────────
  let students = 0;
  let parents = 0;
  let untis = 0;
  let oldest = now.getTime();
  for (const user of users) {
    if (user.role === 'parent') parents += 1;
    else students += 1;
    if (user.isUntisUser) untis += 1;
    oldest = Math.min(oldest, user.createdAt.getTime());
  }
  const classes = classRows
    .map((row) => ({ name: row.name, seconds: num(row.seconds), users: num(row.users), sessions: num(row.sessions) }))
    .filter((c) => c.seconds > 0);

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
    period: { key: period.key, label: period.label, fromKey, toKey },
    availableYears: await availableYears(tz),
    days,
    axis,
    live: { online: Object.values(online).reduce((a, b) => a + b, 0), byPlatform: online },
    platforms: {
      mode,
      total: platformTotal,
      byPlatform,
      multiPlatform: [...platformsPerUser.values()].filter((n) => n > 1).length,
      web: webCounts,
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
      dau,
      wau,
      mau,
      visitUsers,
      activeUsers: activeUids.size,
      avgDau: round(avgDau),
      stickiness: mau > 0 ? round(recentAvgDau / mau, 3) : null,
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
      usageConsents,
      usageRefusals,
      usageUndecided: Math.max(0, users.length - usageConsents - usageRefusals),
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
    appVersions: versionRows.map((row) => ({ platform: platformOf(row.device, 'app'), version: row.version, sessions: num(row.sessions) })),
    pages,
  };
}

router.get('/', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  let period: Period;
  try {
    period = await resolvePeriod(req.query);
  } catch (err) {
    if (err instanceof BadPeriod) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  const key = period.key;
  const fresh = req.query['fresh'] === '1';

  const cached = fresh ? undefined : cache.get(key);
  if (cached) {
    res.json(cached);
    return;
  }

  try {
    const result = await buildAnalytics(period, fresh);
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

// ─── GET /api/admin/analytics/people ─────────────────────────────────────────
// The accounts behind a figure on the Analytics page, each with its own
// numbers — time in Pokyh, visits, active days, last activity — so the page
// can list and sort them. The filters narrow which visits count:
//
//   range     the page's period (7 | 30 | 90 | 365 | all | a year); visits
//             name their account for USAGE_ANALYTICS_RETENTION_DAYS only, so
//             the list covers at most that much of it
//   platform  ios | android | web | other
//   day       one local day (YYYY-MM-DD)
//   hours     start hours, comma-separated (0–23)
//   weekdays  0 = Monday … 6 = Sunday, comma-separated
//   klasse    a class name (students only)
//   segment   loyal | multi | new | returning | inactive
//   page      a website page as the page lists it ("/timetable"): who opened it
//   created   accounts created on this local day (YYYY-MM-DD), active or not
//   band      session-length band (0–4, see LENGTH_BANDS)
//
// Accounts known for a platform only from the server logs (app versions that
// report no visits yet) are counted wherever the page's own counts include
// them, so a list always adds up to the figure it was opened from.
//
// Only accounts that consented to the usage statistics are listed by name;
// the others are counted as `hidden` (Garante 2021: tracking that singles
// people out needs consent, legitimate interest cannot justify it).

const PEOPLE_LIMIT = 2000;
const SEGMENTS = ['loyal', 'multi', 'new', 'returning', 'inactive', 'consented'] as const;
type Segment = typeof SEGMENTS[number];

interface Person {
  stableUid: string;
  username: string;
  klasse: string;
  role: string;
  createdAt: string;
  seconds: number;
  // 0 when the account shows up only in the server logs.
  visits: number;
  activeDays: number;
  lastSeenAt: string | null;
  platforms: UsagePlatform[];
  // With a platform filter: the app version last used, or for the web every
  // way it was opened.
  detail: string;
}

function webDetail(device: string, client: string): string {
  const where = device === 'ios' || device === 'android' ? 'Handy' : device === 'desktop' ? 'Computer' : 'Gerät';
  if (client === 'pwa') return `${where} · Web-App`;
  if (client === 'browser') return `${where} · Browser`;
  return where;
}

class BadFilter extends Error {}

function readFilters(query: Request['query']) {
  const text = (key: string): string | null => {
    const value = query[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  };
  const platform = text('platform');
  if (platform !== null && !(USAGE_PLATFORMS as readonly string[]).includes(platform)) throw new BadFilter('Unknown platform');

  const day = text('day');
  if (day !== null && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new BadFilter('Invalid day');

  const hoursText = text('hours');
  const hours = hoursText === null ? [] : [...new Set(hoursText.split(',').map((h) => Number(h)))];
  if (hours.some((h) => !Number.isInteger(h) || h < 0 || h > 23)) throw new BadFilter('Invalid hours');

  const weekdaysText = text('weekdays');
  const weekdays = weekdaysText === null ? [] : [...new Set(weekdaysText.split(',').map((d) => Number(d)))];
  if (weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new BadFilter('Invalid weekdays');

  const klasse = text('klasse');
  if (klasse !== null && klasse.length > 100) throw new BadFilter('Invalid class');

  const segment = text('segment');
  if (segment !== null && !(SEGMENTS as readonly string[]).includes(segment)) throw new BadFilter('Unknown segment');

  const page = text('page');
  if (page !== null && (page.length > 500 || !page.startsWith('/'))) throw new BadFilter('Invalid page');

  const created = text('created');
  if (created !== null && !/^\d{4}-\d{2}-\d{2}$/.test(created)) throw new BadFilter('Invalid created day');

  const bandText = text('band');
  const band = bandText === null ? null : Number(bandText);
  if (band !== null && (!Number.isInteger(band) || band < 0 || band >= LENGTH_BANDS.length)) throw new BadFilter('Invalid band');

  return { platform: platform as UsagePlatform | null, day, hours, weekdays, klasse, segment: segment as Segment | null, page, created, band };
}

router.get('/people', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  let filters: ReturnType<typeof readFilters>;
  let period: Period;
  try {
    filters = readFilters(req.query);
    period = await resolvePeriod(req.query);
  } catch (err) {
    if (err instanceof BadFilter || err instanceof BadPeriod) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  const { platform, day, hours, weekdays, klasse, segment, page, created, band } = filters;
  const tz = config.usageAnalytics.timezone;
  // Older visits no longer name anyone.
  const identityFrom = dayAxis(config.usageAnalytics.retentionDays, tz)[0]!;
  const fromKey = period.fromKey > identityFrom ? period.fromKey : identityFrom;
  const toKey = period.toKey;
  const windowInfo = { fromKey, toKey, clamped: fromKey !== period.fromKey };
  if (fromKey > toKey) {
    res.json({ days: 0, total: 0, hidden: 0, people: [], window: windowInfo });
    return;
  }
  const axis = daysBetween(fromKey, toKey);
  const since = startOfLocalDay(fromKey, tz);
  const until = startOfLocalDay(addDays(toKey, 1), tz);

  const conditions: Prisma.Sql[] = [Prisma.sql`day_key >= ${fromKey}`, Prisma.sql`day_key <= ${toKey}`, Prisma.sql`stable_uid IS NOT NULL`];
  if (platform) conditions.push(Prisma.sql`${PLATFORM_SQL} = ${platform}`);
  if (day) conditions.push(Prisma.sql`day_key = ${day}`);
  if (hours.length > 0) conditions.push(Prisma.sql`start_hour IN (${Prisma.join(hours)})`);
  if (weekdays.length > 0) conditions.push(Prisma.sql`WEEKDAY(day_key) IN (${Prisma.join(weekdays)})`);
  if (band !== null) {
    const lower = band === 0 ? 0 : LENGTH_BANDS[band - 1]!.maxSeconds;
    const upper = LENGTH_BANDS[band]!.maxSeconds;
    conditions.push(Prisma.sql`active_seconds >= ${lower}`);
    if (Number.isFinite(upper)) conditions.push(Prisma.sql`active_seconds < ${upper}`);
  }
  if (klasse) {
    conditions.push(Prisma.sql`stable_uid IN (SELECT stable_uid FROM users WHERE webuntis_klasse_name = ${klasse} AND role <> 'parent')`);
  }
  const where = Prisma.join(conditions, ' AND ');

  // Log rows have no day or hour of their own, so they only join lists that
  // span the whole range — exactly the ones whose figures include them.
  const timeFiltered = day !== null || hours.length > 0 || weekdays.length > 0 || band !== null;
  const withLogs = !timeFiltered && (platform !== null || (segment !== null && segment !== 'loyal'));

  type VisitRow = { uid: string; device: string; client: string; version: string; visits: bigint; seconds: unknown; lastSeenAt: Date };
  type DaysRow = { uid: string; activeDays: bigint };
  type PageViewRow = { uid: string; page: string; views: bigint; lastAt: Date };
  const [visitRows, dayRows, uaRows, pageRows] = await Promise.all([
    prisma.$queryRaw<VisitRow[]>`
      SELECT stable_uid AS uid, device, client, app_version AS version,
             COUNT(*) AS visits, SUM(active_seconds) AS seconds, MAX(last_seen_at) AS lastSeenAt
      FROM usage_sessions WHERE ${where}
      GROUP BY stable_uid, device, client, app_version`,
    prisma.$queryRaw<DaysRow[]>`
      SELECT stable_uid AS uid, COUNT(DISTINCT day_key) AS activeDays
      FROM usage_sessions WHERE ${where}
      GROUP BY stable_uid`,
    withLogs ? requestLogUserAgents(`people|${fromKey}|${toKey}`, since, until, false) : Promise.resolve([] as UaRow[]),
    // Page views are logged per localised path ("/de/timetable"); they are
    // matched after the same normalising the page list uses.
    page
      ? prisma.$queryRaw<PageViewRow[]>`
          SELECT stable_uid AS uid, page, COUNT(*) AS views, MAX(created_at) AS lastAt
          FROM frontend_activity_logs
          WHERE event = 'page_view' AND created_at >= ${since} AND created_at < ${until} AND stable_uid IS NOT NULL AND page IS NOT NULL
          GROUP BY stable_uid, page`
      : Promise.resolve([] as PageViewRow[]),
  ]);
  const pageViews = new Map<string, { views: number; lastAt: Date }>();
  for (const row of pageRows) {
    if (normalisePage(row.page) !== page) continue;
    const entry = pageViews.get(row.uid) ?? { views: 0, lastAt: row.lastAt };
    entry.views += num(row.views);
    if (row.lastAt > entry.lastAt) entry.lastAt = row.lastAt;
    pageViews.set(row.uid, entry);
  }

  type Entry = { seconds: number; visits: number; lastSeenAt: Date | null; platforms: Set<UsagePlatform>; details: Array<{ text: string; at: number }> };
  const byUid = new Map<string, Entry>();
  const entryFor = (uid: string): Entry => {
    let entry = byUid.get(uid);
    if (!entry) {
      entry = { seconds: 0, visits: 0, lastSeenAt: null, platforms: new Set(), details: [] };
      byUid.set(uid, entry);
    }
    return entry;
  };
  for (const row of visitRows) {
    const entry = entryFor(row.uid);
    entry.seconds += num(row.seconds);
    entry.visits += num(row.visits);
    if (!entry.lastSeenAt || row.lastSeenAt > entry.lastSeenAt) entry.lastSeenAt = row.lastSeenAt;
    entry.platforms.add(platformOf(row.device, row.client));
    const text = row.client === 'app' ? row.version : webDetail(row.device, row.client);
    if (text) entry.details.push({ text, at: row.lastSeenAt.getTime() });
  }
  for (const row of uaRows) {
    const kind = classifyUserAgent(row.ua);
    if (!kind) continue;
    const rowPlatform = platformOf(kind.device, kind.client);
    if (platform && rowPlatform !== platform) continue;
    const known = byUid.has(row.uid);
    const entry = entryFor(row.uid);
    entry.platforms.add(rowPlatform);
    if (!known || entry.visits === 0) {
      const lastAt = new Date(row.lastAt);
      if (!entry.lastSeenAt || lastAt > entry.lastSeenAt) entry.lastSeenAt = lastAt;
      entry.details.push({ text: kind.client === 'app' ? 'ältere Version' : webDetail(kind.device, ''), at: lastAt.getTime() });
    }
  }
  const activeDays = new Map(dayRows.map((row) => [row.uid, num(row.activeDays)]));
  // Visitors of the page who have no visits of their own counted (an older
  // website version) still belong on its list.
  for (const [uid, view] of pageViews) {
    const entry = entryFor(uid);
    if (!entry.lastSeenAt) entry.lastSeenAt = view.lastAt;
  }

  // "Inactive" lists the accounts of the range that do not appear above, and
  // "created" every account made that day, whether it was used or not.
  const createdFrom = created ? startOfLocalDay(created, tz) : null;
  const createdTo = createdFrom ? new Date(createdFrom.getTime() + 36 * 60 * 60 * 1000) : null;
  const accounts = await prisma.user.findMany({
    where: createdFrom && createdTo
      ? { createdAt: { gte: createdFrom, lt: createdTo } }
      : segment === 'inactive' || segment === 'consented'
        ? (klasse ? { webuntisKlasseName: klasse, role: { not: 'parent' } } : {})
        : { stableUid: { in: [...byUid.keys()] } },
    select: { stableUid: true, username: true, webuntisKlasseName: true, role: true, createdAt: true },
  });

  const consenting = new Set(
    (await prisma.privacyConsent.findMany({ where: { usageStats: true }, select: { stableUid: true } })).map((row) => row.stableUid),
  );
  // The same threshold as the page: half of the days with use.
  let loyalThreshold = 2;
  if (segment === 'loyal') {
    const [row] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(DISTINCT day_key) AS n FROM usage_sessions WHERE day_key >= ${fromKey} AND day_key <= ${toKey}`;
    loyalThreshold = Math.max(2, Math.ceil(num(row?.n) / 2));
  }
  const keep = (account: typeof accounts[number], entry: Entry | undefined): boolean => {
    if (klasse && (account.webuntisKlasseName !== klasse || account.role === 'parent')) return false;
    if (page && !pageViews.has(account.stableUid)) return false;
    // 36 hours were fetched to cover a DST day; keep only the asked day.
    if (created && localDayAndHour(account.createdAt, tz).dayKey !== created) return false;
    switch (segment) {
      case 'inactive': return !entry;
      case 'consented': return consenting.has(account.stableUid);
      case 'loyal': return (activeDays.get(account.stableUid) ?? 0) >= loyalThreshold;
      case 'multi': return (entry?.platforms.size ?? 0) > 1;
      case 'new': return account.createdAt >= since && account.createdAt < until;
      case 'returning': return account.createdAt < since;
      default: return true;
    }
  };

  const people: Person[] = [];
  let hidden = 0;
  for (const account of accounts) {
    const entry = byUid.get(account.stableUid);
    if (!keep(account, entry)) continue;
    if (!consenting.has(account.stableUid)) {
      hidden += 1;
      continue;
    }
    const details = [...new Set((entry?.details ?? []).sort((a, b) => b.at - a.at).map((d) => d.text))];
    people.push({
      stableUid: account.stableUid,
      username: account.username,
      klasse: account.webuntisKlasseName,
      role: account.role,
      createdAt: account.createdAt.toISOString(),
      seconds: entry?.seconds ?? 0,
      visits: entry?.visits ?? 0,
      activeDays: activeDays.get(account.stableUid) ?? 0,
      lastSeenAt: entry?.lastSeenAt ? entry.lastSeenAt.toISOString() : null,
      platforms: USAGE_PLATFORMS.filter((p) => entry?.platforms.has(p)),
      // An app shows the version last used; the web every way it was opened.
      detail: page
        ? `${pageViews.get(account.stableUid)?.views ?? 0}× aufgerufen`
        : !platform ? '' : platform === 'web' ? details.join(', ') : details[0] ?? '',
    });
  }
  people.sort((a, b) => b.seconds - a.seconds || (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '') || a.username.localeCompare(b.username));

  res.json({ days: axis.length, total: people.length, hidden, people: people.slice(0, PEOPLE_LIMIT), window: windowInfo });
});

// ─── GET /api/admin/analytics/breakdown?kind=…&days=30 ───────────────────────
// What a "created in the range" figure is made of, without naming anyone:
// todos and reminders by class, comments by class, downloads by file, Pokyh
// Learn by course.

const BREAKDOWN_KINDS = ['todos', 'reminders', 'reminderComments', 'downloads', 'learn'] as const;
type BreakdownKind = typeof BREAKDOWN_KINDS[number];

router.get('/breakdown', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const kind = String(req.query['kind'] ?? '') as BreakdownKind;
  if (!(BREAKDOWN_KINDS as readonly string[]).includes(kind)) {
    res.status(400).json({ error: 'Unknown kind' });
    return;
  }
  let period: Period;
  try {
    period = await resolvePeriod(req.query);
  } catch (err) {
    if (err instanceof BadPeriod) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  const { fromKey, toKey, since, until } = period;
  const days = period.axis.length;

  type Row = { label: string | null; value: bigint; a: unknown; b: unknown; c: unknown };
  let rows: Row[];
  switch (kind) {
    case 'todos':
      rows = await prisma.$queryRaw<Row[]>`
        SELECT CASE WHEN u.role = 'parent' THEN 'Eltern' WHEN u.webuntis_klasse_name = '' THEN 'ohne Klasse' ELSE u.webuntis_klasse_name END AS label,
               COUNT(*) AS value, SUM(t.done) AS a, COUNT(DISTINCT t.stable_uid) AS b, NULL AS c
        FROM todos t JOIN users u ON u.stable_uid = t.stable_uid
        WHERE t.created_at >= ${since} AND t.created_at < ${until}
        GROUP BY label`;
      break;
    case 'reminders':
      rows = await prisma.$queryRaw<Row[]>`
        SELECT c.name AS label, COUNT(*) AS value, NULL AS a, NULL AS b, NULL AS c
        FROM reminders r JOIN classes c ON c.id = r.class_id
        WHERE r.created_at >= ${since} AND r.created_at < ${until}
        GROUP BY c.id, c.name`;
      break;
    case 'reminderComments':
      rows = await prisma.$queryRaw<Row[]>`
        SELECT c.name AS label, COUNT(*) AS value, COUNT(DISTINCT m.reminder_id) AS a, NULL AS b, NULL AS c
        FROM comments m JOIN classes c ON c.id = m.class_id
        WHERE m.created_at >= ${since} AND m.created_at < ${until}
        GROUP BY c.id, c.name`;
      break;
    case 'downloads':
      rows = await prisma.$queryRaw<Row[]>`
        SELECT detail AS label, COUNT(*) AS value, COUNT(DISTINCT stable_uid) AS a, NULL AS b, NULL AS c
        FROM frontend_activity_logs
        WHERE event = 'download' AND created_at >= ${since} AND created_at < ${until}
        GROUP BY detail`;
      break;
    case 'learn':
      rows = await prisma.$queryRaw<Row[]>`
        SELECT c.title AS label, SUM(a.answer_count) AS value, SUM(a.correct_count) AS a,
               COUNT(DISTINCT a.stable_uid) AS b, SUM(a.duration_ms) AS c
        FROM learn_activity_daily a JOIN learn_courses c ON c.id = a.course_id
        WHERE a.day_key >= ${fromKey} AND a.day_key <= ${toKey}
        GROUP BY c.id, c.title`;
      break;
  }

  const items = rows
    .map((row) => {
      const value = num(row.value);
      const a = num(row.a);
      const b = num(row.b);
      const c = num(row.c);
      let note = '';
      if (kind === 'todos') note = `${b} ${b === 1 ? 'Konto' : 'Konten'} · ${value > 0 ? Math.round((a / value) * 100) : 0} % erledigt`;
      else if (kind === 'reminderComments') note = `zu ${a} ${a === 1 ? 'Erinnerung' : 'Erinnerungen'}`;
      else if (kind === 'downloads') note = `${a} ${a === 1 ? 'Konto' : 'Konten'}`;
      else if (kind === 'learn') note = `${b} Lernende · ${value > 0 ? Math.round((a / value) * 100) : 0} % richtig · ${Math.round(c / 60_000)} Min.`;
      return { label: row.label?.trim() || '(ohne Namen)', value, note };
    })
    .filter((item) => item.value > 0)
    .sort((x, y) => y.value - x.value || x.label.localeCompare(y.label))
    .slice(0, 300);

  res.json({ kind, days, total: items.reduce((sum, item) => sum + item.value, 0), items });
});

// ─── GET /api/admin/analytics/dishes ─────────────────────────────────────────
// Every rated or commented dish with its ratings by stars, average and
// comment count, so the Mensa figures can list the dishes behind them. A dish
// is its stable key: the same dish on another day shares it (older rows were
// keyed by id). Not limited to the range — a dish's ratings outlive it.

const DISHES_LIMIT = 500;

router.get('/dishes', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  type RatingRow = { dishKey: string; ratings: bigint; avgStars: unknown; s1: unknown; s2: unknown; s3: unknown; s4: unknown; s5: unknown };
  type CommentRow = { dishKey: string; comments: bigint };
  const [ratingRows, commentRows] = await Promise.all([
    prisma.$queryRaw<RatingRow[]>`
      SELECT dish_id AS dishKey, COUNT(*) AS ratings, AVG(stars) AS avgStars,
             SUM(stars = 1) AS s1, SUM(stars = 2) AS s2, SUM(stars = 3) AS s3, SUM(stars = 4) AS s4, SUM(stars = 5) AS s5
      FROM dish_ratings GROUP BY dish_id`,
    prisma.$queryRaw<CommentRow[]>`SELECT dish_id AS dishKey, COUNT(*) AS comments FROM dish_comments GROUP BY dish_id`,
  ]);

  const keys = [...new Set([...ratingRows.map((r) => r.dishKey), ...commentRows.map((r) => r.dishKey)])];
  const dishRows = keys.length > 0
    ? await prisma.dish.findMany({
      where: { OR: [{ stableKey: { in: keys } }, { id: { in: keys } }] },
      select: { id: true, stableKey: true, nameDe: true, date: true },
      orderBy: { date: 'desc' },
    })
    : [];
  // The newest row of a dish names it; how many rows it has is how often it was on the menu.
  const info = new Map<string, { name: string; lastServed: Date; served: number }>();
  for (const row of dishRows) {
    for (const key of new Set([row.stableKey, row.id])) {
      if (!key || !keys.includes(key)) continue;
      const entry = info.get(key);
      if (entry) entry.served += 1;
      else info.set(key, { name: row.nameDe, lastServed: row.date, served: 1 });
    }
  }
  const comments = new Map(commentRows.map((r) => [r.dishKey, num(r.comments)]));

  const dishes = keys
    .filter((key) => info.has(key))
    .map((key) => {
      const rating = ratingRows.find((r) => r.dishKey === key);
      const dish = info.get(key)!;
      return {
        key,
        name: dish.name,
        lastServed: dish.lastServed.toISOString().slice(0, 10),
        served: dish.served,
        ratings: num(rating?.ratings),
        avgStars: rating ? round(num(rating.avgStars), 2) : null,
        // Ratings with 1 … 5 stars.
        stars: rating ? [num(rating.s1), num(rating.s2), num(rating.s3), num(rating.s4), num(rating.s5)] : [0, 0, 0, 0, 0],
        comments: comments.get(key) ?? 0,
      };
    })
    .sort((a, b) => b.ratings - a.ratings || b.comments - a.comments || a.name.localeCompare(b.name));

  res.json({ total: dishes.length, dishes: dishes.slice(0, DISHES_LIMIT) });
});

export { router as analyticsAdminRouter };
