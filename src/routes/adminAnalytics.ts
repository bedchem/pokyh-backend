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
import { normaliseIp } from '../services/webVisitMeta';

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

// The same evidence, but only from the local days `keepDay` accepts — for
// lists narrowed to a day or to weekdays. Grouped by hour like requestLogDays,
// then folded back to one row per account and user agent.
async function requestLogUserAgentsOn(key: string, since: Date, until: Date, tz: string, keepDay: (dayKey: string) => boolean): Promise<UaRow[]> {
  const cached = userAgentCache.get(key);
  if (cached) return cached;
  const rows = await prisma.$queryRaw<Array<UaRow & { h: string }>>`
    SELECT stable_uid AS uid, user_agent AS ua, DATE_FORMAT(created_at, '%Y-%m-%d %H') AS h, MAX(created_at) AS lastAt
    FROM request_logs
    WHERE created_at >= ${since} AND created_at < ${until} AND stable_uid IS NOT NULL AND user_agent IS NOT NULL
    GROUP BY stable_uid, user_agent, h`;
  const merged = new Map<string, UaRow>();
  for (const row of rows) {
    if (!keepDay(localDayAndHour(new Date(`${row.h.replace(' ', 'T')}:00:00Z`), tz).dayKey)) continue;
    const lastAt = new Date(row.lastAt);
    const id = `${row.uid}\n${row.ua}`;
    const known = merged.get(id);
    if (!known || lastAt > known.lastAt) merged.set(id, { uid: row.uid, ua: row.ua, lastAt });
  }
  const result = [...merged.values()];
  userAgentCache.set(key, result);
  return result;
}

type LogDay = { all: Set<string>; byPlatform: Record<UsagePlatform, Set<string>> };
const logDayCache = new TtlCache<Map<string, LogDay>>(60 * 1000);

// Who was active on which local day according to the request logs, by
// platform — for the days the visit heartbeat did not measure (before it
// existed, older app versions). Grouped by hour to keep the result small; the
// logs reach back REQUEST_LOG_RETENTION_DAYS. Stored times are UTC.
async function requestLogDays(since: Date, until: Date, tz: string, fresh: boolean): Promise<Map<string, LogDay>> {
  const key = `${since.getTime()}|${until.getTime()}`;
  const cached = fresh ? undefined : logDayCache.get(key);
  if (cached) return cached;
  const rows = await prisma.$queryRaw<Array<{ uid: string; ua: string; h: string }>>`
    SELECT stable_uid AS uid, user_agent AS ua, DATE_FORMAT(created_at, '%Y-%m-%d %H') AS h
    FROM request_logs
    WHERE created_at >= ${since} AND created_at < ${until} AND stable_uid IS NOT NULL AND user_agent IS NOT NULL
    GROUP BY stable_uid, user_agent, h`;
  const kinds = new Map<string, ReturnType<typeof classifyUserAgent>>();
  const days = new Map<string, LogDay>();
  for (const row of rows) {
    if (!kinds.has(row.ua)) kinds.set(row.ua, classifyUserAgent(row.ua));
    const kind = kinds.get(row.ua);
    if (!kind) continue;
    const { dayKey } = localDayAndHour(new Date(`${row.h.replace(' ', 'T')}:00:00Z`), tz);
    let day = days.get(dayKey);
    if (!day) {
      day = { all: new Set(), byPlatform: { ios: new Set(), android: new Set(), web: new Set(), other: new Set() } };
      days.set(dayKey, day);
    }
    day.all.add(row.uid);
    day.byPlatform[platformOf(kind.device, kind.client)].add(row.uid);
  }
  logDayCache.set(key, days);
  return days;
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

// "Aktivste Klassen" shows a class only from this many person-days up.
const CLASS_MIN_PEOPLE = 5;

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
    // Different people measured by the visit heartbeat (time is per these)…
    users: number;
    // …and different people active that day at all: visits, or the server
    // logs where they saw more (days before the heartbeat, older apps).
    people: number;
    sessions: number;
    seconds: number;
    userSeconds: number;
    byPlatform: PlatformCounts;
    signups: number;
    // Website page views and different website visitors (signed in or not).
    webViews: number;
    webVisitors: number;
  }>;
  // Everyone on the website, signed in or not (web_visits).
  web: {
    views: number;
    // Different visitors per day, added up over the period: someone on the
    // site on two days counts twice.
    visitors: number;
    guestViews: number;
    // The same three for what was opened signed in ("davon mit Konto").
    signedViews: number;
    signedVisitors: number;
    // Different addresses in the part of the period that still has them —
    // every address, signed in or not — and those with a signed-in view.
    ips: number;
    signedIps: number;
    countries: number;
    // Every known country, most views first.
    byCountry: Array<{ country: string; views: number; visitors: number }>;
    // The first day a website visit was recorded.
    since: string | null;
    ipRetentionDays: number;
  };
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
    // Accounts with no role at all: neither student nor parent, and not an admin.
    noRole: number;
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
  // Anonymous class totals; `people` counts person-days, `avgPeople` people
  // per day with use.
  classes: Array<{ name: string; seconds: number; sessions: number; people: number; avgPeople: number }>;
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

