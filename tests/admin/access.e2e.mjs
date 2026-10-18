import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Cluster, REPO, sleep, waitFor } from '../cluster/harness.mjs';

// End-to-end tests of schools, permissions and the admin panel's API against
// a real backend process and a real MySQL (tests/cluster/harness.mjs):
//
//   - schools joining on their first WebUntis sign-in, never made in the panel;
//   - school-level isolation of users, comments, analytics, logs and menus,
//     through direct API requests that change ids, headers and bodies;
//   - permissions: deny by default, read-only viewers, no self-elevation, no
//     global admin made by a school admin, revocation taking effect at once;
//   - the user list's filters and paging across the whole data set;
//   - requests kept apart from admin traffic, full request paths logged;
//   - comments grouped by dish per menu; menus per school;
//   - frontend error reports scrubbed and kept apart from backend logs;
//   - the one-time migration of existing admins.
//
// Run with `npm run test:admin` (builds first).

const require = createRequire(import.meta.url);
const jwt = require(path.join(REPO, 'node_modules', 'jsonwebtoken'));

const cluster = new Cluster();
let node;
let ownerToken;
let schoolA;
let schoolB;

const tokenFor = (username) => jwt.sign({ role: 'admin', sub: 'admin-panel', username }, cluster.secrets.jwt, { expiresIn: '2h' });

function api(method, pathname, { token = ownerToken, school, body, apiKey = false, headers = {} } = {}) {
  return cluster.request(node, method, pathname, {
    body,
    token,
    apiKey,
    headers: { ...(school ? { 'x-pokyh-school': school } : {}), ...headers },
  });
}

async function ok(promise, status = 200) {
  const res = await promise;
  assert.equal(res.status, status, `${res.status} ${res.text}`);
  return res.json;
}

// An app login the way the web frontend does it, optionally for a school
// (its WebUntis login name, display name and server).
async function appLogin(username, { school, schoolName, schoolServer, klasseId = 0, klasseName = '' } = {}) {
  return cluster.request(node, 'POST', '/auth/login', {
    body: { username, klasseId, klasseName, ...(school ? { school } : {}), ...(schoolName ? { schoolName } : {}), ...(schoolServer ? { schoolServer } : {}) },
    headers: { 'x-server-key': node.serverKey },
  });
}

// A local account with panel access and the given rights, made by the owner.
async function makeAdmin(username, schoolId, grant) {
  const created = await ok(api('POST', '/api/admin/users', {
    body: { username, password: 'Very-long-pass-1', role: 'none', isAdmin: true, schoolId, grant },
  }), 201);
  return { token: tokenFor(username), stableUid: created.stableUid };
}

before(async () => {
  await cluster.startMysql();
  node = await cluster.addNode('admin', { WEBUNTIS_SCHOOL: 'lbs-brixen', DEFAULT_SCHOOL_NAME: 'LBS Tschuggmall' });
  await cluster.start(node);
  ownerToken = cluster.adminToken;
}, { timeout: 600_000 });

after(async () => {
  await cluster.teardown();
}, { timeout: 120_000 });

test('the default school exists and the owner sees every school', async () => {
  const me = await ok(api('GET', '/api/admin/me'));
  assert.equal(me.owner, true);
  assert.equal(me.schools.length, 1);
  schoolA = me.schools[0];
  assert.equal(schoolA.name, 'LBS Tschuggmall');
  assert.equal(schoolA.isDefault, true);
  // Schools are never made in the panel, not even by the owner: there is no
  // such route (an unknown path is refused like any other).
  const made = await api('POST', '/api/admin/schools', { body: { name: 'Fachschule Zweite', slug: 'zweite' } });
  assert.ok(made.status >= 400 && made.status < 500, `${made.status}`);
  assert.equal((await ok(api('GET', '/api/admin/schools'))).schools.length, 1);
  // Nor is their WebUntis identity changed there.
  await ok(api('PATCH', `/api/admin/schools/${schoolA.id}`, { body: { webuntisSchool: 'other' } }), 422);
});

