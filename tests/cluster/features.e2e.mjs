import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, before, test } from 'node:test';
import { Cluster, sleep, waitFor } from './harness.mjs';

// End-to-end tests with real backend processes for:
//   - popups meant for chosen users and classes only;
//   - a way through the administrator's own web proxy on the API address,
//     taken when the pinned channel fails, and "test this way".
// Run with `npm run test:cluster`.

const cluster = new Cluster();
let a;
let b;

before(async () => {
  await cluster.startMysql();
}, { timeout: 600_000 });

after(async () => {
  await proxy?.close().catch(() => {});
  await bForwarder?.close().catch(() => {});
  await cluster.teardown();
}, { timeout: 120_000 });

async function activePopups(node, { token = null, audience = 'user', platform = 'web' } = {}) {
  const res = await cluster.request(node, 'GET', `/popups/active?platform=${platform}&audience=${audience}`, token ? { token } : {});
  assert.equal(res.status, 200, res.text);
  return res.json.popups.map((popup) => popup.title);
}

function popupInput(title, extra = {}) {
  return { title, content: '', platform: 'all', audience: 'all', mode: 'once', showCount: 1, startsAt: null, endsAt: null, enabled: true, ...extra };
}

// A small stand-in for the administrator's web proxy: passes one path prefix
// on, prefix removed, to a node's API port — and records what it carried.
async function webProxy(prefix, target) {
  const carried = [];
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith(`${prefix}/`)) { res.writeHead(404).end(); return; }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      carried.push(body);
      const upstream = http.request({
        host: '127.0.0.1', port: target.port, method: req.method, path: req.url.slice(prefix.length),
        headers: { ...req.headers, host: `127.0.0.1:${target.port}` },
      }, (reply) => { res.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(res); });
      upstream.on('error', () => { res.writeHead(502); res.end(); });
      upstream.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}${prefix}`, carried, close: () => new Promise((resolve) => server.close(resolve)) };
}

// A TCP forwarder that can be taken away (a pinned way that fails).
async function forwarder(port) {
  const sockets = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: '127.0.0.1', port });
    sockets.add(client); sockets.add(upstream);
    client.pipe(upstream); upstream.pipe(client);
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on('error', close); upstream.on('error', close); client.on('close', close); upstream.on('close', close);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => { for (const socket of sockets) socket.destroy(); return new Promise((resolve) => server.close(resolve)); },
  };
}

// ─── Two nodes, the channel of B behind a forwarder ──────────────────────────

let bForwarder;

test('two nodes link up and lock their link to the pinned channel', async () => {
  a = await cluster.addNode('a', {}, { mtls: true });
  b = await cluster.addNode('b', {}, { mtls: true });
  bForwarder = await forwarder(b.mtlsPort);
  b.overrides.CLUSTER_MTLS_URL = `https://127.0.0.1:${bForwarder.port}`;
  await Promise.all([cluster.start(a), cluster.start(b)]);
  await cluster.pair(a, b);
  await cluster.waitPaired(a, b, 120_000);
  await waitFor(async () => {
    const [sa, sb] = await Promise.all([cluster.status(a), cluster.status(b)]);
    return cluster.peerOf(sa, b)?.tls?.locked === true && cluster.peerOf(sb, a)?.tls?.locked === true;
  }, { timeoutMs: 120_000, label: 'the link to be locked to the channel' });
});

// ─── Popups for chosen people ────────────────────────────────────────────────