function avgDauOf(daily: Array<{ people: number }>, daysWithUse: number): number {
  return daily.reduce((sum, d) => sum + d.people, 0) / Math.max(1, daysWithUse);
}

function round(value: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

// ─── Website visitors (web_visits) ───────────────────────────────────────────
// Everyone who opened the website, signed in or not: one row per page view
// (services/webVisits.ts). Different visitors are counted per day through the
// day-scoped visitor key, so over a period "visitors" adds up the days. The
// address is kept only as long as the request logs, so per-address figures
// cover at most that much of a period.

interface WebSummary {
  byDay: Map<string, { views: number; visitors: number; signedVisitors: number }>;
  views: number;
  guestViews: number;
  ips: number;
  // Addresses with at least one page view made signed in.
  signedIps: number;
  countries: Array<{ country: string; views: number; visitors: number }>;
  since: string | null;
}

const EMPTY_WEB: WebSummary = { byDay: new Map(), views: 0, guestViews: 0, ips: 0, signedIps: 0, countries: [], since: null };

// Never rejects: a missing table (the schema not applied yet) must not cost
// the rest of the page.
async function webSummary(fromKey: string, toKey: string): Promise<WebSummary> {
  try {
    const inPeriod = Prisma.sql`day_key >= ${fromKey} AND day_key <= ${toKey}`;
    const [dayRows, countryRows, [ipRow], [sinceRow]] = await Promise.all([
      prisma.$queryRaw<Array<{ dayKey: string; views: bigint; visitors: bigint; signedVisitors: bigint; guestViews: unknown }>>`
        SELECT day_key AS dayKey, COUNT(*) AS views, COUNT(DISTINCT visitor_key) AS visitors,
               COUNT(DISTINCT CASE WHEN signed_in THEN visitor_key END) AS signedVisitors,
               SUM(CASE WHEN signed_in THEN 0 ELSE 1 END) AS guestViews
        FROM web_visits WHERE ${inPeriod} GROUP BY day_key`,
      prisma.$queryRaw<Array<{ country: string; views: bigint; visitors: bigint }>>`
        SELECT country, COUNT(*) AS views, COUNT(DISTINCT day_key, visitor_key) AS visitors FROM web_visits
        WHERE ${inPeriod} AND country <> '' GROUP BY country ORDER BY views DESC`,
      prisma.$queryRaw<Array<{ n: bigint; signed: bigint }>>`
        SELECT COUNT(DISTINCT ip) AS n, COUNT(DISTINCT CASE WHEN signed_in THEN ip END) AS signed
        FROM web_visits WHERE ${inPeriod} AND ip IS NOT NULL`,
      prisma.$queryRaw<Array<{ k: string | null }>>`SELECT MIN(day_key) AS k FROM web_visits`,
    ]);
    const byDay = new Map(dayRows.map((row) => [row.dayKey, { views: num(row.views), visitors: num(row.visitors), signedVisitors: num(row.signedVisitors) }]));
    return {
      byDay,
      views: dayRows.reduce((sum, row) => sum + num(row.views), 0),
      guestViews: dayRows.reduce((sum, row) => sum + num(row.guestViews), 0),
      ips: num(ipRow?.n),
      signedIps: num(ipRow?.signed),
      countries: countryRows.map((row) => ({ country: row.country, views: num(row.views), visitors: num(row.visitors) })),
      since: sinceRow?.k ?? null,
    };
  } catch {
    return EMPTY_WEB;
  }
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
  type ClassRow = { name: string; seconds: unknown; sessions: unknown; people: unknown; days: bigint };

  // Runs beside the queries below; it never rejects.
  const webPromise = webSummary(fromKey, toKey);

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
    adminRows,
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
    logDays,
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
    prisma.admin.findMany({ select: { stableUid: true } }),
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
    // Anonymous class totals; a class shows from CLASS_MIN_PEOPLE
    // person-days up, so no single person stands out.
    prisma.$queryRaw<ClassRow[]>`
      SELECT klasse AS name, SUM(seconds) AS seconds, SUM(visits) AS sessions,
             SUM(people) AS people, COUNT(*) AS days
      FROM usage_class_days
      WHERE day_key >= ${fromKey} AND day_key <= ${toKey}
      GROUP BY klasse
      HAVING SUM(people) >= ${CLASS_MIN_PEOPLE}
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
    // Active accounts per day from the server logs: the period, the last 30
    // days ("täglich da") and today, whatever the period.
    requestLogDays(since < monthStart ? since : monthStart, until > now ? until : now, tz, fresh),
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
  // A day counts whoever was there: the measured visits, or the server logs
  // where they saw more.
  const peopleOn = (dayKey: string, visitPeople: number) => Math.max(visitPeople, logDays.get(dayKey)?.all.size ?? 0);
  const site = await webPromise;
  const daily = axis.map((dayKey) => {
    const total = totalsByDay.get(dayKey);
    const visits = platformsByDay.get(dayKey) ?? zeroPlatforms();
    const logged = logDays.get(dayKey);
    const users = num(total?.users);
    return {
      dayKey,
      users,
      people: peopleOn(dayKey, users),
      sessions: num(total?.sessions),
      seconds: num(total?.seconds),
      userSeconds: num(total?.userSeconds),
      byPlatform: logged
        ? Object.fromEntries(USAGE_PLATFORMS.map((p) => [p, Math.max(visits[p], logged.byPlatform[p].size)])) as PlatformCounts
        : visits,
      signups: signupsByDay.get(dayKey) ?? 0,
      webViews: site.byDay.get(dayKey)?.views ?? 0,
      webVisitors: site.byDay.get(dayKey)?.visitors ?? 0,
    };
  });
  const userDays = daily.reduce((sum, d) => sum + d.users, 0);
  const userSeconds = daily.reduce((sum, d) => sum + d.userSeconds, 0);
  const daysWithUse = Math.max(1, daily.filter((d) => d.sessions > 0 || d.people > 0).length);

  const hourMap = new Map(hourRows.map((row) => [num(row.hour), row]));
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    sessions: num(hourMap.get(hour)?.sessions),
    seconds: num(hourMap.get(hour)?.seconds),
  }));

  const weekdays = Array.from({ length: 7 }, (_, weekday) => {
    const ofDay = daily.filter((d) => weekdayOf(d.dayKey) === weekday);
    // Averaged over the days with use: a long period starts before Pokyh did.
    const used = ofDay.filter((d) => d.people > 0);
    return {
      weekday,
      sessions: ofDay.reduce((sum, d) => sum + d.sessions, 0),
      seconds: ofDay.reduce((sum, d) => sum + d.seconds, 0),
      avgUsers: used.length > 0 ? round(used.reduce((sum, d) => sum + d.people, 0) / used.length) : 0,
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
  const avgDau = daily.reduce((sum, d) => sum + d.people, 0) / daysWithUse;
  const union = (a: UidRow[], b: UidRow[]) => new Set([...a, ...b].map((row) => row.uid)).size;
  // Today counts everyone (day keys, or the server logs where they saw more),
  // 7 and 30 days count accounts (server logs and named visits); a longer
  // window never shows fewer.
  const dau = peopleOn(todayKey, num(dauRow?.n));
  const wau = Math.max(dau, union(weekLogUids, weekVisitUids));
  const mau = Math.max(wau, union(monthLogUids, monthVisitUids));
  const recentVisits = new Map(recentDau.map((row) => [row.dayKey, num(row.n)]));
  const recentAvgDau = dayAxis(30, tz, now).reduce((sum, dayKey) => sum + peopleOn(dayKey, recentVisits.get(dayKey) ?? 0), 0) / 30;

  // ── Accounts and classes ──────────────────────────────────────────────────
  let students = 0;
  let parents = 0;
  let noRole = 0;
  let untis = 0;
  let oldest = now.getTime();
  // An admin set to "none" has the admin role; it is not counted as role-less.
  const adminUids = new Set(adminRows.map((row) => row.stableUid));
  for (const user of users) {
    if (user.role === 'parent') parents += 1;
    else if (user.role === 'none') { if (!adminUids.has(user.stableUid)) noRole += 1; }
    else students += 1;
    if (user.isUntisUser) untis += 1;
    oldest = Math.min(oldest, user.createdAt.getTime());
  }
  const classes = classRows
    .map((row) => ({
      name: row.name,
      seconds: num(row.seconds),
      sessions: num(row.sessions),
      people: num(row.people),
      avgPeople: round(num(row.people) / Math.max(1, num(row.days))),
    }))
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
    web: {
      views: site.views,
      visitors: daily.reduce((sum, d) => sum + d.webVisitors, 0),
      guestViews: site.guestViews,
      signedViews: site.views - site.guestViews,
      signedVisitors: [...site.byDay.values()].reduce((sum, d) => sum + d.signedVisitors, 0),
      ips: site.ips,
      signedIps: site.signedIps,
      countries: site.countries.length,
      byCountry: site.countries,
      since: site.since,
      ipRetentionDays: config.requestLogRetentionDays,
    },
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
      noRole,
      untis,
      local: users.length - untis,
      newInRange,
      withPush: num(pushRows[0]?.n),
      withLearn: learnProfiles,
      admins: adminRows.length,
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

// "Heute aktiv" exactly as the Analytics page counts it (engagement.dau), for
// the dashboard: different people in today's visits, or the server logs where
// they saw more.
export async function activeToday(now = new Date()): Promise<number> {
  const tz = config.usageAnalytics.timezone;
  const todayKey = localDayAndHour(now, tz).dayKey;
  const [[row], logDays] = await Promise.all([
    prisma.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(DISTINCT ${PERSON_SQL}) AS n FROM usage_sessions WHERE day_key = ${todayKey}`,
    requestLogDays(startOfLocalDay(todayKey, tz), startOfLocalDay(addDays(todayKey, 1), tz), tz, false),
  ]);
  return Math.max(num(row?.n), logDays.get(todayKey)?.all.size ?? 0);
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

  // Log rows join every list whose figure includes them: the whole range, a
  // platform, most segments — and a day or weekdays, matched by the log's own
  // local day. They have no start hour or visit length, so lists narrowed by
  // those stay visits only, as do the figures made of visits or page views.
  const sessionFiltered = hours.length > 0 || band !== null;
  const dayFiltered = day !== null || weekdays.length > 0;
  const visitsOnly = segment === 'loyal' || klasse !== null || page !== null || created !== null;
  const withLogs = !sessionFiltered && (platform !== null || !visitsOnly);
  const logDayMatches = (dayKey: string) =>
    dayKey >= fromKey && dayKey <= toKey
    && (day === null || dayKey === day)
    && (weekdays.length === 0 || weekdays.includes(weekdayOf(dayKey)));
  const logRows = (): Promise<UaRow[]> => {
    if (!withLogs) return Promise.resolve([]);
    if (!dayFiltered) return requestLogUserAgents(`people|${fromKey}|${toKey}`, since, until, false);
    // One day needs only that day's logs.
    const from = day !== null && day >= fromKey ? startOfLocalDay(day, tz) : since;
    const to = day !== null && day <= toKey ? startOfLocalDay(addDays(day, 1), tz) : until;
    return requestLogUserAgentsOn(`people|${fromKey}|${toKey}|${day ?? ''}|${weekdays.join(',')}`, from, to, tz, logDayMatches);
  };

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
    logRows(),
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

