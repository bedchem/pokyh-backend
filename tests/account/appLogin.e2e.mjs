import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Cluster, REPO, waitFor } from '../cluster/harness.mjs';

// The apps' sign-in (POST /auth/login) and the class every account gets, end
// to end: a real backend process and MySQL, WebUntis played by the harness's
// stand-in (tests/helpers/fakeWebUntis.mjs). Run with `npm run test:account`
// (builds first).
//
// The app key ships in every app; who signs in is proven by the WebUntis
// session alone, and a class only ever comes from the pupil's own records.

const require = createRequire(import.meta.url);
const bcrypt = require(path.join(REPO, 'node_modules', 'bcrypt'));

const cluster = new Cluster();
const untis = cluster.webuntis;
let node;

const login = (username, options = {}) => cluster.appLogin(node, username, options);
const userRow = (username) => node.db.user.findUnique({ where: { username } });
const asApp = (body) => cluster.request(node, 'POST', '/auth/login', { body, headers: { 'x-server-key': node.serverKey } });

before(async () => {
  await cluster.startMysql();
  node = await cluster.addNode('applogin', {
    ADMIN_USERNAMES: 'clusteradmin',
    WEBUNTIS_SCHOOL: 'lbs-brixen',
    // Lifted for the other suites; here the account budget is what is tested.
    RATE_LIMIT_APP_LOGIN_PER_ACCOUNT_MAX: '8',
  });
  await cluster.start(node, { waitForCluster: false });
}, { timeout: 400_000 });

after(async () => {
  await cluster.teardown();
}, { timeout: 120_000 });

// ── Who signs in ────────────────────────────────────────────────────────────

test('the app key alone signs nobody in: without a WebUntis session nothing is created', async () => {
  const res = await asApp({ username: 'victim.one' });
  assert.equal(res.status, 400, res.text);
  assert.equal(res.json.code, 'untis_session_required');
  // The class the app claims was never a way in either.
  assert.equal((await asApp({ username: 'victim.one', klasseId: 4711, klasseName: '4A' })).status, 400);
  assert.equal(await userRow('victim.one'), null);
});

test('another account\'s session cannot sign in as this account', async () => {
  untis.account('eva.e', { klasseId: 4711, pageConfig: true });
  const evasSession = untis.session('eva.e');
  const res = await asApp({ username: 'victim.two', untisSessionId: evasSession });
  assert.equal(res.status, 403, res.text);
  assert.equal(res.json.code, 'account_mismatch');
  assert.equal(await userRow('victim.two'), null);
});

test('a session WebUntis names nobody for, or an ended one, is refused', async () => {
  untis.account('nobody.n', { appLoginName: null, tokenName: null });
  const unnamed = await asApp({ username: 'nobody.n', untisSessionId: untis.session('nobody.n') });
  assert.equal(unnamed.status, 401, unnamed.text);
  assert.equal(unnamed.json.code, 'untis_identity_unverified');

  untis.account('ended.e');
  const session = untis.session('ended.e');
  untis.endSession(session);
  const ended = await asApp({ username: 'ended.e', untisSessionId: session });
  assert.equal(ended.status, 401, ended.text);
  assert.equal(ended.json.code, 'untis_session_invalid');
  assert.equal(await userRow('nobody.n'), null);
  assert.equal(await userRow('ended.e'), null);
});

test('with WebUntis away nothing is created, not even a new school', async () => {
  untis.account('down.d');
  const session = untis.session('down.d');
  untis.down = true;
  try {
    const res = await asApp({ username: 'down.d', untisSessionId: session, school: 'neue-schule', schoolServer: 'neu.webuntis.com' });
    assert.equal(res.status, 503, res.text);
    assert.equal(res.json.code, 'webuntis_unavailable');
  } finally {
    untis.down = false;
  }
  assert.equal(await userRow('down.d'), null);
  assert.equal(await node.db.school.findFirst({ where: { webuntisSchool: 'neue-schule' } }), null);
});

