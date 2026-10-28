// Endpoint benchmark for the admin panel and the hottest app routes.
//
//   node tests/perf/bench.mjs --app <dir> [--label before] [--keep] [--reuse <mysql-url>]
//
// Starts a throw-away MySQL (or reuses one given by --reuse / BENCH_MYSQL_URL),
// seeds one database with a realistic month of data the first time, runs the
// backend built in <dir> (its dist/index.js, prisma/ and node_modules/) against
// it, and measures every endpoint sequentially: three warm-up calls, then
// BENCH_RUNS measured ones. Reported per endpoint: mean, p50, p95 and the
// approximate number of SQL statements the server issued per request (MySQL's
// global `Questions` counter, read around each call).
//
// Nothing here reads or writes a developer's `.env` or a running stack: the
// server gets an explicitly constructed environment and a temporary working
// directory, exactly like tests/cluster/harness.mjs.

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { PrismaClient } = require(path.join(REPO, 'node_modules', '@prisma', 'client'));
const jwt = require(path.join(REPO, 'node_modules', 'jsonwebtoken'));

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const APP = path.resolve(opt('app', REPO));
const LABEL = opt('label', path.basename(APP));
const RUNS = Number(process.env.BENCH_RUNS ?? 25);
const DATABASE = opt('db', 'pokyh_bench');
// Fixed so a second run (another build) can reuse the same seeded database.
const SECRETS = {
  jwt: process.env.BENCH_JWT_SECRET ?? 'bench-jwt-secret-0123456789abcdef0123456789abcdef',
  refresh: 'bench-refresh-secret-0123456789abcdef0123456789abcdef',
  apiKey: 'bench-api-key-0123456789abcdef0123456789',
  serverKey: 'bench-server-key-0123456789abcdef01234567',
};
const ADMIN_USERNAME = 'benchadmin';
const ADMIN_PASSWORD_HASH = '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (await check()) return; } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(500);
  }
}

function envKeys(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').map((l) => /^([A-Z][A-Z0-9_]*)=/.exec(l)?.[1]).filter(Boolean);
}

// ── MySQL ────────────────────────────────────────────────────────────────────

async function mysqlServer() {
  const reuse = opt('reuse') ?? process.env.BENCH_MYSQL_URL;
  if (reuse) return { url: reuse.replace(/\/$/, ''), container: null };
  const password = randomBytes(12).toString('hex');
  const container = `pokyh-bench-${randomBytes(4).toString('hex')}`;
  execFileSync('docker', [
    'run', '-d', '--rm', '--name', container,
    '-e', `MYSQL_ROOT_PASSWORD=${password}`,
    '-p', '127.0.0.1::3306',
    // Disk-backed like a real server (a tmpfs fills up with the binary log
    // of the seed and then stalls every write).
    'mysql:8.4.10',
    '--mysql-native-password=ON',
  ], { stdio: 'pipe' });
  const mapping = execFileSync('docker', ['port', container, '3306/tcp'], { encoding: 'utf8' }).trim().split('\n')[0];
  return { url: `mysql://root:${password}@127.0.0.1:${mapping.split(':').pop()}`, container };
}

// ── Server ───────────────────────────────────────────────────────────────────