// ─── GET /api/admin/analytics/visitors?range=… ───────────────────────────────
// Behind the visitor map: every country the website was opened from, and
// every address with how often, on how many days and from which devices.
// Addresses exist only for the last REQUEST_LOG_RETENTION_DAYS (index.ts), so
// the address list covers at most that part of the period (`ipWindow`); the
// country figures cover all of it.

const IP_LIMIT = 2000;
const visitorsCache = new TtlCache<unknown>(3 * 1000);

async function readPeriod(req: Request, res: Response): Promise<Period | null> {
  try {
    return await resolvePeriod(req.query);
  } catch (err) {
    if (err instanceof BadPeriod) {
      res.status(400).json({ error: err.message });
      return null;
    }
    throw err;
  }
}

// The days of a period that still have addresses.
function ipWindowOf(period: Period) {
  const tz = config.usageAnalytics.timezone;
  const ipFrom = dayAxis(config.requestLogRetentionDays, tz)[0]!;
  const fromKey = period.fromKey > ipFrom ? period.fromKey : ipFrom;
  return { fromKey, toKey: period.toKey, clamped: fromKey !== period.fromKey };
}

// Usernames of the given accounts that consent to the usage statistics right
// now — checked when read, not only when a row was written.
async function consentingNames(uids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(uids)];
  if (unique.length === 0) return new Map();
  const [consenting, users] = await Promise.all([
    prisma.privacyConsent.findMany({ where: { stableUid: { in: unique }, usageStats: true }, select: { stableUid: true } }),
    prisma.user.findMany({ where: { stableUid: { in: unique } }, select: { stableUid: true, username: true } }),
  ]);
  const allowed = new Set(consenting.map((row) => row.stableUid));
  return new Map(users.filter((user) => allowed.has(user.stableUid)).map((user) => [user.stableUid, user.username]));
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

