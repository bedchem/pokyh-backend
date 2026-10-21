import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The updater (deploy/node/updater.mjs) against real Docker: the stack of
// deploy/node/compose.yml — with Caddy and the Caddyfile the installer
// writes — and small stand-in app images, switched between blue and green
// while clients keep sending HTTPS requests through Caddy and opening
// connections through the edge forwarder. Needs Docker with the images
// node:22-alpine, mysql:8.4.10, redis:7.4.1-alpine and caddy:2.8.4-alpine;
// run with `npm run test:updater`. Everything runs in a Compose project of its
// own, bound to 127.0.0.1, and is removed afterwards.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const home = mkdtempSync(path.join(os.tmpdir(), 'pokyh-updater-docker-'));
const project = `pokyhupd${randomBytes(4).toString('hex')}`;
process.env.POKYH_HOME = home;
process.env.POKYH_SWITCH_SETTLE_MS = '4000';
const updater = await import(pathToFileURL(path.join(REPO, 'deploy/node/updater.mjs')).href);
const bootstrap = await import(pathToFileURL(path.join(REPO, 'deploy/node/bootstrap.mjs')).href);

const V2 = '2'.repeat(40);
const V3 = '3'.repeat(40);
let edgePort;
let httpsPort;

function sh(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function compose(...args) {
  return sh('docker', ['compose', '--project-directory', home, '--env-file', path.join(home, 'compose.env'), '-f', path.join(home, 'compose.yml'), ...args]);
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

// A stand-in for the backend that behaves like it: HTTP with /readyz on PORT
// at once; on 4100 (where the real one serves the cluster channel) one line
// with its version — only once the updater named its colour active.
const SERVER = `
const fs = require('fs');
const http = require('http');
const net = require('net');
const version = process.env.APP_VERSION;
const healthy = process.env.APP_HEALTHY !== '0';
const web = http.createServer((req, res) => { res.writeHead(req.url === '/readyz' && !healthy ? 503 : 200); res.end(version); });
web.listen(Number(process.env.PORT || 4000));
const channel = net.createServer((socket) => { socket.on('error', () => {}); socket.end(version + '\\n'); });
const waiting = setInterval(() => {
  let active = '';
  try { active = fs.readFileSync(process.env.POKYH_ACTIVATION_FILE, 'utf8').trim(); } catch {}
  if (active === process.env.POKYH_COLOR) { clearInterval(waiting); channel.listen(4100); }
}, 200);
process.on('SIGTERM', () => { clearInterval(waiting); channel.close(); web.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
`;

function appSource(dir, version, healthy = true) {
  mkdirSync(path.join(dir, 'deploy', 'node'), { recursive: true });
  writeFileSync(path.join(dir, 'server.js'), SERVER);
  writeFileSync(path.join(dir, 'deploy', 'node', 'Dockerfile'), `FROM node:22-alpine\nWORKDIR /app\nCOPY server.js .\nENV APP_VERSION=${version} APP_HEALTHY=${healthy ? '1' : '0'}\nCMD ["node", "server.js"]\n`);
}

// A build as the cluster hands it over: a .tgz with one top directory.
function bundle(version, healthy) {
  const stage = mkdtempSync(path.join(os.tmpdir(), 'pokyh-updater-bundle-'));
  appSource(path.join(stage, 'pokyh-app'), version, healthy);
  const file = path.join(stage, 'bundle.tgz');
  sh('tar', ['-czf', file, '-C', stage, 'pokyh-app']);
  const data = readFileSync(file);
  const sha256 = createHash('sha256').update(data).digest('hex');
  writeFileSync(path.join(home, 'data', 'update', `bundle-${sha256}.tgz`), data);
  rmSync(stage, { recursive: true, force: true });
  return sha256;
}

// Clients that keep going during an update: HTTPS requests through Caddy,
// and connections through the edge forwarder (the cluster channel's way in).
function probe() {
  const web = { seen: [], failures: [] };
  const channel = { seen: [], failures: [] };
  let running = true;
  const viaCaddy = () => new Promise((resolve) => {
    const started = Date.now();
    const req = https.request({ host: '127.0.0.1', port: httpsPort, path: '/', servername: 'localhost', headers: { host: 'localhost' }, rejectUnauthorized: false, agent: false, timeout: 20_000 }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200 && text) web.seen.push({ version: text, ms: Date.now() - started });
        else web.failures.push(`${res.statusCode} ${text.slice(0, 80)}`);
        resolve();
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => { web.failures.push(err.message); resolve(); });
    req.end();
  });
  const viaEdge = () => new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: edgePort });
    let text = '';
    const timer = setTimeout(() => socket.destroy(new Error('timeout')), 3000);
    socket.on('data', (chunk) => { text += chunk; });
    socket.on('close', () => { clearTimeout(timer); if (text.trim()) channel.seen.push(text.trim()); else channel.failures.push(Date.now()); resolve(); });
    socket.on('error', () => {});
  });
  const loop = (once) => (async () => { while (running) { await once(); await new Promise((r) => setTimeout(r, 100)); } })();
  const loops = [loop(viaCaddy), loop(viaEdge)];
  return { web, channel, stop: async () => { running = false; await Promise.all(loops); } };
}

