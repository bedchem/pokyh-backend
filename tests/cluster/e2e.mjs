import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import { Cluster, sleep, waitFor } from './harness.mjs';

// End-to-end test of the cluster layer with three real backend processes.
// Run with `npm run test:cluster` (needs Docker for the throw-away MySQL
// server). Nothing here touches a developer's own database or `.env`.

const cluster = new Cluster();
let a;
let b;
let c;
// Every request A sends to B goes through this proxy and is recorded.
let wire;

// A 1×1 PNG, enough for the image pipeline to accept and re-encode.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const MARKER = 'PLAINTEXT-MARKER-7f3a91c2';

const users = {};
let courseId;
let sectionIds;
let classId;
let dishId;

async function triggerCount(node) {
  const rows = await node.db.$queryRawUnsafe(
    "SELECT COUNT(*) AS c FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME LIKE 'pokyh\\_cl\\_%'",
  );
  return Number(rows[0].c);
}

async function todosOf(node, user) {
  const res = await cluster.request(node, 'GET', `/users/${user.user.username}/todos`, { token: user.token });
  assert.equal(res.status, 200, res.text);
  return res.json;
}

before(async () => {
  await cluster.startMysql();
  a = await cluster.addNode('a');
  b = await cluster.addNode('b');
  // A deliberately different SERVER_KEY on C, to see the mismatch reported.
  c = await cluster.addNode('c', { SERVER_KEY: 'c'.repeat(48) });
  await Promise.all([cluster.start(a), cluster.start(b), cluster.start(c)]);
  wire = await cluster.recordingProxy(b);
}, { timeout: 600_000 });

after(async () => {
  await cluster.teardown();
}, { timeout: 120_000 });

// ─── Standalone behaviour and the audit fixes ────────────────────────────────

