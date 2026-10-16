import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { createReadStream } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { prisma } from '../db';
import { config } from '../config';
import { requireAdmin, requirePermission, scopeSchool } from '../middleware/requireAdmin';
import { can } from '../security/permissions';
import { endpointOf } from '../utils/endpoint';
import { intQueryParam } from '../utils/duration';
import { addDays, dayAxis, localDayAndHour, startOfLocalDay } from '../services/usageAnalytics';
import { listSchools } from '../services/schools';
import { storeClientError } from './clientErrors';
import { likeText } from '../utils/like';

// The panel's "Anfragen" (API requests), "System" (health and performance)
// and the two log views: frontend/app logs (what the apps report) and
// backend/system logs (what the server writes). Kept apart from analytics:
// requests are traffic, not activity, and the panel's own requests are their
// own scope ("admin") that only the system's operators see.

const router = Router();

// Request scopes a view can ask for. "app" is everything the apps send
// (core + learn), the default; "admin" and "all" include the panel's own
// traffic and are for the global view of who monitors the system.
type ScopeChoice = 'app' | 'core' | 'learn' | 'admin' | 'all';

function scopeChoice(req: Request): ScopeChoice | null {
  const raw = String(req.query['scope'] ?? 'app');
  const choice: ScopeChoice = raw === 'core' || raw === 'learn' || raw === 'admin' || raw === 'all' ? raw : 'app';
  if ((choice === 'admin' || choice === 'all') && !(scopeSchool(req) === null && can(req.adminAccess!, 'system.monitoring.view', null))) {
    return null;
  }
  return choice;
}

function scopeSql(choice: ScopeChoice): Prisma.Sql {
  if (choice === 'all') return Prisma.empty;
  if (choice === 'app') return Prisma.sql` AND scope <> 'admin'`;
  return Prisma.sql` AND scope = ${choice}`;
}

function schoolSql(req: Request): Prisma.Sql {
  const schoolId = scopeSchool(req);
  return schoolId ? Prisma.sql` AND school_id = ${schoolId}` : Prisma.empty;
}

// Response-time buckets (upper bounds, ms). Percentiles are read from these:
// exact enough to see where time goes, one cheap GROUP BY instead of sorting
// every request.
const BUCKETS = [10, 25, 50, 100, 250, 500, 1000, 2500] as const;

function bucketColumns(): Prisma.Sql {
  return Prisma.raw(BUCKETS.map((b, i) => `SUM(duration < ${b}) AS b${i}`).join(', '));
}

function percentile(counts: number[], total: number, p: number): number | null {
  if (total === 0) return null;
  const wanted = total * p;
  let seen = 0;
  for (let i = 0; i < BUCKETS.length; i++) {
    seen = counts[i]!;
    if (seen >= wanted) return BUCKETS[i]!;
  }
  return null; // above the last bucket
}

type BucketRow = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0)) || 0;
const cumulative = (row: BucketRow) => BUCKETS.map((_, i) => num(row[`b${i}`]));

