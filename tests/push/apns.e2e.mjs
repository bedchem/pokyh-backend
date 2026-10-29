import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import { generateKeyPairSync } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Cluster, sleep, waitFor } from '../cluster/harness.mjs';

// APNs end to end: a real backend process and MySQL (tests/cluster/harness.mjs),
// with Apple played by a local HTTP/2 server. Covers registering a phone, a
// due to-do reaching it, Apple saying the token is gone, signing the device
// session out, and the account's data export.
//
// Run with `npm run test:push` (builds first).

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const p8 = privateKey.export({ type: 'pkcs8', format: 'pem' });
const TOPIC = 'dev.example.pokyh';

const pushes = [];
// Per device token: what the fake Apple answers (default 200).
const answers = new Map();
const apple = http2.createServer();
apple.on('stream', (stream, headers) => {
  let body = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => { body += chunk; });
  stream.on('end', () => {
    const token = String(headers[':path']).split('/').pop();
    pushes.push({ token, headers, payload: JSON.parse(body) });
    const answer = answers.get(token) ?? { status: 200 };
    stream.respond({ ':status': answer.status, 'content-type': 'application/json' });
    stream.end(answer.reason ? JSON.stringify({ reason: answer.reason }) : '');
  });
});

// WebUntis' message list, per session id: how many are unread, or 401.
const inbox = new Map();
const webuntis = http.createServer((req, res) => {
  const session = /JSESSIONID=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
  const unread = inbox.get(session);
  if (!req.url.includes('/api/rest/view/v1/messages') || unread === undefined) {
    res.writeHead(404).end();
    return;
  }
  if (unread === 401) {
    res.writeHead(401).end();
    return;
  }
  const incomingMessages = Array.from({ length: unread + 2 }, (_, i) => ({ id: i + 1, isRead: i >= unread }));
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ incomingMessages }));
});

const cluster = new Cluster();
let node;

const deviceToken = (n) => n.toString(16).padStart(2, '0').repeat(32);
const pushesTo = (token) => pushes.filter((p) => p.token === token);

// Each sign-in is its own device, as the app sends its device id.
let devices = 0;
async function signIn(username) {
  devices += 1;
  const res = await cluster.request(node, 'POST', '/auth/login', {
    body: { username, klasseId: 0, klasseName: '' },
    headers: { 'x-server-key': node.serverKey, 'x-pokyh-device': `e2e-device-${String(devices).padStart(8, '0')}` },
  });
  assert.equal(res.status, 200, res.text);
  return { token: res.json.token, user: res.json.user };
}

async function register(token, accessToken, environment = 'sandbox', extra = {}) {
  return cluster.request(node, 'POST', '/push/apns', { token: accessToken, body: { token, environment, ...extra } });
}

async function dueTodo(username, accessToken, title) {
  const res = await cluster.request(node, 'POST', `/users/${username}/todos`, {
    token: accessToken,
    body: { title, dueAt: new Date(Date.now() - 60_000).toISOString() },
  });
  assert.equal(res.status, 201, res.text);
  return res.json;
}

before(async () => {
  await new Promise((resolve) => apple.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => webuntis.listen(0, '127.0.0.1', resolve));
  const appleHost = `http://127.0.0.1:${apple.address().port}`;
  await cluster.startMysql();
  node = await cluster.addNode('push', {
    APNS_KEY_ID: 'KEY1234567',
    APNS_TEAM_ID: 'TEAM123456',
    APNS_KEY: p8.replace(/\n/g, '\\n'),
    APNS_TOPIC: TOPIC,
    APNS_HOST_SANDBOX: appleHost,
    APNS_HOST_PRODUCTION: appleHost,
    PUSH_DUE_CHECK_INTERVAL_MS: '300',
    PUSH_POLL_INTERVAL_MS: '300',
    WEBUNTIS_BASE: `http://127.0.0.1:${webuntis.address().port}/WebUntis`,
  });
  await cluster.start(node, { waitForCluster: false });
});

after(async () => {
  await cluster.teardown();
  await new Promise((resolve) => apple.close(resolve));
  await new Promise((resolve) => webuntis.close(resolve));
});

test('the poller starts with APNs as its channel', async () => {
  await waitFor(() => cluster.logText(node).includes('[push] Poller started for APNs'), { label: 'the push poller to start' });
});