test('a school joins on the first WebUntis sign-in of one of its accounts', async () => {
  const b = await appLogin('bert.b', { school: 'fs-zweite', schoolName: 'Fachschule\u0007  Zweite', schoolServer: 'zweite.webuntis.com', klasseId: 11, klasseName: '1A' });
  assert.equal(b.status, 200, b.text);
  const { schools } = await ok(api('GET', '/api/admin/schools'));
  assert.equal(schools.length, 2);
  schoolB = schools.find((s) => s.webuntisSchool === 'fs-zweite');
  assert.ok(schoolB, 'the school was added');
  assert.equal(b.json.user.schoolId, schoolB.id);
  assert.equal(schoolB.name, 'Fachschule Zweite');
  assert.equal(schoolB.origin, 'webuntis');
  assert.equal(schoolB.active, true);
  assert.equal(schoolB.webuntisBase, 'https://zweite.webuntis.com/WebUntis');
  // It arrives without a menu: its app shows none until one is assigned.
  assert.equal(schoolB.menu, null);
  const dishes = await cluster.request(node, 'GET', `/dishes?school=${schoolB.slug}`, { apiKey: true });
  assert.equal(dishes.status, 200, dishes.text);
  assert.equal(dishes.json.available, false);
  assert.deepEqual(dishes.json.menu.dishes, []);
  // Recorded in the audit trail, as the school's own event.
  const events = (await ok(api('GET', '/api/admin/audit-events?limit=50'))).events;
  assert.ok(events.some((e) => e.action === 'school.join' && e.schoolId === schoolB.id && e.actor === 'webuntis'));

  // The next sign-in finds it again: one school, not two.
  const again = await appLogin('bert.b', { school: 'FS-Zweite', schoolName: 'Something else' });
  assert.equal(again.status, 200, again.text);
  const after = (await ok(api('GET', '/api/admin/schools'))).schools;
  assert.equal(after.length, 2);
  assert.equal(after.find((s) => s.id === schoolB.id).name, 'Fachschule Zweite');

  // A server outside WebUntis is not stored; a name that is not a WebUntis
  // login name is refused.
  const third = await appLogin('dora.d', { school: 'dritte schule', schoolServer: 'evil.example.com' });
  assert.equal(third.status, 200, third.text);
  const dritte = (await ok(api('GET', '/api/admin/schools'))).schools.find((s) => s.webuntisSchool === 'dritte schule');
  assert.equal(dritte.webuntisBase, '');
  assert.equal(dritte.name, 'dritte schule');
  assert.equal((await appLogin('eve.e', { school: '<script>' })).status, 422);
  assert.equal((await appLogin('eve.e', { school: ' ' })).status, 422);

  // Without the server key nobody adds a school.
  const anon = await cluster.request(node, 'POST', '/auth/login', { body: { username: 'x', password: 'y', school: 'vierte' } });
  assert.equal(anon.status, 401);
  assert.equal((await ok(api('GET', '/api/admin/schools'))).schools.some((s) => s.webuntisSchool === 'vierte'), false);

  // A school switched off in the panel stays refused.
  await ok(api('PATCH', `/api/admin/schools/${dritte.id}`, { body: { active: false } }));
  assert.equal((await appLogin('dora.d', { school: 'dritte schule' })).status, 403);
});

test('a WebUntis login lands in its school; the same name from another school is refused', async () => {
  const a = await appLogin('anna.a', { klasseId: 11, klasseName: '1A' });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.json.user.schoolId, schoolA.id);
  const b = await appLogin('bert.b', { school: 'fs-zweite', klasseId: 11, klasseName: '1A' });
  assert.equal(b.status, 200, b.text);
  assert.equal(b.json.user.schoolId, schoolB.id);
  // WebUntis class 11 exists in both schools: two different classes.
  const classes = await ok(api('GET', '/api/admin/classes'));
  const elevens = classes.filter((c) => c.webuntisKlasseId === 11);
  assert.equal(elevens.length, 2);
  assert.notEqual(elevens[0].schoolId, elevens[1].schoolId);

  const clash = await appLogin('anna.a', { school: 'fs-zweite' });
  assert.equal(clash.status, 409, clash.text);
});

let adminA;
let viewerA;
let adminB;

test('school admins and viewers are made with rights in their school only', async () => {
  const catalog = await ok(api('GET', '/api/admin/access/catalog'));
  const preset = (key) => catalog.presets.find((p) => p.key === key).permissions;
  adminA = await makeAdmin('admin.a', schoolA.id, { scope: schoolA.id, permissions: preset('school_admin'), preset: 'school_admin' });
  viewerA = await makeAdmin('viewer.a', schoolA.id, { scope: schoolA.id, permissions: preset('viewer'), preset: 'viewer' });
  adminB = await makeAdmin('admin.b', schoolB.id, { scope: schoolB.id, permissions: preset('school_admin'), preset: 'school_admin' });

  const me = await ok(api('GET', '/api/admin/me', { token: adminA.token }));
  assert.equal(me.owner, false);
  assert.equal(me.globalView, false);
  assert.deepEqual(me.schools.map((s) => s.id), [schoolA.id]);
});

test('a school admin cannot reach another school by id, header or body', async () => {
  const bUser = (await ok(api('GET', '/api/admin/users?search=bert.b', { school: schoolB.id }))).users[0];
  // Their own school's view does not contain it …
  await ok(api('GET', `/api/admin/users/${bUser.stableUid}`, { token: adminA.token, school: schoolA.id }), 404);
  await ok(api('DELETE', `/api/admin/users/${bUser.stableUid}`, { token: adminA.token, school: schoolA.id }), 404);
  await ok(api('PATCH', `/api/admin/users/${bUser.stableUid}/role`, { token: adminA.token, school: schoolA.id, body: { role: 'parent' } }), 404);
  await ok(api('PATCH', `/api/admin/users/${bUser.stableUid}/password`, { token: adminA.token, school: schoolA.id, body: { password: 'Hijacked-pass-1' } }), 404);
  // … naming the other school is refused, and so is the all-schools view.
  await ok(api('GET', '/api/admin/users', { token: adminA.token, school: schoolB.id }), 403);
  await ok(api('GET', '/api/admin/users', { token: adminA.token }), 403);
  await ok(api('GET', '/api/admin/analytics', { token: adminA.token, school: schoolB.id }), 403);
  // A new account always lands in the request's school, whatever the body says.
  const made = await ok(api('POST', '/api/admin/users', { token: adminA.token, school: schoolA.id, body: { username: 'smuggled', password: 'Long-enough-1', schoolId: schoolB.id } }), 201);
  assert.equal(made.schoolId, schoolA.id);
});

