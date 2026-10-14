import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Cluster, REPO, sleep, waitFor } from './harness.mjs';

// End-to-end test of the leaderless update rollout (src/cluster/updates.ts)
// and of the edge forwarder in front of the channel (deploy/node/edge.mjs),
// with real backend processes. A small HTTPS server plays the git host; the
// test plays each node's updater (deploy/node/updater.mjs, which needs
// Docker): it answers the update requests the nodes write and "switches" a
// node by changing the commit of its build and restarting it.

const cluster = new Cluster();
const work = mkdtempSync(path.join(os.tmpdir(), 'pokyh-update-e2e-'));
const edge = await import(pathToFileURL(path.join(REPO, 'deploy/node/edge.mjs')).href);

const OLD = '1'.repeat(40);
const V2 = '2'.repeat(40);
const V3 = '3'.repeat(40);

let git;
let head = OLD;
let refsRequests = 0;
const nodes = [];
const updaters = new Map();
let edgeServer;

// ─── The git host ────────────────────────────────────────────────────────────

function pkt(text) {
  return `${(Buffer.byteLength(text) + 4).toString(16).padStart(4, '0')}${text}`;
}

function startGitHost() {
  const dir = path.join(work, 'tls');
  mkdirSync(dir);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-addext', 'basicConstraints=critical,CA:TRUE',
  ], { stdio: 'ignore' });
  const server = https.createServer({ key: readFileSync(path.join(dir, 'key.pem')), cert: readFileSync(path.join(dir, 'cert.pem')) }, (req, res) => {
    if (req.url !== '/team/pokyh.git/info/refs?service=git-upload-pack') {
      res.writeHead(404).end();
      return;
    }
    refsRequests += 1;
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
    res.end([
      pkt('# service=git-upload-pack\n'), '0000',
      pkt(`${head} HEAD\0symref=HEAD:refs/heads/main agent=git/test\n`),
      pkt(`${head} refs/heads/main\n`),
      pkt(`${'9'.repeat(40)} refs/heads/other\n`),
      '0000',
    ].join(''));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, ca: path.join(dir, 'cert.pem') })));
}

// ─── Nodes and their stand-in updaters ───────────────────────────────────────

// A node running from its own copy of the build, so its commit can change.
function prepareApp(name) {
  const appDir = path.join(work, name);
  for (const entry of ['dist', 'admin/dist', 'scripts', 'deploy']) {
    cpSync(path.join(REPO, entry), path.join(appDir, entry), { recursive: true });
  }
  for (const file of ['package.json', 'package-lock.json', 'entrypoint.sh']) cpSync(path.join(REPO, file), path.join(appDir, file));
  setCommit(appDir, OLD);
  const updateDir = path.join(appDir, 'update');
  mkdirSync(updateDir, { recursive: true });
  writeFileSync(path.join(updateDir, 'active'), 'blue\n');
  return { appDir, updateDir };
}

function setCommit(appDir, commit) {
  writeFileSync(path.join(appDir, 'dist', 'build-info.json'), `${JSON.stringify({ commit, builtAt: new Date().toISOString() })}\n`);
}

async function addNode(name, extra = {}) {
  const { appDir, updateDir } = prepareApp(name);
  const node = await cluster.addNode(name, {
    POKYH_UPDATE_DIR: updateDir,
    POKYH_COLOR: 'blue',
    POKYH_ACTIVATION_FILE: path.join(updateDir, 'active'),
    CLUSTER_UPDATE_REPO: `https://localhost:${git.port}/team/pokyh`,
    CLUSTER_UPDATE_BRANCH: 'main',
    CLUSTER_UPDATE_REQUIRE_CI: 'false',
    CLUSTER_UPDATE_SKIP_OFFLINE_MINUTES: '1',
    NODE_EXTRA_CA_CERTS: git.ca,
    ...extra,
  }, { mtls: true, appDir });
  node.appDir = appDir;
  node.updateDir = updateDir;
  nodes.push(node);
  return node;
}

