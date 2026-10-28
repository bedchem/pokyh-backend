#!/usr/bin/env node
// Test data for a DEVELOPMENT installation: several schools, admins of every
// kind, pupils and parents, classes, a menu per school, comments, ratings,
// todos, reminders, popups, error reports, and two weeks of usage and request
// history — enough to try every part of the admin panel, including what one
// school's admins must NOT see of another school.
//
// Runs inside the app container, against the running server (so the real
// permission, school and menu rules create the data) and its database (for
// the history only):
//
//   docker compose exec -T -e SEED_TEST_PASSWORD='…' app node - --yes < scripts/seed-test-data.js
//   docker compose exec -T app node - --yes --remove < scripts/seed-test-data.js
//
// The test admins' password comes from SEED_TEST_PASSWORD (or --password=…);
// without one a random password is made and printed once. Never against a
// production database: everything it creates is test data. It is all marked —
// accounts "test.*", classes and menus "(Test)", dishes in category "Test",
// popups and error reports "[Test]" — and --remove takes it out again (the
// account named by SEED_ADMIN_USERNAME, if any, stays).

const jwt = require('jsonwebtoken');
const { randomUUID, createHash, randomBytes } = require('crypto');
const { PrismaClient } = require('@prisma/client');

const args = process.argv.slice(1);
const REMOVE = args.includes('--remove');
if (!args.includes('--yes')) {
  console.error('Test data with known passwords — for a development installation only. Run again with --yes.');
  process.exit(1);
}

const fromFlag = args.find((a) => a.startsWith('--password='))?.slice('--password='.length);
const PASSWORD = fromFlag || process.env.SEED_TEST_PASSWORD || `Test-${randomBytes(9).toString('base64url')}`;
if (PASSWORD.length < 8) {
  console.error('The test password needs at least 8 characters.');
  process.exit(1);
}
// An extra personal admin account to create (e.g. your own login), optional.
const PERSONAL = (args.find((a) => a.startsWith('--admin='))?.slice('--admin='.length) || process.env.SEED_ADMIN_USERNAME || '').trim().toLowerCase();
const BASE = `http://127.0.0.1:${process.env.PORT || 4000}`;
const OWNER = (process.env.ADMIN_USERNAMES || process.env.ADMIN_USERNAME || '').split(',')[0].trim();
const JWT_SECRET = process.env.JWT_SECRET;
const API_KEY = process.env.API_KEY;
const SERVER_KEY = process.env.SERVER_KEY;
if (!OWNER || !JWT_SECRET || !API_KEY || !SERVER_KEY) {
  console.error('ADMIN_USERNAMES, JWT_SECRET, API_KEY and SERVER_KEY must be set (run this inside the app container).');
  process.exit(1);
}

const prisma = new PrismaClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ownerToken = jwt.sign({ role: 'admin', sub: 'admin-panel', username: OWNER }, JWT_SECRET, { expiresIn: '1h' });
// The app's own session token for an account (same claims as routes/auth.ts).
const appToken = (u) => jwt.sign({ stableUid: u.stableUid, username: u.username, klasseId: u.webuntisKlasseId || 0, klasseName: u.webuntisKlasseName || '', role: u.role, isUntisUser: true }, JWT_SECRET, { expiresIn: '1h' });

// ── HTTP, paced below the server's own rate limits ───────────────────────────
// Every request from here counts against one address: the global limit, and
// 60 writes a minute for the app's write routes.
let lastCall = 0;
let lastWrite = 0;
async function call(method, path, { token = ownerToken, school, body, app = false } = {}) {
  const wait = Math.max(0, lastCall + 160 - Date.now());
  if (wait) await sleep(wait);
  if (app && method !== 'GET') {
    const w = Math.max(0, lastWrite + 1100 - Date.now());
    if (w) await sleep(w);
    lastWrite = Date.now();
  }
  lastCall = Date.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(app ? { 'x-api-key': API_KEY } : {}),
        ...(school ? { 'x-pokyh-school': school } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      await sleep((Number(res.headers.get('retry-after')) || 10) * 1000);
      continue;
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const error = new Error(`${method} ${path} → ${res.status} ${json?.error ?? text.slice(0, 200)}`);
      error.status = res.status;
      throw error;
    }
    return json;
  }
  throw new Error(`${method} ${path}: still rate limited`);
}