test('a popup meant for chosen users and classes reaches exactly them — on every node', async () => {
  const s1 = await cluster.login(a, 'popup-anna', { klasseId: 101, klasseName: '4AHIT' });
  const s2 = await cluster.login(a, 'popup-ben', { klasseId: 101, klasseName: '4AHIT' });
  const s3 = await cluster.login(a, 'popup-cleo', { klasseId: 202, klasseName: '5BHIT' });
  const s4 = await cluster.login(a, 'popup-dora', { klasseId: 0, klasseName: '' });

  const targets = await cluster.admin(a, 'GET', '/popups/targets?q=popup-');
  assert.equal(targets.status, 200, targets.text);
  assert.ok(targets.json.users.some((user) => user.username === 'popup-anna'));
  const class101 = targets.json.classes.find((entry) => entry.id === 101);
  assert.equal(class101.name, '4AHIT');
  assert.equal(class101.users, 2);

  for (const [extra, pattern] of [
    [{ targetUsers: ['does-not-exist'] }, /Benutzer/],
    [{ targetClasses: [999_999] }, /Klasse/],
  ]) {
    const refused = await cluster.admin(a, 'POST', '/popups', popupInput('refused', extra));
    assert.ok([400, 422].includes(refused.status), refused.text);
    assert.match(refused.text, pattern);
  }

  const created = await cluster.admin(a, 'POST', '/popups', popupInput('Nur 4AHIT und Dora', {
    audience: 'guests',
    targetUsers: [s4.user.stableUid],
    targetClasses: [101],
  }));
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.popup.audience, 'users', 'chosen people are signed in by definition');
  assert.deepEqual(created.json.popup.targetClasses, [{ id: 101, name: '4AHIT' }]);
  assert.deepEqual(created.json.popup.targetUsers.map((user) => user.username), ['popup-dora']);
  const everyone = await cluster.admin(a, 'POST', '/popups', popupInput('Für alle'));
  assert.equal(everyone.status, 201, everyone.text);

  const sees = async (node, token, extra) => (await activePopups(node, { token, ...extra })).includes('Nur 4AHIT und Dora');
  assert.equal(await sees(a, s1.token), true, 'class 101');
  assert.equal(await sees(a, s2.token), true, 'class 101');
  assert.equal(await sees(a, s3.token), false, 'another class');
  assert.equal(await sees(a, s4.token), true, 'chosen by name');
  assert.equal(await sees(a, null), false, 'no session: never');
  assert.equal(await sees(a, s1.token, { audience: 'guest' }), false, 'asked as a guest: never');
  assert.equal(await sees(a, s1.token, { platform: 'android' }), true, 'on every platform the popup is for');
  assert.ok((await activePopups(a, { token: null })).includes('Für alle'), 'popups for everybody are unchanged');

  // The choice travels with the popup to the other node.
  await waitFor(async () => sees(b, s1.token), { timeoutMs: 30_000, label: 'the targeted popup to reach B' });
  assert.equal(await sees(b, s3.token), false);
  assert.equal(await sees(b, s4.token), true);

  // Everybody again.
  const id = created.json.popup.id;
  const opened = await cluster.admin(a, 'PUT', `/popups/${id}`, popupInput('Nur 4AHIT und Dora', { targetUsers: [], targetClasses: [] }));
  assert.equal(opened.status, 200, opened.text);
  assert.equal(await sees(a, s3.token), true);
  await waitFor(async () => sees(b, s3.token), { timeoutMs: 30_000, label: 'the change to reach B' });

  // Only administrators choose recipients.
  assert.ok([401, 403].includes((await cluster.request(a, 'GET', '/api/admin/popups/targets', { token: s1.token })).status));
});

// ─── Mensa: summer and winter plan ───────────────────────────────────────────

// YYYY-MM-DD of a UTC date `days` after the last Sunday of `month` (0-based).
function afterLastSunday(year, month, days) {
  const last = new Date(Date.UTC(year, month + 1, 0));
  return new Date(Date.UTC(year, month, last.getUTCDate() - last.getUTCDay() + days)).toISOString().slice(0, 10);
}

test('the public menu serves every week from the plan of its season, switching with the clocks — on every node', async () => {
  // Next year, so no week is in the past and rotated away.
  const year = new Date().getUTCFullYear() + 1;
  const lastSummerWeek = afterLastSunday(year, 9, -6); // Monday before the switch to winter time
  const firstWinterWeek = afterLastSunday(year, 9, 1); // Monday after it
  const lastWinterWeek = afterLastSunday(year, 2, -6); // Monday before the switch to summer time
  const firstSummerWeek = afterLastSunday(year, 2, 1); // Monday after it
  const december = `${year}-12-07`;

  const dishes = [
    ['Winter vor der Sommerzeit', 'winter', lastWinterWeek],
    ['Sommer vor der Sommerzeit', 'summer', lastWinterWeek],
    ['Sommer ab der Sommerzeit', 'summer', firstSummerWeek],
    ['Winter ab der Sommerzeit', 'winter', firstSummerWeek],
    ['Sommer vor der Winterzeit', 'summer', lastSummerWeek],
    ['Winter vor der Winterzeit', 'winter', lastSummerWeek],
    ['Winter ab der Winterzeit', 'winter', firstWinterWeek],
    ['Sommer ab der Winterzeit', 'summer', firstWinterWeek],
    // A winter week the winter plan has nothing for: the summer plan fills it.
    ['Sommer statt leerer Winterwoche', 'summer', december],
  ];
  for (const [nameDe, plan, date] of dishes) {
    const res = await cluster.admin(a, 'POST', '/dishes', { nameDe, plan, date });
    assert.equal(res.status, 201, res.text);
  }

  const served = async (node) => {
    const res = await cluster.request(node, 'GET', '/dishes');
    assert.equal(res.status, 200, res.text);
    return res.json.menu.dishes
      .filter((d) => dishes.some(([name]) => name === d.name.de))
      .map((d) => `${d.date} ${d.name.de}`);
  };
  const expected = [
    `${lastWinterWeek} Winter vor der Sommerzeit`,
    `${firstSummerWeek} Sommer ab der Sommerzeit`,
    `${lastSummerWeek} Sommer vor der Winterzeit`,
    `${firstWinterWeek} Winter ab der Winterzeit`,
    `${december} Sommer statt leerer Winterwoche`,
  ];
  assert.deepEqual(await served(a), expected);
  await waitFor(async () => JSON.stringify(await served(b)) === JSON.stringify(expected), { timeoutMs: 30_000, label: 'the menu to reach B' });
});