test('a phone registers, and nonsense is refused', async () => {
  const { token } = await signIn('anna.apns');
  assert.equal((await register(deviceToken(1), token)).status, 204);
  // Same token again: still one device.
  assert.equal((await register(deviceToken(1), token)).status, 204);
  assert.equal(await node.db.apnsDevice.count({ where: { token: deviceToken(1) } }), 1);

  // Validation errors are 422 throughout the API.
  assert.equal((await register('not-a-token', token)).status, 422);
  assert.equal((await register(deviceToken(2), token, 'development')).status, 422);
  const anonymous = await cluster.request(node, 'POST', '/push/apns', { body: { token: deviceToken(3), environment: 'sandbox' } });
  assert.equal(anonymous.status, 401);
});

test('a due to-do reaches the phone with its string keys and deep link', async () => {
  const { token, user } = await signIn('ben.apns');
  assert.equal((await register(deviceToken(4), token, 'production')).status, 204);
  const todo = await dueTodo(user.username, token, 'Mathe Hausübung');

  await waitFor(() => pushesTo(deviceToken(4)).length === 1, { label: 'the to-do push' });
  const [{ headers, payload }] = pushesTo(deviceToken(4));
  assert.equal(headers['apns-topic'], TOPIC);
  assert.equal(headers['apns-push-type'], 'alert');
  assert.equal(headers['apns-collapse-id'], `todo-${todo.id}`);
  assert.equal(payload.aps.alert['title-loc-key'], 'push.todo.due');
  assert.deepEqual(payload.aps.alert['title-loc-args'], ['Mathe Hausübung']);
  assert.equal(payload.aps['thread-id'], 'todos');
  assert.equal(payload.url, `/todos/${todo.id}`);

  // Sent once, not on every pass.
  await sleep(1000);
  assert.equal(pushesTo(deviceToken(4)).length, 1);
});

test('new WebUntis messages are pushed once, counted from the first look', async () => {
  const { token } = await signIn('ida.apns');
  inbox.set('jsession-ida', 2);
  assert.equal((await register(deviceToken(10), token, 'sandbox', { jsessionid: 'jsession-ida', bearerToken: 'bearer-ida' })).status, 204);

  // The first poll only learns what is there: two unread, no push.
  await waitFor(async () => (await node.db.apnsDevice.findUnique({ where: { token: deviceToken(10) } })).knownUnread === 2, { label: 'the first count' });
  assert.equal(pushesTo(deviceToken(10)).length, 0);

  inbox.set('jsession-ida', 3);
  await waitFor(() => pushesTo(deviceToken(10)).length === 1, { label: 'the message push' });
  const [{ payload, headers }] = pushesTo(deviceToken(10));
  assert.equal(payload.aps.alert['title-loc-key'], 'push.messages.new.one');
  assert.equal(payload.aps['thread-id'], 'messages');
  assert.equal(payload.url, '/messages');
  assert.equal(headers['apns-collapse-id'], 'messages');

  inbox.set('jsession-ida', 6);
  await waitFor(() => pushesTo(deviceToken(10)).length === 2, { label: 'the second message push' });
  assert.equal(pushesTo(deviceToken(10))[1].payload.aps.alert['title-loc-key'], 'push.messages.new.other');
  assert.deepEqual(pushesTo(deviceToken(10))[1].payload.aps.alert['title-loc-args'], ['3']);

  // Reading them doesn't push; it only lowers the count.
  inbox.set('jsession-ida', 1);
  await waitFor(async () => (await node.db.apnsDevice.findUnique({ where: { token: deviceToken(10) } })).knownUnread === 1, { label: 'the lower count' });
  assert.equal(pushesTo(deviceToken(10)).length, 2);
});