test('a node without peers is a plain standalone server', async () => {
  const status = await cluster.status(a);
  assert.equal(status.running, true);
  assert.deepEqual(status.peers, []);
  assert.equal(status.node.isLeader, true);
  assert.equal(await triggerCount(a), 0, 'no trigger may exist before the first peer is added');

  const session = await fetch(`${a.url}/cluster/v1/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.ok([400, 404].includes(session.status));
  const pairing = await fetch(`${a.url}/cluster/v1/pair/init`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.ok([400, 404].includes(pairing.status), 'nobody can pair while no pairing is open');
});

test('audit fixes hold on a running server', async () => {
  users.anna = await cluster.login(a, 'anna', { klasseId: 4711, klasseName: '4A' });
  users.ben = await cluster.login(a, 'ben', { klasseId: 4711, klasseName: '4A' });
  classId = users.anna.user.classId;
  assert.ok(classId);
  assert.equal(users.ben.user.classId, classId);

  // An admin-panel token is not a user session.
  const asUser = await cluster.request(a, 'GET', '/auth/me', { token: cluster.adminToken });
  assert.equal(asUser.status, 401);
  const stream = await cluster.request(a, 'GET', '/sse/todos', { token: cluster.adminToken });
  assert.equal(stream.status, 401);

  // Over-long text is a validation error, not a database error.
  const tooLong = await cluster.request(a, 'POST', '/users/anna/todos', { token: users.anna.token, body: { title: 't', details: 'x'.repeat(5001) } });
  assert.equal(tooLong.status, 422, tooLong.text);
  const fits = await cluster.request(a, 'POST', '/users/anna/todos', { token: users.anna.token, body: { title: 'long', details: 'x'.repeat(5000) } });
  assert.equal(fits.status, 201, fits.text);

  // A malformed page number no longer reaches the database.
  for (const query of ['?page=abc&limit=xyz', '?page=-3', '?limit=999999']) {
    const res = await cluster.admin(a, 'GET', `/users${query}`);
    assert.equal(res.status, 200, `${query}: ${res.text}`);
    assert.ok(Number.isInteger(res.json.page) && Number.isInteger(res.json.limit));
  }
  assert.equal((await cluster.admin(a, 'GET', '/logs?page=abc&status=abc')).status, 200);

  // A spoofed forwarding header does not buy a fresh rate-limit bucket or a
  // forged address in the activity log.
  const forged = await cluster.request(a, 'POST', '/activity-log', {
    body: { event: 'page_view', page: '/x' },
    headers: { 'x-forwarded-for': '203.0.113.77' },
  });
  assert.equal(forged.status, 204);
  await waitFor(async () => (await a.db.$queryRawUnsafe('SELECT ip FROM frontend_activity_logs')).length > 0, { label: 'activity log row' });
  const logged = await a.db.$queryRawUnsafe('SELECT ip FROM frontend_activity_logs');
  assert.ok(logged.every((row) => row.ip !== '203.0.113.77'), 'the forwarded address must not be trusted without TRUST_PROXY');

  // A refreshed token keeps the account-type claim.
  const refreshed = await cluster.request(a, 'POST', '/auth/refresh', { body: { refreshToken: users.anna.refreshToken } });
  assert.equal(refreshed.status, 200, refreshed.text);
  const claims = JSON.parse(Buffer.from(refreshed.json.token.split('.')[1], 'base64url').toString());
  assert.equal(claims.isUntisUser, true);
  users.anna.token = refreshed.json.token;
  users.anna.refreshToken = refreshed.json.refreshToken;
});

test('a personal import within the configured limits completes', async () => {
  const uuid = () => crypto.randomUUID();
  const courses = Array.from({ length: 4 }, (_, n) => {
    const sections = Array.from({ length: 10 }, (_, i) => ({ sourceRef: uuid(), title: `Abschnitt ${i}` }));
    return {
      sourceRef: uuid(),
      title: `Importkurs ${n}`,
      sections,
      completedSectionRefs: [sections[0].sourceRef],
      vocabulary: Array.from({ length: 1000 }, (_, i) => ({
        sourceRef: uuid(),
        sectionRef: sections[i % sections.length].sourceRef,
        sourceLanguage: 'en',
        targetLanguage: 'de',
        sourceText: `word ${n}-${i}`,
        targetText: `Wort ${n}-${i}`,
        review: { intervalDays: 1, easeFactor: 2.5, dueAt: new Date().toISOString(), correctCount: 1, incorrectCount: 0, lastWasCorrect: true },
      })),
      enrollment: { status: 'ACTIVE', progressPercent: 0, completedSections: 0 },
    };
  });
  // Imported on C, which stays unpaired for a while: the rows then also
  // exercise the transfer of a larger existing data set later on.
  const importer = await cluster.login(c, 'importeur');
  const res = await cluster.request(c, 'POST', '/learn/library/import', {
    token: importer.token,
    body: { kind: 'pokyh-learn-personal-export', version: 1, courses },
  });
  assert.equal(res.status, 201, res.text.slice(0, 300));
  assert.equal(res.json.imported.vocabularyCount, 4000);
});

// ─── Data that exists before the cluster does ────────────────────────────────

test('seed data on the first node', async () => {
  for (const title of ['Mathe lernen', 'Vokabeln', MARKER]) {
    const res = await cluster.request(a, 'POST', '/users/anna/todos', { token: users.anna.token, body: { title, details: `details of ${title}` } });
    assert.equal(res.status, 201, res.text);
  }
  const reminder = await cluster.request(a, 'POST', `/classes/${classId}/reminders`, {
    token: users.anna.token, body: { title: 'Schularbeit', body: 'Kapitel 3', remindAt: new Date(Date.now() + 86_400_000).toISOString() },
  });
  assert.equal(reminder.status, 201, reminder.text);
  const comment = await cluster.request(a, 'POST', `/classes/${classId}/reminders/${reminder.json.id}/comments`, {
    token: users.ben.token, body: { body: 'Welche Seiten?' },
  });
  assert.equal(comment.status, 201, comment.text);

  const dish = await cluster.admin(a, 'POST', '/dishes', { nameDe: 'Käsespätzle', date: '2026-10-12', plan: 'winter', tags: ['vegetarisch'] });
  assert.equal(dish.status, 201, dish.text);
  dishId = dish.json.id;
  const image = await cluster.admin(a, 'PUT', `/dishes/${dishId}/image`, { data: PNG, mimeType: 'image/png' });
  assert.equal(image.status, 200, image.text);
  const rating = await cluster.request(a, 'POST', `/dish-ratings/${dishId}`, { token: users.anna.token, body: { stars: 4 } });
  assert.equal(rating.status, 200, rating.text);

  const course = await cluster.request(a, 'POST', '/learn/courses', {
    token: users.anna.token,
    body: {
      title: 'Englisch Unit 1',
      sections: [{ title: 'Eins' }, { title: 'Zwei' }, { title: 'Drei' }],
    },
  });
  assert.equal(course.status, 201, course.text);
  courseId = course.json.id;
  sectionIds = course.json.sections.map((section) => section.id);
  assert.equal(sectionIds.length, 3);
});

test('reordering one list from several requests at once succeeds every time', async () => {
  // Without a retry, a good part of these requests fails with a lock conflict.
  const statuses = [];
  for (let round = 0; round < 10; round++) {
    statuses.push(...await Promise.all(Array.from({ length: 6 }, (_, i) => {
      const shift = (i + round) % sectionIds.length;
      const rotated = [...sectionIds.slice(shift), ...sectionIds.slice(0, shift)];
      return cluster.request(a, 'POST', `/learn/courses/${courseId}/sections/reorder`, { token: users.anna.token, body: { sectionIds: rotated } })
        .then((res) => res.status);
    })));
  }
  assert.deepEqual(statuses.filter((status) => status !== 200), []);
  const rows = await a.db.$queryRawUnsafe('SELECT sort_order FROM learn_course_sections WHERE course_id = ? ORDER BY sort_order', courseId);
  assert.deepEqual(rows.map((row) => row.sort_order), [0, 1, 2], 'the list is left in a clean order');
  // Back to a known order for the tests that follow.
  await cluster.request(a, 'POST', `/learn/courses/${courseId}/sections/reorder`, { token: users.anna.token, body: { sectionIds } });
});

// ─── Pairing ─────────────────────────────────────────────────────────────────

test('a weak pairing key and a bad address are refused', async () => {
  const weak = await cluster.admin(a, 'POST', '/cluster/peers', { address: `127.0.0.1:${b.port}`, pairingKey: 'kurz' });
  assert.equal(weak.status, 400);
  assert.match(weak.json.error, /at least 16/);
  const address = await cluster.admin(a, 'POST', '/cluster/peers', { address: 'ftp://nope', pairingKey: 'x'.repeat(10) + 'abcdefghij' });
  assert.equal(address.status, 400);
  assert.equal((await cluster.status(a)).peers.length, 0);
});

test('pairing with different keys fails on both sides and locks', async () => {
  await cluster.pair(a, b, { keyA: 'key-number-one-AAAA-1111', keyB: 'key-number-two-BBBB-2222', addressOfB: `127.0.0.1:${wire.port}` });
  await waitFor(async () => {
    const [sa, sb] = await Promise.all([cluster.status(a), cluster.status(b)]);
    return sa.peers[0]?.status === 'LOCKED' && sb.peers[0]?.status === 'LOCKED';
  }, { timeoutMs: 90_000, label: 'both pairings to lock after repeated wrong keys' });
  const [sa, sb] = await Promise.all([cluster.status(a), cluster.status(b)]);
  assert.equal(sa.peers[0].health, null);
  assert.equal(sb.peers[0].nodeId, null, 'a failed pairing must not reveal or store the other identity');
  assert.ok(await triggerCount(a) > 0, 'change capture is installed as soon as a peer is configured');
});

test('pairing with the same key on both sides succeeds', async () => {
  const key = (await cluster.admin(a, 'POST', '/cluster/pairing-key')).json.pairingKey;
  assert.match(key, /^([A-Z2-9]{5}-){7}[A-Z2-9]{5}$/);
  const [sa, sb] = await Promise.all([cluster.status(a), cluster.status(b)]);
  assert.equal((await cluster.admin(a, 'POST', `/cluster/peers/${sa.peers[0].id}/pair`, { pairingKey: key })).status, 200);
  assert.equal((await cluster.admin(b, 'POST', `/cluster/peers/${sb.peers[0].id}/pair`, { pairingKey: key })).status, 200);
  await cluster.waitPaired(a, b);

  // The pairing key is gone and no key material is exposed anywhere.
  for (const node of [a, b]) {
    const rows = await node.db.$queryRawUnsafe('SELECT pairing_secret_enc, pairing_state_enc, link_key_enc FROM cluster_peers');
    assert.equal(rows[0].pairing_secret_enc, null);
    assert.equal(rows[0].pairing_state_enc, null);
    assert.ok(rows[0].link_key_enc && !rows[0].link_key_enc.includes(key));
    const text = JSON.stringify(await cluster.status(node));
    assert.equal(text.includes(key), false);
    assert.equal(text.includes(rows[0].link_key_enc), false);
    assert.equal(cluster.logText(node).includes(key), false, 'the pairing key must never be logged');
  }
});

test('an existing database is transferred completely to the new node', async () => {
  await cluster.converged([a, b], { timeoutMs: 90_000, label: 'the initial transfer to finish' });
  for (const node of [a, b]) {
    const status = await cluster.status(node);
    assert.equal(status.node.captureReady, true);
    assert.equal(status.node.captureGap, false, 'setting capture up for the first time is not a gap');
    assert.equal(status.node.captureError, null);
  }
  const todos = await todosOf(b, users.anna);
  assert.deepEqual(todos.map((todo) => todo.title).sort(), ['Mathe lernen', MARKER, 'Vokabeln', 'long'].sort());
  const image = await fetch(`${b.url}/dishes/${dishId}/image`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/webp');
  const original = Buffer.from(await (await fetch(`${a.url}/dishes/${dishId}/image`)).arrayBuffer());
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), original, 'binary data must arrive byte for byte');
});

test('node-local tables stay local', async () => {
  const count = async (node, table) => Number((await node.db.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM \`${table}\``))[0].c);
  assert.ok(await count(a, 'request_logs') > 0);
  assert.notEqual(await count(a, 'request_logs'), await count(b, 'request_logs'));
  const ids = await Promise.all([a, b].map(async (node) => (await node.db.$queryRawUnsafe('SELECT node_id FROM cluster_node'))[0].node_id));
  assert.notEqual(ids[0], ids[1]);
});

