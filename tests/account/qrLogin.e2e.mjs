import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Cluster } from '../cluster/harness.mjs';

// Signing the website in with the POKYH app's QR code (services/qrLogin.ts),
// end to end: a real backend process and MySQL, WebUntis played by the
// harness's stand-in (tests/helpers/fakeWebUntis.mjs). Run with
// `npm run test:account` (builds first).
//
// The website asks for a code (POST /webuntis/qr/start) and keeps asking
// (POST /webuntis/qr/poll); the app approves it (POST /auth/qr/:code/approve)
// the way the iOS app does: usually with nothing but its WebUntis session and
// its school, as its saved password sits behind Face ID.

const cluster = new Cluster();
const untis = cluster.webuntis;
let node;

// The school as the iOS app hands it over: login name and server, no name.
const SCHOOL = { loginName: 'lbs-brixen', server: 'lbs-brixen.webuntis.com' };
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);
const userRow = (username) => node.db.user.findUnique({ where: { username } });

// A browser: keeps the API's cookies and sends them back where they belong.
class Browser {
  constructor() {
    this.jar = new Map();
  }

  has(name) {
    return this.jar.has(name);
  }

  keep(headers) {
    for (const line of headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';').map((part) => part.trim());
      const at = pair.indexOf('=');
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      const path = attributes.find((a) => /^path=/i.test(a))?.slice(5) || '/';
      const expires = attributes.find((a) => /^expires=/i.test(a));
      const gone = !value || attributes.some((a) => /^max-age=0$/i.test(a)) || (expires && new Date(expires.slice(8)) <= new Date());
      if (gone) this.jar.delete(name);
      else this.jar.set(name, { value, path });
    }
  }

  async send(method, pathname, body) {
    const cookie = [...this.jar].filter(([, c]) => pathname.startsWith(c.path)).map(([name, c]) => `${name}=${c.value}`).join('; ');
    const res = await cluster.request(node, method, pathname, { body, headers: cookie ? { cookie } : {} });
    this.keep(res.headers);
    return res;
  }

  timetable() {
    return this.send('GET', `/webuntis/timetable?date=${today()}`);
  }
}

// The website shows a code. It only lives in the QR image, so the test gives
// the row a code it knows.
async function showCode(browser) {
  const started = await browser.send('POST', '/webuntis/qr/start', {});
  assert.equal(started.status, 200, started.text);
  assert.match(started.json.qrSvg, /<svg/);
  const code = randomBytes(24).toString('base64url');
  await node.db.qrLogin.update({ where: { pollHash: sha256(started.json.poll) }, data: { codeHash: sha256(code) } });
  return { code, poll: started.json.poll };
}

const poll = (browser, qr) => browser.send('POST', '/webuntis/qr/poll', { poll: qr.poll });

// The app, signed in to POKYH with a WebUntis session of its own. The session
// it hands over later is another one of the same account (the app signs in
// to WebUntis again whenever one ends), so the backend has not verified it a
// moment ago and asks WebUntis afresh.
async function app(username, account = {}) {
  untis.account(username, account);
  const res = await cluster.request(node, 'POST', '/auth/login', {
    body: { username, untisSessionId: untis.session(username), school: SCHOOL.loginName, schoolServer: SCHOOL.server, schoolName: 'LBS Brixen' },
    headers: { 'x-server-key': node.serverKey },
  });
  assert.equal(res.status, 200, res.text);
  return { username, token: res.json.token, user: res.json.user, sessionId: untis.session(username) };
}

// What the iOS app sends: its user name, its school and what it hands over.
const approve = (signedIn, qr, handOver, username = signedIn.username) => cluster.request(node, 'POST', `/auth/qr/${qr.code}/approve`, {
  token: signedIn.token,
  body: { username, school: SCHOOL, ...handOver },
});