// The channel may be closed only between the old colour stopping and the
// new one taking over: one short stretch, never longer than a few seconds.
function assertShortChannelGap(failures) {
  if (failures.length === 0) return;
  const span = failures.at(-1) - failures[0];
  assert.ok(span < 4000, `the channel was closed for ${span} ms`);
}

const env = () => updater.readEnvFile(readFileSync(path.join(home, 'compose.env'), 'utf8'));
const active = () => readFileSync(path.join(home, 'data', 'update', 'active'), 'utf8').trim();
const status = () => JSON.parse(readFileSync(path.join(home, 'data', 'update', 'status.json'), 'utf8'));

before(async () => {
  edgePort = await freePort();
  httpsPort = await freePort();
  writeFileSync(path.join(home, 'Caddyfile'), bootstrap.renderCaddyfile({ domain: 'localhost', acmeEmail: '', tlsInternal: true }));
  cpSync(path.join(REPO, 'deploy/node/compose.yml'), path.join(home, 'compose.yml'));
  mkdirSync(path.join(home, 'runtime'));
  cpSync(path.join(REPO, 'deploy/node/edge.mjs'), path.join(home, 'runtime', 'edge.mjs'));
  for (const dir of ['data/bootstrap', 'data/update', 'releases']) mkdirSync(path.join(home, dir), { recursive: true });
  writeFileSync(path.join(home, 'data/update/active'), 'blue\n');
  writeFileSync(path.join(home, '.env'), `MYSQL_ROOT_PASSWORD=${randomBytes(12).toString('hex')}\nDB_NAME=pokyh\nPORT=4000\n`, { mode: 0o600 });
  writeFileSync(path.join(home, 'compose.env'), [
    `COMPOSE_PROJECT_NAME=${project}`,
    `POKYH_HOME=${home}`,
    'COMPOSE_PROFILES=blue,web',
    'POKYH_IMAGE_BLUE=v1',
    'POKYH_RUNTIME_REPO=',
    'POKYH_RUNTIME_BRANCH=main',
    'POKYH_CLUSTER_BIND=127.0.0.1',
    `POKYH_CLUSTER_PORT=${edgePort}`,
    'POKYH_WEB_BIND=127.0.0.1',
    `POKYH_HTTP_PORT=${await freePort()}`,
    `POKYH_HTTPS_PORT=${httpsPort}`,
    '',
  ].join('\n'), { mode: 0o600 });
  const v1 = mkdtempSync(path.join(os.tmpdir(), 'pokyh-updater-v1-'));
  appSource(v1, 'v1');
  sh('docker', ['build', '-q', '-f', path.join(v1, 'deploy/node/Dockerfile'), '-t', 'pokyh-node:v1', v1]);
  rmSync(v1, { recursive: true, force: true });
  compose('up', '-d', 'mysql', 'redis', 'edge', 'caddy', 'app-blue');
  const deadline = Date.now() + 240_000;
  for (;;) {
    const id = compose('ps', '-q', 'app-blue').trim();
    const health = id ? sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', id]).trim() : '';
    if (health === 'healthy') break;
    if (Date.now() > deadline) throw new Error('the stack did not become healthy');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  // Caddy answers once it has its internal certificate and sees blue healthy.
  for (;;) {
    const client = probe();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await client.stop();
    if (client.web.seen.length > 0 && client.channel.seen.length > 0) break;
    if (Date.now() > deadline) throw new Error(`Caddy or the edge do not answer: ${client.web.failures.at(-1)}`);
  }
}, { timeout: 300_000 });

after(() => {
  try { compose('--profile', 'blue', '--profile', 'green', '--profile', 'web', 'down', '-v', '--remove-orphans', '-t', '2'); } catch { /* reported by docker */ }
  for (const tag of ['v1', V2.slice(0, 12), V3.slice(0, 12)]) {
    try { sh('docker', ['image', 'rm', '-f', `pokyh-node:${tag}`]); } catch { /* not there */ }
  }
  rmSync(home, { recursive: true, force: true });
}, { timeout: 120_000 });

test('the Caddyfiles the installer writes are valid for Caddy (own domain and behind a proxy)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pokyh-caddy-check-'));
  try {
    for (const [name, text] of [
      ['domain', bootstrap.renderCaddyfile({ domain: 'node2.example.org', acmeEmail: 'ops@example.org', tlsInternal: false })],
      ['gateway', bootstrap.renderGatewayCaddyfile({ trusted: ['10.8.0.1', '10.8.0.0/24'] })],
    ]) {
      writeFileSync(path.join(dir, name), text);
      const out = sh('docker', ['run', '--rm', '-v', `${path.join(dir, name)}:/etc/caddy/Caddyfile:ro`, 'caddy:2.8.4-alpine', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'], { stdio: ['ignore', 'pipe', 'pipe'] });
      assert.match(out, /Valid configuration/, name);
    }
  } catch (err) {
    throw new Error(`${err.message}\n${err.stderr ?? ''}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real compose.yml passes the updater\'s own policy', () => {
  const rendered = JSON.parse(compose('--profile', 'blue', '--profile', 'green', '--profile', 'web', '--profile', 'ai', 'config', '--format', 'json'));
  assert.deepEqual(updater.checkComposePolicy(rendered, home), []);
});

test('an update switches from blue to green without a single failed request', async () => {
  const client = probe();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const sha256 = bundle('v2', true);
  await updater.carryOut({ id: randomUUID(), source: 'bundle', commit: V2, sha256 }, { healthTimeoutMs: 120_000 });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await client.stop();
  assert.equal(active(), 'green');
  assert.equal(status().state, 'done');
  assert.equal(env().get('POKYH_IMAGE_GREEN'), V2.slice(0, 12));
  assert.equal(env().get('COMPOSE_PROFILES'), 'green,web');
  assert.equal(compose('ps', '-q', '--status', 'running', 'app-blue').trim(), '', 'blue is stopped');
  assert.deepEqual(client.web.failures, [], 'no HTTPS request failed');
  assert.equal(client.web.seen[0].version, 'v1');
  assert.equal(client.web.seen.at(-1).version, 'v2');
  const slowest = Math.max(...client.web.seen.map((entry) => entry.ms));
  process.stdout.write(`# requests: ${client.web.seen.length}, slowest ${slowest} ms; channel connections: ${client.channel.seen.length}, refused ${client.channel.failures.length}\n`);
  assertShortChannelGap(client.channel.failures);
  assert.equal(client.channel.seen.at(-1), 'v2');
});

test('a version that does not become healthy is removed; the running one stays', async () => {
  const client = probe();
  const sha256 = bundle('v3', false);
  await assert.rejects(updater.carryOut({ id: randomUUID(), source: 'bundle', commit: V3, sha256 }, { healthTimeoutMs: 30_000 }), /healthy/);
  await client.stop();
  assert.equal(active(), 'green');
  assert.equal(env().get('POKYH_IMAGE_BLUE'), 'v1', 'the settings are as before');
  assert.equal(compose('ps', '-q', '--status', 'running', 'app-blue').trim(), '', 'the failed version is gone');
  assert.deepEqual(client.web.failures, []);
  assert.deepEqual(client.channel.failures, []);
  assert.ok(client.web.seen.every((entry) => entry.version === 'v2'), 'no request reached the failing version');
  assert.ok(client.channel.seen.every((version) => version === 'v2'), 'no connection reached the failing version');
});

test('rolling back starts the previous version again, without downtime', async () => {
  const client = probe();
  await updater.carryOut({ id: randomUUID(), source: 'rollback' }, { healthTimeoutMs: 120_000 });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await client.stop();
  assert.equal(active(), 'blue');
  assert.equal(env().get('COMPOSE_PROFILES'), 'blue,web');
  assert.deepEqual(client.web.failures, []);
  assertShortChannelGap(client.channel.failures);
  assert.equal(client.web.seen.at(-1).version, 'v1');
});

test('a build that does not match its hash is refused before anything starts', async () => {
  const sha256 = bundle('v4', true);
  const file = path.join(home, 'data', 'update', `bundle-${sha256}.tgz`);
  writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from('x')]));
  await assert.rejects(updater.carryOut({ id: randomUUID(), source: 'bundle', commit: '4'.repeat(40), sha256 }, { healthTimeoutMs: 30_000 }), /hash/);
  assert.equal(active(), 'blue');
});