test('global administration is closed to school admins', async () => {
  for (const [method, url] of [
    ['GET', '/api/admin/cluster'], ['GET', '/api/admin/backups'], ['GET', '/api/admin/api-keys'],
    ['GET', '/api/admin/system-logs'], ['GET', '/api/admin/monitoring/performance'], ['GET', '/api/admin/schools'],
    ['GET', '/api/admin/school-years'], ['GET', '/api/admin/learn-config'], ['GET', '/api/admin/file-logs'],
    ['GET', '/api/admin/export'],
  ]) {
    const res = await api(method, url, { token: adminA.token, school: schoolA.id, body: method === 'POST' ? { name: 'X' } : undefined });
    assert.equal(res.status, 403, `${method} ${url}: ${res.status}`);
  }
});

test('a school admin can neither make a global admin nor elevate anyone beyond their own rights', async () => {
  await ok(api('PUT', '/api/admin/admins/viewer.a/grants/global', { token: adminA.token, school: schoolA.id, body: { permissions: ['users.view'] } }), 403);
  // Not in another school either, and not for that school's accounts.
  await ok(api('PUT', `/api/admin/admins/viewer.a/grants/${schoolB.id}`, { token: adminA.token, school: schoolA.id, body: { permissions: ['users.view'] } }), 403);
  await ok(api('PUT', `/api/admin/admins/admin.b/grants/${schoolA.id}`, { token: adminA.token, school: schoolA.id, body: { permissions: ['users.view'] } }), 403);
  // A global-only right in a school grant is refused as such.
  await ok(api('PUT', `/api/admin/admins/viewer.a/grants/${schoolA.id}`, { token: adminA.token, school: schoolA.id, body: { permissions: ['cluster.manage'] } }), 422);
  // Their own rights: never.
  await ok(api('PUT', `/api/admin/admins/admin.a/grants/${schoolA.id}`, { token: adminA.token, school: schoolA.id, body: { permissions: ['users.view'] } }), 403);
  // Creating an account with global rights through the user form: refused, nothing created.
  await ok(api('POST', '/api/admin/users', { token: adminA.token, school: schoolA.id, body: { username: 'wannabe', password: 'Long-enough-1', isAdmin: true, grant: { scope: 'global', permissions: ['users.view'] } } }), 403);
  const search = await ok(api('GET', '/api/admin/users?search=wannabe', { school: schoolA.id }));
  assert.equal(search.total, 0);
  // A grant made by a limited admin cannot carry what they lack.
  const limited = await ok(api('PUT', `/api/admin/admins/viewer.a/grants/${schoolA.id}`, { body: { permissions: ['admins.manage', 'users.view'] } }));
  assert.ok(limited.grant);
  // Not for an account without panel access …
  await ok(api('PUT', `/api/admin/admins/smuggled/grants/${schoolA.id}`, { token: viewerA.token, school: schoolA.id, body: { permissions: ['users.view'] } }), 404);
  const smuggled = (await ok(api('GET', '/api/admin/users?search=smuggled', { school: schoolA.id }))).users[0];
  await ok(api('POST', `/api/admin/users/${smuggled.stableUid}/grant-admin`, { body: {} }));
  // … and never beyond the granting admin's own rights.
  await ok(api('PUT', `/api/admin/admins/smuggled/grants/${schoolA.id}`, { token: viewerA.token, school: schoolA.id, body: { permissions: ['users.view', 'comments.view'] } }), 403);
  await ok(api('PUT', `/api/admin/admins/smuggled/grants/${schoolA.id}`, { token: viewerA.token, school: schoolA.id, body: { permissions: ['users.view'] } }));
  // Restore the viewer.
  await ok(api('PUT', `/api/admin/admins/viewer.a/grants/${schoolA.id}`, { body: { permissions: ['dashboard.view', 'users.view', 'comments.view', 'analytics.view'], preset: 'viewer' } }));
});

test('a viewer reads and cannot write', async () => {
  await ok(api('GET', '/api/admin/users', { token: viewerA.token, school: schoolA.id }));
  const anna = (await ok(api('GET', '/api/admin/users?search=anna.a', { token: viewerA.token, school: schoolA.id }))).users[0];
  await ok(api('PATCH', `/api/admin/users/${anna.stableUid}/role`, { token: viewerA.token, school: schoolA.id, body: { role: 'parent' } }), 403);
  await ok(api('DELETE', `/api/admin/users/${anna.stableUid}`, { token: viewerA.token, school: schoolA.id }), 403);
  await ok(api('POST', '/api/admin/users', { token: viewerA.token, school: schoolA.id, body: { username: 'nope', password: 'Long-enough-1' } }), 403);
});

test('a revoked right stops working with the next request', async () => {
  await ok(api('GET', '/api/admin/users', { token: viewerA.token, school: schoolA.id }));
  await ok(api('DELETE', `/api/admin/admins/viewer.a/grants/${schoolA.id}`), 204);
  await ok(api('GET', '/api/admin/users', { token: viewerA.token, school: schoolA.id }), 403);
  const me = await ok(api('GET', '/api/admin/me', { token: viewerA.token }));
  assert.equal(me.hasAnyPermission, false);
  // Revoking the admin standing itself ends the session's use entirely.
  await ok(api('DELETE', `/api/admin/users/${viewerA.stableUid}/revoke-admin`), 204);
  await ok(api('GET', '/api/admin/me', { token: viewerA.token }), 403);
});