// ─── Live replication ────────────────────────────────────────────────────────

test('changes replicate in both directions within moments', async () => {
  const created = await cluster.request(b, 'POST', '/users/ben/todos', { token: users.ben.token, body: { title: 'auf B angelegt' } });
  assert.equal(created.status, 201, created.text);
  await waitFor(async () => (await todosOf(a, users.ben)).some((todo) => todo.title === 'auf B angelegt'), { timeoutMs: 10_000, label: 'B → A' });

  const [first] = await todosOf(a, users.anna);
  const patched = await cluster.request(a, 'PATCH', `/users/anna/todos/${first.id}`, { token: users.anna.token, body: { done: true, title: 'geändert auf A' } });
  assert.equal(patched.status, 200, patched.text);
  await waitFor(async () => (await todosOf(b, users.anna)).find((todo) => todo.id === first.id)?.title === 'geändert auf A', { timeoutMs: 10_000, label: 'A → B update' });

  // A change of capitalisation only is still a change.
  await cluster.request(a, 'PATCH', `/users/anna/todos/${first.id}`, { token: users.anna.token, body: { title: 'GEÄNDERT AUF A' } });
  await waitFor(async () => (await todosOf(b, users.anna)).find((todo) => todo.id === first.id)?.title === 'GEÄNDERT AUF A', { timeoutMs: 10_000, label: 'case-only update' });

  const removed = await cluster.request(b, 'DELETE', `/users/anna/todos/${first.id}`, { token: users.anna.token });
  assert.equal(removed.status, 204);
  await waitFor(async () => !(await todosOf(a, users.anna)).some((todo) => todo.id === first.id), { timeoutMs: 10_000, label: 'B → A delete' });
  await cluster.converged([a, b]);
});

test('a live update reaches a browser connected to another node', async () => {
  const controller = new AbortController();
  const res = await fetch(`${b.url}/sse/todos?token=${users.anna.token}&apiKey=${cluster.secrets.apiKey}`, { signal: controller.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  let received = '';
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      received += Buffer.from(value).toString('utf8');
    }
  })();
  try {
    await waitFor(() => received.includes('event: todos'), { label: 'initial list' });
    const created = await cluster.request(a, 'POST', '/users/anna/todos', { token: users.anna.token, body: { title: 'live von A' } });
    assert.equal(created.status, 201);
    await waitFor(() => received.includes('live von A'), { timeoutMs: 10_000, label: 'the event on the other node' });
  } finally {
    controller.abort();
    await pump;
  }
});