test('an expired WebUntis session resets the count instead of pushing', async () => {
  const { token } = await signIn('jonas.apns');
  inbox.set('jsession-jonas', 1);
  assert.equal((await register(deviceToken(11), token, 'sandbox', { jsessionid: 'jsession-jonas' })).status, 204);
  await waitFor(async () => (await node.db.apnsDevice.findUnique({ where: { token: deviceToken(11) } })).knownUnread === 1, { label: 'the first count' });

  inbox.set('jsession-jonas', 401);
  await waitFor(async () => (await node.db.apnsDevice.findUnique({ where: { token: deviceToken(11) } })).knownUnread === -1, { label: 'the reset' });

  // The app comes back with a fresh session: counted again, no push for what was already there.
  inbox.set('jsession-jonas-2', 4);
  assert.equal((await register(deviceToken(11), token, 'sandbox', { jsessionid: 'jsession-jonas-2' })).status, 204);
  await waitFor(async () => (await node.db.apnsDevice.findUnique({ where: { token: deviceToken(11) } })).knownUnread === 4, { label: 'the new count' });
  assert.equal(pushesTo(deviceToken(11)).length, 0);
});

test('a token Apple reports as gone is deleted', async () => {
  const { token, user } = await signIn('clara.apns');
  answers.set(deviceToken(5), { status: 410, reason: 'Unregistered' });
  assert.equal((await register(deviceToken(5), token)).status, 204);
  await dueTodo(user.username, token, 'Bio');

  await waitFor(async () => (await node.db.apnsDevice.count({ where: { token: deviceToken(5) } })) === 0, { label: 'the gone device to be deleted' });
  assert.equal(pushesTo(deviceToken(5)).length, 1);
});

test('signing the device session out stops its pushes', async () => {
  const phone = await signIn('dora.apns');
  const laptop = await signIn('dora.apns');
  assert.equal((await register(deviceToken(6), phone.token)).status, 204);

  const sessions = await cluster.request(node, 'GET', '/auth/sessions', { token: laptop.token });
  assert.equal(sessions.status, 200, sessions.text);
  const device = await node.db.apnsDevice.findUnique({ where: { token: deviceToken(6) } });
  assert.ok(device.sessionId, 'the device keeps the session it registered from');
  assert.equal((await cluster.request(node, 'DELETE', `/auth/sessions/${device.sessionId}`, { token: laptop.token })).status, 200);

  await dueTodo('dora.apns', laptop.token, 'Turnsachen');
  await waitFor(async () => (await node.db.apnsDevice.count({ where: { token: deviceToken(6) } })) === 0, { label: 'the signed-out device to go' });
  await sleep(600);
  assert.equal(pushesTo(deviceToken(6)).length, 0);
});

test('signing out on the phone removes the device', async () => {
  const { token } = await signIn('emil.apns');
  assert.equal((await register(deviceToken(7), token)).status, 204);
  const res = await cluster.request(node, 'DELETE', '/push/apns', { token, body: { token: deviceToken(7) } });
  assert.equal(res.status, 204);
  assert.equal(await node.db.apnsDevice.count({ where: { token: deviceToken(7) } }), 0);
});

test('a token moving to another account belongs to that account only', async () => {
  const first = await signIn('fritz.apns');
  const second = await signIn('greta.apns');
  assert.equal((await register(deviceToken(8), first.token)).status, 204);
  assert.equal((await register(deviceToken(8), second.token)).status, 204);
  const device = await node.db.apnsDevice.findUnique({ where: { token: deviceToken(8) } });
  assert.equal(device.stableUid, second.user.stableUid);
  assert.equal(await node.db.apnsDevice.count({ where: { token: deviceToken(8) } }), 1);
});

test("the account's data export lists its phones, without the token", async () => {
  const { token } = await signIn('hanna.apns');
  assert.equal((await register(deviceToken(9), token, 'production')).status, 204);
  const res = await cluster.request(node, 'GET', '/users/me/export', { token });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.notifications.apnsDevices.map((d) => d.environment), ['production']);
  assert.ok(!res.text.includes(deviceToken(9)));
});

test('a full backup keeps the phones and a restore brings them back', async () => {
  const { token } = await signIn('karl.apns');
  assert.equal((await register(deviceToken(12), token, 'production')).status, 204);

  const backup = await cluster.admin(node, 'GET', '/export');
  assert.equal(backup.status, 200, backup.text);
  const saved = backup.json.data.apnsDevices.find((d) => d.token === deviceToken(12));
  assert.ok(saved, 'the backup has the device');

  const restored = await cluster.admin(node, 'POST', '/import', backup.json);
  assert.equal(restored.status, 200, restored.text);
  const device = await node.db.apnsDevice.findUnique({ where: { token: deviceToken(12) } });
  assert.equal(device?.environment, 'production');
  assert.equal(device?.sessionId, saved.sessionId);
});