async function startServer(databaseUrl) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pokyh-bench-'));
  symlinkSync(path.join(APP, 'prisma'), path.join(dir, 'prisma'), 'dir');
  symlinkSync(path.join(APP, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  writeFileSync(path.join(dir, 'package.json'), '{"name":"pokyh-bench","private":true}\n');
  const port = await freePort();
  const env = {};
  for (const key of [...envKeys(path.join(REPO, '.env.example')), ...envKeys(path.join(REPO, '.env'))]) env[key] = '';
  Object.assign(env, {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NODE_ENV: 'test',
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    JWT_SECRET: SECRETS.jwt,
    REFRESH_TOKEN_SECRET: SECRETS.refresh,
    API_KEY: SECRETS.apiKey,
    SERVER_KEY: SECRETS.serverKey,
    ADMIN_USERNAME,
    ADMIN_USERNAMES: ADMIN_USERNAME,
    ADMIN_PASSWORD_HASH,
    DB_AUTO_PUSH: 'true',
    BACKUP_ENABLED: 'false',
    BACKUP_DIR: path.join(dir, 'backups'),
    SCHOOL_YEAR_ROLLOVER_AUTO: 'false',
    MENSA_IMPORT_URL: 'http://127.0.0.1:9/unreachable.json',
    RATE_LIMIT_GLOBAL_MAX: '1000000',
    RATE_LIMIT_WRITE_MAX: '1000000',
    RATE_LIMIT_READ_MAX: '1000000',
    RATE_LIMIT_SSE_MAX: '1000000',
    WEBUNTIS_SCHOOL: 'lbs-brixen',
  });
  const logFile = path.join(dir, 'server.log');
  const child = spawn(process.execPath, [path.join(APP, 'dist', 'index.js')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (c) => appendFileSync(logFile, c));
  child.stderr.on('data', (c) => appendFileSync(logFile, c));
  let exited = false;
  child.once('exit', () => { exited = true; });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (exited) throw new Error(`server exited:\n${readFileSync(logFile, 'utf8').slice(-3000)}`);
    const res = await fetch(`${url}/readyz`).catch(() => null);
    return res?.ok === true;
  }, 240_000, 'the server to become ready');
  return { url, child, dir, logFile };
}

// ── Seed ─────────────────────────────────────────────────────────────────────
// One school's month: 2 500 accounts, ~450 000 request log rows (a third of
// them the admin panel's own polling, as on the live system), 24 000 visits,
// 45 000 website visits, 60 000 frontend events, a two-plan menu with ratings
// and comments, todos, classes and reminders.

const DAY = 86_400_000;
const pick = (list, i) => list[i % list.length];
const q = (v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? '1' : '0')
  : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
const dt = (ms) => q(new Date(ms).toISOString().slice(0, 19).replace('T', ' '));
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

async function insertRows(db, table, columns, rows, chunk = 2000) {
  for (let i = 0; i < rows.length; i += chunk) {
    const values = rows.slice(i, i + chunk).map((r) => `(${r.join(',')})`).join(',');
    await db.$executeRawUnsafe(`INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(',')}) VALUES ${values}`);
  }
}