test('a reordered list arrives intact', async () => {
  const reversed = [...sectionIds].reverse();
  const res = await cluster.request(a, 'POST', `/learn/courses/${courseId}/sections/reorder`, { token: users.anna.token, body: { sectionIds: reversed } });
  assert.equal(res.status, 200, res.text);
  await cluster.converged([a, b]);
  const rows = await b.db.$queryRawUnsafe('SELECT id FROM learn_course_sections WHERE course_id = ? ORDER BY sort_order', courseId);
  assert.deepEqual(rows.map((row) => row.id), reversed);
});

test('writes that bypass the application are captured as well', async () => {
  // A changed primary key, done directly in SQL.
  await a.db.$executeRawUnsafe("UPDATE dish_ratings SET stable_uid = 'legacy-uid' WHERE stable_uid = ?", users.anna.user.stableUid);
  await cluster.converged([a, b]);
  const rows = await b.db.$queryRawUnsafe('SELECT stable_uid FROM dish_ratings');
  assert.deepEqual(rows.map((row) => row.stable_uid), ['legacy-uid']);
});

test('deleting a parent removes its dependants everywhere', async () => {
  const before = Number((await b.db.$queryRawUnsafe('SELECT COUNT(*) AS c FROM comments'))[0].c);
  assert.ok(before > 0);
  assert.equal((await cluster.admin(a, 'DELETE', `/classes/${classId}`)).status, 204);
  await cluster.converged([a, b]);
  for (const table of ['classes', 'class_members', 'reminders', 'comments']) {
    assert.equal(Number((await b.db.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM \`${table}\``))[0].c), 0, table);
  }
});

// ─── What travels over the network ───────────────────────────────────────────

test('nothing readable crosses the network, and recorded traffic is useless', async () => {
  const frames = wire.captured.filter((entry) => entry.url === '/cluster/v1/rpc');
  assert.ok(frames.length > 5, 'replication traffic was recorded');
  for (const entry of wire.captured) {
    assert.equal(entry.body.includes(Buffer.from(MARKER)), false, 'row content must never be sent in the clear');
    assert.equal(entry.body.includes(Buffer.from('anna')), false);
    assert.equal(entry.body.includes(Buffer.from(cluster.secrets.jwt)), false);
  }

  const send = (body) => fetch(`${b.url}/cluster/v1/rpc`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body });
  const last = frames[frames.length - 1].body;

  // Replaying a genuine frame is refused: its counter was already used.
  assert.equal((await send(last)).status, 401);

  // So is a frame with a single flipped bit …
  const flipped = Buffer.from(last);
  flipped[flipped.length - 5] ^= 0x01;
  assert.equal((await send(flipped)).status, 401);

  // … a genuine frame claiming a fresh counter …
  const recounted = Buffer.from(last);
  recounted.writeBigUInt64BE(recounted.readBigUInt64BE(16) + 1000n, 16);
  assert.equal((await send(recounted)).status, 401);

  // … and anything from someone without a session.
  assert.equal((await send(Buffer.alloc(64, 7))).status, 401);
  assert.equal((await send(Buffer.alloc(8))).status, 400);

  // A recorded session handshake does not open a usable session either.
  const handshake = wire.captured.filter((entry) => entry.url === '/cluster/v1/session').pop();
  assert.ok(handshake);
  const replayed = await fetch(`${b.url}/cluster/v1/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: handshake.body });
  if (replayed.status === 200) {
    const { sid } = await replayed.json();
    const forged = Buffer.concat([Buffer.from(sid, 'base64url'), Buffer.alloc(8), Buffer.alloc(48, 1)]);
    assert.equal((await send(forged)).status, 401, 'without the ephemeral key the session cannot be used');
  }
  const tampered = JSON.parse(handshake.body.toString());
  tampered.from = '00000000-0000-4000-8000-000000000000';
  const unknown = await fetch(`${b.url}/cluster/v1/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tampered) });
  assert.ok([403, 404].includes(unknown.status));

  // The application's own API key does not open the cluster channel.
  const withApiKey = await fetch(`${b.url}/cluster/v1/rpc`, { method: 'POST', headers: { 'x-api-key': cluster.secrets.apiKey, 'content-type': 'application/octet-stream' }, body: Buffer.alloc(64, 1) });
  assert.equal(withApiKey.status, 401);

  // And replication is unharmed by all of the above.
  await cluster.request(a, 'POST', '/users/anna/todos', { token: users.anna.token, body: { title: 'nach dem Angriff' } });
  await waitFor(async () => (await todosOf(b, users.anna)).some((todo) => todo.title === 'nach dem Angriff'), { timeoutMs: 10_000, label: 'replication after the probes' });
});

// ─── Three nodes ─────────────────────────────────────────────────────────────

test('a third node paired with only one of them still receives everything', async () => {
  await cluster.pair(b, c);
  await cluster.waitPaired(b, c);
  await cluster.converged([a, b, c], { timeoutMs: 90_000, label: 'the third node to receive the data' });

  // A change on A reaches C although A and C have never been paired.
  await cluster.request(a, 'POST', '/users/anna/todos', { token: users.anna.token, body: { title: 'über B weitergereicht' } });
  await waitFor(async () => (await todosOf(c, users.anna)).some((todo) => todo.title === 'über B weitergereicht'), { timeoutMs: 15_000, label: 'A → B → C' });

  const status = await cluster.status(b);
  const seenFromB = cluster.peerOf(status, c);
  assert.ok(seenFromB.warnings.some((warning) => warning.includes('SERVER_KEY differs')), JSON.stringify(seenFromB.warnings));
  assert.equal(cluster.peerOf(status, a).warnings.length, 0, JSON.stringify(cluster.peerOf(status, a).warnings));
});