// ── What is created ──────────────────────────────────────────────────────────

// Schools arrive the way real ones do: with the first WebUntis sign-in of one
// of their accounts (POST /auth/login with the server key).
const SCHOOLS = [
  { slug: 'testtal', name: 'Fachschule Testtal (Test)', shortName: 'Testtal', webuntisSchool: 'fs-testtal-test', firstClass: { id: 9101, name: '1A (Test)' }, menu: 'Mensa Testtal (Test)' },
  // No menu: its accounts see no Mensa at all.
  { slug: 'musterhausen', name: 'LBS Musterhausen (Test)', shortName: 'Musterhausen', webuntisSchool: 'lbs-musterhausen-test', firstClass: { id: 9201, name: '1M (Test)' }, menu: null },
];

const FIRST = ['lena', 'paul', 'anna', 'jonas', 'sophie', 'lukas', 'marie', 'felix', 'emma', 'david', 'laura', 'simon', 'julia', 'elias', 'hannah', 'matteo', 'sara', 'luca', 'nina', 'tobias', 'lisa', 'noah', 'eva', 'fabian', 'giulia', 'samuel', 'clara', 'leon'];

const DISHES = {
  a: ['Knödel mit Speck', 'Spaghetti Bolognese', 'Gemüsestrudel', 'Wiener Schnitzel', 'Risotto ai funghi', 'Kaiserschmarrn', 'Linsensuppe', 'Pizza Margherita', 'Schlutzkrapfen', 'Polenta mit Gulasch'],
  // "Knödel mit Speck" again: the same name in another menu is another dish.
  b: ['Knödel mit Speck', 'Pasta al pomodoro', 'Hühnercurry mit Reis', 'Gemüselasagne', 'Apfelstrudel'],
};

const COMMENTS = ['Sehr lecker heute!', 'Etwas zu salzig.', 'Portion war zu klein.', 'Bitte öfter!', 'War kalt, schade.', 'Bestes Essen der Woche.', 'Die Soße war super.', 'Ganz okay.', 'Vegetarische Option fehlt.', 'Nachschlag wäre toll gewesen.'];

const ERRORS = [
  { name: 'TypeError', message: "[Test] Cannot read properties of undefined (reading 'dishes')", page: '/de/mensa', stack: 'TypeError: Cannot read properties of undefined\n    at MensaWeek (https://pokyh.com/_next/static/chunks/mensa.js?v=3:12:9)\n    at renderWithHooks (https://pokyh.com/_next/static/chunks/framework.js:1:400)' },
  { name: 'ChunkLoadError', message: '[Test] Loading chunk 812 failed.', page: '/de/timetable', stack: 'ChunkLoadError: Loading chunk 812 failed.\n    at __webpack_require__.f.j (https://pokyh.com/_next/static/chunks/webpack.js:1:3600)' },
  { name: 'Error', message: '[Test] Request failed with status 502 token=abc123secret', page: '/de/todos?filter=open', stack: null },
];

