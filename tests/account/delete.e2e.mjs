import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Cluster } from '../cluster/harness.mjs';

// DELETE /users/me end to end: a real backend process and MySQL
// (tests/cluster/harness.mjs). Run with `npm run test:account` (builds first).

const cluster = new Cluster();
let node;
let devices = 0;

// Each sign-in is its own device, as the app sends its device id.
async function signIn(username) {
  devices += 1;
  // The app's sign-in, with its WebUntis session (the harness's stand-in).
  const res = await cluster.appLogin(node, username, {
    headers: { 'x-pokyh-device': `e2e-device-${String(devices).padStart(8, '0')}` },
  });
  assert.equal(res.status, 200, res.text);
  return { token: res.json.token, refreshToken: res.json.refreshToken, user: res.json.user };
}

const deleteMe = (token) => cluster.request(node, 'DELETE', '/users/me', { token });

before(async () => {
  await cluster.startMysql();
  node = await cluster.addNode('account', { ADMIN_USERNAMES: 'clusteradmin,owner.delete' });
  await cluster.start(node, { waitForCluster: false });
});

after(async () => {
  await cluster.teardown();
});

test('nobody deletes an account without signing in', async () => {
  assert.equal((await cluster.request(node, 'DELETE', '/users/me')).status, 401);
});

test('an account deletes itself and what POKYH keeps about it', async () => {
  const anna = await signIn('anna.delete');
  const other = await signIn('otto.delete');
  const uid = anna.user.stableUid;

  const todo = await cluster.request(node, 'POST', '/users/anna.delete/todos', { token: anna.token, body: { title: 'Lernen' } });
  assert.equal(todo.status, 201, todo.text);
  assert.equal((await cluster.request(node, 'PUT', '/privacy/usage-stats', { token: anna.token, body: { enabled: true } })).status < 300, true);

  // A class she founded, a reminder of hers with both people's comments on it, a comment
  // and a rating at the Mensa, and last year's archive.
  const klass = await node.db.class.create({
    data: { id: 'klasse-delete', name: '4A', code: 'DEL123', webuntisKlasseId: 4711, createdBy: uid, createdByName: 'anna.delete' },
  });
  await node.db.classMember.create({ data: { classId: klass.id, stableUid: uid, username: 'anna.delete' } });
  const reminder = await node.db.reminder.create({
    data: { classId: klass.id, title: 'Test', remindAt: new Date(Date.now() + 86_400_000), createdBy: uid, createdByName: 'anna.delete', createdByUsername: 'anna.delete' },
  });
  await node.db.comment.create({ data: { reminderId: reminder.id, classId: klass.id, stableUid: uid, username: 'anna.delete', body: 'von Anna' } });
  await node.db.comment.create({ data: { reminderId: reminder.id, classId: klass.id, stableUid: other.user.stableUid, username: 'otto.delete', body: 'von Otto' } });
  await node.db.dishComment.create({ data: { dishId: 'dish-1', stableUid: uid, username: 'anna.delete', body: 'lecker' } });
  await node.db.dishRating.create({ data: { dishId: 'dish-1', stableUid: uid, username: 'anna.delete', stars: 5 } });
  const year = await node.db.schoolYear.create({ data: { label: '2025/2026', startYear: 2025, rolledAt: new Date() } });
  await node.db.archivedTodo.create({ data: { schoolYearId: year.id, originalId: 'x', stableUid: uid, username: 'anna.delete', title: 'alt', createdAt: new Date() } });
  await node.db.archivedReminder.create({
    data: {
      schoolYearId: year.id, originalId: 'y', classId: klass.id, title: 'alt', remindAt: new Date(), createdBy: uid, createdByName: 'anna.delete', createdByUsername: 'anna.delete', createdAt: new Date(),
      commentsJson: JSON.stringify([
        { id: 'a', stableUid: uid, username: 'anna.delete', body: 'von Anna', createdAt: new Date().toISOString() },
        { id: 'b', stableUid: other.user.stableUid, username: 'otto.delete', body: 'von Otto', createdAt: new Date().toISOString() },
      ]),
    },
  });

  const res = await deleteMe(anna.token);
  assert.equal(res.status, 204, res.text);

  // Her token is dead, on every device.
  assert.equal((await cluster.request(node, 'GET', '/users/me', { token: anna.token })).status, 401);
  assert.equal((await cluster.request(node, 'POST', '/auth/refresh', { body: { refreshToken: anna.refreshToken } })).status >= 400, true);

  const db = node.db;
  assert.equal(await db.user.count({ where: { stableUid: uid } }), 0);
  assert.equal(await db.todo.count({ where: { stableUid: uid } }), 0);
  assert.equal(await db.refreshToken.count({ where: { stableUid: uid } }), 0);
  assert.equal(await db.loginEvent.count({ where: { stableUid: uid } }), 0);
  assert.equal(await db.classMember.count({ where: { stableUid: uid } }), 0);
  assert.equal(await db.privacyConsent.count({ where: { stableUid: uid } }), 0);
  assert.equal(await db.comment.count({ where: { stableUid: uid } }), 0);
  assert.equal(await db.dishComment.count({ where: { stableUid: uid } }), 0);
  assert.equal(await db.dishRating.count({ where: { stableUid: uid } }), 0);
  assert.equal(await db.requestAccountDay.count({ where: { stableUid: uid } }), 0);

  // The class keeps its reminder and Otto's comment, without her name.
  const kept = await db.reminder.findUnique({ where: { id: reminder.id }, include: { comments: true } });
  assert.equal(kept.createdBy, '');
  assert.equal(kept.createdByUsername, '');
  assert.equal(kept.createdByName, 'Gelöschtes Konto');
  assert.deepEqual(kept.comments.map((c) => c.body), ['von Otto']);
  assert.equal((await db.class.findUnique({ where: { id: klass.id } })).createdByName, 'Gelöschtes Konto');

  assert.equal(await db.archivedTodo.count({ where: { stableUid: uid } }), 0);
  const archived = await db.archivedReminder.findFirst({ where: { schoolYearId: year.id } });
  assert.equal(archived.createdByUsername, '');
  assert.ok(!archived.commentsJson.includes('anna.delete'));
  assert.ok(archived.commentsJson.includes('otto.delete'));

  // The audit trail says it happened, not who it was.
  const event = await waitForAudit(uid);
  assert.equal(event.actor, 'account');
  assert.ok(!JSON.stringify(event).includes('anna.delete'));

  // The delete itself doesn't put her back into the logs.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await db.requestLog.count({ where: { OR: [{ stableUid: uid }, { username: 'anna.delete' }] } }), 0);
  assert.equal(await db.requestAccountDay.count({ where: { stableUid: uid } }), 0);

  // Otto didn't notice.
  assert.equal((await cluster.request(node, 'GET', '/users/me', { token: other.token })).status, 200);
});