function assertSignedIn(res, browser) {
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.ok, true, res.text);
  assert.ok(res.json.token, 'a POKYH token for the website');
  assert.equal(res.json.pokyhSynced, true);
  assert.ok(browser.has('pokyh_session'), 'the WebUntis session cookie');
  assert.ok(browser.has('pokyh_api_refresh'), 'the POKYH refresh cookie');
}

function assertNotSignedIn(res, browser) {
  assert.notEqual(res.status, 200, res.text);
  assert.notEqual(res.json?.ok, true, res.text);
  assert.equal(res.json?.token, undefined);
  assert.equal(browser.has('pokyh_session'), false);
  assert.equal(browser.has('pokyh_api_refresh'), false);
}

// Signs the website in with what the app hands over; the answer and the browser.
async function qrSignIn(signedIn, handOver) {
  const web = new Browser();
  const qr = await showCode(web);
  const approved = await approve(signedIn, qr, handOver);
  assert.equal(approved.status, 200, approved.text);
  return { web, qr, res: await poll(web, qr) };
}

const endSessionsOf = (username) => {
  for (const [id, owner] of untis.sessions) if (owner === username) untis.endSession(id);
};

before(async () => {
  await cluster.startMysql();
  node = await cluster.addNode('qrlogin', { ADMIN_USERNAMES: 'clusteradmin', WEBUNTIS_SCHOOL: 'lbs-brixen' });
  await cluster.start(node, { waitForCluster: false });
  // As in production: the school's WebUntis tenant is known.
  await node.db.school.updateMany({ where: { webuntisSchool: 'lbs-brixen' }, data: { webuntisTenantId: untis.tenantId } });
}, { timeout: 400_000 });

after(async () => {
  await cluster.teardown();
}, { timeout: 120_000 });

// ── The app's session alone ─────────────────────────────────────────────────

test('a pupil\'s app hands over only its WebUntis session: the website is signed in, with the class', async () => {
  const anna = await app('qr.anna', { klasseId: 4711, pageConfig: true });
  const web = new Browser();
  const qr = await showCode(web);
  const waiting = await poll(web, qr);
  assert.equal(waiting.status, 200, waiting.text);
  assert.equal(waiting.json.status, 'pending');

  assert.equal((await approve(anna, qr, { sessionId: anna.sessionId })).status, 200);
  const authenticateBefore = untis.calls.filter((c) => c === 'rpc:authenticate').length;
  const res = await poll(web, qr);
  assertSignedIn(res, web);
  assert.equal(res.json.username, 'qr.anna');
  assert.equal(res.json.user.klasseId, 4711);
  assert.equal(res.json.user.isParent, false);
  assert.equal(res.json.user.school.loginName, 'lbs-brixen');
  // Taken over, not signed in again: WebUntis saw no new sign-in.
  assert.equal(untis.calls.filter((c) => c === 'rpc:authenticate').length, authenticateBefore);

  // The website works with it, WebUntis and POKYH alike.
  assert.equal((await web.timetable()).status, 200);
  const me = await cluster.request(node, 'GET', '/auth/me', { token: res.json.token });
  assert.equal(me.status, 200, me.text);
  assert.equal(me.json.username, 'qr.anna');
  assert.equal(me.json.role, 'student');
  assert.equal(me.json.webuntisKlasseId, 4711);
  assert.equal(me.json.classCheckPending, false);
});

test('a guardian\'s app hands over only its session: signed in for the child, without a class', async () => {
  const mama = await app('qr.mama', { kind: 'parent', children: [5551] });
  const { web, res } = await qrSignIn(mama, { sessionId: mama.sessionId });
  assertSignedIn(res, web);
  assert.equal(res.json.user.isParent, true);
  assert.equal(res.json.studentId, 5551);
  assert.equal(res.json.user.klasseId, 0);
  assert.equal((await web.timetable()).status, 200);
  const me = await cluster.request(node, 'GET', '/auth/me', { token: res.json.token });
  assert.equal(me.json.role, 'parent');
  assert.equal(me.json.webuntisKlasseId, 0);
});