const ADMINS = [
  { username: 'test.schuladmin.a', preset: 'school_admin', school: 'a', note: 'School-Admin der Standardschule' },
  { username: 'test.viewer.a', preset: 'viewer', school: 'a', note: 'nur lesen, Standardschule' },
  { username: 'test.moderator.a', preset: 'moderator', school: 'a', note: 'Kommentare moderieren, Standardschule' },
  { username: 'test.mensa.a', preset: 'mensa_manager', school: 'a', note: 'Speiseplan, Standardschule' },
  { username: 'test.schuladmin.b', preset: 'school_admin', school: 'b', note: 'School-Admin Testtal' },
  { username: 'test.multi', preset: 'school_admin', school: 'a', also: 'b', note: 'School-Admin in Standardschule und Testtal' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function findUser(username) {
  return prisma.user.findUnique({ where: { username } });
}

async function ensureSchools() {
  const me = await call('GET', '/api/admin/me');
  const a = me.schools.find((s) => s.isDefault);
  if (!a) throw new Error('No default school yet — start the server once first.');
  const out = { a: { id: a.id, name: a.name, menuId: a.menuId } };
  for (const [i, spec] of SCHOOLS.entries()) {
    let school = (await call('GET', '/api/admin/schools')).schools.find((s) => s.webuntisSchool === spec.webuntisSchool);
    if (!school) {
      // The first account signs in through WebUntis, as the web app's server
      // does it; the school joins on that sign-in.
      const key = i === 0 ? 'b' : 'c';
      const res = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'x-server-key': SERVER_KEY },
        body: JSON.stringify({ username: `test.${key}.${FIRST[0]}`, klasseId: spec.firstClass.id, klasseName: spec.firstClass.name, school: spec.webuntisSchool, schoolName: spec.name }),
      });
      if (!res.ok) throw new Error(`POST /auth/login → ${res.status} ${(await res.text()).slice(0, 200)}`);
      school = (await call('GET', '/api/admin/schools')).schools.find((s) => s.webuntisSchool === spec.webuntisSchool);
      if (!school) throw new Error(`${spec.name} did not join on its first sign-in`);
      console.log(`  Schule ist mit der ersten Anmeldung dazugekommen: ${school.name}`);
    }
    if (school.slug !== spec.slug || school.shortName !== spec.shortName) {
      school = (await call('PATCH', `/api/admin/schools/${school.id}`, { body: { shortName: spec.shortName, ...(school.slug !== spec.slug ? { slug: spec.slug } : {}) } })).school;
    }
    let menuId = null;
    if (spec.menu) {
      const { menus } = await call('GET', '/api/admin/menus');
      let menu = menus.find((m) => m.name === spec.menu);
      if (!menu) menu = (await call('POST', '/api/admin/menus', { body: { name: spec.menu } })).menu;
      if (school.menu?.id !== menu.id) await call('PUT', `/api/admin/schools/${school.id}/menu`, { body: { menuId: menu.id } });
      menuId = menu.id;
    }
    out[i === 0 ? 'b' : 'c'] = { id: school.id, name: school.name, menuId };
  }
  return out;
}