// What the updater would do; `outcome(request)` decides: 'ok' or 'fail'.
// While `paused`, there is no updater at all (no heartbeat, no answers).
function standInUpdater(node, outcome, { paused = false } = {}) {
  const state = { requests: [], outcome, busy: false, paused };
  const beat = () => writeFileSync(path.join(node.updateDir, 'updater.json'), `${JSON.stringify({ at: new Date().toISOString(), active: 'blue' })}\n`);
  const status = (fields) => writeFileSync(path.join(node.updateDir, 'status.json'), `${JSON.stringify({ ...fields, at: new Date().toISOString() })}\n`);
  let lastId = null;
  if (!paused) beat();
  state.timer = setInterval(async () => {
    if (state.paused) return;
    beat();
    if (state.busy) return;
    let request;
    try { request = JSON.parse(readFileSync(path.join(node.updateDir, 'request.json'), 'utf8')); } catch { return; }
    if (request.id === lastId) return;
    lastId = request.id;
    state.busy = true;
    try {
      if (request.source === 'bundle') {
        const file = path.join(node.updateDir, `bundle-${request.sha256}.tgz`);
        const hash = existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
        request.bundleVerified = hash === request.sha256;
      }
      state.requests.push(request);
      const base = { id: request.id, commit: request.commit, source: request.source };
      status({ ...base, state: 'building', message: 'Building the new version' });
      await sleep(300);
      if (state.outcome(request) === 'fail') {
        status({ ...base, state: 'failed', message: 'the new version did not become healthy in time' });
        return;
      }
      status({ ...base, state: 'done', message: 'Running the new version as green' });
      setCommit(node.appDir, request.commit);
      await cluster.stop(node);
      await cluster.start(node);
    } finally {
      state.busy = false;
    }
  }, 300);
  updaters.set(node.name, state);
  return state;
}

async function updates(node) {
  const res = await cluster.admin(node, 'GET', '/cluster/updates');
  assert.equal(res.status, 200, res.text);
  return res.json;
}

before(async () => {
  git = await startGitHost();
  await cluster.startMysql();
}, { timeout: 600_000 });

after(async () => {
  for (const state of updaters.values()) clearInterval(state.timer);
  edgeServer?.close();
  git?.server.close();
  await cluster.teardown();
  if (!process.env.CLUSTER_E2E_KEEP) rmSync(work, { recursive: true, force: true });
}, { timeout: 120_000 });

// ─── A single node ───────────────────────────────────────────────────────────

test('a single node updates itself — no leader, no second node', async () => {
  const n1 = await addNode('u1');
  const updater = standInUpdater(n1, () => 'ok');
  await cluster.start(n1);
  const first = await updates(n1);
  assert.equal(first.self.commit, OLD);
  assert.equal(first.settings.repo, `https://localhost:${git.port}/team/pokyh`);
  assert.equal(first.settings.source, 'env');
  await waitFor(async () => (await updates(n1)).self.selfUpdating === true, { timeoutMs: 15_000, label: 'the updater to be seen' });

  // Nothing new on the branch: nothing happens.
  const checked = await cluster.admin(n1, 'POST', '/cluster/updates/check');
  assert.equal(checked.status, 200, checked.text);
  assert.equal(checked.json.upstream.commit, OLD);
  assert.equal(checked.json.target, OLD);
  await sleep(1_000);
  assert.equal(updater.requests.length, 0);

  head = V2;
  await cluster.admin(n1, 'POST', '/cluster/updates/check');
  await waitFor(() => updater.requests.length === 1, { timeoutMs: 60_000, label: 'the node to ask its updater for the new version' });
  assert.equal(updater.requests[0].source, 'git', 'nobody to take a build from: built from git');
  assert.equal(updater.requests[0].commit, V2);
  assert.equal(updater.requests[0].repo, `https://localhost:${git.port}/team/pokyh`);
  await waitFor(async () => (await updates(n1)).self.commit === V2, { timeoutMs: 60_000, label: 'the node to run the new version' });
  await waitFor(async () => {
    const after = await updates(n1);
    return after.self.state === 'done' && after.decision?.action === 'none';
  }, { timeoutMs: 40_000, label: 'the new process to read what the updater did' });
  assert.equal(updater.requests.length, 1, 'exactly one update');
});

// ─── Several nodes ───────────────────────────────────────────────────────────