async function seed(db) {
  const now = Date.now();
  const users = [];
  const classIds = [];
  for (let c = 0; c < 80; c++) classIds.push({ id: `bench-class-${c}`, code: `B${String(c).padStart(5, '0')}`, klasseId: 1000 + c, name: `${1 + (c % 5)}${String.fromCharCode(65 + (c % 8))}` });
  for (let i = 0; i < 2500; i++) {
    const role = i % 25 === 0 ? 'parent' : i % 97 === 0 ? 'none' : 'student';
    const cls = role === 'student' ? classIds[i % classIds.length] : null;
    users.push({ id: randomUUID(), uid: `bench-uid-${i}`, username: `bench.user${i}`, role, cls, created: now - (i % 300) * DAY - i * 1000 });
  }
  await insertRows(db, 'users', ['id', 'stable_uid', 'username', 'webuntis_klasse_id', 'webuntis_klasse_name', 'is_untis_user', 'role', 'created_at', 'updated_at'],
    users.map((u) => [q(u.id), q(u.uid), q(u.username), u.cls ? u.cls.klasseId : 0, q(u.cls ? u.cls.name : ''), 1, q(u.role), dt(u.created), dt(u.created)]));
  // A handful of panel admins.
  await insertRows(db, 'admins', ['stable_uid', 'can_create_class', 'created_at'], users.slice(0, 4).map((u) => [q(u.uid), 1, dt(now)]));
  await insertRows(db, 'classes', ['id', 'name', 'code', 'webuntis_klasse_id', 'created_by', 'created_by_name', 'created_at'],
    classIds.map((c) => [q(c.id), q(c.name), q(c.code), c.klasseId, q('admin'), q('admin'), dt(now - 200 * DAY)]));
  await insertRows(db, 'class_members', ['class_id', 'stable_uid', 'username', 'role', 'joined_at'],
    users.filter((u) => u.cls).map((u) => [q(u.cls.id), q(u.uid), q(u.username), q('student'), dt(u.created)]));

  const todos = [];
  for (let i = 0; i < 10_000; i++) {
    const u = users[(i * 7) % users.length];
    todos.push([q(randomUUID()), q(u.uid), q(`Aufgabe ${i}`), q(''), i % 3 === 0 ? 1 : 0, dt(now - (i % 60) * DAY)]);
  }
  await insertRows(db, 'todos', ['id', 'stable_uid', 'title', 'details', 'done', 'created_at'], todos);

  const reminders = [];
  const comments = [];
  for (let i = 0; i < 1500; i++) {
    const c = classIds[i % classIds.length];
    const id = randomUUID();
    reminders.push([q(id), q(c.id), q(`Erinnerung ${i}`), q(''), dt(now + (i % 40 - 20) * DAY), q('admin'), q('admin'), q('admin'), dt(now - (i % 60) * DAY)]);
    if (i % 2 === 0) {
      const u = users[(i * 3) % users.length];
      comments.push([q(randomUUID()), q(id), q(c.id), q(u.uid), q(u.username), q(`Kommentar ${i}`), dt(now - (i % 50) * DAY), dt(now - (i % 50) * DAY)]);
    }
  }
  await insertRows(db, 'reminders', ['id', 'class_id', 'title', 'body', 'remind_at', 'created_by', 'created_by_name', 'created_by_username', 'created_at'], reminders);
  await insertRows(db, 'comments', ['id', 'reminder_id', 'class_id', 'stable_uid', 'username', 'body', 'created_at', 'updated_at'], comments);

  const dishNames = Array.from({ length: 60 }, (_, i) => `Gericht Nummer ${i}`);
  const dishes = [];
  const monday = new Date(now - ((new Date(now).getUTCDay() + 6) % 7) * DAY);
  for (const plan of ['summer', 'winter']) {
    for (let w = 0; w < 6; w++) {
      for (let d = 0; d < 5; d++) {
        for (let k = 0; k < 2; k++) {
          const name = pick(dishNames, w * 10 + d * 2 + k);
          const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
          dishes.push([q(randomUUID()), q(name), q(name), q(name), q(`${dayKey(monday.getTime() + (w * 7 + d) * DAY)}`), k, q(plan), q(slug), w + 1, dt(now), dt(now)]);
        }
      }
    }
  }
  await insertRows(db, 'dishes', ['id', 'name_de', 'name_it', 'name_en', 'date', 'sort_order', 'plan', 'stable_key', 'week_ordinal', 'created_at', 'updated_at'], dishes);
  const ratings = [];
  const seenRating = new Set();
  for (let i = 0; i < 6000; i++) {
    const u = users[(i * 11) % users.length];
    const slug = pick(dishNames, i).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const k = `${slug}|${u.uid}`;
    if (seenRating.has(k)) continue;
    seenRating.add(k);
    ratings.push([q(slug), q(u.uid), q(u.username), 1 + (i % 5), dt(now - (i % 80) * DAY), dt(now - (i % 80) * DAY)]);
  }
  await insertRows(db, 'dish_ratings', ['dish_id', 'stable_uid', 'username', 'stars', 'created_at', 'updated_at'], ratings);
  const dishComments = [];
  for (let i = 0; i < 1500; i++) {
    const u = users[(i * 13) % users.length];
    const slug = pick(dishNames, i * 7).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    dishComments.push([q(randomUUID()), q(slug), q(u.uid), q(u.username), q(`Mensa-Kommentar ${i}`), dt(now - (i % 80) * DAY), dt(now - (i % 80) * DAY)]);
  }
  await insertRows(db, 'dish_comments', ['id', 'dish_id', 'stable_uid', 'username', 'body', 'created_at', 'updated_at'], dishComments);

  // Request logs: app traffic plus the panel's own polling (prefix-stripped
  // paths, as the old logger wrote them).
  const appPaths = ['/dishes', '/users/me', '/classes/mine', '/dish-ratings/batch', '/usage/ping', '/auth/refresh', '/popups/active', '/sse/todos'];
  const adminPaths = ['/', '/users', '/stats', '/comments', '/stats/requests-chart', '/activity-logs/stats', '/live'];
  const uas = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
    'okhttp/4.12.0',
    'Pokyh/2.0.1 CFNetwork/1568 Darwin/24.0.0',
  ];
  const logs = [];
  for (let i = 0; i < 450_000; i++) {
    const t = now - Math.floor((i / 450_000) * 30 * DAY) - (i % 997) * 1000;
    const admin = i % 3 === 0;
    const u = users[(i * 17) % users.length];
    logs.push([
      q(randomUUID()), q(admin ? 'GET' : pick(['GET', 'GET', 'GET', 'POST'], i)), q(admin ? pick(adminPaths, i) : pick(appPaths, i)),
      i % 211 === 0 ? 500 : i % 37 === 0 ? 404 : 200, 3 + (i % 70), q('10.0.0.1'),
      admin ? 'NULL' : q(u.uid), q(admin ? ADMIN_USERNAME : u.username), q(pick(uas, i)), 'NULL', q(randomUUID().slice(0, 16)), q('core'), dt(t),
    ]);
  }
  await insertRows(db, 'request_logs', ['id', 'method', 'path', 'status', 'duration', 'ip', 'stable_uid', 'username', 'user_agent', 'error', 'request_id', 'scope', 'created_at'], logs, 5000);

  const sessions = [];
  for (let i = 0; i < 24_000; i++) {
    const t = now - Math.floor((i / 24_000) * 30 * DAY);
    const u = users[(i * 19) % users.length];
    sessions.push([q(randomUUID()), i % 3 === 0 ? q(u.uid) : 'NULL', q(randomBytes(8).toString('hex')), q(pick(['ios', 'android', 'desktop'], i)), q(pick(['app', 'pwa', 'browser'], i)), q(''), q(dayKey(t)), new Date(t).getUTCHours(), 30 + (i % 900), i % 20, dt(t), dt(t + 600_000)]);
  }
  await insertRows(db, 'usage_sessions', ['id', 'stable_uid', 'visitor_key', 'device', 'client', 'app_version', 'day_key', 'start_hour', 'active_seconds', 'screens', 'started_at', 'last_seen_at'], sessions);
  const visits = [];
  for (let i = 0; i < 45_000; i++) {
    const t = now - Math.floor((i / 45_000) * 30 * DAY);
    visits.push([q(randomUUID()), q('web'), q(`10.0.${i % 250}.${i % 200}`), q(pick(['IT', 'AT', 'DE'], i)), q(randomBytes(8).toString('hex')), q(pick(['ios', 'android', 'desktop'], i)), i % 2 === 0 ? 1 : 0, q(pick(['/timetable', '/mensa', '/todos', '/grades'], i)), q(dayKey(t)), new Date(t).getUTCHours(), dt(t)]);
  }
  await insertRows(db, 'web_visits', ['id', 'client', 'ip', 'country', 'visitor_key', 'device', 'signed_in', 'page', 'day_key', 'hour', 'created_at'], visits);
  const events = [];
  for (let i = 0; i < 60_000; i++) {
    const t = now - Math.floor((i / 60_000) * 30 * DAY);
    const u = users[(i * 23) % users.length];
    events.push([q(randomUUID()), q(pick(['page_view', 'page_view', 'page_view', 'login', 'download'], i)), q(pick(['/de/timetable', '/de/mensa', '/it/todos'], i)), 'NULL', i % 4 === 0 ? q(u.uid) : 'NULL', i % 4 === 0 ? q(u.username) : 'NULL', dt(t)]);
  }
  await insertRows(db, 'frontend_activity_logs', ['id', 'event', 'page', 'detail', 'stable_uid', 'username', 'created_at'], events);
  const tokens = users.slice(0, 2000).map((u, i) => [q(randomUUID()), q(u.uid), q(randomBytes(32).toString('hex')), dt(now + 20 * DAY), dt(now - (i % 10) * DAY)]);
  await insertRows(db, 'refresh_tokens', ['id', 'stable_uid', 'token_hash', 'expires_at', 'created_at'], tokens);
}