test('a school admin cannot take over or remove a global admin', async () => {
  const global = await makeAdmin('global.x', schoolA.id, { scope: 'global', permissions: (await ok(api('GET', '/api/admin/access/catalog'))).permissions.map((p) => p.key) });
  await ok(api('PATCH', `/api/admin/users/${global.stableUid}/password`, { token: adminA.token, school: schoolA.id, body: { password: 'Takeover-pass-1' } }), 403);
  await ok(api('DELETE', `/api/admin/users/${global.stableUid}/revoke-admin`, { token: adminA.token, school: schoolA.id }), 403);
  await ok(api('DELETE', `/api/admin/users/${global.stableUid}`, { token: adminA.token, school: schoolA.id }), 403);
  // The global admin may work in every school and in the global view.
  await ok(api('GET', '/api/admin/users', { token: global.token }));
  await ok(api('GET', '/api/admin/users', { token: global.token, school: schoolB.id }));
});

test('user filters run over every page; totals and pages describe the filtered set', async () => {
  for (let i = 0; i < 45; i++) await appLogin(`filler.${String(i).padStart(2, '0')}`, { klasseId: 12, klasseName: '1B' });
  const admins = await ok(api('GET', '/api/admin/users?role=admin&limit=20&page=1', { school: schoolA.id }));
  // Every admin of the school on the first page (the viewer was revoked).
  assert.equal(admins.total, admins.users.length);
  assert.ok(admins.users.every((u) => u.isAdmin));
  assert.deepEqual(admins.users.map((u) => u.username).sort(), ['admin.a', 'global.x', 'smuggled']);

  const page1 = await ok(api('GET', '/api/admin/users?role=student&limit=20&page=1', { school: schoolA.id }));
  const page2 = await ok(api('GET', '/api/admin/users?role=student&limit=20&page=2', { school: schoolA.id }));
  const page3 = await ok(api('GET', '/api/admin/users?role=student&limit=20&page=3', { school: schoolA.id }));
  const all = [...page1.users, ...page2.users, ...page3.users].map((u) => u.stableUid);
  assert.equal(new Set(all).size, all.length, 'no account twice');
  assert.equal(all.length, page1.total, 'no account missing');
  assert.ok(page1.users.every((u) => u.role === 'student' && u.schoolId === schoolA.id));
  // A page past the end shows the last one.
  const beyond = await ok(api('GET', '/api/admin/users?role=student&limit=20&page=99', { school: schoolA.id }));
  assert.equal(beyond.page, page1.pages);
  // School B's view has its own accounts only.
  const inB = await ok(api('GET', '/api/admin/users?limit=100', { school: schoolB.id }));
  assert.ok(inB.users.every((u) => u.schoolId === schoolB.id));
});

test('requests are logged with their full path and kept apart from admin traffic', async () => {
  const anna = (await appLogin('anna.a')).json;
  for (let i = 0; i < 3; i++) await cluster.request(node, 'GET', '/users/me', { token: anna.token });
  for (let i = 0; i < 5; i++) await api('GET', '/api/admin/stats');
  await sleep(500);
  const paths = await node.db.$queryRawUnsafe("SELECT DISTINCT path, scope FROM request_logs WHERE path LIKE '/api/admin%' OR path = '/users/me'");
  assert.ok(paths.some((r) => r.path === '/api/admin/stats' && r.scope === 'admin'), JSON.stringify(paths));
  assert.ok(!paths.some((r) => r.path === '/stats'));
  const app = await ok(api('GET', '/api/admin/requests/summary?scope=app'));
  const everything = await ok(api('GET', '/api/admin/requests/summary?scope=all'));
  assert.ok(everything.totals.count > app.totals.count);
  assert.ok(!app.endpoints.some((e) => e.endpoint.startsWith('/api/admin')));
  // School admins see their school's app requests, never the panel's.
  const scoped = await ok(api('GET', '/api/admin/requests/summary?scope=app', { token: adminA.token, school: schoolA.id }));
  assert.ok(scoped.endpoints.some((e) => e.endpoint === '/users/me'));
  await ok(api('GET', '/api/admin/requests/summary?scope=admin', { token: adminA.token, school: schoolA.id }), 403);
  // Their request log view carries no addresses or user agents.
  const logs = await ok(api('GET', '/api/admin/logs?limit=20', { token: adminA.token, school: schoolA.id }));
  assert.ok(logs.logs.length > 0);
  assert.ok(logs.logs.every((l) => l.ip === null && l.userAgent === null && l.scope !== 'admin'));
});