interface EndpointStat {
  endpoint: string;
  method: string;
  count: number;
  errors: number;
  serverErrors: number;
  avgMs: number;
  maxMs: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

async function endpointStats(since: Date, until: Date, filters: Prisma.Sql, limit: number): Promise<EndpointStat[]> {
  type Row = BucketRow & { method: string; path: string; n: bigint; errors: unknown; serverErrors: unknown; total: unknown; maxMs: unknown };
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT method, path, COUNT(*) AS n, SUM(status >= 400) AS errors, SUM(status >= 500) AS serverErrors,
           SUM(duration) AS total, MAX(duration) AS maxMs, ${bucketColumns()}
    FROM request_logs
    WHERE created_at >= ${since} AND created_at < ${until}${filters}
    GROUP BY method, path
    ORDER BY n DESC
    LIMIT 2000`;
  const grouped = new Map<string, { method: string; endpoint: string; count: number; errors: number; serverErrors: number; total: number; maxMs: number; buckets: number[] }>();
  for (const row of rows) {
    const endpoint = endpointOf(row.path);
    const key = `${row.method} ${endpoint}`;
    const entry = grouped.get(key) ?? { method: row.method, endpoint, count: 0, errors: 0, serverErrors: 0, total: 0, maxMs: 0, buckets: BUCKETS.map(() => 0) };
    entry.count += num(row.n);
    entry.errors += num(row.errors);
    entry.serverErrors += num(row.serverErrors);
    entry.total += num(row.total);
    entry.maxMs = Math.max(entry.maxMs, num(row.maxMs));
    cumulative(row).forEach((v, i) => { entry.buckets[i]! += v; });
    grouped.set(key, entry);
  }
  return [...grouped.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((e) => ({
      endpoint: e.endpoint,
      method: e.method,
      count: e.count,
      errors: e.errors,
      serverErrors: e.serverErrors,
      avgMs: e.count > 0 ? Math.round(e.total / e.count) : 0,
      maxMs: e.maxMs,
      p50Ms: percentile(e.buckets, e.count, 0.5),
      p95Ms: percentile(e.buckets, e.count, 0.95),
    }));
}

// ─── GET /api/admin/requests/summary?day=YYYY-MM-DD&scope=app ────────────────
// One local day of requests, hour by hour, with totals, status classes and
// the busiest endpoints. The panel swipes between days with ?day=.

router.get('/requests/summary', requireAdmin, requirePermission('requests.view'), async (req: Request, res: Response): Promise<void> => {
  const choice = scopeChoice(req);
  if (!choice) {
    res.status(403).json({ error: 'Admin-Anfragen sind nur in der globalen Ansicht für System-Admins sichtbar' });
    return;
  }
  const tz = config.usageAnalytics.timezone;
  const today = localDayAndHour(new Date(), tz).dayKey;
  const firstDay = dayAxis(config.requestLogRetentionDays, tz)[0]!;
  const asked = typeof req.query['day'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query['day']) ? req.query['day'] : today;
  const day = asked > today ? today : asked < firstDay ? firstDay : asked;
  const since = startOfLocalDay(day, tz);
  const until = startOfLocalDay(addDays(day, 1), tz);
  const filters = Prisma.sql`${scopeSql(choice)}${schoolSql(req)}`;

  type HourRow = BucketRow & { h: string; n: bigint; e4: unknown; e5: unknown; total: unknown };
  const [hourRows, statusRows, endpoints] = await Promise.all([
    prisma.$queryRaw<HourRow[]>`
      SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H') AS h, COUNT(*) AS n,
             SUM(status >= 400 AND status < 500) AS e4, SUM(status >= 500) AS e5, SUM(duration) AS total, ${bucketColumns()}
      FROM request_logs
      WHERE created_at >= ${since} AND created_at < ${until}${filters}
      GROUP BY h`,
    prisma.$queryRaw<Array<{ status: number; n: bigint }>>`
      SELECT status, COUNT(*) AS n FROM request_logs
      WHERE created_at >= ${since} AND created_at < ${until}${filters}
      GROUP BY status ORDER BY n DESC LIMIT 30`,
    endpointStats(since, until, filters, 15),
  ]);

  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0, clientErrors: 0, serverErrors: 0, avgMs: 0, total: 0 }));
  const allBuckets = BUCKETS.map(() => 0);
  for (const row of hourRows) {
    const local = localDayAndHour(new Date(`${row.h.replace(' ', 'T')}:00:00Z`), tz);
    const slot = hours[local.hour]!;
    slot.count += num(row.n);
    slot.clientErrors += num(row.e4);
    slot.serverErrors += num(row.e5);
    slot.total += num(row.total);
    cumulative(row).forEach((v, i) => { allBuckets[i]! += v; });
  }
  const count = hours.reduce((s, h) => s + h.count, 0);
  const total = hours.reduce((s, h) => s + h.total, 0);
  res.json({
    day,
    today,
    firstDay,
    scope: choice,
    schoolId: scopeSchool(req),
    totals: {
      count,
      clientErrors: hours.reduce((s, h) => s + h.clientErrors, 0),
      serverErrors: hours.reduce((s, h) => s + h.serverErrors, 0),
      avgMs: count > 0 ? Math.round(total / count) : 0,
      p50Ms: percentile(allBuckets, count, 0.5),
      p95Ms: percentile(allBuckets, count, 0.95),
    },
    hours: hours.map(({ total: t, ...h }) => ({ ...h, avgMs: h.count > 0 ? Math.round(t / h.count) : 0 })),
    statuses: statusRows.map((r) => ({ status: num(r.status), count: num(r.n) })),
    endpoints,
    retentionDays: config.requestLogRetentionDays,
  });
});

// ─── GET /api/admin/monitoring/performance?hours=24 ──────────────────────────
// Every endpoint's load and response times — the apps' and the panel's —
// for the operators: what is slow, what fails.

router.get('/monitoring/performance', requireAdmin, requirePermission('system.monitoring.view'), async (req: Request, res: Response): Promise<void> => {
  const hours = intQueryParam(req.query['hours'], 24, 1, 24 * 7);
  const until = new Date();
  const since = new Date(until.getTime() - hours * 60 * 60 * 1000);
  const [all, admin] = await Promise.all([
    endpointStats(since, until, Prisma.empty, 60),
    prisma.$queryRaw<Array<{ scope: string | null; n: bigint; total: unknown }>>`
      SELECT scope, COUNT(*) AS n, SUM(duration) AS total FROM request_logs
      WHERE created_at >= ${since} AND created_at < ${until} GROUP BY scope`,
  ]);
  res.json({
    hours,
    endpoints: all,
    slowest: [...all].filter((e) => e.count >= 5).sort((a, b) => (b.p95Ms ?? 9999) - (a.p95Ms ?? 9999) || b.avgMs - a.avgMs).slice(0, 10),
    byScope: admin.map((r) => ({ scope: r.scope ?? 'core', count: num(r.n), avgMs: num(r.n) > 0 ? Math.round(num(r.total) / num(r.n)) : 0 })),
    buckets: BUCKETS,
  });
});

// ─── GET /api/admin/monitoring/health ────────────────────────────────────────

router.get('/monitoring/health', requireAdmin, requirePermission('system.monitoring.view'), async (_req: Request, res: Response): Promise<void> => {
  const started = performance.now();
  let database: { ok: boolean; latencyMs: number | null; version: string | null; connections: number | null } = { ok: false, latencyMs: null, version: null, connections: null };
  try {
    const [row] = await prisma.$queryRaw<Array<{ v: string }>>`SELECT VERSION() AS v`;
    const latencyMs = Math.round((performance.now() - started) * 10) / 10;
    const status = await prisma.$queryRaw<Array<{ Variable_name: string; Value: string }>>`SHOW STATUS LIKE 'Threads_connected'`.catch(() => []);
    database = { ok: true, latencyMs, version: row?.v ?? null, connections: status[0] ? Number(status[0].Value) : null };
  } catch {
    // reported as not ok
  }
  const since = new Date(Date.now() - 5 * 60 * 1000);
  const [recent] = await prisma.$queryRaw<Array<{ n: bigint; e5: unknown; total: unknown }>>`
    SELECT COUNT(*) AS n, SUM(status >= 500) AS e5, SUM(duration) AS total FROM request_logs WHERE created_at >= ${since}`.catch(() => [{ n: 0n, e5: 0, total: 0 }]);
  const memory = process.memoryUsage();
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    process: {
      uptimeSeconds: Math.floor(process.uptime()),
      node: process.version,
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
    },
    host: { cpus: os.cpus().length, loadAvg: os.loadavg().map((v) => Math.round(v * 100) / 100), freeMemMb: Math.round(os.freemem() / 1024 / 1024) },
    database,
    lastFiveMinutes: {
      requests: num(recent?.n),
      serverErrors: num(recent?.e5),
      avgMs: num(recent?.n) > 0 ? Math.round(num(recent?.total) / num(recent?.n)) : 0,
    },
  });
});

// ─── GET /api/admin/system-logs ──────────────────────────────────────────────
// Backend/system logs: the server's own log files (Winston, JSON lines,
// secrets redacted when written — utils/logger.ts), newest first, filtered by
// level, days, text and request id. Warnings and errors by default.

const LOG_DIR = path.join(process.cwd(), 'logs');
const LEVELS = ['error', 'warn', 'info', 'debug'] as const;
const MAX_MATCHES = 5000;

router.get('/system-logs', requireAdmin, requirePermission('system.logs.view'), async (req: Request, res: Response): Promise<void> => {
  const levelRaw = String(req.query['level'] ?? 'warn');
  const minLevel = (LEVELS as readonly string[]).includes(levelRaw) ? LEVELS.indexOf(levelRaw as typeof LEVELS[number]) : 1;
  const days = intQueryParam(req.query['days'], 3, 1, 14);
  const search = typeof req.query['search'] === 'string' ? req.query['search'].trim().toLowerCase().slice(0, 200) : '';
  const requestId = typeof req.query['requestId'] === 'string' ? req.query['requestId'].trim().slice(0, 64) : '';
  const page = intQueryParam(req.query['page'], 1, 1, 1_000);
  const limit = intQueryParam(req.query['limit'], 100, 1, 500);

  const matches: Array<Record<string, unknown>> = [];
  let truncated = false;
  for (let offset = 0; offset < days && !truncated; offset++) {
    const date = new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
    const file = path.join(LOG_DIR, `app-${date}.log`);
    if (path.dirname(file) !== LOG_DIR) continue;
    try {
      await fs.access(file);
    } catch {
      continue;
    }
    const ofDay: Array<Record<string, unknown>> = [];
    const lines = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const level = LEVELS.indexOf(String(entry['level']) as typeof LEVELS[number]);
      if (level < 0 || level > minLevel) continue;
      if (requestId && entry['requestId'] !== requestId) continue;
      if (search && !line.toLowerCase().includes(search)) continue;
      ofDay.push(entry);
      if (ofDay.length > MAX_MATCHES) ofDay.shift();
    }
    // Newest first.
    for (let i = ofDay.length - 1; i >= 0; i--) {
      matches.push(ofDay[i]!);
      if (matches.length >= MAX_MATCHES) {
        truncated = true;
        break;
      }
    }
  }
  const counts = { error: 0, warn: 0, info: 0, debug: 0 } as Record<string, number>;
  for (const m of matches) counts[String(m['level'])] = (counts[String(m['level'])] ?? 0) + 1;
  res.json({
    entries: matches.slice((page - 1) * limit, page * limit).map((e) => ({
      timestamp: e['timestamp'] ?? null,
      level: e['level'] ?? null,
      message: e['message'] ?? '',
      requestId: e['requestId'] ?? null,
      action: e['action'] ?? null,
      method: e['method'] ?? null,
      path: e['path'] ?? null,
      status: e['status'] ?? null,
      // Whatever else the line carries, already redacted by the logger.
      meta: Object.fromEntries(Object.entries(e).filter(([k]) => !['timestamp', 'level', 'message', 'service', 'environment'].includes(k))),
    })),
    total: matches.length,
    truncated,
    counts,
    page,
    limit,
  });
});

// ─── Frontend / app logs: error reports ──────────────────────────────────────

// The panel's own errors, reported by the panel.
router.post('/client-errors', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  await storeClientError(req, req.body, 'admin').catch(() => 'invalid');
  res.status(204).send();
});

// Grouped by error (fingerprint), most recent first; ?fingerprint= lists the
// occurrences of one. A school's view: its accounts' reports (and never the
// panel's own).
router.get('/client-errors', requireAdmin, requirePermission('logs.frontend.view'), async (req: Request, res: Response): Promise<void> => {
  const schoolId = scopeSchool(req);
  const source = typeof req.query['source'] === 'string' && ['web', 'android', 'ios', 'admin'].includes(req.query['source']) ? req.query['source'] : null;
  const level = req.query['level'] === 'warning' || req.query['level'] === 'error' ? req.query['level'] : null;
  const days = intQueryParam(req.query['days'], 7, 1, config.clientErrors.retentionDays);
  const search = typeof req.query['search'] === 'string' ? req.query['search'].trim().slice(0, 100) : '';
  const fingerprint = typeof req.query['fingerprint'] === 'string' && /^[0-9a-f]{16}$/.test(req.query['fingerprint']) ? req.query['fingerprint'] : null;
  const since = new Date(Date.now() - days * 86_400_000);
  const where: Prisma.ClientErrorLogWhereInput = {
    createdAt: { gte: since },
    ...(schoolId ? { schoolId, source: { not: 'admin' } } : {}),
    ...(source && !(schoolId && source === 'admin') ? { source } : {}),
    ...(level ? { level } : {}),
    ...(search ? { OR: [{ message: { contains: likeText(search) } }, { name: { contains: likeText(search) } }, { page: { contains: likeText(search) } }] } : {}),
    ...(fingerprint ? { fingerprint } : {}),
  };
  const schools = new Map((await listSchools()).map((s) => [s.id, s.name]));

  if (fingerprint) {
    const rows = await prisma.clientErrorLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 100 });
    res.json({
      occurrences: rows.map((r) => ({
        id: r.id, at: r.createdAt.toISOString(), source: r.source, level: r.level, name: r.name, message: r.message,
        stack: r.stack, page: r.page, release: r.release, browser: r.browser, requestId: r.requestId,
        schoolName: r.schoolId ? schools.get(r.schoolId) ?? null : null,
      })),
    });
    return;
  }

  const groups = await prisma.clientErrorLog.groupBy({
    by: ['fingerprint'],
    where,
    _count: { _all: true },
    _max: { createdAt: true },
    _min: { createdAt: true },
    orderBy: { _max: { createdAt: 'desc' } },
    take: 200,
  });
  const samples = groups.length > 0
    ? await prisma.clientErrorLog.findMany({
      where: { ...where, fingerprint: { in: groups.map((g) => g.fingerprint) } },
      orderBy: { createdAt: 'desc' },
      distinct: ['fingerprint'],
    })
    : [];
  const sampleOf = new Map(samples.map((s) => [s.fingerprint, s]));
  res.json({
    groups: groups.map((g) => {
      const s = sampleOf.get(g.fingerprint);
      return {
        fingerprint: g.fingerprint,
        count: g._count._all,
        firstAt: g._min.createdAt?.toISOString() ?? null,
        lastAt: g._max.createdAt?.toISOString() ?? null,
        source: s?.source ?? null,
        level: s?.level ?? null,
        name: s?.name ?? '',
        message: s?.message ?? '',
        page: s?.page ?? '',
        browser: s?.browser ?? '',
        release: s?.release ?? '',
      };
    }),
    days,
    retentionDays: config.clientErrors.retentionDays,
  });
});

// ─── GET /api/admin/privacy/overview ─────────────────────────────────────────
// What the installation stores, why, how long and who sees it — from the
// running configuration, so the overview cannot drift from what the code
// does. A working aid for the controller and the privacy notice, not a
// statement that the processing is lawful: the open points name what the
// software cannot decide.

router.get('/privacy/overview', requireAdmin, requirePermission('privacy.view'), async (_req: Request, res: Response): Promise<void> => {
  const [accounts, consents, refused] = await Promise.all([
    prisma.user.count(),
    prisma.privacyConsent.count({ where: { usageStats: true } }),
    prisma.privacyConsent.count({ where: { usageStats: false, usageStatsAt: { not: null } } }),
  ]);
  const days = (n: number) => `${n} Tage`;
  res.json({
    retention: [
      { key: 'requestLogs', label: 'API-Anfragen (Pfad, Status, IP, User-Agent)', days: config.requestLogRetentionDays, note: 'REQUEST_LOG_RETENTION_DAYS; danach gelöscht' },
      { key: 'webVisits', label: 'Website- und App-Besuche: IP-Adresse und Ort', days: config.requestLogRetentionDays, note: 'danach anonyme Zählung ohne Adresse' },
      { key: 'usageNamed', label: 'Nutzungsstatistik mit Konto (nur mit Einwilligung)', days: config.usageAnalytics.retentionDays, note: 'USAGE_ANALYTICS_RETENTION_DAYS; danach anonym' },
      { key: 'clientErrors', label: 'Fehlerberichte der Apps (ohne IP und Konto)', days: config.clientErrors.retentionDays, note: 'CLIENT_ERROR_RETENTION_DAYS' },
      { key: 'audit', label: 'Admin-Protokoll', days: config.auditRetentionDays, note: 'AUDIT_RETENTION_DAYS, mindestens 180 Tage' },
      { key: 'logFiles', label: 'Server-Logdateien', days: Number.parseInt(process.env['LOG_FILE_RETENTION_DAYS'] ?? '30', 10) || 30, note: 'LOG_FILE_RETENTION_DAYS; Geheimnisse werden beim Schreiben entfernt' },
      { key: 'accounts', label: 'Konten, Todos, Klassen, Kommentare', days: null, note: 'bis zur Löschung des Kontos oder zum Schuljahreswechsel (Archiv)' },
    ],
    consents: { usageStats: consents, refused, undecided: Math.max(0, accounts - consents - refused), accounts },
    categories: [
      { key: 'account', label: 'Konto', purpose: 'Anmeldung, Klasse, Rolle, Schule', basis: 'Nutzung des Dienstes (Art. 6 Abs. 1 lit. b DSGVO) bzw. öffentliche Aufgabe der Schule (lit. e) — vom Verantwortlichen festzulegen', retention: 'bis zur Löschung / Schuljahreswechsel', access: 'Admins der Schule mit „Nutzer ansehen“' },
      { key: 'content', label: 'Todos, Erinnerungen, Kommentare, Bewertungen', purpose: 'Funktionen der App', basis: 'Nutzung des Dienstes (lit. b)', retention: 'bis zur Löschung durch Nutzer, Admin oder Kontolöschung', access: 'Admins der Schule mit den jeweiligen Rechten' },
      { key: 'requestLogs', label: 'API-Anfragen', purpose: 'Betrieb, Fehlersuche, Missbrauchsabwehr', basis: 'berechtigtes Interesse (lit. f)', retention: days(config.requestLogRetentionDays), access: 'Schul-Admins ohne IP und User-Agent; System-Admins vollständig' },
      { key: 'usage', label: 'Nutzungsstatistik', purpose: 'Analytics (Zeit, Gerät, Bildschirme)', basis: 'mit Konto: Einwilligung (lit. a, widerrufbar); sonst anonyme Zählung (berechtigtes Interesse, Garante-Leitlinien 2021)', retention: `${days(config.usageAnalytics.retentionDays)} mit Konto, danach anonym`, access: 'Admins mit „Analytics ansehen“, Namen nur bei Einwilligung' },
      { key: 'clientErrors', label: 'Fehlerberichte', purpose: 'Fehler in Website und Apps finden', basis: 'berechtigtes Interesse (lit. f); keine IP, kein Konto', retention: days(config.clientErrors.retentionDays), access: 'Admins mit „Frontend-Logs ansehen“ (eigene Schule)' },
      { key: 'audit', label: 'Admin-Protokoll', purpose: 'Nachvollziehbarkeit von Admin-Zugriffen und -Änderungen', basis: 'berechtigtes Interesse / Vorgaben des Garante zu Systemadministratoren (27.11.2008)', retention: days(config.auditRetentionDays), access: 'Admins mit „Admin-Protokoll ansehen“ (eigene Schule)' },
    ],
    openPoints: [
      { kind: 'controller', text: 'Rollen festlegen: Ist die Schule Verantwortliche und Pokyh Auftragsverarbeiter? Dann Auftragsverarbeitungsvertrag nach Art. 28 DSGVO abschließen.' },
      { kind: 'controller', text: 'Rechtsgrundlage für Konten und Inhalte pro Schule festlegen (Vertrag vs. öffentliche Aufgabe) und in der Datenschutzerklärung nennen.' },
      { kind: 'legal', text: 'Minderjährige: In Italien können Jugendliche ab 14 Jahren selbst einwilligen (Art. 2-quinquies Codice Privacy). Vorgehen für Jüngere bei der einwilligungsbasierten Nutzungsstatistik rechtlich prüfen lassen.' },
      { kind: 'legal', text: 'Datenschutz-Folgenabschätzung (Art. 35 DSGVO) prüfen lassen: schulischer Kontext, Minderjährige, Nutzungsanalyse.' },
      { kind: 'operational', text: 'Systemadministratoren schriftlich benennen, Liste führen und ihre Tätigkeit mindestens jährlich prüfen (Garante, 27.11.2008); das Admin-Protokoll liefert die Zugriffsnachweise.' },
      { kind: 'operational', text: 'Verzeichnis von Verarbeitungstätigkeiten (Art. 30 DSGVO) mit dieser Übersicht abgleichen und aktuell halten.' },
      { kind: 'operational', text: 'Datenflüsse zu Dritten prüfen (Hosting, Cloudflare-Länderkopfzeilen, Push-Dienste von Apple/Google, WebUntis) inkl. Drittlandübermittlungen.' },
      { kind: 'code', text: 'Datenschutzhinweis im Schüler-Frontend um Fehlerberichte und die Schulzuordnung ergänzen (Frontend-Anleitung).' },
    ],
  });
});

export { router as adminMonitoringRouter };