test('all nodes agree on one leader', async () => {
  await cluster.pair(a, c);
  await cluster.waitPaired(a, c);
  await cluster.converged([a, b, c]);
  await waitFor(async () => {
    const statuses = await Promise.all([a, b, c].map((node) => cluster.status(node)));
    const leaders = new Set(statuses.map((status) => status.node.leaderId));
    return leaders.size === 1 && statuses.filter((status) => status.node.isLeader).length === 1;
  }, { label: 'a single leader' });
});

// ─── Failure and recovery ────────────────────────────────────────────────────

test('an offline node is detected, the others carry on, and it catches up', async () => {
  const before = await cluster.status(a);
  const leaderBefore = before.node.leaderId;
  const idOfB = cluster.peerOf(before, b).nodeId;

  await cluster.stop(b, 'SIGKILL');
  const downAt = Date.now();
  await waitFor(async () => cluster.peerOf(await cluster.status(a), b).health === 'SUSPECT' || cluster.peerOf(await cluster.status(a), b).health === 'OFFLINE', { timeoutMs: 15_000, label: 'B to be suspected' });
  await waitFor(async () => cluster.peerOf(await cluster.status(a), b).health === 'OFFLINE' && cluster.peerOf(await cluster.status(c), b).health === 'OFFLINE', { timeoutMs: 20_000, label: 'B to be reported offline' });
  assert.ok(Date.now() - downAt < 20_000);
  assert.ok((await cluster.status(a)).events.some((event) => event.message.includes('offline')));

  // Exactly one of the remaining nodes leads.
  await waitFor(async () => {
    const statuses = await Promise.all([a, c].map((node) => cluster.status(node)));
    const leaders = new Set(statuses.map((status) => status.node.leaderId));
    return leaders.size === 1 && !leaders.has(idOfB) && statuses.filter((status) => status.node.isLeader).length === 1;
  }, { label: 'leadership without B' });
  if (leaderBefore === idOfB) assert.notEqual((await cluster.status(a)).node.leaderId, idOfB);

  // Work continues without B and is queued for it.
  for (let i = 0; i < 5; i++) {
    await cluster.request(a, 'POST', '/users/anna/todos', { token: users.anna.token, body: { title: `während B fehlt ${i}` } });
  }
  await cluster.request(c, 'POST', '/users/ben/todos', { token: users.ben.token, body: { title: 'auf C während B fehlt' } });
  await cluster.converged([a, c]);
  assert.ok(cluster.peerOf(await cluster.status(a), b).queuedRows > 0);

  await cluster.start(b);
  await cluster.waitPaired(a, b);
  await cluster.converged([a, b, c], { timeoutMs: 60_000, label: 'B to catch up' });
  assert.ok((await todosOf(b, users.anna)).some((todo) => todo.title === 'während B fehlt 4'));
  assert.equal(cluster.peerOf(await cluster.status(a), b).queuedRows, 0);
});

test('a revoked session is rejected on every node, and stays rejected after a restart', async () => {
  const carla = await cluster.login(a, 'carla');
  await cluster.converged([a, b, c]);
  assert.equal((await cluster.request(b, 'GET', '/auth/me', { token: carla.token })).status, 200);

  // Token timestamps have one-second resolution.
  await sleep(1_100);
  const reset = await cluster.admin(a, 'PATCH', `/users/${carla.user.stableUid}/password`, { password: 'neues-passwort-123' });
  assert.equal(reset.status, 204, reset.text);
  assert.equal((await cluster.request(a, 'GET', '/auth/me', { token: carla.token })).status, 401);
  await waitFor(async () => (await cluster.request(b, 'GET', '/auth/me', { token: carla.token })).status === 401, { timeoutMs: 10_000, label: 'the revocation on B' });
  await waitFor(async () => (await cluster.request(c, 'GET', '/auth/me', { token: carla.token })).status === 401, { timeoutMs: 10_000, label: 'the revocation on C' });

  await cluster.stop(a);
  await cluster.start(a);
  assert.equal((await cluster.request(a, 'GET', '/auth/me', { token: carla.token })).status, 401, 'a restart must not re-admit a revoked token');
  await cluster.waitPaired(a, b);
  await cluster.waitPaired(a, c);
});

// ─── Concurrent, conflicting work on separated nodes ─────────────────────────