test('menus are per school: no menu, no dishes; comments group by dish per menu and school', async () => {
  const menus = await ok(api('GET', '/api/admin/menus'));
  const today = new Date().toISOString().slice(0, 10);
  // School A has the default menu once it has dishes; create one.
  const dish = await ok(api('POST', '/api/admin/dishes', { school: schoolA.id, body: { nameDe: 'Knödel mit Speck', date: today, plan: 'summer' } }), 201);
  assert.ok(dish.id);
  const anna = (await appLogin('anna.a')).json;
  const bert = (await appLogin('bert.b', { school: 'fs-zweite' })).json;
  const key = dish.stableKey;

  // School B has no menu: no dishes, no comments.
  const bMenu = await cluster.request(node, 'GET', '/dishes', { token: bert.token, apiKey: false });
  assert.deepEqual(bMenu.json.menu.dishes, []);
  const refused = await cluster.request(node, 'POST', `/dish-comments/${key}`, { token: bert.token, body: { body: 'darf nicht' } });
  assert.equal(refused.status, 403);

  await ok(cluster.request(node, 'POST', `/dish-comments/${key}`, { token: anna.token, body: { body: 'Sehr gut!' } }), 201);
  await ok(cluster.request(node, 'POST', `/dish-ratings/${key}`, { token: anna.token, body: { stars: 5 } }));

  // Share the menu with school B: its accounts see and comment the same dish.
  const menuA = (await ok(api('GET', '/api/admin/me'))).schools.find((s) => s.id === schoolA.id).menuId;
  assert.ok(menuA, JSON.stringify(menus));
  await ok(api('PUT', `/api/admin/schools/${schoolB.id}/menu`, { body: { menuId: menuA } }));
  await sleep(100);
  const shared = await cluster.request(node, 'GET', '/dishes', { token: bert.token, apiKey: false });
  assert.ok(shared.json.menu.dishes.some((d) => d.id === key));
  await ok(cluster.request(node, 'POST', `/dish-comments/${key}`, { token: bert.token, body: { body: 'Aus Schule B' } }), 201);

  // Grouped by dish: A's admin counts A's comment only, the global view both.
  const groupedA = await ok(api('GET', '/api/admin/comments/dishes', { token: adminA.token, school: schoolA.id }));
  const rowA = groupedA.dishes.find((d) => d.dishId === key);
  assert.equal(rowA.comments, 1);
  assert.equal(rowA.name, 'Knödel mit Speck');
  assert.equal(rowA.avgStars, 5);
  const detailA = await ok(api('GET', `/api/admin/comments/dishes/${key}`, { token: adminA.token, school: schoolA.id }));
  assert.deepEqual(detailA.comments.map((c) => c.body), ['Sehr gut!']);
  assert.equal(detailA.comments[0].stars, 5);
  const groupedAll = await ok(api('GET', `/api/admin/comments/dishes?menuId=${menuA}`));
  assert.equal(groupedAll.dishes.find((d) => d.dishId === key).comments, 2);

  // B's admin cannot delete A's comment by id; A's admin can.
  const bComment = (await ok(api('GET', `/api/admin/comments/dishes/${key}`, { school: schoolB.id }))).comments[0];
  const aComment = detailA.comments[0];
  await ok(api('DELETE', `/api/admin/comments/dish/${aComment.id}`, { token: adminB.token, school: schoolB.id }), 404);
  await ok(api('DELETE', `/api/admin/comments/dish/${bComment.id}`, { token: adminA.token, school: schoolA.id }), 404);
  await ok(api('DELETE', `/api/admin/comments/dish/${aComment.id}`, { token: adminA.token, school: schoolA.id }), 204);

  // A Mensa manager of one school cannot change a menu another school shares.
  const catalog = await ok(api('GET', '/api/admin/access/catalog'));
  const mensaA = await makeAdmin('mensa.a', schoolA.id, { scope: schoolA.id, permissions: catalog.presets.find((p) => p.key === 'mensa_manager').permissions });
  await ok(api('POST', '/api/admin/dishes', { token: mensaA.token, school: schoolA.id, body: { nameDe: 'Strudel', date: today } }), 403);
  await ok(api('PUT', `/api/admin/schools/${schoolB.id}/menu`, { body: { menuId: null } }));
  await ok(api('POST', '/api/admin/dishes', { token: mensaA.token, school: schoolA.id, body: { nameDe: 'Strudel', date: today } }), 201);
  // … and imports from the internal network are refused for them.
  const internal = await api('POST', '/api/admin/dishes/import-url', { token: mensaA.token, school: schoolA.id, body: { url: 'http://127.0.0.1:3306/mensa.json' } });
  assert.equal(internal.status, 502);
  assert.match(internal.json.error, /intern/);
});

test('analytics, caches and dashboards never mix schools', async () => {
  const anna = (await appLogin('anna.a')).json;
  const bert = (await appLogin('bert.b', { school: 'fs-zweite' })).json;
  const ping = (token) => cluster.request(node, 'POST', '/usage/ping', {
    token, body: { sessionId: crypto.randomUUID(), client: 'browser', device: 'desktop', activeSeconds: 30, screens: 1 },
  });
  for (let i = 0; i < 3; i++) await ok(ping(anna.token), 204);
  await ok(ping(bert.token), 204);
  // Global first, so a cached global answer would be what a leak returns.
  const global = await ok(api('GET', '/api/admin/analytics?range=7&fresh=1'));
  const inA = await ok(api('GET', '/api/admin/analytics?range=7', { token: adminA.token, school: schoolA.id }));
  const inB = await ok(api('GET', '/api/admin/analytics?range=7', { token: adminB.token, school: schoolB.id }));
  assert.equal(global.time.sessions, 4);
  assert.equal(inA.time.sessions, 3);
  assert.equal(inB.time.sessions, 1);
  assert.ok(inA.accounts.total > inB.accounts.total);
  const statsB = await ok(api('GET', '/api/admin/stats', { token: adminB.token, school: schoolB.id }));
  assert.equal(statsB.totalUsers, inB.accounts.total);
  // Visitor addresses are the global view's only.
  await ok(api('GET', '/api/admin/analytics/visitors', { token: adminA.token, school: schoolA.id }), 403);
});