// ─── A way through the web proxy ─────────────────────────────────────────────

let proxy;

test('"test this way" tells whether a way arrives at this very node', async () => {
  proxy = await webProxy('/cluster-node/b', b);
  const test1 = await cluster.admin(b, 'POST', '/cluster/reach/test', { kind: 'proxy-path', endpoint: proxy.url });
  assert.equal(test1.status, 200, test1.text);
  assert.equal(test1.json.ok, true, test1.json.message);
  const wrong = await cluster.admin(b, 'POST', '/cluster/reach/test', { kind: 'proxy-path', endpoint: a.url });
  assert.equal(wrong.json.ok, false, 'A answers there, not B');
  const pinned = await cluster.admin(b, 'POST', '/cluster/reach/test', { kind: 'direct', endpoint: `https://127.0.0.1:${bForwarder.port}` });
  assert.equal(pinned.json.ok, true, pinned.json.message);
  const foreign = await cluster.admin(b, 'POST', '/cluster/reach/test', { kind: 'direct', endpoint: `https://127.0.0.1:${a.mtlsPort}` });
  assert.equal(foreign.json.ok, false);
  assert.match(foreign.json.message, /another certificate/);
  const nothing = await cluster.admin(b, 'POST', '/cluster/reach/test', { kind: 'direct', endpoint: 'https://127.0.0.1:1' });
  assert.equal(nothing.json.ok, false);
});

test('when the pinned channel fails, the way through the web proxy carries the link — only while it is offered', async () => {
  // Offered by B: off by default, switched on explicitly.
  const saved = await cluster.admin(b, 'PUT', '/cluster/reach', { entries: [{ kind: 'proxy-path', endpoint: proxy.url, enabled: true, backend: `127.0.0.1:${b.port}` }] });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.json.pathWays, [proxy.url]);
  assert.match(saved.json.entries[0].snippets.nginx, /location \/cluster-node\/b\/cluster\//);
  await waitFor(async () => cluster.peerOf(await cluster.status(a), b)?.pathWays?.includes(proxy.url), { timeoutMs: 15_000, label: 'A to learn the way' });

  // The pinned way to B goes away.
  await bForwarder.close();
  const writer = await cluster.login(a, 'path-paula');
  const todo = await cluster.request(a, 'POST', `/users/${writer.user.username}/todos`, { token: writer.token, body: { title: 'over the web proxy' } });
  assert.ok([200, 201].includes(todo.status), todo.text);
  await waitFor(async () => {
    const res = await cluster.request(b, 'GET', `/users/${writer.user.username}/todos`, { token: writer.token });
    return res.status === 200 && JSON.stringify(res.json).includes('over the web proxy');
  }, { timeoutMs: 90_000, label: 'the change to reach B over the web proxy' });
  const peer = cluster.peerOf(await cluster.status(a), b);
  assert.equal(peer.onPath, true);
  assert.equal(peer.health, 'ONLINE');
  assert.equal(peer.tls.locked, true, 'still locked: no other unpinned way is accepted');
  // The proxy carried only sealed frames.
  assert.ok(proxy.carried.length > 0);
  assert.ok(proxy.carried.every((body) => !body.includes('over the web proxy') && !body.includes('path-paula')), 'nothing readable');

  // B stops offering it: A's sessions are refused there, the link waits.
  const stopped = await cluster.admin(b, 'PUT', '/cluster/reach', { entries: [{ kind: 'proxy-path', endpoint: proxy.url, enabled: false, backend: `127.0.0.1:${b.port}` }] });
  assert.equal(stopped.status, 200, stopped.text);
  await waitFor(async () => ['SUSPECT', 'OFFLINE'].includes(cluster.peerOf(await cluster.status(a), b)?.health), { timeoutMs: 120_000, label: 'B to become unreachable for A' });
});

test('nothing of it leaked into the logs', async () => {
  for (const node of [a, b]) {
    const log = cluster.logText(node);
    assert.ok(!log.includes(cluster.secrets.jwt), `${node.name}: JWT secret`);
    assert.ok(!log.includes('over the web proxy'), `${node.name}: user content`);
  }
});