test('new nodes on an older version catch up one after the other, with the build of a node that has it', async () => {
  const [n1] = nodes;
  const n2 = await addNode('u2');
  // The third node's channel is behind the edge forwarder (PROXY protocol).
  const n3 = await addNode('u3', { CLUSTER_MTLS_PROXY_PROTOCOL: 'true' });
  edgeServer = edge.createEdge({ targetHosts: ['app'], targetPort: n3.mtlsPort, connectTimeoutMs: 1000, maxConnections: 100, lookup: async () => [{ address: '127.0.0.1' }] });
  await new Promise((resolve) => edgeServer.listen(0, '127.0.0.1', resolve));
  const edgeUrl = `https://127.0.0.1:${edgeServer.address().port}`;
  Object.assign(n3.overrides, { CLUSTER_MTLS_URL: edgeUrl });
  n3.channelUrl = edgeUrl;

  // No updater on them yet (as on a server not set up by the installer):
  // they cannot update on their own before they are linked.
  const u2 = standInUpdater(n2, () => 'ok', { paused: true });
  const u3 = standInUpdater(n3, () => 'ok', { paused: true });
  await Promise.all([cluster.start(n2), cluster.start(n3)]);
  await cluster.pair(n1, n2);
  await cluster.pair(n1, n3);
  await cluster.waitPaired(n1, n2, 120_000);
  await cluster.waitPaired(n1, n3, 120_000);
  await cluster.waitPaired(n2, n3, 120_000);
  const s3 = await cluster.status(n3);
  assert.equal(cluster.peerOf(s3, n1).tls.locked, true, 'linked over the channel, through the edge');

  assert.equal((await updates(n2)).self.state, 'idle', 'without an updater, a node leaves its version alone');
  // Their updaters appear; the order for V2 decides who goes first.
  u2.paused = false;
  u3.paused = false;
  await waitFor(() => u2.requests.length + u3.requests.length >= 1, { timeoutMs: 90_000, label: 'the first of the two to update' });
  await sleep(2_000);
  assert.equal(u2.requests.length + u3.requests.length, 1, 'one at a time');
  const firstName = u2.requests.length === 1 ? 'u2' : 'u3';
  const firstRequest = updaters.get(firstName).requests[0];
  assert.equal(firstRequest.source, 'bundle', 'taken from the node that runs the new version');
  assert.equal(firstRequest.bundleVerified, true, 'the build arrived complete and matches its hash');
  await waitFor(() => u2.requests.length === 1 && u3.requests.length === 1, { timeoutMs: 120_000, label: 'the second one to follow' });
  const second = updaters.get(firstName === 'u2' ? 'u3' : 'u2').requests[0];
  assert.equal(second.source, 'bundle');
  assert.equal(second.bundleVerified, true);
  await waitFor(async () => (await updates(n2)).self.commit === V2 && (await updates(n3)).self.commit === V2, { timeoutMs: 120_000, label: 'both to run V2' });
});

test('a failed update stops the rollout where it happened, until an administrator decides', async () => {
  const [n1, n2, n3] = nodes;
  const ids = await Promise.all(nodes.map(async (node) => (await cluster.status(node)).node.id));
  // Who goes first for V3, computed the way every node does.
  const rank = (id) => createHash('sha256').update(`${V3}:${id}`).digest('hex');
  const order = [...ids].sort((x, y) => (rank(x) < rank(y) ? -1 : 1)).map((id) => nodes[ids.indexOf(id)]);
  const [first, second, third] = order;
  const counts = new Map(nodes.map((node) => [node.name, updaters.get(node.name).requests.length]));
  updaters.get(first.name).outcome = () => 'fail';

  head = V3;
  await Promise.all(nodes.map((node) => cluster.admin(node, 'POST', '/cluster/updates/check')));
  await waitFor(async () => (await updates(first)).self.state === 'failed', { timeoutMs: 90_000, label: 'the first node to report the failure' });
  const failed = await updates(first);
  assert.equal(failed.self.failed, V3);
  assert.equal(failed.self.commit, V2, 'still on its previous version');
  await waitFor(async () => (await updates(second)).decision?.action === 'blocked', { timeoutMs: 60_000, label: 'the next node to stop' });
  await sleep(20_000);
  assert.equal(updaters.get(second.name).requests.length, counts.get(second.name), 'the second node did not update');
  assert.equal(updaters.get(third.name).requests.length, counts.get(third.name), 'the third node did not update');
  assert.match((await updates(third)).decision.reason, /failed/);

  // The administrator fixed the cause and lets it try again.
  updaters.get(first.name).outcome = () => 'ok';
  assert.equal((await cluster.admin(first, 'POST', '/cluster/updates/retry')).status, 200);
  let last = [];
  try {
    await waitFor(async () => {
      last = await Promise.all(nodes.map((node) => updates(node)));
      return last.every((entry) => entry.self.commit === V3);
    }, { timeoutMs: 240_000, label: 'every node to run V3' });
  } catch (err) {
    const states = last.map((entry, index) => `${nodes[index].name}: ${entry.self.commit?.slice(0, 7)} ${entry.self.state} ${entry.decision?.action ?? '-'} (${entry.decision?.reason ?? entry.targetWhy})`);
    throw new Error(`${err.message}\n${states.join('\n')}`);
  }
  assert.equal(updaters.get(first.name).requests.at(-1).commit, V3);
  assert.ok([n1, n2, n3].every(Boolean));
});