const OWNERS = (process.env.ADMIN_USERNAMES || process.env.ADMIN_USERNAME || '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);

async function ensureAdmin(username, schoolId, grants, catalog) {
  let user = await findUser(username);
  // An operator from ADMIN_USERNAMES holds every right already; the panel
  // (rightly) never edits them. Only the account itself is made.
  if (OWNERS.includes(username.toLowerCase())) {
    if (!user) {
      await call('POST', '/api/admin/users', { body: { username, password: PASSWORD, role: 'none', schoolId } });
      user = await findUser(username);
    }
    return user;
  }
  if (!user) {
    await call('POST', '/api/admin/users', { body: { username, password: PASSWORD, role: 'none', isAdmin: true, schoolId } });
    user = await findUser(username);
  } else {
    await call('PATCH', `/api/admin/users/${user.stableUid}/password`, { body: { password: PASSWORD } });
    await call('POST', `/api/admin/users/${user.stableUid}/grant-admin`, { body: {} });
  }
  for (const { scope, preset } of grants) {
    const permissions = preset === 'global_admin' ? catalog.permissions.map((p) => p.key) : catalog.presets.find((p) => p.key === preset).permissions;
    await call('PUT', `/api/admin/admins/${encodeURIComponent(username)}/grants/${scope}`, { body: { permissions, preset } });
  }
  return user;
}

async function ensurePupil(username, schoolId, role, klasse) {
  let user = await findUser(username);
  if (!user) {
    await call('POST', '/api/admin/users', {
      body: { username, role, schoolId, ...(klasse ? { webuntisKlasseId: klasse.id, webuntisKlasseName: klasse.name } : {}) },
    });
    user = await findUser(username);
  }
  return user;
}

function seasonPlan(date = new Date()) {
  const m = date.getMonth() + 1;
  return m >= 4 && m <= 10 ? 'summer' : 'winter';
}

function mondayOf(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
}

const iso = (d) => d.toISOString().slice(0, 10);
const pick = (list, i) => list[i % list.length];
const hex = (n) => createHash('sha256').update(randomUUID()).digest('hex').slice(0, n);

// ── Seed ─────────────────────────────────────────────────────────────────────

async function seed() {
  console.log('\n── Testdaten ───────────────────────────────────────────\n');
  const catalog = await call('GET', '/api/admin/access/catalog');
  const schools = await ensureSchools();
  const { a, b, c } = schools;

  // Admins
  if (PERSONAL) {
    await ensureAdmin(PERSONAL, a.id, [{ scope: 'global', preset: 'global_admin' }], catalog);
    console.log(`  Admin ${PERSONAL} bereit${OWNERS.includes(PERSONAL) ? ' (Server-Owner aus ADMIN_USERNAMES: alle Rechte)' : ' (Global-Admin)'}`);
  }
  for (const spec of ADMINS) {
    const own = spec.school === 'a' ? a : b;
    const grants = [{ scope: own.id, preset: spec.preset }, ...(spec.also ? [{ scope: (spec.also === 'b' ? b : a).id, preset: spec.preset }] : [])];
    await ensureAdmin(spec.username, own.id, grants, catalog);
  }
  console.log(`  ${ADMINS.length} Test-Admins bereit`);

  // Pupils and parents, in classes.
  // WebUntis ids in the 9000s, clear of real classes; 9101 in two schools.
  const plan = { a: [{ id: 9101, name: '1A (Test)' }, { id: 9102, name: '2B (Test)' }, { id: 9103, name: '3C (Test)' }], b: [{ id: 9101, name: '1A (Test)' }, { id: 9104, name: '4D (Test)' }], c: [{ id: 9201, name: '1M (Test)' }] };
  const people = { a: [], b: [], c: [] };
  const counts = { a: 24, b: 12, c: 6 };
  for (const key of ['a', 'b', 'c']) {
    const school = schools[key];
    const classes = [];
    const existing = await call('GET', '/api/admin/classes', { school: school.id });
    for (const k of plan[key]) {
      let cls = existing.find((x) => x.webuntisKlasseId === k.id);
      if (!cls) cls = await call('POST', '/api/admin/classes', { school: school.id, body: { name: k.name, webuntisKlasseId: k.id } });
      classes.push({ ...k, classId: cls.id });
    }
    for (let i = 0; i < counts[key]; i++) {
      const k = classes[i % classes.length];
      const user = await ensurePupil(`test.${key}.${pick(FIRST, i)}${i >= FIRST.length ? i : ''}`, school.id, 'student', k);
      people[key].push({ ...user, classId: k.classId });
      await call('POST', `/api/admin/classes/${k.classId}/members`, { school: school.id, body: { username: user.username } }).catch(() => undefined);
    }
    for (let i = 0; i < (key === 'c' ? 1 : 3); i++) {
      const user = await ensurePupil(`test.${key}.elternteil${i + 1}`, school.id, 'parent', null);
      people[key].push({ ...user, classId: null });
    }
    console.log(`  ${school.name}: ${people[key].length} Konten in ${classes.length} Klassen`);
    school.classes = classes;
  }

  // Menus: two weeks for the default school, one for Testtal.
  const seasonal = seasonPlan();
  const monday = mondayOf(new Date());
  for (const [key, names, weeks] of [['a', DISHES.a, 2], ['b', DISHES.b, 1]]) {
    const school = schools[key];
    const dishes = await call('GET', `/api/admin/dishes?plan=${seasonal}`, { school: school.id });
    if (dishes.filter((d) => d.category === 'Test').length > 0) continue;
    let n = 0;
    for (let w = 0; w < weeks; w++) {
      for (let d = 0; d < 5; d++) {
        for (let k = 0; k < 2; k++) {
          const date = new Date(monday.getTime() + (w * 7 + d) * 86_400_000);
          await call('POST', '/api/admin/dishes', {
            school: school.id,
            body: { nameDe: pick(names, n), nameIt: pick(names, n), nameEn: pick(names, n), date: iso(date), plan: seasonal, category: 'Test', sortOrder: k, price: 4.5 + k, isVegetarian: /Gemüse|Strudel|Risotto|Pasta|Pizza|Kaiser/.test(pick(names, n)) },
          });
          n++;
        }
      }
    }
    console.log(`  ${school.name}: ${n} Gerichte im Speiseplan`);
  }

  // Ratings and comments through the app's own routes (school and menu are
  // taken from the account, as for real users). Paced: 60 writes a minute.
  const keyOf = (name) => name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  let writes = 0;
  for (const [key, names, voters] of [['a', DISHES.a, 12], ['b', DISHES.b, 7]]) {
    const pupils = people[key].filter((p) => p.role === 'student').slice(0, voters);
    for (const [i, pupil] of pupils.entries()) {
      const token = appToken(pupil);
      const dish = keyOf(pick(names, i));
      await call('POST', `/dish-ratings/${dish}`, { token, app: true, body: { stars: 1 + ((i * 3) % 5) } });
      writes++;
      if (i % 2 === 0) {
        await call('POST', `/dish-comments/${dish}`, { token, app: true, body: { body: pick(COMMENTS, i + (key === 'b' ? 3 : 0)) } });
        writes++;
      }
    }
  }
  console.log(`  Bewertungen und Kommentare angelegt (${writes} Schreibzugriffe über die App-API)`);

  // Todos and reminders with comments.
  for (const key of ['a', 'b']) {
    const pupils = people[key].filter((p) => p.role === 'student');
    for (const [i, pupil] of pupils.slice(0, 4).entries()) {
      await call('POST', `/users/${encodeURIComponent(pupil.username)}/todos`, { token: appToken(pupil), app: true, body: { title: `Hausaufgabe ${i + 1}`, details: 'Testeintrag', dueAt: new Date(Date.now() + (i + 1) * 86_400_000).toISOString() } });
    }
    for (const cls of schools[key].classes) {
      const reminders = await call('GET', `/api/admin/classes/${cls.classId}/reminders`, { school: schools[key].id });
      const reminder = reminders[0] ?? await call('POST', `/api/admin/classes/${cls.classId}/reminders`, {
        school: schools[key].id,
        body: { title: `Schularbeit ${cls.name.replace(' (Test)', '')}`, body: 'Bitte Taschenrechner mitbringen.', remindAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
      });
      const member = pupils.find((p) => p.classId === cls.classId);
      if (member && reminders.length === 0) {
        await call('POST', `/classes/${cls.classId}/reminders/${reminder.id}/comments`, { token: appToken(member), app: true, body: { body: 'Gilt das auch für die Nachschreiber?' } });
      }
    }
  }
  console.log('  Todos, Erinnerungen und Kommentare dazu angelegt');

  // Half of the pupils consent to the usage statistics (named in Analytics).
  for (const key of ['a', 'b']) {
    for (const [i, pupil] of people[key].entries()) {
      if (i % 2 !== 0) continue;
      await call('PUT', '/privacy/usage-stats', { token: appToken(pupil), app: true, body: { enabled: true } });
    }
  }
  // Someone online right now, in each school.
  for (const key of ['a', 'b']) {
    for (const pupil of people[key].slice(0, key === 'a' ? 6 : 3)) {
      await call('POST', '/usage/ping', { token: appToken(pupil), app: true, body: { sessionId: randomUUID(), client: 'browser', device: 'ios', activeSeconds: 40, screens: 2 } });
    }
  }
  console.log('  Einwilligungen und laufende Besuche angelegt');

  // Error reports from the apps (scrubbed by the server on the way in).
  for (const [i, report] of ERRORS.entries()) {
    const pupil = people[i === 2 ? 'b' : 'a'][i];
    await call('POST', '/client-errors', { token: appToken(pupil), app: true, body: { source: 'web', release: '2026.10.16', ...report } });
  }
  console.log('  Fehlerberichte angelegt');

  // Popups: one for every school, one for the default school only.
  const { popups } = await call('GET', '/api/admin/popups');
  if (!popups.some((p) => p.title.startsWith('[Test]'))) {
    const base = { content: 'Dies ist ein **Test-Popup**.', platform: 'all', audience: 'all', mode: 'once', showCount: 1, startsAt: null, endsAt: null, enabled: false };
    await call('POST', '/api/admin/popups', { body: { ...base, title: '[Test] Für alle Schulen' } });
    await call('POST', '/api/admin/popups', { school: a.id, body: { ...base, title: `[Test] Nur ${a.name}` } });
  }

  await seedHistory(schools, people);

  const given = Boolean(fromFlag || process.env.SEED_TEST_PASSWORD);
  console.log(`\n── Anmeldungen (Admin-Panel /admin) — Passwort: ${given ? 'wie angegeben' : PASSWORD} ──\n`);
  if (PERSONAL) console.log(`  ${PERSONAL.padEnd(20)}${OWNERS.includes(PERSONAL) ? 'Server-Owner (ADMIN_USERNAMES)' : 'Global-Admin'}: alle Schulen, System`);
  for (const spec of ADMINS) console.log(`  ${spec.username.padEnd(20)}${spec.note}`);
  console.log(`\n  Schulen: ${a.name} (Standard, Mensaplan), ${b.name} (eigener Mensaplan), ${c.name} (kein Mensaplan)`);
  console.log(`  App-Konten: test.a.* / test.b.* / test.c.* (WebUntis-Konten, keine Passwörter)`);
  console.log(`  Entfernen: docker compose exec -T app node - --yes --remove < scripts/seed-test-data.js\n`);
}

// Two weeks of history for Analytics and the Anfragen page: visits, request
// evidence and request logs, all marked as test data.
async function seedHistory(schools, people) {
  // The server's own analytics time zone, from its configuration.
  const { config } = require(`${process.cwd()}/dist/config`);
  const tz = config.usageAnalytics.timezone;
  const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const consenting = new Set((await prisma.privacyConsent.findMany({ where: { usageStats: true }, select: { stableUid: true } })).map((r) => r.stableUid));
  // Per school: a school added again (new id) gets its history again.
  const ids = ['a', 'b', 'c'].map((key) => schools[key].id);
  const have = new Set((await prisma.usageSession.groupBy({ by: ['schoolId'], where: { visitorKey: { startsWith: 'feedc0de' }, schoolId: { in: ids } } })).map((r) => r.schoolId));
  const keys = ['a', 'b', 'c'].filter((key) => !have.has(schools[key].id));
  if (keys.length === 0) {
    console.log('  Verlauf schon vorhanden');
    return;
  }
  const sessions = [];
  const accountDays = [];
  const logs = [];
  const now = Date.now();
  const paths = ['/dishes', '/users/me', '/classes/mine', '/dish-ratings/batch', '/auth/refresh', '/popups/active'];
  const uas = ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'okhttp/4.12.0', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'];
  for (let day = 13; day >= 1; day--) {
    for (const key of keys) {
      const pupils = people[key];
      const active = pupils.filter((_, i) => (i + day) % 3 !== 0);
      for (const [i, pupil] of active.entries()) {
        const hour = 7 + ((i * 5 + day) % 13);
        const start = new Date(now - day * 86_400_000);
        start.setHours(hour, (i * 7) % 60, 0, 0);
        const device = pick(['ios', 'android', 'desktop'], i + day);
        const client = device === 'desktop' ? 'browser' : pick(['app', 'pwa', 'browser'], i);
        sessions.push({
          id: randomUUID(),
          stableUid: consenting.has(pupil.stableUid) ? pupil.stableUid : null,
          visitorKey: `feedc0de${hex(8)}`,
          device, client, appVersion: client === 'app' ? '2.1.0' : '',
          dayKey: dayKey(start), startHour: hour, activeSeconds: 60 + ((i * 37 + day * 11) % 900), screens: 1 + ((i + day) % 9),
          startedAt: start, lastSeenAt: new Date(start.getTime() + 10 * 60_000), schoolId: schools[key].id,
        });
        const kind = client === 'app' ? (device === 'android' ? { device: 'android', client: 'app' } : { device: 'ios', client: 'app' }) : { device, client: 'web' };
        accountDays.push({ dayKey: dayKey(start), stableUid: pupil.stableUid, device: kind.device, client: kind.client, schoolId: schools[key].id, lastAt: start });
        for (let r = 0; r < 6; r++) {
          const at = new Date(start.getTime() + r * 90_000);
          const status = (i + r + day) % 41 === 0 ? 500 : (i + r) % 17 === 0 ? 404 : 200;
          logs.push({
            id: randomUUID(), method: r === 3 ? 'POST' : 'GET', path: pick(paths, i + r), status, duration: 4 + ((i * 13 + r * 7 + day) % 120),
            ip: `10.20.${key === 'a' ? 1 : key === 'b' ? 2 : 3}.${(i % 200) + 1}`, stableUid: pupil.stableUid, username: pupil.username,
            userAgent: uas[device === 'android' ? 1 : device === 'ios' ? 0 : 2], error: status >= 500 ? 'server_error' : status >= 400 ? 'client_error' : null,
            requestId: randomUUID(), scope: 'core', schoolId: schools[key].id, createdAt: at,
          });
        }
      }
    }
  }
  await prisma.usageSession.createMany({ data: sessions });
  await prisma.requestAccountDay.createMany({ data: accountDays, skipDuplicates: true });
  for (let i = 0; i < logs.length; i += 1000) await prisma.requestLog.createMany({ data: logs.slice(i, i + 1000) });
  console.log(`  Verlauf: ${sessions.length} Besuche, ${logs.length} Anfragen über 13 Tage`);
}

// ── Remove ───────────────────────────────────────────────────────────────────

async function remove() {
  console.log('\n── Testdaten entfernen ─────────────────────────────────\n');
  const users = await prisma.user.findMany({ where: { username: { startsWith: 'test.' } }, select: { stableUid: true, username: true } });
  const uids = users.map((u) => u.stableUid);
  const names = users.map((u) => u.username);
  const schools = await prisma.school.findMany({ where: { OR: [{ webuntisSchool: { in: SCHOOLS.map((s) => s.webuntisSchool) } }, { slug: { in: SCHOOLS.map((s) => s.slug) } }] }, select: { id: true } });
  const schoolIds = schools.map((s) => s.id);
  const menus = await prisma.mensaMenu.findMany({ where: { name: { in: SCHOOLS.map((s) => s.menu).filter(Boolean) } }, select: { id: true } });
  const menuIds = menus.map((m) => m.id);
  const testDishes = await prisma.dish.findMany({ where: { OR: [{ category: 'Test' }, { menuId: { in: menuIds } }] }, select: { id: true } });
  const r = {};
  // Usage statistics are never deleted in this project (tests/usageRetention):
  // the test visits only lose their accounts and stay as anonymous counts.
  r.usageAnonymised = (await prisma.usageSession.updateMany({ where: { stableUid: { in: uids } }, data: { stableUid: null } })).count;
  r.accountDays = (await prisma.requestAccountDay.deleteMany({ where: { stableUid: { in: uids } } })).count;
  r.requestLogs = (await prisma.requestLog.deleteMany({ where: { OR: [{ username: { in: names } }, { schoolId: { in: schoolIds } }] } })).count;
  r.activity = (await prisma.frontendActivityLog.deleteMany({ where: { username: { in: names } } })).count;
  r.webVisits = (await prisma.webVisit.deleteMany({ where: { OR: [{ stableUid: { in: uids } }, { schoolId: { in: schoolIds } }] } })).count;
  r.errors = (await prisma.clientErrorLog.deleteMany({ where: { message: { startsWith: '[Test]' } } })).count;
  r.ratings = (await prisma.dishRating.deleteMany({ where: { stableUid: { in: uids } } })).count;
  r.comments = (await prisma.dishComment.deleteMany({ where: { stableUid: { in: uids } } })).count;
  r.popups = (await prisma.popup.deleteMany({ where: { title: { startsWith: '[Test]' } } })).count;
  r.grants = (await prisma.adminGrant.deleteMany({ where: { OR: [{ username: { in: names } }, { scope: { in: schoolIds } }] } })).count;
  r.admins = (await prisma.admin.deleteMany({ where: { stableUid: { in: uids } } })).count;
  r.classes = (await prisma.class.deleteMany({ where: { name: { endsWith: '(Test)' } } })).count;
  r.users = (await prisma.user.deleteMany({ where: { stableUid: { in: uids } } })).count;
  await prisma.dishImage.deleteMany({ where: { dishId: { in: testDishes.map((d) => d.id) } } });
  r.dishes = (await prisma.dish.deleteMany({ where: { id: { in: testDishes.map((d) => d.id) } } })).count;
  await prisma.mensaMenuSchool.deleteMany({ where: { OR: [{ menuId: { in: menuIds } }, { schoolId: { in: schoolIds } }] } });
  r.menus = (await prisma.mensaMenu.deleteMany({ where: { id: { in: menuIds } } })).count;
  r.schools = (await prisma.school.deleteMany({ where: { id: { in: schoolIds } } })).count;
  for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(12)} ${v}`);
  console.log('\n  Persönliche Admin-Konten bleiben bestehen. Nutzungsstatistiken werden nie gelöscht: die Test-Besuche bleiben als anonyme Zählung. Die Server-Caches leeren sich innerhalb von 30 Sekunden.\n');
}

(REMOVE ? remove() : seed())
  .catch((err) => { console.error(`\n❌ ${err.message}`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