// ── Measurements ─────────────────────────────────────────────────────────────

const ENDPOINTS = [
  ['GET', '/api/admin/stats'],
  ['GET', '/api/admin/stats/requests-chart'],
  ['GET', '/api/admin/stats/top-endpoints'],
  ['GET', '/api/admin/activity-logs/stats'],
  ['GET', '/api/admin/users?page=1&limit=20'],
  ['GET', '/api/admin/users?page=1&limit=20&role=student'],
  ['GET', '/api/admin/comments?page=1&limit=50'],
  ['GET', '/api/admin/dish-ratings'],
  ['GET', '/api/admin/logs?page=1&limit=50'],
  ['GET', '/api/admin/analytics?range=30&fresh=1'],
  ['GET', '/api/admin/analytics?range=30'],
  ['GET', '/api/admin/analytics?range=7&fresh=1'],
  ['GET', '/dishes'],
  ['POST', '/dish-ratings/batch', { dishIds: Array.from({ length: 20 }, (_, i) => `gericht-nummer-${i}`) }],
  ...(process.env.BENCH_EXTRA ? JSON.parse(process.env.BENCH_EXTRA) : []),
];

async function questions(db) {
  const [row] = await db.$queryRawUnsafe("SHOW GLOBAL STATUS LIKE 'Questions'");
  return Number(row.Value);
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { mean: sorted.reduce((s, v) => s + v, 0) / sorted.length, p50: at(0.5), p95: at(0.95) };
}