test('frontend error reports are scrubbed, school-scoped and separate from backend logs', async () => {
  const anna = (await appLogin('anna.a')).json;
  const secret = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4eHh4eHh4eCJ9.c2lnbmF0dXJlc2lnbmF0dXJl';
  await ok(cluster.request(node, 'POST', '/client-errors', {
    token: anna.token,
    body: { source: 'web', message: `Request failed: Bearer ${secret} for anna@example.org`, page: '/de/mensa?token=abc', stack: 'at load (https://pokyh.com/app.js?x=1:3:9)' },
  }), 204);
  await ok(cluster.request(node, 'POST', '/client-errors', { body: { source: 'admin', message: 'spoofed' } }), 400);
  const groupsA = await ok(api('GET', '/api/admin/client-errors', { token: adminA.token, school: schoolA.id }));
  assert.equal(groupsA.groups.length, 1);
  const report = groupsA.groups[0];
  assert.ok(!report.message.includes(secret) && !report.message.includes('anna@example.org'), report.message);
  assert.equal(report.page, '/de/mensa');
  const groupsB = await ok(api('GET', '/api/admin/client-errors', { token: adminB.token, school: schoolB.id }));
  assert.equal(groupsB.groups.length, 0);
  // Backend logs are the system operators'.
  await ok(api('GET', '/api/admin/system-logs', { token: adminA.token, school: schoolA.id }), 403);
  const system = await ok(api('GET', '/api/admin/system-logs?level=info&days=1'));
  assert.ok(Array.isArray(system.entries));
  // Nothing stored has an address or account.
  const [row] = await node.db.$queryRawUnsafe('SELECT * FROM client_error_logs LIMIT 1');
  assert.equal('ip' in row, false);
  assert.equal('stable_uid' in row, false);
});

test('the search finds only what an admin may see, in every school they reach', async () => {
  const catalog = await ok(api('GET', '/api/admin/access/catalog'));
  const preset = (key) => catalog.presets.find((p) => p.key === key).permissions;
  const searchA = await makeAdmin('search.a', schoolA.id, { scope: schoolA.id, permissions: preset('school_admin'), preset: 'school_admin' });
  const mensaOnly = await makeAdmin('mensaonly.a', schoolA.id, { scope: schoolA.id, permissions: ['mensa.view'] });
  const search = (q, { types, ...opts } = {}) => api('GET', `/api/admin/search?q=${encodeURIComponent(q)}${types ? `&types=${types}` : ''}`, opts);

  // The owner finds accounts of every school, each with its school.
  const bertAll = await ok(search('bert'));
  assert.ok(bertAll.results.users.items.some((u) => u.username === 'bert.b' && u.schoolId === schoolB.id && u.schoolName === 'Fachschule Zweite'));

  // A school admin of A never finds B's accounts — whatever view or header.
  for (const school of [schoolA.id, schoolB.id, undefined]) {
    const res = await ok(search('bert', { token: searchA.token, school }));
    assert.equal(res.results.users.total, 0);
    assert.deepEqual(res.results.users.items, []);
  }
  const anna = await ok(search('anna', { token: searchA.token, school: schoolA.id }));
  assert.ok(anna.results.users.items.some((u) => u.username === 'anna.a'));
  // Classes, comments and admins likewise.
  const classesA = await ok(search('1A', { token: searchA.token, types: 'classes' }));
  assert.ok(classesA.results.classes.items.length >= 1);
  assert.ok(classesA.results.classes.items.every((c) => c.schoolId === schoolA.id));
  assert.ok((await ok(search('1A', { types: 'classes' }))).results.classes.items.some((c) => c.schoolId === schoolB.id));
  assert.equal((await ok(search('Schule B', { token: searchA.token, types: 'comments' }))).results.comments.total, 0);
  assert.ok((await ok(search('Schule B', { types: 'comments' }))).results.comments.items.some((c) => c.schoolId === schoolB.id && c.context === 'Knödel mit Speck'));
  assert.equal((await ok(search('admin.b', { token: searchA.token, types: 'admins' }))).results.admins.total, 0);
  assert.ok((await ok(search('admin.b', { types: 'admins' }))).results.admins.items.some((a) => a.username === 'admin.b'));

  // A kind without the right is left out entirely — not even a count.
  const mensa = await ok(search('anna', { token: mensaOnly.token, school: schoolA.id }));
  assert.deepEqual(Object.keys(mensa.results), ['dishes']);
  assert.ok((await ok(search('Knödel', { token: mensaOnly.token }))).results.dishes.items.some((d) => d.name === 'Knödel mit Speck'));

  // LIKE wildcards are matched literally: '%' and '_' find nothing here.
  for (const q of ['%%', '__', '%_']) {
    const res = await ok(search(q));
    assert.equal(res.results.users.total, 0, q);
    assert.equal(res.results.classes.total, 0, q);
  }
  // The admin user list escapes them too.
  assert.equal((await ok(api('GET', '/api/admin/users?search=%25'))).total, 0);

  // Input bounds, and never without a session.
  assert.equal((await search('a')).status, 422);
  assert.equal((await search('x'.repeat(65))).status, 422);
  assert.equal((await api('GET', '/api/admin/search?q=ab&q=cd')).status, 422);
  assert.equal((await api('GET', '/api/admin/search?q=anna', { token: null })).status, 401);

  // No network details or secrets in a result.
  const text = JSON.stringify(await ok(search('.a')));
  for (const needle of ['"ip"', 'userAgent', 'passwordHash', 'Very-long-pass-1', 'refreshToken']) assert.ok(!text.includes(needle), needle);
  // The terms are not stored: the request log keeps the path only.
  const logged = await node.db.$queryRawUnsafe("SELECT path FROM request_logs WHERE path LIKE '/api/admin/search%'");
  assert.ok(logged.length > 0);
  assert.ok(logged.every((row) => row.path === '/api/admin/search'));
});