async function waitForAudit(id) {
  for (let i = 0; i < 40; i += 1) {
    const event = await node.db.adminAuditEvent.findFirst({ where: { action: 'user.self_delete', targetId: id } });
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('no audit event');
}

test('signing in again starts a new, empty account', async () => {
  const first = await signIn('berta.delete');
  await cluster.request(node, 'POST', '/users/berta.delete/todos', { token: first.token, body: { title: 'alt' } });
  assert.equal((await deleteMe(first.token)).status, 204);

  const again = await signIn('berta.delete');
  assert.notEqual(again.user.stableUid, first.user.stableUid);
  const todos = await cluster.request(node, 'GET', '/users/berta.delete/todos', { token: again.token });
  assert.deepEqual(todos.json, []);
  const history = await cluster.request(node, 'GET', '/users/me/export', { token: again.token });
  assert.equal(history.status, 200, history.text);
  assert.ok(!history.text.includes(first.user.stableUid));
});

test('admins stay until someone else takes their rights away', async () => {
  const admin = await signIn('admin.delete');
  await node.db.admin.create({ data: { stableUid: admin.user.stableUid } });
  const res = await deleteMe(admin.token);
  assert.equal(res.status, 403, res.text);
  assert.equal(await node.db.user.count({ where: { stableUid: admin.user.stableUid } }), 1);
  // Refused means nothing happened: still signed in.
  assert.equal((await cluster.request(node, 'GET', '/users/me', { token: admin.token })).status, 200);

  const owner = await signIn('owner.delete');
  assert.equal((await deleteMe(owner.token)).status, 403);
});

test('a token that deleted its account is dead right away, in the same second too', async () => {
  const { token, user } = await signIn('carla.delete');
  assert.equal((await deleteMe(token)).status, 204);
  assert.equal(await node.db.user.count({ where: { stableUid: user.stableUid } }), 0);
  assert.equal((await deleteMe(token)).status, 401);
});