test('a guardian whose app-data names only the children, no person of their own, is signed in too', async () => {
  // The app's own sign-in (POST /auth/login) takes such a session; the
  // website's must as well.
  const papa = await app('qr.papa', { kind: 'parent', children: [5552], appPerson: false });
  assert.equal(papa.user.role, 'parent');
  const { web, res } = await qrSignIn(papa, { sessionId: papa.sessionId });
  assertSignedIn(res, web);
  assert.equal(res.json.user.isParent, true);
  assert.equal(res.json.studentId, 5552);
  assert.equal((await web.timetable()).status, 200);
});

test('an app-data that answers too late does not undo a session WebUntis\' token names the account for', async () => {
  const slow = await app('qr.slow', { klasseId: 4711, pageConfig: true });
  untis.accounts.get('qr.slow').appDataDelayMs = 8_500;
  try {
    const { web, res } = await qrSignIn(slow, { sessionId: slow.sessionId });
    assertSignedIn(res, web);
    // Nothing new was learned: the class confirmed at the app's sign-in stays.
    assert.equal(res.json.user.klasseId, 4711);
    assert.equal((await userRow('qr.slow')).webuntisKlasseId, 4711);
  } finally {
    untis.accounts.get('qr.slow').appDataDelayMs = 0;
  }
});

// ── What does not sign in ───────────────────────────────────────────────────

test('a session WebUntis no longer knows, and no password: the website is told to scan again', async () => {
  const ended = await app('qr.ended', { klasseId: 4711, pageConfig: true });
  untis.endSession(ended.sessionId);
  const { web, qr, res } = await qrSignIn(ended, { sessionId: ended.sessionId });
  assert.equal(res.status, 410, res.text);
  assert.equal(res.json.status, 'expired');
  assert.equal(res.json.code, 'session_gone');
  assertNotSignedIn(res, web);
  // The code is gone with it.
  assert.equal((await poll(web, qr)).status, 410);
});

test('another account\'s session never signs the website in', async () => {
  const anna = await app('qr.victim', { klasseId: 4711, pageConfig: true });
  untis.account('qr.other', { klasseId: 4712, pageConfig: true });
  const { web, res } = await qrSignIn(anna, { sessionId: untis.session('qr.other') });
  assertNotSignedIn(res, web);
  assert.equal(res.status, 410, res.text);
  assert.equal(res.json.code, 'session_gone');
  assert.equal(await userRow('qr.other'), null);
});

test('a session of another school\'s WebUntis tenant never signs the website in', async () => {
  const bound = await app('qr.bound', { klasseId: 4711, pageConfig: true });
  untis.account('qr.bound', { klasseId: 4711, pageConfig: true, tenantId: '9999900' });
  const { web, res } = await qrSignIn(bound, { sessionId: untis.session('qr.bound') });
  assertNotSignedIn(res, web);
  assert.equal((await userRow('qr.bound')).webuntisTenantId, untis.tenantId);
});

test('a code signs in once: asked again it has expired, and the app cannot approve it again', async () => {
  const once = await app('qr.once', { klasseId: 4711, pageConfig: true });
  const { web, qr, res } = await qrSignIn(once, { sessionId: once.sessionId });
  assertSignedIn(res, web);
  const again = await poll(new Browser(), qr);
  assert.equal(again.status, 410, again.text);
  assert.equal(again.json.status, 'expired');
  assert.equal(again.json.code, undefined);
  const reapproved = await approve(once, qr, { sessionId: once.sessionId });
  assert.equal(reapproved.status, 404, reapproved.text);
  assert.equal(reapproved.json.code, 'qr_expired');
});

test('WebUntis away for a moment: the code waits, and signs in once WebUntis answers', async () => {
  const wait = await app('qr.wait', { klasseId: 4711, pageConfig: true });
  const web = new Browser();
  const qr = await showCode(web);
  assert.equal((await approve(wait, qr, { sessionId: wait.sessionId })).status, 200);
  untis.down = true;
  let away;
  try {
    away = await poll(web, qr);
  } finally {
    untis.down = false;
  }
  // The website asks again on a 5xx (app/[lang]/login/QrSignIn.tsx).
  assert.equal(away.status, 503, away.text);
  assertNotSignedIn(away, web);
  assertSignedIn(await poll(web, qr), web);
});