router.get('/visitors', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const period = await readPeriod(req, res);
  if (!period) return;
  const cached = req.query['fresh'] === '1' ? undefined : visitorsCache.get(period.key);
  if (cached) {
    res.json(cached);
    return;
  }

  const { fromKey, toKey } = period;
  const ipWindow = ipWindowOf(period);
  const inPeriod = Prisma.sql`day_key >= ${fromKey} AND day_key <= ${toKey}`;
  const inIpWindow = Prisma.sql`day_key >= ${ipWindow.fromKey} AND day_key <= ${ipWindow.toKey} AND ip IS NOT NULL`;

  type TotalRow = { views: bigint; visitors: bigint; signedVisitors: bigint; guestViews: unknown; unknownViews: unknown };
  type CountryRow = { country: string; views: bigint; visitors: bigint; ips: bigint };
  type IpRow = {
    ip: string; country: string; region: string | null; city: string | null;
    views: bigint; signedViews: unknown; days: bigint; firstAt: Date; lastAt: Date; devices: string | null; uids: string | null; accountCount: bigint;
  };
  try {
    const [[totals], countryRows, ipRows, [ipCount], [sinceRow]] = await Promise.all([
      prisma.$queryRaw<TotalRow[]>`
        SELECT COUNT(*) AS views, COUNT(DISTINCT day_key, visitor_key) AS visitors,
               COUNT(DISTINCT CASE WHEN signed_in THEN CONCAT(day_key, ':', visitor_key) END) AS signedVisitors,
               SUM(CASE WHEN signed_in THEN 0 ELSE 1 END) AS guestViews,
               SUM(CASE WHEN country = '' THEN 1 ELSE 0 END) AS unknownViews
        FROM web_visits WHERE ${inPeriod}`,
      prisma.$queryRaw<CountryRow[]>`
        SELECT country, COUNT(*) AS views, COUNT(DISTINCT day_key, visitor_key) AS visitors, COUNT(DISTINCT ip) AS ips
        FROM web_visits WHERE ${inPeriod}
        GROUP BY country ORDER BY views DESC`,
      // The place of an address is the one it had most recently.
      prisma.$queryRaw<IpRow[]>`
        SELECT ip,
               SUBSTRING_INDEX(GROUP_CONCAT(country ORDER BY created_at DESC SEPARATOR '\n'), '\n', 1) AS country,
               SUBSTRING_INDEX(GROUP_CONCAT(region ORDER BY created_at DESC SEPARATOR '\n'), '\n', 1) AS region,
               SUBSTRING_INDEX(GROUP_CONCAT(city ORDER BY created_at DESC SEPARATOR '\n'), '\n', 1) AS city,
               COUNT(*) AS views, SUM(CASE WHEN signed_in THEN 1 ELSE 0 END) AS signedViews,
               COUNT(DISTINCT day_key) AS days,
               MIN(created_at) AS firstAt, MAX(created_at) AS lastAt,
               GROUP_CONCAT(DISTINCT device) AS devices, GROUP_CONCAT(DISTINCT stable_uid) AS uids,
               COUNT(DISTINCT account_key) AS accountCount
        FROM web_visits WHERE ${inIpWindow}
        GROUP BY ip ORDER BY views DESC, lastAt DESC
        LIMIT ${Prisma.raw(String(IP_LIMIT))}`,
      prisma.$queryRaw<Array<{ n: bigint; signed: bigint }>>`
        SELECT COUNT(DISTINCT ip) AS n, COUNT(DISTINCT CASE WHEN signed_in THEN ip END) AS signed
        FROM web_visits WHERE ${inIpWindow}`,
      prisma.$queryRaw<Array<{ k: string | null }>>`SELECT MIN(day_key) AS k FROM web_visits`,
    ]);

    // The accounts behind an address, by name only while their consent holds.
    const names = await consentingNames(ipRows.flatMap((row) => (row.uids ?? '').split(',').filter(Boolean)));

    const result = {
      period: { key: period.key, label: period.label, fromKey, toKey },
      totals: {
        views: num(totals?.views),
        visitors: num(totals?.visitors),
        guestViews: num(totals?.guestViews),
        // "davon mit Konto": opened signed in.
        signedViews: num(totals?.views) - num(totals?.guestViews),
        signedVisitors: num(totals?.signedVisitors),
        unknownViews: num(totals?.unknownViews),
        ips: num(ipCount?.n),
        signedIps: num(ipCount?.signed),
        countries: countryRows.filter((row) => row.country !== '').length,
      },
      countries: countryRows.map((row) => ({ country: row.country, views: num(row.views), visitors: num(row.visitors), ips: num(row.ips) })),
      ips: ipRows.map((row) => ({
        ip: row.ip,
        country: row.country ?? '',
        region: row.region || null,
        city: row.city || null,
        views: num(row.views),
        // Page views made signed in; the rest came as a guest.
        signedViews: num(row.signedViews),
        days: num(row.days),
        firstAt: iso(row.firstAt),
        lastAt: iso(row.lastAt),
        devices: (row.devices ?? '').split(',').filter(Boolean),
        // Different accounts signed in from it, and those that may be named.
        accountCount: num(row.accountCount),
        accounts: (row.uids ?? '').split(',').filter((uid) => names.has(uid)).map((uid) => ({ stableUid: uid, username: names.get(uid)! })),
      })),
      ipWindow,
      ipRetentionDays: config.requestLogRetentionDays,
      since: sinceRow?.k ?? null,
    };
    visitorsCache.set(period.key, result);
    res.json(result);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError || err instanceof Prisma.PrismaClientUnknownRequestError) {
      res.status(503).json({ error: 'Visitor statistics are not available yet' });
      return;
    }
    throw err;
  }
});