test('nodes that were separated converge on one consistent state', async () => {
  await cluster.converged([a, b, c]);
  const target = (await todosOf(a, users.anna)).find((todo) => todo.title === 'Vokabeln');
  const doomed = (await todosOf(a, users.anna)).find((todo) => todo.title === 'Mathe lernen');
  assert.ok(target && doomed);

  // Cut A off from B and C.
  const sa = await cluster.status(a);
  for (const peer of sa.peers) {
    assert.equal((await cluster.admin(a, 'PATCH', `/cluster/peers/${peer.id}`, { enabled: false })).status, 200);
  }
  await waitFor(async () => cluster.peerOf(await cluster.status(b), a).health === 'OFFLINE', { timeoutMs: 20_000, label: 'the separation to be noticed' });

  // The same row edited on both sides: the later edit wins.
  await cluster.request(a, 'PATCH', `/users/anna/todos/${target.id}`, { token: users.anna.token, body: { title: 'Stand von A' } });
  await sleep(50);
  await cluster.request(b, 'PATCH', `/users/anna/todos/${target.id}`, { token: users.anna.token, body: { title: 'Stand von B (später)' } });

  // Deleted on one side, edited later on the other: the later edit wins.
  await cluster.request(a, 'DELETE', `/users/anna/todos/${doomed.id}`, { token: users.anna.token });
  await sleep(50);
  await cluster.request(c, 'PATCH', `/users/anna/todos/${doomed.id}`, { token: users.anna.token, body: { details: 'auf C weiterbearbeitet' } });

  // The same account created independently on both sides.
  const onA = await cluster.login(a, 'doppelt');
  await sleep(50);
  const onB = await cluster.login(b, 'doppelt');
  assert.notEqual(onA.user.stableUid, onB.user.stableUid);
  await cluster.request(a, 'POST', '/users/doppelt/todos', { token: onA.token, body: { title: 'gehört dem ersten Konto' } });
  await cluster.request(b, 'POST', '/users/doppelt/todos', { token: onB.token, body: { title: 'gehört dem zweiten Konto' } });

  // A new list entry at the same position on both sides.
  const sectionA = await cluster.request(a, 'POST', `/learn/courses/${courseId}/sections`, { token: users.anna.token, body: { title: 'neu auf A' } });
  const sectionB = await cluster.request(b, 'POST', `/learn/courses/${courseId}/sections`, { token: users.anna.token, body: { title: 'neu auf B' } });
  assert.equal(sectionA.status, 201, sectionA.text);
  assert.equal(sectionB.status, 201, sectionB.text);
  assert.equal(sectionA.json.sortOrder, sectionB.json.sortOrder);

  // Two different courses that picked the same address.
  const courseA = await cluster.request(a, 'POST', '/learn/courses', { token: users.anna.token, body: { title: 'Kurs von A', slug: 'gleiche-adresse' } });
  const courseB = await cluster.request(b, 'POST', '/learn/courses', { token: users.ben.token, body: { title: 'Kurs von B', slug: 'gleiche-adresse' } });
  assert.equal(courseA.status, 201, courseA.text);
  assert.equal(courseB.status, 201, courseB.text);

  // Reconnect.
  for (const peer of sa.peers) {
    assert.equal((await cluster.admin(a, 'PATCH', `/cluster/peers/${peer.id}`, { enabled: true })).status, 200);
  }
  await cluster.waitPaired(a, b);
  await cluster.waitPaired(a, c);
  await cluster.converged([a, b, c], { timeoutMs: 120_000, label: 'the separated nodes to converge' });

  for (const node of [a, b, c]) {
    const todos = await node.db.$queryRawUnsafe('SELECT id, title, details FROM todos WHERE id IN (?, ?)', target.id, doomed.id);
    assert.equal(todos.find((todo) => todo.id === target.id).title, 'Stand von B (später)', node.name);
    assert.equal(todos.find((todo) => todo.id === doomed.id)?.details, 'auf C weiterbearbeitet', node.name);

    const accounts = await node.db.$queryRawUnsafe("SELECT stable_uid FROM users WHERE username = 'doppelt'");
    assert.equal(accounts.length, 1, `${node.name}: exactly one account may remain`);
    assert.equal(accounts[0].stable_uid, onA.user.stableUid, `${node.name}: the account created first is kept`);
    const owned = await node.db.$queryRawUnsafe('SELECT title FROM todos WHERE stable_uid IN (?, ?)', onA.user.stableUid, onB.user.stableUid);
    assert.deepEqual(owned.map((todo) => todo.title), ['gehört dem ersten Konto'], node.name);

    const sections = await node.db.$queryRawUnsafe('SELECT title, sort_order FROM learn_course_sections WHERE course_id = ? ORDER BY sort_order', courseId);
    assert.equal(sections.length, 5, `${node.name}: both new entries are kept`);
    assert.equal(new Set(sections.map((section) => section.sort_order)).size, 5, `${node.name}: every position is unique`);
    assert.ok(sections.some((section) => section.title === 'neu auf A') && sections.some((section) => section.title === 'neu auf B'));

    const courses = await node.db.$queryRawUnsafe("SELECT title, slug FROM learn_courses WHERE slug LIKE 'gleiche-adresse%' ORDER BY title");
    assert.deepEqual(courses.map((course) => course.title), ['Kurs von A', 'Kurs von B'], `${node.name}: both courses are kept`);
    assert.equal(new Set(courses.map((course) => course.slug)).size, 2, `${node.name}: their addresses differ now`);
    assert.ok(courses.some((course) => course.slug === 'gleiche-adresse'), `${node.name}: one course keeps the address`);
  }
});

// ─── Backup and restore inside a cluster ─────────────────────────────────────

