import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Cluster, REPO, sleep, waitFor } from './harness.mjs';

// End-to-end test of the ways nodes reach each other: several endpoints per
// node, a real Pokyh relay process, and a proxy that routes TLS by server
// name. Node A plays the homelab: its only announced direct address is dead,
// so other nodes reach it through the relay (or the proxy). Run with
// `npm run test:cluster`.

const cluster = new Cluster();
const work = mkdtempSync(path.join(os.tmpdir(), 'pokyh-relay-e2e-'));
let a;
let b;
let relayProcess = null;
let relayPort;
let relayKey;
const DEAD = 'https://127.0.0.1:9';

function run(file, args, { input, env, cwd } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { env: env ?? process.env, cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function startRelay() {
  const dataDir = path.join(work, 'relay-data');
  mkdirSync(dataDir, { recursive: true });
  const log = path.join(work, 'relay.log');
  relayProcess = spawn(process.execPath, [path.join(REPO, 'deploy/relay/relay.mjs')], {
    env: { PATH: process.env.PATH ?? '', RELAY_DATA: dataDir, RELAY_PORT: String(relayPort), RELAY_BIND: '127.0.0.1', RELAY_PUBLIC: `https://127.0.0.1:${relayPort}`, RELAY_NAME: 'vps-test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relayProcess.stdout.on('data', (chunk) => appendFileSync(log, chunk));
  relayProcess.stderr.on('data', (chunk) => appendFileSync(log, chunk));
  await waitFor(() => { try { return readFileSync(path.join(dataDir, 'relay-key.txt'), 'utf8').trim(); } catch { return null; } },
    { timeoutMs: 15_000, label: 'the relay to start' });
  return readFileSync(path.join(dataDir, 'relay-key.txt'), 'utf8').trim();
}

async function stopRelay() {
  if (!relayProcess) return;
  const exited = new Promise((resolve) => relayProcess.once('exit', resolve));
  relayProcess.kill('SIGKILL');
  await exited;
  relayProcess = null;
}

async function reach(node) {
  const res = await cluster.admin(node, 'GET', '/cluster/reach');
  assert.equal(res.status, 200, res.text);
  return res.json;
}

function tokenOf(command) {
  return /sh pokyh-install\.sh '(pokyhnode1\.[A-Za-z0-9_-]+)'/.exec(command)[1];
}

function parseEnv(file) {
  const env = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    env[line.slice(0, at)] = line.slice(at + 1);
  }
  return env;
}

// A TCP proxy that routes TLS by server name without terminating it — the
// kind of proxy an administrator runs on a VPS in front of a homelab.
async function sniProxy(routes) {
  const server = net.createServer((client) => {
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      if (head.length < 5 || head.length < 5 + head.readUInt16BE(3)) return;
      client.off('data', onData);
      const text = head.toString('latin1');
      const target = Object.entries(routes).find(([name]) => text.includes(name));
      if (!target) { client.destroy(); return; }
      const upstream = net.connect(target[1], '127.0.0.1', () => { upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    };
    client.on('data', onData);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cluster.proxies.push(server);
  return server.address().port;
}

before(async () => {
  relayPort = await freePort();
  relayKey = await startRelay();
  await cluster.startMysql();
  // A: the homelab. Its direct address as announced is dead; only the relay
  // (added below) and later a proxy make it reachable.
  a = await cluster.addNode('a', { CLUSTER_MTLS_URL: '', CLUSTER_MTLS_ENDPOINTS: DEAD }, { mtls: true });
  await cluster.start(a);
}, { timeout: 600_000 });

after(async () => {
  await stopRelay();
  await cluster.teardown();
  if (!process.env.CLUSTER_E2E_KEEP) rmSync(work, { recursive: true, force: true });
}, { timeout: 120_000 });

test('the ways to reach a node are configured with checks, by administrators only', async () => {
  const user = await cluster.login(a, 'relay-mallory');
  assert.ok([401, 403].includes((await cluster.request(a, 'PUT', '/api/admin/cluster/reach', { token: user.token, body: { entries: [] } })).status));
  assert.ok([401, 403].includes((await cluster.request(a, 'POST', '/api/admin/cluster/relays', { token: user.token, body: { key: relayKey } })).status));
  for (const entries of [
    [{ kind: 'direct', endpoint: 'http://10.8.0.2:4100', enabled: true }],
    [{ kind: 'proxy-sni', endpoint: 'https://203.0.113.5:443', enabled: true }],
    [{ kind: 'proxy-port', endpoint: 'https://vps.example.org:4100', enabled: true, backend: '10.8.0.2:4100;evil' }],
    [{ kind: 'direct', endpoint: 'https://10.8.0.2:4100', enabled: true }, { kind: 'direct', endpoint: 'https://10.8.0.2:4100', enabled: true }],
  ]) {
    const res = await cluster.admin(a, 'PUT', '/cluster/reach', { entries });
    assert.equal(res.status, 400, JSON.stringify(entries));
  }
  const status = await reach(a);
  assert.deepEqual(status.effective, [DEAD]);
  assert.deepEqual(status.env, [DEAD]);
});

test('a relay key added once makes the node reachable through the relay', async () => {
  const added = await cluster.admin(a, 'POST', '/cluster/relays', { key: relayKey });
  assert.equal(added.status, 201, added.text);
  await waitFor(async () => (await reach(a)).relays[0]?.parked > 0, { timeoutMs: 20_000, label: 'A to park at the relay' });
  const status = await reach(a);
  const relay = status.relays[0];
  assert.equal(relay.name, 'vps-test');
  assert.equal(relay.error, null);
  assert.equal(status.effective[0], DEAD);
  assert.ok(status.effective.some((way) => way.startsWith(`https://127.0.0.1:${relayPort}?sni=`)), 'the relay way is announced');
  const row = await a.db.relay.findFirst();
  assert.ok(row && !row.keyEnc.includes(relayKey.slice(12, 40)), 'the key is stored encrypted');
});

test('a forged relay key is never used', async () => {
  const body = JSON.parse(Buffer.from(relayKey.slice('pokyhrelay1.'.length), 'base64url').toString());
  const impostorPin = createHash('sha256').update(randomBytes(32)).digest('base64');
  const forged = `pokyhrelay1.${Buffer.from(JSON.stringify({ ...body, f: impostorPin, n: 'forged' })).toString('base64url')}`;
  const added = await cluster.admin(a, 'POST', '/cluster/relays', { key: forged });
  assert.equal(added.status, 201);
  await waitFor(async () => (await reach(a)).relays.find((relay) => relay.name === 'forged')?.error, { timeoutMs: 20_000, label: 'the forged relay to be refused' });
  const forgedStatus = (await reach(a)).relays.find((relay) => relay.name === 'forged');
  assert.match(forgedStatus.error, /certificate other than the one in its key/);
  assert.equal(forgedStatus.parked, 0);
  assert.equal((await cluster.admin(a, 'DELETE', `/cluster/relays/${added.json.id}`)).status, 200);
});

test('curl reaches the homelab through the relay with the server name, pinned', async () => {
  const created = await cluster.admin(a, 'POST', '/cluster/node-installs', { domain: 'node-b.example.org', name: 'Node B' });
  assert.equal(created.status, 201, created.text);
  const relayWay = (await reach(a)).effective.find((way) => way.includes('?sni='));
  const route = new URL(relayWay).searchParams.get('sni');
  const dir = mkdtempSync(path.join(work, 'curl-'));
  const fetched = await run('curl', ['-fsSk', '--proto', '=https', '--pinnedpubkey', `sha256//${created.json.pin}`,
    '--connect-to', `${route}:${relayPort}:127.0.0.1:${relayPort}`, '-o', 'pokyh-install.sh', `https://${route}:${relayPort}/cluster/v1/install.sh`], { cwd: dir });
  assert.equal(fetched.code, 0, fetched.stderr);
  assert.equal(createHash('sha256').update(readFileSync(path.join(dir, 'pokyh-install.sh'))).digest('hex'), created.json.scriptSha256);
  a.installCommand = created.json.command;
});

test('a server installed through the relay joins, and the relay setting reaches it without any configuration', async () => {
  const out = path.join(work, 'node-b');
  mkdirSync(out);
  const result = await run(process.execPath, [path.join(REPO, 'deploy/node/bootstrap.mjs')], {
    input: tokenOf(a.installCommand),
    env: { PATH: process.env.PATH ?? '', POKYH_OUT: out, POKYH_APP_UID: String(process.getuid()), POKYH_MEM_KB: '16000000', POKYH_CPUS: '4' },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Connected to https://127\\.0\\.0\\.1:${relayPort}`), 'the dead way was passed over, the relay used');
  const appDir = path.join(out, 'app');
  mkdirSync(appDir);
  assert.equal((await run('tar', ['-xzf', path.join(out, 'state/bundle.tgz'), '-C', appDir, '--strip-components=1'])).code, 0);
  const env = parseEnv(path.join(out, '.env'));
  for (const key of Object.keys(env)) {
    if (/^(PORT|DATABASE_URL|DB_.*|MYSQL_ROOT_PASSWORD|CLUSTER_MTLS_.*|CLUSTER_ADVERTISE_URL|CLUSTER_BOOTSTRAP_DIR)$/.test(key)) delete env[key];
  }
  b = await cluster.addNode('b', { ...env, CLUSTER_BOOTSTRAP_DIR: path.join(out, 'data/bootstrap') }, { mtls: true, appDir });
  b.overrides.CLUSTER_ADVERTISE_URL = b.channelUrl;
  await cluster.start(b);
  await cluster.waitPaired(a, b, 120_000);
  await cluster.converged([a, b], { timeoutMs: 120_000 });

  const reachB = await reach(b);
  const aOnB = reachB.peers[0];
  assert.match(aOnB.outgoing ?? '', /\?sni=/, 'B reaches A through the relay');
  // The relay was added on A only; B received it with the replicated table
  // and registered itself — no leader, nothing to configure on B.
  await waitFor(async () => (await reach(b)).relays[0]?.parked > 0, { timeoutMs: 40_000, label: 'B to park at the relay by itself' });
  const statusA = await cluster.status(a);
  const bOnA = cluster.peerOf(statusA, b);
  assert.equal(bOnA.tls.locked, true);
});

test('when the relay goes away the link waits, and recovers by itself when it is back', async () => {
  await stopRelay();
  await waitFor(async () => {
    const peer = cluster.peerOf(await cluster.status(b), a);
    return peer && peer.health !== 'ONLINE';
  }, { timeoutMs: 30_000, label: 'B to notice that A is unreachable' });
  await startRelay();
  await waitFor(async () => cluster.peerOf(await cluster.status(b), a)?.health === 'ONLINE', { timeoutMs: 120_000, label: 'B to reach A through the relay again' });
  const user = await cluster.login(b, 'relay-after-outage');
  assert.ok(user.token);
  await cluster.converged([a, b], { timeoutMs: 60_000 });
});

test('a proxy routing by server name is another way; switching the relay off moves the link there', async () => {
  const proxyPort = await sniProxy({ 'a.cluster.test': a.mtlsPort });
  const saved = await cluster.admin(a, 'PUT', '/cluster/reach', {
    entries: [{ kind: 'proxy-port', endpoint: `https://127.0.0.1:${proxyPort}?sni=a.cluster.test`, enabled: true, backend: `127.0.0.1:${a.mtlsPort}` }],
  });
  assert.equal(saved.status, 200, saved.text);
  assert.ok(saved.json.entries[0].snippets.nginx.includes(`127.0.0.1:${a.mtlsPort}`), 'proxy configuration offered');
  const relay = (await reach(a)).relays[0];
  assert.equal((await cluster.admin(a, 'PATCH', `/cluster/relays/${relay.id}`, { enabled: false })).status, 200);
  // The switch is replicated: every node stops using the relay.
  await waitFor(async () => (await reach(a)).relayEndpoints.length === 0 && (await reach(b)).relayEndpoints.length === 0,
    { timeoutMs: 40_000, label: 'the relay to be switched off on both nodes' });
  await waitFor(async () => {
    const aOnB = (await reach(b)).peers[0];
    return (aOnB.outgoing ?? '').includes(`:${proxyPort}`) && cluster.peerOf(await cluster.status(b), a)?.health === 'ONLINE';
  }, { timeoutMs: 60_000, label: 'B to reach A through the proxy' });
  const user = await cluster.login(a, 'relay-via-proxy');
  assert.ok(user.token);
  await cluster.converged([a, b], { timeoutMs: 60_000 });
  assert.equal((await cluster.admin(a, 'PATCH', `/cluster/relays/${relay.id}`, { enabled: true })).status, 200);
});

test('the relay setup command serves a checked script only while its window is open', async () => {
  const closed = await fetch(`${a.url}/cluster-relay/v1/install.sh`);
  assert.equal(closed.status, 404);
  const user = await cluster.login(a, 'relay-eve');
  assert.ok([401, 403].includes((await cluster.request(a, 'POST', '/api/admin/cluster/relay-command', { token: user.token, body: { origin: a.url, host: 'vps.example.org' } })).status));
  const bad = await cluster.admin(a, 'POST', '/cluster/relay-command', { origin: 'https://x.example.org/evil', host: 'vps.example.org' });
  assert.equal(bad.status, 400);
  const res = await cluster.admin(a, 'POST', '/cluster/relay-command', { origin: a.url, host: 'vps.example.org', port: 4100, publicPort: true, domain: 'cluster.example.org', name: 'vps 1' });
  assert.equal(res.status, 200, res.text);
  assert.match(res.json.command, /sh pokyh-relay\.sh --name 'vps 1' --port 4100 --public --host 'vps\.example\.org' --domain 'cluster\.example\.org'$/);
  const dir = mkdtempSync(path.join(work, 'relay-script-'));
  const fetchPart = res.json.command.slice(0, res.json.command.indexOf(' && sh pokyh-relay.sh'));
  const fetched = await run('sh', ['-c', fetchPart], { cwd: dir });
  assert.equal(fetched.code, 0, fetched.stderr);
  const script = readFileSync(path.join(dir, 'pokyh-relay.sh'), 'utf8');
  assert.ok(script.includes('export function createRelay('), 'the relay is embedded');
  assert.ok(!script.includes(relayKey.slice(12, 40)), 'no key in the script');
  writeFileSync(path.join(dir, 'check.sh'), script);
  assert.equal((await run('sh', ['-n', path.join(dir, 'check.sh')])).code, 0);
});

test('no node logged a relay key or install secret', async () => {
  for (const node of [a, b].filter(Boolean)) {
    const log = cluster.logText(node);
    assert.ok(!log.includes('pokyhrelay1.'), `${node.name}: relay key`);
    assert.ok(!log.includes('pokyhnode1.'), `${node.name}: install token`);
  }
  await sleep(0);
});