test('update settings are shared by every node and checked strictly', async () => {
  const [n1, n2] = nodes;
  for (const body of [
    { repo: 'http://github.com/a/b', branch: 'main', auto: true, requireCi: false },
    { repo: 'https://user:pw@github.com/a/b', branch: 'main', auto: true, requireCi: false },
    { repo: 'https://github.com/a/b', branch: '../x', auto: true, requireCi: false },
    { repo: `https://localhost:${git.port}/team/pokyh`, branch: 'main', auto: true, requireCi: true },
  ]) {
    const res = await cluster.admin(n1, 'PUT', '/cluster/updates/settings', body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const saved = await cluster.admin(n1, 'PUT', '/cluster/updates/settings', { repo: `https://localhost:${git.port}/team/pokyh.git`, branch: 'main', auto: false, requireCi: false });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.repo, `https://localhost:${git.port}/team/pokyh`);
  await waitFor(async () => (await updates(n2)).settings.auto === false, { timeoutMs: 30_000, label: 'the settings to reach the other node' });

  // By hand: a new version waits for its release.
  const counts = nodes.map((node) => updaters.get(node.name).requests.length);
  head = '4'.repeat(40);
  await Promise.all(nodes.map((node) => cluster.admin(node, 'POST', '/cluster/updates/check')));
  const waiting = await updates(n2);
  assert.equal(waiting.target, null);
  assert.match(waiting.targetWhy, /released/);
  await sleep(16_000);
  assert.deepEqual(nodes.map((node) => updaters.get(node.name).requests.length), counts, 'nothing happens without a release');
  assert.equal((await cluster.admin(n1, 'POST', '/cluster/updates/release', { commit: '5'.repeat(40) })).status, 400, 'only the newest commit');
  assert.equal((await cluster.admin(n1, 'POST', '/cluster/updates/release', { commit: '4'.repeat(40) })).status, 200);
  await waitFor(async () => (await Promise.all(nodes.map((node) => updates(node)))).every((entry) => entry.self.commit === '4'.repeat(40)), { timeoutMs: 240_000, label: 'every node to run the released version' });
});

test('only administrators see or change updates', async () => {
  const [n1] = nodes;
  assert.equal((await cluster.request(n1, 'GET', '/api/admin/cluster/updates', { apiKey: false })).status, 401);
  const user = await cluster.login(n1, 'update-mallory');
  for (const [method, route] of [['GET', '/updates'], ['PUT', '/updates/settings'], ['POST', '/updates/rollback'], ['POST', '/updates/retry'], ['POST', '/updates/release']]) {
    const res = await cluster.request(n1, method, `/api/admin/cluster${route}`, { token: user.token, ...(method === 'GET' ? {} : { body: {} }) });
    assert.ok([401, 403].includes(res.status), `${route}: ${res.status}`);
  }
});

test('nothing of the updates leaked into the logs', async () => {
  for (const node of nodes) {
    const log = cluster.logText(node);
    assert.ok(!log.includes(cluster.secrets.jwt), `${node.name}: JWT secret`);
    assert.ok(/cluster_update_requested/.test(log), `${node.name}: the update is logged`);
  }
  assert.ok(refsRequests > 0);
});