test('a restored backup wins cluster-wide while newer rows are kept', async (t) => {
  await cluster.converged([a, b, c]);
  const kept = (await todosOf(a, users.ben)).find((todo) => todo.title === 'auf B angelegt');
  assert.ok(kept);
  const backup = await cluster.admin(a, 'POST', '/backups/run');
  if (backup.status !== 201) {
    t.skip(`backup tooling is not usable on this machine: ${backup.text}`);
    return;
  }

  // After the backup: one row is deleted, one edited, one newly created.
  await cluster.request(b, 'DELETE', `/users/ben/todos/${kept.id}`, { token: users.ben.token });
  const edited = (await todosOf(c, users.anna)).find((todo) => todo.title === 'Stand von B (später)');
  await cluster.request(c, 'PATCH', `/users/anna/todos/${edited.id}`, { token: users.anna.token, body: { title: 'nach dem Backup geändert' } });
  await cluster.request(b, 'POST', '/users/ben/todos', { token: users.ben.token, body: { title: 'nach dem Backup angelegt' } });
  await cluster.converged([a, b, c]);
  assert.equal((await todosOf(a, users.ben)).some((todo) => todo.id === kept.id), false);

  const restore = await cluster.admin(a, 'POST', `/backups/${backup.json.filename}/restore`, { confirmation: backup.json.filename });
  assert.equal(restore.status, 200, restore.text);
  assert.ok(await triggerCount(a) > 0, 'change capture is re-installed after the restore');
  await cluster.converged([a, b, c], { timeoutMs: 120_000, label: 'the restored state to spread' });

  for (const node of [a, b, c]) {
    const ben = await node.db.$queryRawUnsafe('SELECT title FROM todos WHERE stable_uid = ?', users.ben.user.stableUid);
    const titles = ben.map((todo) => todo.title);
    assert.ok(titles.includes('auf B angelegt'), `${node.name}: the deleted row is back`);
    assert.ok(titles.includes('nach dem Backup angelegt'), `${node.name}: a row created after the backup is kept`);
    const row = await node.db.$queryRawUnsafe('SELECT title FROM todos WHERE id = ?', edited.id);
    assert.equal(row[0].title, 'Stand von B (später)', `${node.name}: the edited row has its backup content`);
  }
  const status = await cluster.status(a);
  assert.equal(status.peers.filter((peer) => peer.status === 'ACTIVE').length, 2, 'the restore keeps the current peers');
});

// ─── Load ────────────────────────────────────────────────────────────────────

async function inParallel(tasks, concurrency) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  }));
  return results;
}

test('many simultaneous writers on two nodes neither fail nor block each other', async () => {
  await cluster.converged([a, b, c]);
  const writers = [];
  for (let i = 0; i < 20; i++) writers.push(await cluster.login(a, `last${i}`));
  await cluster.converged([a, b, c]);

  const tasks = [];
  for (const [index, writer] of writers.entries()) {
    const node = index % 2 === 0 ? a : b;
    const name = writer.user.username;
    tasks.push(async () => {
      const statuses = [];
      const ids = [];
      for (let round = 0; round < 6; round++) {
        const created = await cluster.request(node, 'POST', `/users/${name}/todos`, { token: writer.token, body: { title: `${name} ${round}`, details: 'x'.repeat(200) } });
        statuses.push(created.status);
        if (created.json?.id) ids.push(created.json.id);
      }
      for (const id of ids.slice(0, 4)) {
        statuses.push((await cluster.request(node, 'PATCH', `/users/${name}/todos/${id}`, { token: writer.token, body: { done: true, doneAt: new Date().toISOString() } })).status);
      }
      statuses.push((await cluster.request(node, 'DELETE', `/users/${name}/todos/${ids[0]}`, { token: writer.token })).status);
      statuses.push((await cluster.request(node, 'POST', `/dish-ratings/${dishId}`, { token: writer.token, body: { stars: 1 + (index % 5) } })).status);
      return statuses;
    });
  }
  // Meanwhile a list is reordered again and again on the third node.
  const order = (await c.db.$queryRawUnsafe('SELECT id FROM learn_course_sections WHERE course_id = ? ORDER BY sort_order', courseId)).map((row) => row.id);
  tasks.push(async () => {
    const statuses = [];
    for (let i = 0; i < 8; i++) {
      const rotated = [...order.slice(i % order.length), ...order.slice(0, i % order.length)];
      statuses.push((await cluster.request(c, 'POST', `/learn/courses/${courseId}/sections/reorder`, { token: users.anna.token, body: { sectionIds: rotated } })).status);
    }
    return statuses;
  });

  const logLengths = new Map([a, b, c].map((node) => [node, cluster.logText(node).length]));
  const startedAt = Date.now();
  const statuses = (await inParallel(tasks, 26)).flat();
  const failures = statuses.filter((status) => status >= 400);
  assert.deepEqual(failures, [], `${failures.length} of ${statuses.length} requests failed`);
  assert.ok(statuses.length >= 240);
  await cluster.converged([a, b, c], { timeoutMs: 90_000, label: 'the nodes to converge after the load' });
  assert.ok(Date.now() - startedAt < 90_000);

  // Replication must not make the database roll back anybody's transaction:
  // no lock conflict may have been reported while all of this was going on.
  for (const node of [a, b, c]) {
    const written = cluster.logText(node).slice(logLengths.get(node));
    assert.equal(/Deadlock|P2034|Lock wait timeout/i.test(written), false, `${node.name} reported a locking problem`);
  }
});

// ─── Data changed underneath the application ─────────────────────────────────

test('changes made while capture was missing are noticed and can be published', async () => {
  await cluster.converged([a, b, c]);
  const todo = (await todosOf(a, users.anna)).find((entry) => entry.title === 'nach dem Angriff');
  assert.ok(todo);

  // Simulate a manual restore: the triggers are gone and a row differs.
  await cluster.stop(a);
  const triggers = await a.db.$queryRawUnsafe("SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME LIKE 'pokyh\\_cl\\_%'");
  assert.ok(triggers.length > 0);
  cluster.runSql(a, triggers.map((trigger) => `DROP TRIGGER \`${trigger.name}\`;`).join('\n'));
  await a.db.$executeRawUnsafe("UPDATE todos SET title = 'direkt in der Datenbank geändert' WHERE id = ?", todo.id);
  await cluster.start(a);

  const status = await cluster.status(a);
  assert.equal(status.node.captureGap, true);
  assert.equal(status.node.captureReady, true);
  assert.ok(await triggerCount(a) > 0, 'capture is re-installed on start');
  assert.ok(status.events.some((event) => event.message.includes('Change capture was missing')));
  await cluster.waitPaired(a, b);
  await sleep(1_500);
  assert.equal((await b.db.$queryRawUnsafe('SELECT title FROM todos WHERE id = ?', todo.id))[0].title, 'nach dem Angriff', 'the unrecorded change is not replicated by itself');

  assert.equal((await cluster.admin(a, 'POST', '/cluster/rebuild', {})).status, 422, 'a rebuild needs an explicit confirmation');
  const rebuild = await cluster.admin(a, 'POST', '/cluster/rebuild', { confirmation: 'REBUILD' });
  assert.equal(rebuild.status, 200, rebuild.text);
  await cluster.waitPaired(a, c);
  await cluster.converged([a, b, c], { timeoutMs: 120_000, label: 'the rebuilt state to spread' });
  for (const node of [b, c]) {
    assert.equal((await node.db.$queryRawUnsafe('SELECT title FROM todos WHERE id = ?', todo.id))[0].title, 'direkt in der Datenbank geändert', node.name);
  }
  assert.equal((await cluster.status(a)).node.captureGap, false);
});