// ── The password, and what renews ───────────────────────────────────────────

test('the password alone signs the website in as typing it would', async () => {
  const pw = await app('qr.password', { klasseId: 4712, password: 'Qr-Passwort-1' });
  const { web, res } = await qrSignIn(pw, { password: 'Qr-Passwort-1' });
  assertSignedIn(res, web);
  assert.equal(res.json.user.klasseId, 4712);
  assert.ok(web.has('pokyh_renew'), 'renewed later with the password');
  assert.equal((await web.timetable()).status, 200);
});

test('a sign-in with the app\'s session alone ends with that session; with the password too it renews like a typed one', async () => {
  const name = 'qr.renew';
  const renew = await app(name, { klasseId: 4711, pageConfig: true, password: 'Renew-Passwort-1' });
  const renewal = (web) => web.send('POST', '/webuntis/login', { renewal: true });

  // The session alone: nothing to renew it with. When WebUntis ends it, the
  // website is signed out ("Sitzung abgelaufen"), by design.
  const alone = await qrSignIn(renew, { sessionId: renew.sessionId });
  assertSignedIn(alone.res, alone.web);
  assert.equal(alone.web.has('pokyh_renew'), false);
  assert.equal((await alone.web.timetable()).status, 200);
  endSessionsOf(name);
  const expired = await alone.web.timetable();
  assert.equal(expired.status, 401, expired.text);
  assert.equal(expired.json.error, 'session_expired');
  const notRenewed = await renewal(alone.web);
  assert.equal(notRenewed.status, 401, notRenewed.text);
  assert.equal(notRenewed.json.code, 'session_expired');

  // The session and the password: taken over now, renewed with the password
  // later, with the school as the app named it (no name).
  const both = await qrSignIn(renew, { sessionId: untis.session(name), password: 'Renew-Passwort-1' });
  assertSignedIn(both.res, both.web);
  assert.ok(both.web.has('pokyh_renew'));
  endSessionsOf(name);
  assert.equal((await both.web.timetable()).status, 401);
  const renewed = await renewal(both.web);
  assert.equal(renewed.status, 200, renewed.text);
  assert.equal(renewed.json.user.school.loginName, 'lbs-brixen');
  assert.equal(renewed.json.user.klasseId, 4711);
  assert.equal((await both.web.timetable()).status, 200);

  // The same as a website sign-in with the typed password and the school's name.
  const typed = new Browser();
  const signIn = await typed.send('POST', '/webuntis/login', { username: name, password: 'Renew-Passwort-1', school: { ...SCHOOL, name: 'LBS Brixen' } });
  assert.equal(signIn.status, 200, signIn.text);
  endSessionsOf(name);
  assert.equal((await typed.timetable()).status, 401);
  assert.equal((await renewal(typed)).status, 200);
  assert.equal((await typed.timetable()).status, 200);
});

// ── The user name ───────────────────────────────────────────────────────────

test('an account stored with capitals (an old script made it) approves with its own name', async () => {
  const school = await node.db.school.findFirst({ where: { webuntisSchool: 'lbs-brixen' } });
  await node.db.user.create({ data: { stableUid: 'qr-legacy-uid-0001', username: 'Lena.Legacy', isUntisUser: true, schoolId: school.id } });
  const lena = await app('lena.legacy', { klasseId: 4711, pageConfig: true });
  assert.equal(lena.user.stableUid, 'qr-legacy-uid-0001', 'the same account');
  const web = new Browser();
  const qr = await showCode(web);
  const approved = await approve(lena, qr, { sessionId: lena.sessionId }, 'Lena.Legacy');
  assert.equal(approved.status, 200, approved.text);
  assertSignedIn(await poll(web, qr), web);
});
