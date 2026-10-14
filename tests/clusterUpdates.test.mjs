import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadTs } from './helpers/loadTs.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const proxy = await loadTs('src/cluster/proxyProtocol.ts');
const rollout = await loadTs('src/cluster/rollout.ts');
const endpoints = await loadTs('src/cluster/endpoints.ts');
const edge = await import(pathToFileURL(path.join(REPO, 'deploy/node/edge.mjs')).href);
const updater = await import(pathToFileURL(path.join(REPO, 'deploy/node/updater.mjs')).href);

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

// ─── PROXY protocol ──────────────────────────────────────────────────────────

test('a PROXY line names the client and is consumed exactly', () => {
  const line = proxy.formatProxyHeader({ address: '203.0.113.7', port: 51234 }, { address: '10.0.0.2', port: 4100 });
  assert.equal(line, 'PROXY TCP4 203.0.113.7 10.0.0.2 51234 4100\r\n');
  const parsed = proxy.parseProxyHeader(Buffer.concat([Buffer.from(line), Buffer.from([0x16, 0x03, 0x01])]));
  assert.deepEqual(parsed, { status: 'ok', address: '203.0.113.7', port: 51234, length: line.length });
  assert.equal(proxy.formatProxyHeader({ address: '::ffff:198.51.100.1', port: 1 }, { address: '::ffff:10.0.0.2', port: 2 }), 'PROXY TCP4 198.51.100.1 10.0.0.2 1 2\r\n');
  assert.equal(proxy.formatProxyHeader({ address: '2001:db8::1', port: 1 }, { address: '2001:db8::2', port: 2 }), 'PROXY TCP6 2001:db8::1 2001:db8::2 1 2\r\n');
  assert.equal(proxy.formatProxyHeader({ address: '2001:db8::1', port: 1 }, { address: '10.0.0.2', port: 2 }), 'PROXY UNKNOWN\r\n');
  assert.deepEqual(proxy.parseProxyHeader(Buffer.from('PROXY UNKNOWN\r\n')), { status: 'ok', address: null, port: null, length: 15 });
});

test('anything that is not a clean PROXY line is told apart', () => {
  assert.equal(proxy.parseProxyHeader(Buffer.from([0x16, 0x03, 0x01, 0x00])).status, 'none', 'a TLS hello');
  assert.equal(proxy.parseProxyHeader(Buffer.from('PRO')).status, 'more');
  assert.equal(proxy.parseProxyHeader(Buffer.from('PROXY TCP4 1.2.3.4 5.6.7.8 1 2')).status, 'more');
  assert.equal(proxy.parseProxyHeader(Buffer.from(`PROXY TCP4 ${'1'.repeat(120)}`)).status, 'invalid', 'too long without an end');
  for (const bad of [
    'PROXY TCP4 1.2.3.4 5.6.7.8 1\r\n',
    'PROXY TCP4 2001:db8::1 5.6.7.8 1 2\r\n',
    'PROXY TCP6 1.2.3.4 5.6.7.8 1 2\r\n',
    'PROXY TCP4 1.2.3.4 5.6.7.8 99999 2\r\n',
    'PROXY TCP4 1.2.3.4 5.6.7.8 -1 2\r\n',
    'PROXY UDP4 1.2.3.4 5.6.7.8 1 2\r\n',
    'PROXY TCP4 1.2.3.999 5.6.7.8 1 2\r\n',
  ]) {
    assert.equal(proxy.parseProxyHeader(Buffer.from(bad)).status, 'invalid', bad.trim());
  }
});

// ─── The edge forwarder ──────────────────────────────────────────────────────

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}

function roundTrip(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('close', () => resolve(Buffer.concat(chunks)));
    // A refused hand-over may reset the connection: nothing arrived either way.
    socket.on('error', (err) => (err.code === 'ECONNRESET' ? resolve(Buffer.concat(chunks)) : reject(err)));
    socket.on('connect', () => socket.end(payload));
  });
}