// ─── GET /api/admin/analytics/visitors/ip?ip=…&range=… ───────────────────────
// One address in detail: where it comes from, when and how often it opened
// which pages, on which devices. Within the period's address window only.

router.get('/visitors/ip', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const ip = normaliseIp(typeof req.query['ip'] === 'string' ? req.query['ip'] : null);
  if (!ip) {
    res.status(400).json({ error: 'Invalid address' });
    return;
  }
  const period = await readPeriod(req, res);
  if (!period) return;
  const window = ipWindowOf(period);
  if (window.fromKey > window.toKey) {
    res.status(404).json({ error: 'No visits from this address in the period' });
    return;
  }
  const where = Prisma.sql`ip = ${ip} AND day_key >= ${window.fromKey} AND day_key <= ${window.toKey}`;

  type SummaryRow = { views: bigint; days: bigint; firstAt: Date | null; lastAt: Date | null; signedInViews: unknown; accountCount: bigint };
  type PlaceRow = { country: string; region: string | null; city: string | null };
  type CountRow = { key: string | number; n: bigint };
  type RecentRow = { at: Date; page: string; device: string; signedIn: unknown };
  type AccountRow = { uid: string; views: bigint; lastAt: Date };
  try {
    const [[summary], [place], dayRows, hourRows, pageRows, deviceRows, recentRows, accountRows] = await Promise.all([
      prisma.$queryRaw<SummaryRow[]>`
        SELECT COUNT(*) AS views, COUNT(DISTINCT day_key) AS days, MIN(created_at) AS firstAt, MAX(created_at) AS lastAt,
               SUM(CASE WHEN signed_in THEN 1 ELSE 0 END) AS signedInViews, COUNT(DISTINCT account_key) AS accountCount
        FROM web_visits WHERE ${where}`,
      prisma.$queryRaw<PlaceRow[]>`SELECT country, region, city FROM web_visits WHERE ${where} ORDER BY created_at DESC LIMIT 1`,
      prisma.$queryRaw<CountRow[]>`SELECT day_key AS \`key\`, COUNT(*) AS n FROM web_visits WHERE ${where} GROUP BY day_key`,
      prisma.$queryRaw<CountRow[]>`SELECT hour AS \`key\`, COUNT(*) AS n FROM web_visits WHERE ${where} GROUP BY hour`,
      prisma.$queryRaw<CountRow[]>`SELECT page AS \`key\`, COUNT(*) AS n FROM web_visits WHERE ${where} GROUP BY page ORDER BY n DESC LIMIT 12`,
      prisma.$queryRaw<CountRow[]>`SELECT device AS \`key\`, COUNT(*) AS n FROM web_visits WHERE ${where} GROUP BY device ORDER BY n DESC`,
      prisma.$queryRaw<RecentRow[]>`
        SELECT created_at AS at, page, device, signed_in AS signedIn
        FROM web_visits WHERE ${where} ORDER BY created_at DESC LIMIT 30`,
      prisma.$queryRaw<AccountRow[]>`
        SELECT stable_uid AS uid, COUNT(*) AS views, MAX(created_at) AS lastAt
        FROM web_visits WHERE ${where} AND stable_uid IS NOT NULL
        GROUP BY stable_uid ORDER BY views DESC LIMIT 20`,
    ]);
    const views = num(summary?.views);
    if (views === 0) {
      res.status(404).json({ error: 'No visits from this address in the period' });
      return;
    }

    // Accounts are named only while their consent to the usage statistics
    // holds; it is checked again here, not only when the row was written.
    const uids = accountRows.map((row) => row.uid);
    const [consenting, users] = uids.length > 0
      ? await Promise.all([
        prisma.privacyConsent.findMany({ where: { stableUid: { in: uids }, usageStats: true }, select: { stableUid: true } }),
        prisma.user.findMany({ where: { stableUid: { in: uids } }, select: { stableUid: true, username: true, webuntisKlasseName: true, role: true } }),
      ])
      : [[], []];
    const allowed = new Set(consenting.map((row) => row.stableUid));
    const userByUid = new Map(users.map((user) => [user.stableUid, user]));
    const accounts = accountRows
      .filter((row) => allowed.has(row.uid) && userByUid.has(row.uid))
      .map((row) => {
        const user = userByUid.get(row.uid)!;
        return {
          stableUid: row.uid,
          username: user.username,
          klasse: user.role === 'parent' ? 'Elternteil' : user.webuntisKlasseName,
          views: num(row.views),
          lastAt: iso(row.lastAt),
        };
      });
    const namedViews = accounts.reduce((sum, account) => sum + account.views, 0);
    const perDay = new Map(dayRows.map((row) => [String(row.key), num(row.n)]));
    const perHour = new Map(hourRows.map((row) => [num(row.key), num(row.n)]));
    res.json({
      ip,
      country: place?.country ?? '',
      region: place?.region || null,
      city: place?.city || null,
      views,
      days: num(summary?.days),
      firstAt: iso(summary?.firstAt ?? null),
      lastAt: iso(summary?.lastAt ?? null),
      signedInViews: num(summary?.signedInViews),
      // Different accounts signed in from it; those with consent to the
      // usage statistics by name, the others only counted.
      accountCount: num(summary?.accountCount),
      accounts,
      // Signed in without that consent: counted, never named.
      unnamedSignedInViews: Math.max(0, num(summary?.signedInViews) - namedViews),
      daily: daysBetween(window.fromKey, window.toKey).map((dayKey) => ({ dayKey, views: perDay.get(dayKey) ?? 0 })),
      hours: Array.from({ length: 24 }, (_, hour) => perHour.get(hour) ?? 0),
      pages: pageRows.map((row) => ({ page: String(row.key) || '/', views: num(row.n) })),
      devices: deviceRows.map((row) => ({ device: String(row.key), views: num(row.n) })),
      recent: recentRows.map((row) => ({ at: iso(row.at), page: row.page || '/', device: row.device, signedIn: num(row.signedIn) > 0 })),
      window,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError || err instanceof Prisma.PrismaClientUnknownRequestError) {
      res.status(503).json({ error: 'Visitor statistics are not available yet' });
      return;
    }
    throw err;
  }
});