test('a plan is given to its schools in one step; schools switch plans and can be left without one', async () => {
  const { menus } = await ok(api('GET', '/api/admin/menus'));
  const main = menus.find((m) => m.isDefault);
  const created = (await ok(api('POST', '/api/admin/menus', { body: { name: 'Plan Zwei' } }), 201)).menu;
  const schoolsNow = async () => Object.fromEntries((await ok(api('GET', '/api/admin/schools'))).schools.map((s) => [s.id, s.menu?.id ?? null]));

  // A school without a plan gets it; one with another plan switches.
  const first = await ok(api('PUT', `/api/admin/menus/${created.id}/schools`, { body: { schoolIds: [schoolB.id] } }));
  assert.deepEqual(first.added, [schoolB.id]);
  assert.deepEqual(first.removed, []);
  const both = await ok(api('PUT', `/api/admin/menus/${created.id}/schools`, { body: { schoolIds: [schoolA.id, schoolB.id, schoolA.id] } }));
  assert.deepEqual(both.added, [schoolA.id]);
  assert.deepEqual(both.moved, [schoolA.id]);
  let state = await schoolsNow();
  assert.equal(state[schoolA.id], created.id);
  assert.equal(state[schoolB.id], created.id);
  // The apps follow at once: A now shows the new, still empty plan.
  const anna = (await appLogin('anna.a')).json;
  const shown = await cluster.request(node, 'GET', '/dishes', { token: anna.token, apiKey: false });
  assert.equal(shown.json.available, true);
  assert.deepEqual(shown.json.menu.dishes, []);

  // An empty list leaves both without a plan — their apps show no Mensa.
  const none = await ok(api('PUT', `/api/admin/menus/${created.id}/schools`, { body: { schoolIds: [] } }));
  assert.deepEqual(none.removed.sort(), [schoolA.id, schoolB.id].sort());
  state = await schoolsNow();
  assert.equal(state[schoolA.id], null);
  assert.equal((await cluster.request(node, 'GET', '/dishes', { token: anna.token, apiKey: false })).json.available, false);
  // Each change is in the audit trail with the plan the school had before.
  const events = (await ok(api('GET', '/api/admin/audit-events?limit=50'))).events.filter((e) => e.action === 'school.menu' && e.schoolId === schoolA.id);
  assert.ok(events.some((e) => JSON.stringify(e.detail ?? '').includes(main.id)));

  // Only who manages schools; only known schools; nothing else in the body.
  const catalog = await ok(api('GET', '/api/admin/access/catalog'));
  const planA = await makeAdmin('plan.a', schoolA.id, { scope: schoolA.id, permissions: catalog.presets.find((p) => p.key === 'school_admin').permissions });
  await ok(api('PUT', `/api/admin/menus/${created.id}/schools`, { token: planA.token, school: schoolA.id, body: { schoolIds: [schoolA.id] } }), 403);
  await ok(api('PUT', `/api/admin/menus/${created.id}/schools`, { body: { schoolIds: ['00000000-0000-0000-0000-000000000000'] } }), 422);
  await ok(api('PUT', `/api/admin/menus/${created.id}/schools`, { body: { schoolIds: schoolA.id } }), 422);
  await ok(api('PUT', `/api/admin/menus/${created.id}/schools`, { body: { schoolIds: [], menuId: 'x' } }), 422);
  await ok(api('PUT', '/api/admin/menus/00000000-0000-0000-0000-000000000000/schools', { body: { schoolIds: [] } }), 404);

  // Back as before for the tests that follow.
  await ok(api('PUT', `/api/admin/menus/${main.id}/schools`, { body: { schoolIds: [schoolA.id] } }));
  assert.equal((await schoolsNow())[schoolA.id], main.id);
});

test('every sensitive change is in the audit trail, scoped per school', async () => {
  const all = await ok(api('GET', '/api/admin/audit-events?limit=200'));
  const actions = new Set(all.events.map((e) => e.action));
  for (const action of ['school.join', 'school.update', 'user.create', 'admin.appoint', 'admin.grant.set', 'admin.grant.remove', 'admin.revoke', 'comment.delete', 'school.menu']) {
    assert.ok(actions.has(action), `missing ${action}`);
  }
  const inB = await ok(api('GET', '/api/admin/audit-events?limit=200', { token: adminB.token, school: schoolB.id }));
  assert.ok(inB.events.every((e) => e.schoolId === schoolB.id));
  // The audit trail holds no passwords.
  assert.ok(!JSON.stringify(all).includes('Very-long-pass-1'));
});