test('the edge passes connections on unchanged, after a PROXY line naming the client', async () => {
  const received = [];
  const target = net.createServer((socket) => {
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => {
      received.push(Buffer.concat(chunks));
      socket.end('pong');
    });
  });
  const targetPort = await listen(target);
  // The first address refuses (a stopped colour), the second one answers.
  const closed = net.createServer();
  const closedPort = await listen(closed);
  await new Promise((resolve) => closed.close(resolve));
  const server = edge.createEdge({
    targetHosts: ['app'],
    targetPort,
    connectTimeoutMs: 1000,
    maxConnections: 10,
    lookup: async () => [{ address: '127.0.0.2' }, { address: '127.0.0.1' }],
  });
  const edgePort = await listen(server);
  try {
    const reply = await roundTrip(edgePort, Buffer.from([0x16, 0x03, 0x01, 0xff]));
    assert.equal(reply.toString(), 'pong');
    const header = proxy.parseProxyHeader(received[0]);
    assert.equal(header.status, 'ok');
    assert.equal(header.address, '127.0.0.1');
    assert.deepEqual([...received[0].subarray(header.length)], [0x16, 0x03, 0x01, 0xff], 'bytes after the line arrive untouched');
    assert.ok(closedPort > 0);
  } finally {
    server.close();
    target.close();
  }
});

test('the edge closes the connection when no app container accepts it', async () => {
  const server = edge.createEdge({ targetHosts: ['app'], targetPort: 1, connectTimeoutMs: 300, maxConnections: 10, lookup: async () => [{ address: '127.0.0.1' }] });
  const edgePort = await listen(server);
  try {
    const reply = await roundTrip(edgePort, 'hello');
    assert.equal(reply.length, 0);
  } finally {
    server.close();
  }
});

test('an address that went away does not hold the edge up', async () => {
  const target = net.createServer((socket) => socket.end('ok'));
  const port = await listen(target);
  try {
    // 192.0.2.1 (TEST-NET) never answers: the next address is tried in
    // parallel after the stagger, long before the first one times out.
    const started = Date.now();
    const socket = await edge.connectFirst(['192.0.2.1', '127.0.0.1'], port, { timeoutMs: 5000, staggerMs: 100 });
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
    assert.equal(socket.remoteAddress, '127.0.0.1');
    socket.destroy();
    await assert.rejects(edge.connectFirst(['127.0.0.1'], 1, { timeoutMs: 1000, staggerMs: 100 }), /no container/);
    await assert.rejects(edge.connectFirst([], port, { timeoutMs: 1000, staggerMs: 100 }), /no container/);
  } finally {
    target.close();
  }
});

test('the edge proxy line matches the cluster\'s parser', () => {
  const line = edge.proxyLine({ address: '::ffff:203.0.113.9', port: 40000 }, { address: '::ffff:172.18.0.5', port: 4100 });
  assert.deepEqual(proxy.parseProxyHeader(Buffer.from(line)), { status: 'ok', address: '203.0.113.9', port: 40000, length: line.length });
  assert.equal(edge.proxyLine({ address: undefined, port: 1 }, { address: '1.2.3.4', port: 2 }), 'PROXY UNKNOWN\r\n');
});

// ─── Where updates come from ─────────────────────────────────────────────────

test('repositories, branches and GitHub names are checked strictly', () => {
  assert.equal(rollout.normalizeRepo('https://github.com/bedchem/pokyh-backend.git'), 'https://github.com/bedchem/pokyh-backend');
  assert.equal(rollout.normalizeRepo(' https://github.com/bedchem/pokyh-backend/ '), 'https://github.com/bedchem/pokyh-backend');
  assert.equal(rollout.normalizeRepo(''), '');
  assert.equal(rollout.normalizeRepo('https://git.example.org:3000/team/app'), 'https://git.example.org:3000/team/app', 'self-hosted, own port');
  for (const bad of [
    'http://github.com/a/b',
    'https://user:pw@github.com/a/b',
    'https://github.com/a',
    'https://github.com/a/b?x=1',
    'https://github.com/a/../b',
    'git@github.com:a/b.git',
    'https://github.com/a/b c',
  ]) {
    assert.equal(rollout.normalizeRepo(bad), null, bad);
  }
  for (const good of ['main', 'release/2026-10', 'v1.2']) assert.equal(rollout.validBranch(good), true, good);
  for (const bad of ['', '/main', 'main/', 'a..b', 'a//b', 'x.lock', 'a b', 'a;b', `a${'b'.repeat(200)}`]) assert.equal(rollout.validBranch(bad), false, bad);
  assert.deepEqual(rollout.githubRepo('https://github.com/bedchem/pokyh-backend'), { owner: 'bedchem', name: 'pokyh-backend' });
  assert.equal(rollout.githubRepo('https://gitlab.com/bedchem/pokyh-backend'), null);
  assert.equal(rollout.githubRepo('https://github.com/a/b/c'), null);
});