test('once the school\'s tenant is known, a session of another tenant cannot take a same-named account', async () => {
  const school = await node.db.school.findFirst({ where: { webuntisSchool: 'lbs-brixen' } });
  await node.db.school.update({ where: { id: school.id }, data: { webuntisTenantId: '1000100' } });
  try {
    // Lists are kept for half a minute (services/schools.ts): wait for the
    // new tenant, a new account each time (the account budget is small here).
    let res;
    for (let i = 0; i < 40; i++) {
      untis.account(`tenant.t${i}`, { tenantId: '9999900' });
      res = await asApp({ username: `tenant.t${i}`, untisSessionId: untis.session(`tenant.t${i}`) });
      if (res.status !== 200) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.equal(res.status, 403, res.text);
    assert.equal(res.json.code, 'tenant_mismatch');
  } finally {
    await node.db.school.update({ where: { id: school.id }, data: { webuntisTenantId: null } });
  }
});

test('the app key skips no limit: an account\'s sign-ins are counted', async () => {
  untis.account('busy.b');
  let last;
  for (let i = 0; i < 9; i++) last = await login('busy.b');
  assert.equal(last.status, 429, last.text);
});

// ── The class ───────────────────────────────────────────────────────────────

const classOf = async (username) => {
  const user = await userRow(username);
  const member = await node.db.classMember.findFirst({ where: { stableUid: user.stableUid }, include: { class: true } });
  return { user, klasseId: member?.class.webuntisKlasseId ?? 0 };
};

test('a pupil gets their class from WebUntis\' own records, each source named', async () => {
  // The timetable set-up names it.
  const anna = await login('anna.k', { klasseId: 4711 });
  assert.equal(anna.status, 200, anna.text);
  assert.ok(anna.json.user.classId);
  let c = await classOf('anna.k');
  assert.equal(c.klasseId, 4711);
  assert.equal(c.user.classSource, 'pageconfig');
  assert.equal(c.user.classCheckVersion, 2);

  // Only the weekly timetable tells: the class in most of the lessons, by id.
  untis.account('ben.k', { klasseId: 0, lessons: [[4712], [4712, 4711], [4712]] });
  assert.equal((await login('ben.k')).status, 200);
  c = await classOf('ben.k');
  assert.equal(c.klasseId, 4712);
  assert.equal(c.user.classSource, 'weekly-data');

  // Only the timetable picker, offering the pupil one class.
  untis.account('cleo.k', { pickerClasses: [4711] });
  assert.equal((await login('cleo.k')).status, 200);
  c = await classOf('cleo.k');
  assert.equal(c.klasseId, 4711);
  assert.equal(c.user.classSource, 'filter-single');

  // Nothing tells: no class, and why.
  untis.account('dora.k');
  const dora = await login('dora.k');
  assert.equal(dora.status, 200);
  assert.equal(dora.json.user.classId, null);
  c = await classOf('dora.k');
  assert.equal(c.klasseId, 0);
  assert.equal(c.user.classNote, 'no_class_found');
  const me = await cluster.request(node, 'GET', '/auth/me', { token: dora.json.token });
  assert.equal(me.json.classNote, 'no_class_found');
  assert.equal(me.json.classCheckPending, false);
});

test('guardians never land in a class: their own account, or a login tagged on the child\'s record', async () => {
  untis.account('mama.own', { kind: 'parent', children: [555] });
  const own = await login('mama.own');
  assert.equal(own.status, 200, own.text);
  assert.equal(own.json.user.role, 'parent');
  assert.equal(own.json.user.classId, null);

  untis.account('papa.tag', { kind: 'parent-on-record', personId: 556, klasseId: 4711, pageConfig: true });
  const tagged = await login('papa.tag');
  assert.equal(tagged.json.user.role, 'parent');
  assert.equal((await classOf('papa.tag')).klasseId, 0);
});

test('an admin\'s "parent" sticks, even when WebUntis calls the account a pupil', async () => {
  untis.account('oma.k', { klasseId: 4711, pageConfig: true, personId: 600 });
  const first = await login('oma.k');
  assert.equal((await classOf('oma.k')).klasseId, 4711);
  const set = await cluster.admin(node, 'PATCH', `/users/${first.json.user.stableUid}/role`, { role: 'parent' });
  assert.equal(set.status, 200, set.text);
  assert.equal(set.json.roleLocked, true);

  const again = await login('oma.k');
  assert.equal(again.json.user.role, 'parent');
  let c = await classOf('oma.k');
  assert.equal(c.klasseId, 0);
  assert.equal(c.user.roleLocked, true);

  // Handed back to WebUntis, a parent still never becomes a pupil by itself.
  assert.equal((await cluster.admin(node, 'PATCH', `/users/${first.json.user.stableUid}/role`, { role: 'auto' })).status, 200);
  const third = await login('oma.k');
  assert.equal(third.json.user.role, 'parent');
  c = await classOf('oma.k');
  assert.equal(c.klasseId, 0);
  assert.equal(c.user.classNote, 'student_record_on_parent');
});

test('two accounts on one pupil\'s record: the older keeps the class, the newer waits for an admin', async () => {
  untis.account('kid.k', { personId: 777, klasseId: 4711, pageConfig: true });
  untis.account('kid.eltern', { personId: 777, klasseId: 4711, pageConfig: true });
  assert.equal((await login('kid.k')).status, 200);
  const second = await login('kid.eltern');
  assert.equal(second.status, 200);
  assert.equal(second.json.user.classId, null);
  assert.equal((await classOf('kid.eltern')).user.classNote, 'shared_person');
  assert.equal((await classOf('kid.k')).klasseId, 4711);
  // Signing in again changes nothing about the older one.
  await login('kid.k');
  assert.equal((await classOf('kid.k')).klasseId, 4711);

  // The admin says which is the parent: the pupil's record is the pupil's again.
  assert.equal((await cluster.admin(node, 'PATCH', `/users/${second.json.user.stableUid}/role`, { role: 'parent' })).status, 200);
  assert.equal((await classOf('kid.eltern')).klasseId, 0);
  assert.equal((await classOf('kid.k')).klasseId, 4711);
});

test('the data export says where the class came from', async () => {
  const anna = await login('anna.k');
  const exported = await cluster.request(node, 'GET', '/users/me/export', { token: anna.json.token });
  assert.equal(exported.status, 200, exported.text);
  assert.equal(exported.json.account.classSource, 'pageconfig');
  assert.ok(exported.json.account.classCheckedAt);
  assert.equal(typeof exported.json.account.roleSetByAdmin, 'boolean');
});

// ── Self-made accounts ──────────────────────────────────────────────────────

test('nobody registers a POKYH-only account themselves', async () => {
  for (const route of ['/auth/register', '/auth/web/register']) {
    const res = await cluster.request(node, 'POST', route, { body: { username: 'squat.new', password: 'Lange-Passwort-1' } });
    assert.equal(res.status, 403, res.text);
    assert.equal(res.json.code, 'registration_disabled');
  }
  assert.equal(await userRow('squat.new'), null);
});

test('a name taken by a self-made account belongs to the WebUntis account: the squatter is out', async () => {
  // As /auth/register made such accounts before it was switched off.
  const school = await node.db.school.findFirst({ where: { webuntisSchool: 'lbs-brixen' } });
  await node.db.user.create({
    data: {
      stableUid: 'squatter-uid-0001', username: 'max.squat', isUntisUser: false, localOrigin: 'register',
      passwordHash: await bcrypt.hash('Squatter-Pass-1', 4), schoolId: school.id,
    },
  });
  const squat = await cluster.request(node, 'POST', '/auth/login', { body: { username: 'max.squat', password: 'Squatter-Pass-1' } });
  assert.equal(squat.status, 200, squat.text);

  untis.account('max.squat', { klasseId: 4711, pageConfig: true });
  const real = await login('max.squat');
  assert.equal(real.status, 200, real.text);
  assert.equal(real.json.user.stableUid, 'squatter-uid-0001');

  // The squatter's password, refresh token and access token are all dead.
  assert.equal((await cluster.request(node, 'POST', '/auth/login', { body: { username: 'max.squat', password: 'Squatter-Pass-1' } })).status, 401);
  assert.equal((await cluster.request(node, 'POST', '/auth/refresh', { body: { refreshToken: squat.json.refreshToken } })).status, 401);
  assert.equal((await cluster.request(node, 'GET', '/auth/me', { token: squat.json.token })).status, 401);
  // The pupil is in, with their class.
  assert.equal((await cluster.request(node, 'GET', '/auth/me', { token: real.json.token })).status, 200);
  assert.equal((await classOf('max.squat')).klasseId, 4711);
  const events = (await cluster.admin(node, 'GET', '/audit-events?limit=50')).json.events;
  assert.ok(events.some((e) => e.action === 'user.local_takeover'));
});

// Schools many share a WebUntis host with; their tenant is known from their
// first verified sign-in on.
const SECOND = { school: 'tenant-schule', schoolServer: 'tenant.webuntis.com', schoolName: 'Tenant-Schule' };
const THIRD = { school: 'dritte-schule', schoolServer: 'dritte.webuntis.com', schoolName: 'Dritte Schule' };
const schoolRow = (loginName) => node.db.school.findFirst({ where: { webuntisSchool: loginName } });

test('a school and its accounts keep the WebUntis tenant of their first sign-in', async () => {
  untis.account('bound.b', { klasseId: 4711, pageConfig: true, tenantId: '2000200' });
  const first = await asApp({ username: 'bound.b', untisSessionId: untis.session('bound.b'), ...SECOND });
  assert.equal(first.status, 200, first.text);
  assert.equal((await userRow('bound.b')).webuntisTenantId, '2000200');
  assert.equal((await schoolRow('tenant-schule')).webuntisTenantId, '2000200');

  // The same login name in another school's tenant on the same host.
  untis.account('bound.b', { klasseId: 4711, pageConfig: true, tenantId: '3000300' });
  const foreign = await asApp({ username: 'bound.b', untisSessionId: untis.session('bound.b'), ...SECOND });
  assert.equal(foreign.status, 403, foreign.text);
  assert.equal(foreign.json.code, 'tenant_mismatch');
  // Nor a new account of that tenant (its class ids are another school's).
  untis.account('neu.fremd', { klasseId: 4711, pageConfig: true, tenantId: '3000300' });
  assert.equal((await asApp({ username: 'neu.fremd', untisSessionId: untis.session('neu.fremd'), ...SECOND })).status, 403);
  assert.equal(await userRow('neu.fremd'), null);
  assert.equal((await schoolRow('tenant-schule')).webuntisTenantId, '2000200');
  assert.equal((await userRow('bound.b')).webuntisTenantId, '2000200');

  // The pupil's own sessions go on working.
  untis.account('bound.b', { klasseId: 4711, pageConfig: true, tenantId: '2000200' });
  assert.equal((await asApp({ username: 'bound.b', untisSessionId: untis.session('bound.b'), ...SECOND })).status, 200);
});

test('a self-made account is taken over only by its own school\'s WebUntis account', async () => {
  const school = await schoolRow('lbs-brixen');
  await node.db.user.create({
    data: {
      stableUid: 'selfmade-uid-0002', username: 'mia.self', isUntisUser: false, localOrigin: 'register',
      passwordHash: await bcrypt.hash('Selfmade-Pass-1', 4), schoolId: school.id,
    },
  });
  untis.account('mia.self', { klasseId: 4711, pageConfig: true, tenantId: '2000200' });
  const elsewhere = await asApp({ username: 'mia.self', untisSessionId: untis.session('mia.self'), ...SECOND });
  assert.equal(elsewhere.status, 409, elsewhere.text);
  const row = await userRow('mia.self');
  assert.equal(row.isUntisUser, false);
  assert.ok(row.passwordHash, 'the account and its password stay');
  assert.equal(row.schoolId, school.id);
  assert.equal((await cluster.request(node, 'POST', '/auth/login', { body: { username: 'mia.self', password: 'Selfmade-Pass-1' } })).status, 200);
});

test('a sign-in POKYH makes with the password corrects the tenant an app recorded first, and ends that tenant\'s accounts', async () => {
  // Sessions of another school on the same host were first, two accounts.
  untis.account('rebind.r', { klasseId: 4711, pageConfig: true, tenantId: '3000300' });
  untis.account('fremd.f', { klasseId: 4711, pageConfig: true, tenantId: '3000300' });
  const first = await asApp({ username: 'rebind.r', untisSessionId: untis.session('rebind.r'), ...THIRD });
  assert.equal(first.status, 200, first.text);
  const stranger = await asApp({ username: 'fremd.f', untisSessionId: untis.session('fremd.f'), ...THIRD });
  assert.equal(stranger.status, 200, stranger.text);
  assert.equal((await schoolRow('dritte-schule')).webuntisTenantId, '3000300');
  assert.ok((await node.db.classMember.count({ where: { stableUid: stranger.json.user.stableUid } })) > 0);

  // The pupil signs in on the website with the password: the school's own word.
  untis.account('rebind.r', { klasseId: 4711, tenantId: '2000200', password: 'Rebind-Passwort-1' });
  const web = await cluster.request(node, 'POST', '/webuntis/login', {
    body: { username: 'rebind.r', password: 'Rebind-Passwort-1', school: { loginName: THIRD.school, server: THIRD.schoolServer, name: THIRD.schoolName } },
  });
  assert.equal(web.status, 200, web.text);
  assert.equal((await schoolRow('dritte-schule')).webuntisTenantId, '2000200');
  assert.equal((await userRow('rebind.r')).webuntisTenantId, '2000200');

  // The other tenant's sessions are over, its account has no class, and its
  // sessions sign in no more.
  for (const s of [first, stranger]) {
    assert.equal((await cluster.request(node, 'GET', '/auth/me', { token: s.json.token })).status, 401);
    assert.equal((await cluster.request(node, 'POST', '/auth/refresh', { body: { refreshToken: s.json.refreshToken } })).status, 401);
  }
  assert.equal((await node.db.classMember.count({ where: { stableUid: stranger.json.user.stableUid } })), 0);
  assert.equal((await userRow('fremd.f')).webuntisKlasseId, 0);
  untis.account('fremd.f', { klasseId: 4711, pageConfig: true, tenantId: '3000300' });
  const again = await asApp({ username: 'fremd.f', untisSessionId: untis.session('fremd.f'), ...THIRD });
  assert.equal(again.status, 403, again.text);
  assert.equal(again.json.code, 'tenant_mismatch');
  const events = (await cluster.admin(node, 'GET', '/audit-events?limit=100')).json.events;
  assert.ok(events.some((e) => e.action === 'school.tenant_replaced'));
  assert.ok(events.some((e) => e.action === 'user.tenant_rebound'));
});

test('an account an admin made with a password keeps it', async () => {
  const made = await cluster.admin(node, 'POST', '/users', { username: 'lehrer.local', password: 'Admin-Made-Pass-1', role: 'none' });
  assert.equal(made.status, 201, made.text);
  untis.account('lehrer.local', { kind: 'teacher' });
  assert.equal((await login('lehrer.local')).status, 200);
  assert.equal((await cluster.request(node, 'POST', '/auth/login', { body: { username: 'lehrer.local', password: 'Admin-Made-Pass-1' } })).status, 200);
  assert.equal((await userRow('lehrer.local')).role, 'none');
});

// ── The website signs in by itself ──────────────────────────────────────────

test('a website sign-in with the password learns the school\'s tenant and the pupil\'s class', async () => {
  untis.account('web.anna', { klasseId: 4712, password: 'Web-Passwort-1' });
  const res = await cluster.request(node, 'POST', '/webuntis/login', { body: { username: 'web.anna', password: 'Web-Passwort-1' } });
  assert.equal(res.status, 200, res.text);
  const c = await classOf('web.anna');
  assert.equal(c.klasseId, 4712);
  assert.equal(c.user.classSource, 'authenticate');
  let tenant = null;
  for (let i = 0; i < 20 && !tenant; i++) {
    tenant = (await node.db.school.findFirst({ where: { webuntisSchool: 'lbs-brixen' } })).webuntisTenantId;
    if (!tenant) await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(tenant, '1000100');
  await node.db.school.updateMany({ data: { webuntisTenantId: null } });
});

// ── The one-time jobs at start-up ───────────────────────────────────────────

test('at start-up an admin\'s old "parent" that a sign-in had undone comes back, once', async () => {
  const school = await node.db.school.findFirst({ where: { webuntisSchool: 'lbs-brixen' } });
  const victim = await node.db.user.create({
    data: { stableUid: 'restore-uid-0001', username: 'restore.me', role: 'student', webuntisKlasseId: 4711, webuntisKlasseName: '4A', classCheckVersion: 2, schoolId: school.id },
  });
  await node.db.adminAuditEvent.create({
    data: { actor: 'clusteradmin', action: 'user.role', targetType: 'user', targetId: victim.stableUid, detail: JSON.stringify({ from: 'student', to: 'parent' }) },
  });
  await node.db.appMigration.delete({ where: { id: 'role-lock-v1' } });
  await cluster.stop(node);
  await cluster.start(node, { waitForCluster: false });
  // The one-time jobs run once the node takes over (after it answers).
  await waitFor(async () => (await node.db.appMigration.findUnique({ where: { id: 'role-lock-v1' } })) !== null, { timeoutMs: 60_000, label: 'the role lock job' });

  const restored = await userRow('restore.me');
  assert.equal(restored.role, 'parent');
  assert.equal(restored.roleLocked, true);
  assert.equal(restored.webuntisKlasseId, 0);
  assert.ok(await node.db.appMigration.findUnique({ where: { id: 'role-lock-v1' } }));
  assert.ok(await node.db.appMigration.findUnique({ where: { id: 'class-check-v2' } }));

  // A second start changes nothing a sign-in confirmed meanwhile.
  const before = await classOf('anna.k');
  await cluster.stop(node);
  await cluster.start(node, { waitForCluster: false });
  assert.equal((await classOf('anna.k')).klasseId, before.klasseId);
});