test('existing admins become global admins once, and never again after a change', async () => {
  // Simulate an installation from before permissions: an admin account
  // without grants, no migration marker, no grants at all.
  const legacy = await appLogin('legacy.admin');
  const uid = legacy.json.user.stableUid;
  await node.db.$executeRawUnsafe(`INSERT INTO admins (stable_uid, can_create_class, created_at) VALUES ('${uid}', 1, NOW())`);
  await node.db.$executeRawUnsafe('DELETE FROM admin_grants');
  await node.db.$executeRawUnsafe("DELETE FROM app_migrations WHERE id = 'admin-grants-v1'");
  await cluster.stop(node);
  await cluster.start(node);
  const legacyToken = tokenFor('legacy.admin');
  await waitFor(async () => (await api('GET', '/api/admin/me', { token: legacyToken })).json?.globalView === true, { timeoutMs: 60_000, label: 'the legacy admin to become a global admin' });
  // Reduce them; a restart must not bring the global grant back.
  await ok(api('DELETE', '/api/admin/admins/legacy.admin/grants/global'), 204);
  await cluster.stop(node);
  await cluster.start(node);
  await sleep(3_000);
  const me = await ok(api('GET', '/api/admin/me', { token: legacyToken }));
  assert.equal(me.globalView, false);
  assert.equal(me.hasAnyPermission, false);
});

test('a second factor can be required per admin: until one is set up, only that step opens', async () => {
  const totp = require(path.join(REPO, 'dist', 'security', 'totp.js'));
  const catalog = await ok(api('GET', '/api/admin/access/catalog'));
  const viewer = catalog.presets.find((p) => p.key === 'viewer').permissions;
  const anna = await makeAdmin('twofa.anna', schoolA.id, { scope: schoolA.id, permissions: viewer, preset: 'viewer' });
  const asAnna = (method, pathname, opts = {}) => api(method, pathname, { token: anna.token, school: schoolA.id, ...opts });
  await ok(asAnna('GET', '/api/admin/users'));

  // Switched on by the owner: everything but the set-up is closed.
  const on = await ok(api('PUT', '/api/admin/admins/twofa.anna/second-factor', { body: { required: true } }));
  assert.deepEqual(on, { required: true, source: 'account', setupPending: true });
  const blocked = await asAnna('GET', '/api/admin/users');
  assert.equal(blocked.status, 403, blocked.text);
  assert.equal(blocked.json.code, 'second_factor_setup_required');
  assert.equal((await ok(asAnna('GET', '/api/admin/me'))).secondFactorSetupRequired, true);
  assert.equal((await ok(asAnna('GET', '/api/admin/account/security'))).secondFactor.setupPending, true);

  // The password login says so right away.
  const login = await cluster.request(node, 'POST', '/api/admin/auth/login', { body: { username: 'twofa.anna', password: 'Very-long-pass-1' }, apiKey: false });
  assert.equal(login.status, 200, login.text);
  assert.equal(login.json.secondFactorSetupRequired, true);

  // Setting up the authenticator app opens the panel.
  const setup = await ok(asAnna('POST', '/api/admin/account/totp/setup'));
  const { recoveryCodes } = await ok(asAnna('POST', '/api/admin/account/totp/enable', { body: { code: totp.totpCode(setup.secret, totp.totpStep(Date.now())) } }));
  await ok(asAnna('GET', '/api/admin/users'));
  assert.equal((await ok(asAnna('GET', '/api/admin/me'))).secondFactorSetupRequired, false);

  // Required: the last factor stays, and only another admin lowers the requirement.
  await ok(asAnna('POST', '/api/admin/account/totp/disable', { body: { code: recoveryCodes[0] } }), 422);
  await ok(asAnna('PUT', '/api/admin/admins/twofa.anna/second-factor', { body: { required: false } }), 403);
  await ok(asAnna('PUT', '/api/admin/admins/twofa.anna/second-factor', { body: { required: true } }));
  await ok(api('PUT', `/api/admin/admins/${'clusteradmin'}/second-factor`, { body: { required: false } }), 403);
  const off = await ok(api('PUT', '/api/admin/admins/twofa.anna/second-factor', { body: { required: false } }));
  assert.deepEqual(off, { required: false, source: 'account', setupPending: false });
  await ok(asAnna('POST', '/api/admin/account/totp/disable', { body: { code: recoveryCodes[0] } }), 204);

  // The lists show it all, with the last panel login.
  await ok(cluster.request(node, 'POST', '/api/admin/auth/login', { body: { username: 'twofa.anna', password: 'Very-long-pass-1' }, apiKey: false }));
  const row = (await ok(api('GET', '/api/admin/admins'))).admins.find((a) => a.username === 'twofa.anna');
  assert.equal(row.security.required, false);
  assert.equal(row.security.totp, false);
  assert.equal(row.security.passkeys, 0);
  assert.ok(row.security.lastLoginAt, 'last panel login is shown');
  assert.equal(row.security.lastLoginMethod, 'password');
  const user = (await ok(api('GET', '/api/admin/users?role=admin&limit=100'))).users.find((u) => u.username === 'twofa.anna');
  assert.equal(user.adminSecurity.required, false);
  assert.ok('lastSignInAt' in user);
  const audit = await ok(api('GET', '/api/admin/audit-events?action=admin.second_factor.requirement'));
  assert.ok(audit.events.some((e) => e.targetId === 'twofa.anna'), 'the change is in the audit trail');
});

test('the server log has no unexpected errors', () => {
  const log = cluster.logText(node);
  const errors = log.split('\n').filter((line) => line.includes('"level":"error"') && !line.includes('HTTP 5xx'));
  assert.deepEqual(errors, []);
});