test('a peer returning after a very long absence is held until an administrator decides', async () => {
  await cluster.converged([a, b, c]);
  await cluster.stop(a);
  await a.db.$executeRawUnsafe('UPDATE cluster_peers SET last_synced_at = DATE_SUB(NOW(), INTERVAL 60 DAY) WHERE address LIKE ?', `%:${wire.port}`);
  await cluster.start(a);
  await waitFor(async () => cluster.peerOf(await cluster.status(a), b)?.health === 'ONLINE', { label: 'A to reach B again' });

  const held = cluster.peerOf(await cluster.status(a), b);
  assert.ok(held.warnings.some((warning) => warning.includes('longer than deleted rows')), JSON.stringify(held.warnings));

  // Nothing flows over the held link in either direction …
  await cluster.request(a, 'POST', '/users/anna/todos', { token: users.anna.token, body: { title: 'während der Sperre' } });
  await sleep(2_000);
  assert.ok(cluster.peerOf(await cluster.status(a), b).queuedRows > 0);

  // … until the administrator confirms.
  const refused = await cluster.admin(a, 'POST', `/cluster/peers/${held.id}/resync`, {});
  assert.equal(refused.status, 409);
  const accepted = await cluster.admin(a, 'POST', `/cluster/peers/${held.id}/resync`, { acceptStale: true });
  assert.equal(accepted.status, 200, accepted.text);
  await cluster.waitPaired(a, c);
  await cluster.converged([a, b, c], { timeoutMs: 120_000, label: 'the held link to catch up' });
  assert.equal(cluster.peerOf(await cluster.status(a), b).warnings.some((warning) => warning.includes('longer than deleted rows')), false);
});

// ─── Nodes on different versions ─────────────────────────────────────────────

test('replication pauses with a node whose database schema differs', async () => {
  // Stands in for a node that has not been upgraded yet: it replicates a
  // different set of tables, so its schema fingerprint differs.
  const d = await cluster.addNode('d', { CLUSTER_EXCLUDE_TABLES: 'popups' });
  await cluster.start(d);
  await cluster.pair(b, d);
  await waitFor(async () => {
    const [sb, sd] = await Promise.all([cluster.status(b), cluster.status(d)]);
    return cluster.peerOf(sb, d)?.health === 'ONLINE' && cluster.peerOf(sd, b)?.health === 'ONLINE';
  }, { timeoutMs: 60_000, label: 'the two nodes to see each other' });

  const seen = cluster.peerOf(await cluster.status(b), d);
  assert.equal(seen.schemaMatch, false);
  assert.ok(seen.warnings.some((warning) => warning.includes('Different database schema')), JSON.stringify(seen.warnings));

  // The link is healthy, but no row crosses it in either direction.
  await sleep(3_000);
  assert.equal(Number((await d.db.$queryRawUnsafe('SELECT COUNT(*) AS c FROM users'))[0].c), 0);
  assert.equal(cluster.peerOf(await cluster.status(b), d).fullTransfer, true, 'the transfer waits instead of being abandoned');

  const removed = await cluster.admin(b, 'DELETE', `/cluster/peers/${seen.id}`);
  assert.equal(removed.status, 204);
  await cluster.stop(d);
});

// ─── Removing a node ─────────────────────────────────────────────────────────

test('a removed peer is dropped on both sides', async () => {
  const status = await cluster.status(a);
  const peer = cluster.peerOf(status, c);
  assert.equal((await cluster.admin(a, 'DELETE', `/cluster/peers/${peer.id}`)).status, 204);
  assert.equal((await cluster.status(a)).peers.length, 1);
  await waitFor(async () => cluster.peerOf(await cluster.status(c), a)?.status === 'REMOVED', { label: 'C to learn it was removed' });

  // B is still paired with both, so the three keep converging.
  await cluster.request(a, 'POST', '/users/anna/todos', { token: users.anna.token, body: { title: 'nach dem Entfernen' } });
  await cluster.converged([a, b, c]);
  assert.equal((await cluster.admin(a, 'DELETE', `/cluster/peers/${peer.id}`)).status, 404);
});

test('no node logged a secret or crashed', async () => {
  for (const node of [a, b, c]) {
    assert.ok(node.process, `${node.name} is still running`);
    const log = cluster.logText(node);
    for (const secret of Object.values(cluster.secrets)) assert.equal(log.includes(secret), false, `${node.name} logged a secret`);
    assert.equal(/unhandled promise rejection|uncaughtException/i.test(log), false, `${node.name}:\n${cluster.logTail(node, 15)}`);
  }
});