// ─── GET /api/admin/analytics/person?uid=…&range=… ───────────────────────────
// One account across the page: its time in Pokyh and where it used it, and
// the addresses and places it opened the website from. Only for an account
// that consents to the usage statistics right now; any other gets 404, the
// same answer as an unknown one. Visits name their account for
// USAGE_ANALYTICS_RETENTION_DAYS, addresses exist for REQUEST_LOG_RETENTION_DAYS.

router.get('/person', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const uid = typeof req.query['uid'] === 'string' ? req.query['uid'].trim() : '';
  if (!uid || uid.length > 64) {
    res.status(400).json({ error: 'Invalid account' });
    return;
  }
  const period = await readPeriod(req, res);
  if (!period) return;
  const [consent, user] = await Promise.all([
    prisma.privacyConsent.findUnique({ where: { stableUid: uid }, select: { usageStats: true } }),
    prisma.user.findUnique({ where: { stableUid: uid }, select: { stableUid: true, username: true, webuntisKlasseName: true, role: true, createdAt: true } }),
  ]);
  if (!user || !consent?.usageStats) {
    res.status(404).json({ error: 'Account not shown without consent' });
    return;
  }

  const tz = config.usageAnalytics.timezone;
  const identityFrom = dayAxis(config.usageAnalytics.retentionDays, tz)[0]!;
  const usageFrom = period.fromKey > identityFrom ? period.fromKey : identityFrom;
  const usageWindow = { fromKey: usageFrom, toKey: period.toKey, clamped: usageFrom !== period.fromKey };
  const ipWindow = ipWindowOf(period);
  const inUsage = Prisma.sql`stable_uid = ${uid} AND day_key >= ${usageWindow.fromKey} AND day_key <= ${usageWindow.toKey}`;
  const inWeb = Prisma.sql`stable_uid = ${uid} AND day_key >= ${ipWindow.fromKey} AND day_key <= ${ipWindow.toKey}`;

  type UsageRow = { visits: bigint; seconds: unknown; days: bigint; lastAt: Date | null };
  type MixRow = { device: string; client: string };
  type DayRow = { dayKey: string; seconds: unknown };
  type IpRow = { ip: string; country: string; region: string | null; city: string | null; views: bigint; lastAt: Date };
  type PageRow = { page: string; views: bigint };
  const [[usage], mixRows, dayRows, ipRows, pageRows, [webTotal]] = await Promise.all([
    prisma.$queryRaw<UsageRow[]>`
      SELECT COUNT(*) AS visits, SUM(active_seconds) AS seconds, COUNT(DISTINCT day_key) AS days, MAX(last_seen_at) AS lastAt
      FROM usage_sessions WHERE ${inUsage}`,
    prisma.$queryRaw<MixRow[]>`SELECT DISTINCT device, client FROM usage_sessions WHERE ${inUsage}`,
    prisma.$queryRaw<DayRow[]>`SELECT day_key AS dayKey, SUM(active_seconds) AS seconds FROM usage_sessions WHERE ${inUsage} GROUP BY day_key`,
    ipWindow.fromKey > ipWindow.toKey ? Promise.resolve([] as IpRow[]) : prisma.$queryRaw<IpRow[]>`
      SELECT ip,
             SUBSTRING_INDEX(GROUP_CONCAT(country ORDER BY created_at DESC SEPARATOR '\n'), '\n', 1) AS country,
             SUBSTRING_INDEX(GROUP_CONCAT(region ORDER BY created_at DESC SEPARATOR '\n'), '\n', 1) AS region,
             SUBSTRING_INDEX(GROUP_CONCAT(city ORDER BY created_at DESC SEPARATOR '\n'), '\n', 1) AS city,
             COUNT(*) AS views, MAX(created_at) AS lastAt
      FROM web_visits WHERE ${inWeb} AND ip IS NOT NULL
      GROUP BY ip ORDER BY lastAt DESC LIMIT 50`,
    prisma.$queryRaw<PageRow[]>`SELECT page, COUNT(*) AS views FROM web_visits WHERE ${inWeb} GROUP BY page ORDER BY views DESC LIMIT 8`,
    prisma.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*) AS n FROM web_visits WHERE ${inWeb}`,
  ]);

  const perDay = new Map(dayRows.map((row) => [row.dayKey, num(row.seconds)]));
  res.json({
    stableUid: user.stableUid,
    username: user.username,
    klasse: user.role === 'parent' ? 'Elternteil' : user.webuntisKlasseName,
    createdAt: user.createdAt.toISOString(),
    usage: {
      seconds: num(usage?.seconds),
      visits: num(usage?.visits),
      activeDays: num(usage?.days),
      lastSeenAt: iso(usage?.lastAt ?? null),
      platforms: USAGE_PLATFORMS.filter((p) => mixRows.some((row) => platformOf(row.device, row.client) === p)),
      daily: daysBetween(usageWindow.fromKey, usageWindow.toKey).slice(-60).map((dayKey) => ({ dayKey, seconds: perDay.get(dayKey) ?? 0 })),
      window: usageWindow,
    },
    web: {
      views: num(webTotal?.n),
      ips: ipRows.map((row) => ({
        ip: row.ip,
        country: row.country ?? '',
        region: row.region || null,
        city: row.city || null,
        views: num(row.views),
        lastAt: iso(row.lastAt),
      })),
      pages: pageRows.map((row) => ({ page: row.page || '/', views: num(row.views) })),
      window: ipWindow,
    },
  });
});

export { router as analyticsAdminRouter };