function pkt(text) {
  return `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;
}

test('git\'s ref advertisement yields the branch heads', () => {
  const body = Buffer.from([
    pkt('# service=git-upload-pack\n'),
    '0000',
    pkt(`${A} HEAD\0multi_ack thin-pack side-band symref=HEAD:refs/heads/main agent=git/github\n`),
    pkt(`${A} refs/heads/main\n`),
    pkt(`${B} refs/heads/release/1\n`),
    pkt(`${'c'.repeat(40)} refs/pull/1/head\n`),
    '0000',
  ].join(''));
  const refs = rollout.parseAdvertisedRefs(body);
  assert.equal(refs.get('refs/heads/main'), A);
  assert.equal(refs.get('refs/heads/release/1'), B);
  assert.throws(() => rollout.parseAdvertisedRefs(Buffer.from('<html>not git</html>')), /not a git/);
  assert.throws(() => rollout.parseAdvertisedRefs(Buffer.from('00ff' + 'x'.repeat(10))), /truncated/);
});

test('GitHub\'s check runs decide whether a commit may roll out', () => {
  const runs = (...list) => ({ total_count: list.length, check_runs: list.map(([name, status, conclusion]) => ({ name, status, conclusion })) });
  assert.equal(rollout.ciFromCheckRuns(runs(['build', 'completed', 'success'], ['lint', 'completed', 'skipped'])).state, 'success');
  assert.equal(rollout.ciFromCheckRuns(runs(['build', 'in_progress', null])).state, 'pending');
  const failed = rollout.ciFromCheckRuns(runs(['build', 'completed', 'success'], ['test', 'completed', 'failure']));
  assert.equal(failed.state, 'failure');
  assert.match(failed.detail, /test/);
  assert.equal(rollout.ciFromCheckRuns(runs(['x', 'completed', 'cancelled'])).state, 'failure');
  assert.equal(rollout.ciFromCheckRuns({ total_count: 0, check_runs: [] }).state, 'none');
  assert.equal(rollout.ciFromCheckRuns({ total_count: 150, check_runs: runs(['a', 'completed', 'success']).check_runs }).state, 'pending', 'more runs than listed: not proven');
  assert.throws(() => rollout.ciFromCheckRuns({ message: 'Not Found' }), /malformed/);
});

// ─── The order ───────────────────────────────────────────────────────────────

const node = (id, overrides = {}) => ({ id, name: id, commit: A, selfUpdating: true, online: true, offlineForMs: 0, failed: null, updating: false, ...overrides });
const decide = (selfId, nodes) => rollout.decideRollout({ target: B, selfId, nodes, skipOfflineMs: 10 * 60_000 });

test('every node computes the same order, and it changes from version to version', () => {
  const ids = ['n1', 'n2', 'n3', 'n4', 'n5'];
  const first = rollout.rolloutOrder(B, ids);
  assert.deepEqual(rollout.rolloutOrder(B, [...ids].reverse()), first, 'independent of how a node lists them');
  assert.deepEqual([...first].sort(), ids);
  const orders = new Set(['1', '2', '3', '4', '5', '6', '7', '8'].map((digit) => rollout.rolloutOrder(digit.repeat(40), ids)[0]));
  assert.ok(orders.size > 1, 'a different node goes first for other versions');
});

test('a single node updates itself — no leader, no other node needed', () => {
  const decision = decide('solo', [node('solo')]);
  assert.equal(decision.action, 'update');
  assert.equal(decide('solo', [node('solo', { commit: B })]).action, 'none');
});

test('nodes update one after the other', () => {
  const ids = rollout.rolloutOrder(B, ['n1', 'n2', 'n3']);
  const [first, second, third] = ids;
  const all = (overrides) => ids.map((id) => node(id, overrides[id] ?? {}));
  assert.equal(decide(first, all({})).action, 'update');
  assert.equal(decide(second, all({})).action, 'wait');
  assert.match(decide(third, all({})).reason, new RegExp(first));
  assert.equal(decide(second, all({ [first]: { updating: true } })).action, 'wait');
  assert.equal(decide(second, all({ [first]: { commit: B } })).action, 'update');
  assert.equal(decide(third, all({ [first]: { commit: B } })).action, 'wait');
  assert.equal(decide(third, all({ [first]: { commit: B }, [second]: { commit: B } })).action, 'update');
  const states = decide(third, all({ [first]: { commit: B } })).order.map((entry) => entry.state);
  assert.deepEqual(states, ['done', 'next', 'waiting']);
});

test('nodes not updated by Pokyh, and nodes gone for long, are passed over', () => {
  const ids = rollout.rolloutOrder(B, ['n1', 'n2']);
  const [first, second] = ids;
  assert.equal(decide(second, [node(first, { selfUpdating: false }), node(second)]).action, 'update', 'e.g. a Dokploy node');
  assert.equal(decide(first, [node(first, { selfUpdating: false }), node(second)]).action, 'manual');
  assert.equal(decide(second, [node(first, { online: false, offlineForMs: 60_000 }), node(second)]).action, 'wait', 'briefly away: wait');
  assert.equal(decide(second, [node(first, { online: false, offlineForMs: 11 * 60_000 }), node(second)]).action, 'update', 'away for long: passed over');
});

test('a failed update stops the rollout where it happened', () => {
  const ids = rollout.rolloutOrder(B, ['n1', 'n2', 'n3']);
  const [first, second, third] = ids;
  const nodes = [node(first, { failed: B }), node(second), node(third)];
  const blocked = decide(second, nodes);
  assert.equal(blocked.action, 'blocked');
  assert.match(blocked.reason, /failed/);
  assert.equal(decide(third, nodes).action, 'blocked');
  assert.equal(decide(first, nodes).action, 'failed');
  assert.equal(decide(second, [node(first, { failed: A }), node(second), node(third)]).action, 'wait', 'an older failure does not count');
});

// ─── The updater ─────────────────────────────────────────────────────────────

const HOME = '/opt/pokyh';
function goodConfig() {
  const bind = (source, target) => ({ type: 'bind', source, target });
  const hardened = { cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'] };
  return {
    services: {
      mysql: { volumes: [bind(`${HOME}/.env`, '/run/configs/pokyh-backend.env'), { type: 'volume', source: 'mysql_data', target: '/var/lib/mysql' }] },
      redis: { ...hardened },
      'app-blue': { ...hardened, cap_add: ['CHOWN', 'SETUID', 'SETGID'], volumes: [bind(`${HOME}/data/bootstrap`, '/app/data/bootstrap'), bind(`${HOME}/data/update`, '/app/data/update')] },
      'app-green': { ...hardened, cap_add: ['CHOWN'], volumes: [bind(`${HOME}/data/update`, '/app/data/update')] },
      edge: { ...hardened, volumes: [bind(`${HOME}/runtime/edge.mjs`, '/edge/edge.mjs')], ports: [{ target: 4100, published: '4100' }] },
      caddy: { ...hardened, cap_add: ['NET_BIND_SERVICE'], volumes: [bind(`${HOME}/Caddyfile`, '/etc/caddy/Caddyfile')], ports: [{ target: 80, published: '80' }, { target: 443, published: '443' }] },
      updater: { image: 'pokyh-updater:local', security_opt: ['no-new-privileges:true'], network_mode: 'bridge', volumes: [bind('/var/run/docker.sock', '/var/run/docker.sock'), bind(HOME, HOME)] },
      ollama: { ...hardened },
    },
  };
}

test('a compose file shipped with an update can never give a service more power', () => {
  assert.deepEqual(updater.checkComposePolicy(goodConfig(), HOME), []);
  const violation = (change, pattern) => {
    const config = goodConfig();
    change(config.services);
    const problems = updater.checkComposePolicy(config, HOME);
    assert.ok(problems.some((problem) => pattern.test(problem)), `${pattern}: ${problems.join('; ')}`);
  };
  violation((s) => { s['app-blue'].privileged = true; }, /privileged/);
  violation((s) => { s['app-blue'].volumes.push({ type: 'bind', source: '/var/run/docker.sock', target: '/s' }); }, /Docker socket/);
  violation((s) => { s['app-blue'].volumes.push({ type: 'bind', source: '/', target: '/host' }); }, /host path/);
  violation((s) => { s['app-blue'].volumes.push({ type: 'bind', source: `${HOME}/runtime`, target: '/r' }); }, /host path/);
  violation((s) => { s.edge.volumes.push({ type: 'bind', source: `${HOME}`, target: '/h' }); }, /host path/);
  violation((s) => { s['app-blue'].cap_add.push('SYS_ADMIN'); }, /capabilities/);
  violation((s) => { s['app-blue'].network_mode = 'host'; }, /network_mode/);
  violation((s) => { s['app-blue'].pid = 'host'; }, /pid/);
  violation((s) => { s['app-blue'].devices = ['/dev/sda']; }, /devices/);
  violation((s) => { s['app-blue'].security_opt = []; }, /no-new-privileges/);
  violation((s) => { s['app-blue'].ports = [{ target: 4000, published: '4000' }]; }, /publishes/);
  violation((s) => { s.miner = {}; }, /unknown service/);
  violation((s) => { s.updater.image = 'pokyh-node:evil'; }, /unexpected image/);
  violation((s) => { s.updater.volumes.push({ type: 'bind', source: '/etc', target: '/etc' }); }, /host path/);
});

test('the updater changes only the settings it owns in compose.env', () => {
  const text = 'COMPOSE_PROJECT_NAME=pokyh\nCOMPOSE_PROFILES=blue,web,ai\nPOKYH_IMAGE_BLUE=abc\n';
  const changed = updater.updateEnvText(text, { POKYH_IMAGE_GREEN: 'def', POKYH_IMAGE_BLUE: 'xyz' });
  assert.equal(changed, 'COMPOSE_PROJECT_NAME=pokyh\nCOMPOSE_PROFILES=blue,web,ai\nPOKYH_IMAGE_BLUE=xyz\nPOKYH_IMAGE_GREEN=def\n');
  assert.equal(updater.readEnvFile(changed).get('POKYH_IMAGE_GREEN'), 'def');
  assert.equal(updater.swapProfile('blue,web,ai', 'blue', 'green'), 'green,web,ai');
  assert.equal(updater.swapProfile('web,green', 'green', 'blue'), 'blue,web');
});

// ─── The public setup address ────────────────────────────────────────────────

test('only a plain https origin (or loopback http) is a public address', () => {
  assert.equal(endpoints.publicOrigin('https://api.pokyh.com'), 'https://api.pokyh.com');
  assert.equal(endpoints.publicOrigin('https://api.pokyh.com/'), 'https://api.pokyh.com');
  assert.equal(endpoints.publicOrigin('https://api.pokyh.com:8443'), 'https://api.pokyh.com:8443');
  assert.equal(endpoints.publicOrigin('http://127.0.0.1:4000'), 'http://127.0.0.1:4000');
  for (const bad of ['http://api.pokyh.com', 'https://api.pokyh.com/admin', 'https://a@api.pokyh.com', 'https://api.pokyh.com/?x', 'ftp://x', 'nonsense']) {
    assert.equal(endpoints.publicOrigin(bad), null, bad);
  }
});