async function measure(server, db) {
  const token = jwt.sign({ role: 'admin', sub: 'admin-panel', username: ADMIN_USERNAME }, SECRETS.jwt, { expiresIn: '2h' });
  const results = [];
  for (const [method, pathname, body] of ENDPOINTS) {
    const call = async () => {
      const started = performance.now();
      const res = await fetch(`${server.url}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'x-api-key': SECRETS.apiKey,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { ms: performance.now() - started, status: res.status, bytes: text.length };
    };
    for (let i = 0; i < 3; i++) await call();
    const samples = [];
    const statements = [];
    let status = 0;
    let bytes = 0;
    for (let i = 0; i < RUNS; i++) {
      const before = await questions(db);
      const r = await call();
      // Let the after-response request-log insert land before reading again.
      await sleep(15);
      const after = await questions(db);
      samples.push(r.ms);
      // The two SHOW statements themselves are subtracted.
      statements.push(Math.max(0, after - before - 1));
      status = r.status;
      bytes = r.bytes;
    }
    const s = stats(samples);
    const sq = stats(statements);
    results.push({ endpoint: `${method} ${pathname.length > 60 ? `${pathname.slice(0, 60)}…` : pathname}`, status, bytes, ...s, sql: sq.p50 });
  }
  return results;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const mysql = await mysqlServer();
const admin = new PrismaClient({ datasources: { db: { url: `${mysql.url}/mysql` } }, log: [] });
await waitFor(async () => { await admin.$queryRawUnsafe('SELECT 1'); return true; }, 120_000, 'MySQL');
const [existing] = await admin.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${DATABASE}'`);
const fresh = Number(existing.n) === 0;
if (fresh) await admin.$executeRawUnsafe(`CREATE DATABASE \`${DATABASE}\``);
const databaseUrl = `${mysql.url}/${DATABASE}`;
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: [] });

let server = await startServer(databaseUrl);
if (fresh) {
  process.stderr.write('seeding…\n');
  await seed(db);
  // Restart so every start-up job (migrations, backfills) sees the data.
  server.child.kill('SIGTERM');
  await sleep(3000);
  server = await startServer(databaseUrl);
}
// Start-up work (migrations, backfills) settles before measuring.
await sleep(Number(process.env.BENCH_SETTLE_MS ?? 2000));
const results = await measure(server, db);
console.log(`\n## ${LABEL} (${RUNS} runs each, ms)\n`);
console.log('| endpoint | status | mean | p50 | p95 | SQL/req | bytes |');
console.log('|---|---|---|---|---|---|---|');
for (const r of results) {
  console.log(`| ${r.endpoint} | ${r.status} | ${r.mean.toFixed(1)} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.sql} | ${r.bytes} |`);
}
const out = opt('out');
if (out) {
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ label: LABEL, runs: RUNS, results }, null, 2));
}
server.child.kill('SIGTERM');
await db.$disconnect();
await admin.$disconnect();
if (mysql.container && !flag('keep')) {
  execFileSync('docker', ['rm', '-f', mysql.container], { stdio: 'ignore' });
} else if (mysql.container) {
  console.log(`\nMySQL kept: ${mysql.url} (container ${mysql.container})`);
}
process.exit(0);
