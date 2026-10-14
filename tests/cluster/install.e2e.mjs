import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';
import { Cluster, REPO, waitFor } from './harness.mjs';

// End-to-end test of the one-line node installer and the mutually
// authenticated channel, with real backend processes and databases. Run with
// `npm run test:cluster`. Everything happens below a temporary directory; the
// installed nodes run from the bundle the inviting node hands out, exactly as
// a new server would.

const require = createRequire(import.meta.url);
const ts = require('typescript');
const cluster = new Cluster();
const work = mkdtempSync(path.join(os.tmpdir(), 'pokyh-install-e2e-'));
let a;
let b;
let c;
let installB;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loadTs(file) {
  const source = readFileSync(path.join(REPO, file), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}
const x509 = await loadTs('src/cluster/x509.ts');
const installToken = await loadTs('src/cluster/installToken.ts');

function run(file, args, { input, env, cwd } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { env: env ?? process.env, cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

// One request on a node's channel, with or without a client certificate.
function channelRequest(node, pathname, { identity = null, method = 'GET', body } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = https.request({
      host: '127.0.0.1', port: node.mtlsPort, method, path: `/cluster/v1${pathname}`, agent: false,
      rejectUnauthorized: false, minVersion: 'TLSv1.3',
      ...(identity ? { key: identity.keyPem, cert: identity.certPem } : {}),
      headers: data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {},
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
      res.on('error', (err) => resolve({ error: err.message }));
    });
    req.setTimeout(5_000, () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ error: err.code || err.message }));
    req.end(data ?? undefined);
  });
}

function tokenOf(command) {
  return /sh pokyh\.sh '(pokyhnode1\.[A-Za-z0-9_-]+)'/.exec(command)[1];
}

function withBody(tokenText, change) {
  const body = JSON.parse(Buffer.from(tokenText.slice('pokyhnode1.'.length), 'base64url').toString());
  return `pokyhnode1.${Buffer.from(JSON.stringify(change(body))).toString('base64url')}`;
}

function bootstrap(tokenText, out) {
  return run(process.execPath, [path.join(REPO, 'deploy/node/bootstrap.mjs')], {
    input: tokenText,
    env: {
      PATH: process.env.PATH ?? '',
      POKYH_OUT: out,
      POKYH_APP_UID: String(process.getuid()),
      POKYH_MEM_KB: String(16 * 1024 * 1024),
      POKYH_CPUS: '4',
    },
  });
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

// As the admin panel sends it: its own address as the browser shows it.
async function createInstall(node, body) {
  return cluster.admin(node, 'POST', '/cluster/node-installs', { origin: node.url, ...body });
}

async function setupRoute(node, method = 'GET', route = '') {
  const res = await fetch(`${node.url}/setup${route}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
  return { status: res.status, text: await res.text() };
}

async function installed(node) {
  return (await cluster.admin(node, 'GET', '/cluster/node-installs')).json.installs;
}

// Unpacks the bundle a bootstrap fetched and starts a node from it with the
// configuration the bootstrap wrote — only what differs on this one test
// machine (database, ports, addresses) is replaced.
async function startInstalled(name, out) {
  const appDir = path.join(out, 'app');
  mkdirSync(appDir, { recursive: true });
  const extracted = await run('tar', ['-xzf', path.join(out, 'state/bundle.tgz'), '-C', appDir, '--strip-components=1']);
  assert.equal(extracted.code, 0, extracted.stderr);
  const env = parseEnv(path.join(out, '.env'));
  for (const key of Object.keys(env)) {
    if (/^(PORT|DATABASE_URL|DB_.*|MYSQL_ROOT_PASSWORD|CLUSTER_MTLS_.*|CLUSTER_ADVERTISE_URL|CLUSTER_BOOTSTRAP_DIR)$/.test(key)) delete env[key];
  }
  const node = await cluster.addNode(name, { ...env, CLUSTER_BOOTSTRAP_DIR: path.join(out, 'data/bootstrap') }, { mtls: true, appDir });
  node.overrides.CLUSTER_ADVERTISE_URL = node.channelUrl;
  await cluster.start(node);
  return node;
}

function readStatusFile(out) {
  try { return JSON.parse(readFileSync(path.join(out, 'data/bootstrap/status.json'), 'utf8')); } catch { return null; }
}

before(async () => {
  await cluster.startMysql();
  a = await cluster.addNode('a', {}, { mtls: true });
  await cluster.start(a);
}, { timeout: 600_000 });

after(async () => {
  await cluster.teardown();
  if (!process.env.CLUSTER_E2E_KEEP) rmSync(work, { recursive: true, force: true });
}, { timeout: 120_000 });

// ─── The channel ─────────────────────────────────────────────────────────────

test('the channel turns away every connection without a pinned certificate', async () => {
  const status = await cluster.status(a);
  assert.equal(status.channel.mtls.listening, true);
  assert.match(status.channel.mtls.pin, x509.PIN_PATTERN);
  assert.equal(status.channel.mtls.url, a.channelUrl);

  const stranger = x509.createNodeCertificate('stranger');
  // Nothing is open: no certificate and an unknown one are both cut off
  // right after the handshake, before any HTTP is read.
  assert.ok((await channelRequest(a, '/install.sh')).error, 'no certificate');
  assert.ok((await channelRequest(a, '/session', { identity: stranger, method: 'POST', body: {} })).error, 'unknown certificate');
  // Plain HTTP on the channel port gets nowhere.
  const plain = await fetch(`http://127.0.0.1:${a.mtlsPort}/cluster/v1/install.sh`).then((res) => res.status, () => 'refused');
  assert.notEqual(plain, 200);
  // The installer's endpoints do not exist outside the channel.
  for (const route of ['/install.sh', '/provision', '/provision/bundle']) {
    const res = await fetch(`${a.url}/cluster/v1${route}`, { method: route === '/install.sh' ? 'GET' : 'POST' });
    assert.equal(res.status, 404, route);
  }
});

test('while a pairing is open, an unknown certificate reaches the pairing steps and nothing else', async () => {
  const invite = await cluster.admin(a, 'POST', '/cluster/invites', { ownAddress: a.url });
  assert.equal(invite.status, 201);
  const stranger = x509.createNodeCertificate('stranger');
  try {
    await waitFor(async () => !(await channelRequest(a, '/pair/init', { identity: stranger, method: 'POST', body: {} })).error,
      { timeoutMs: 15_000, label: 'the pairing window to open the channel' });
    assert.equal((await channelRequest(a, '/pair/init', { identity: stranger, method: 'POST', body: {} })).status, 400);
    assert.equal((await channelRequest(a, '/session', { identity: stranger, method: 'POST', body: {} })).status, 404);
    assert.equal((await channelRequest(a, '/rpc', { identity: stranger, method: 'POST', body: 'x' })).status, 404);
    assert.equal((await channelRequest(a, '/install.sh', { identity: stranger })).status, 404);
  } finally {
    await cluster.admin(a, 'DELETE', `/cluster/peers/${invite.json.id}`);
  }
});

// ─── Creating a command ──────────────────────────────────────────────────────

test('only an administrator can create a one-line command, and only with clean input', async () => {
  const body = { name: 'X', origin: a.url };
  assert.equal((await cluster.request(a, 'POST', '/api/admin/cluster/node-installs', { body, apiKey: false })).status, 401);
  const user = await cluster.login(a, 'install-mallory');
  // A signed-in user who is not an administrator is refused as well.
  assert.ok([401, 403].includes((await cluster.request(a, 'POST', '/api/admin/cluster/node-installs', { body, token: user.token })).status));
  assert.ok([401, 403].includes((await cluster.request(a, 'GET', '/api/admin/cluster/node-installs', { token: user.token })).status));
  assert.ok([401, 403].includes((await cluster.request(a, 'POST', '/api/admin/cluster/certificate/rotate', { token: user.token })).status));

  for (const [input, pattern] of [
    [{ name: 'X', address: 'https://node.example.org' }, /address/],
    [{ name: 'X', address: 'node.example.org:443' }, /address/],
    [{ name: 'X', address: 'localhost' }, /address/],
    [{ name: 'X', address: '1.2.3.4; rm -rf /' }, /address/],
    [{ name: 'X', address: 'node.example.org', acmeEmail: 'a}@b.cd' }, /e-mail/],
    [{ name: 'x\nNODE_OPTIONS=evil' }, /name/],
    [{ name: 'X', origin: 'http://api.example.org' }, /public https address/],
    [{ name: 'X', origin: 'https://api.example.org/admin' }, /public https address/],
  ]) {
    const res = await createInstall(a, input);
    assert.equal(res.status, 400, JSON.stringify(input));
    assert.match(res.json.error, pattern);
  }
  for (const input of [{ origin: a.url }, { name: '', origin: a.url }, { name: 'X' }]) {
    const res = await cluster.admin(a, 'POST', '/cluster/node-installs', input);
    assert.equal(res.status, 400, `${JSON.stringify(input)}: name and origin are required`);
  }
  assert.deepEqual(await installed(a), [], 'nothing was created by the refused requests');
});

test('/setup exists only while a node is being added', async () => {
  // No install open: indistinguishable from a path that does not exist.
  for (const [method, route] of [['GET', ''], ['POST', '/provision'], ['POST', '/bundle'], ['GET', '/anything']]) {
    assert.equal((await setupRoute(a, method, route)).status, 404, `${method} /setup${route}`);
  }
  const created = await createInstall(a, { name: 'Window' });
  assert.equal(created.status, 201, created.text);
  const open = await setupRoute(a);
  assert.equal(open.status, 200);
  assert.equal(createHash('sha256').update(open.text).digest('hex'), created.json.scriptSha256);
  assert.equal((await setupRoute(a, 'POST', '/provision')).status, 400, 'open, but a request without a valid proof gets nothing');
  assert.equal((await setupRoute(a, 'GET', '/anything')).status, 404);
  assert.equal((await cluster.admin(a, 'DELETE', `/cluster/node-installs/${created.json.id}`)).status, 200);
  assert.equal((await setupRoute(a)).status, 404, 'closed again once no install is open');
});

test('the command fetches exactly the pinned, hash-checked installer', async () => {
  const created = await createInstall(a, { address: 'node-b.example.org', name: 'Node B', acmeEmail: 'ops@example.org' });
  assert.equal(created.status, 201, created.text);
  installB = created.json;
  const status = await cluster.status(a);
  assert.equal(installB.pin, status.channel.mtls.pin);
  const command = installB.command;
  assert.ok(command.startsWith(`curl -fsSL --proto '=http,https' -o pokyh.sh '${a.url}/setup'`), command);
  assert.ok(command.includes(`echo '${installB.scriptSha256}  pokyh.sh' | sha256sum -c -`));
  assert.equal(installB.address, 'node-b.example.org');
  const decoded = installToken.decodeInstallToken(tokenOf(command));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.token.url, a.channelUrl);
  assert.equal(decoded.token.pin, installB.pin);
  assert.equal(decoded.token.id, installB.id);
  assert.equal(decoded.token.web, a.url, 'the public address the panel was opened under');

  // The first two steps of the command, word for word.
  const dir = mkdtempSync(path.join(work, 'fetch-'));
  const fetchPart = command.slice(0, command.indexOf(' && sh pokyh.sh'));
  const fetched = await run('sh', ['-c', fetchPart], { cwd: dir });
  assert.equal(fetched.code, 0, fetched.stderr);
  const script = readFileSync(path.join(dir, 'pokyh.sh'));
  assert.equal(createHash('sha256').update(script).digest('hex'), installB.scriptSha256);
  assert.ok(!script.toString().includes(decoded.token.secret.toString('base64url')), 'the script carries no secret');

  // A script changed on the way (a proxy, a CDN) fails the hash check, and
  // the command stops before running anything.
  writeFileSync(path.join(dir, 'pokyh.sh'), `${script}\necho injected\n`);
  const check = await run('sh', ['-c', `echo '${installB.scriptSha256}  pokyh.sh' | sha256sum -c - && echo RAN`], { cwd: dir });
  assert.notEqual(check.code, 0);
  assert.doesNotMatch(check.stdout, /RAN/);
});

test('a fake public address hands out nothing the bootstrap accepts', async () => {
  // Something else answers at the public address (a misrouted proxy, an
  // attacker): its answers do not open with the key, so the bootstrap turns
  // to the pinned channel — and gets the genuine configuration there.
  const created = await createInstall(a, { name: 'Fake' });
  const fake = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ iv: randomBytes(12).toString('base64url'), ct: randomBytes(64).toString('base64url') }));
    });
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  try {
    const forged = withBody(tokenOf(created.json.command), (body) => ({ ...body, w: `http://127.0.0.1:${fake.address().port}` }));
    const out = mkdtempSync(path.join(work, 'fake-web-'));
    const result = await bootstrap(forged, out);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /does not verify — trying the cluster channel/);
    assert.match(result.stdout, /certificate matches the pin/);
    assert.equal(parseEnv(path.join(out, '.env')).JWT_SECRET, cluster.secrets.jwt);
  } finally {
    fake.close();
    await cluster.admin(a, 'DELETE', `/cluster/node-installs/${created.json.id}`);
  }
});

test('the bootstrap refuses an impostor and leaves the install untouched', async () => {
  const impostor = x509.createNodeCertificate('impostor');
  // Only the channel, with someone else's certificate on it.
  const forged = withBody(tokenOf(installB.command), (body) => {
    const { w, ...rest } = body;
    return { ...rest, f: impostor.pin };
  });
  const out = mkdtempSync(path.join(work, 'impostor-'));
  const result = await bootstrap(forged, out);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /certificate other than the pinned one/);
  assert.equal(existsSync(path.join(out, '.env')), false);
  assert.equal((await installed(a)).find((row) => row.id === installB.id).status, 'OPEN');
});

test('wrong proofs lock an install, and a locked install hands out nothing', async () => {
  const created = await createInstall(a, { name: 'Guessed', address: 'node-x.example.org' });
  assert.equal(created.status, 201);
  const genuine = tokenOf(created.json.command);
  const guessed = withBody(genuine, (body) => ({ ...body, s: randomBytes(32).toString('base64url') }));
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = await bootstrap(guessed, mkdtempSync(path.join(work, 'guess-')));
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, attempt < 5 ? /refused the install token/ : /refused|no longer valid/);
  }
  const row = (await installed(a)).find((entry) => entry.id === created.json.id);
  assert.equal(row.status, 'LOCKED');
  assert.equal(row.failures, 5);
  const late = await bootstrap(genuine, mkdtempSync(path.join(work, 'late-')));
  assert.notEqual(late.code, 0);
  assert.match(late.stderr, /no longer valid/);
  const stored = await a.db.clusterInstall.findUnique({ where: { id: created.json.id } });
  assert.equal(stored.secretEnc, null, 'the secret of a locked install is forgotten');
});

test('a revoked command is dead', async () => {
  const created = await createInstall(a, { name: 'Revoked', address: 'node-r.example.org' });
  assert.equal((await cluster.admin(a, 'DELETE', `/cluster/node-installs/${created.json.id}`)).status, 200);
  const result = await bootstrap(tokenOf(created.json.command), mkdtempSync(path.join(work, 'revoked-')));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /no longer valid/);
});

// ─── Installing ──────────────────────────────────────────────────────────────

test('the bootstrap writes the new node\'s configuration, once', async () => {
  const out = path.join(work, 'node-b');
  mkdirSync(out);
  const result = await bootstrap(tokenOf(installB.command), out);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Reached ${a.url.replace(/[.]/g, '\\.')}`), 'over the public address');
  assert.match(result.stdout, /verified/);

  const mode = (file) => statSync(path.join(out, file)).mode & 0o777;
  assert.equal(mode('.env'), 0o600);
  assert.equal(mode('data/bootstrap/join.json'), 0o600);
  assert.equal(mode('state'), 0o700);
  const env = parseEnv(path.join(out, '.env'));
  assert.equal(env.JWT_SECRET, cluster.secrets.jwt, 'shared');
  assert.equal(env.API_KEY, cluster.secrets.apiKey, 'shared');
  assert.notEqual(env.DATABASE_URL, a.databaseUrl, 'never the inviting node\'s database');
  assert.match(env.MYSQL_ROOT_PASSWORD, /^[A-Za-z0-9_-]{32}$/, 'a fresh password of its own');
  assert.match(env.CLUSTER_SECRET, /^[A-Za-z0-9_-]{64}$/);
  assert.equal(env.CLUSTER_MTLS_URL, 'https://node-b.example.org:4100');
  assert.equal(env.CLUSTER_NODE_NAME, 'Node B');
  assert.match(readFileSync(path.join(out, 'Caddyfile'), 'utf8'), /^node-b\.example\.org \{$/m);
  assert.match(readFileSync(path.join(out, 'compose.env'), 'utf8'), /^COMPOSE_PROFILES=blue,web$/m, 'with a domain: its own HTTPS');
  const bundleHash = createHash('sha256').update(readFileSync(path.join(out, 'state/bundle.tgz'))).digest('hex');
  const provision = JSON.parse(readFileSync(path.join(out, 'state/provision.json'), 'utf8'));
  assert.equal(bundleHash, provision.bundle.sha256);
  assert.equal((await installed(a)).find((row) => row.id === installB.id).status, 'PROVISIONED');

  // The configuration is handed out once: a second server gets nothing…
  const second = await bootstrap(tokenOf(installB.command), mkdtempSync(path.join(work, 'second-')));
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /already used/);
  // …while the same server can resume its interrupted run.
  const resumed = await bootstrap(tokenOf(installB.command), out);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.match(resumed.stdout, /received earlier/);
});

test('the new node joins by itself over the pinned channel and takes over the data', async () => {
  const anna = await cluster.login(a, 'install-anna');
  const todo = await cluster.request(a, 'POST', `/users/${anna.user.username}/todos`, { token: anna.token, body: { title: 'before the install' } });
  assert.ok([200, 201].includes(todo.status), todo.text);

  const out = path.join(work, 'node-b');
  b = await startInstalled('b', out);
  await cluster.waitPaired(a, b, 120_000);
  assert.equal(existsSync(path.join(out, 'data/bootstrap/join.json')), false, 'the join instruction is gone from disk');

  const [sa, sb] = await Promise.all([cluster.status(a), cluster.status(b)]);
  const bOnA = cluster.peerOf(sa, b);
  const aOnB = cluster.peerOf(sb, a);
  assert.equal(bOnA.tls.locked, true);
  assert.equal(aOnB.tls.locked, true);
  assert.equal(bOnA.tls.pin, sb.channel.mtls.pin, 'A pinned the certificate B actually holds');
  assert.equal(aOnB.tls.pin, sa.channel.mtls.pin, 'B pinned the certificate from the token');
  assert.equal(sb.node.name, 'Node B');

  await waitFor(() => readStatusFile(out)?.state === 'synced', { timeoutMs: 120_000, label: 'the installer status to report the data received' });
  const report = readStatusFile(out);
  assert.equal(report.ownPin, sb.channel.mtls.pin);
  await cluster.converged([a, b], { timeoutMs: 120_000 });

  const onB = await cluster.request(b, 'GET', `/users/${anna.user.username}/todos`, { token: anna.token });
  assert.equal(onB.status, 200, 'the session issued by A is valid on B');
  assert.ok(JSON.stringify(onB.json).includes('before the install'));
  const written = await cluster.request(b, 'POST', `/users/${anna.user.username}/todos`, { token: anna.token, body: { title: 'written on b' } });
  assert.ok([200, 201].includes(written.status), written.text);
  await waitFor(async () => JSON.stringify((await cluster.request(a, 'GET', `/users/${anna.user.username}/todos`, { token: anna.token })).json).includes('written on b'),
    { timeoutMs: 30_000, label: 'the change on B to reach A' });

  const done = (await installed(a)).find((row) => row.id === installB.id);
  assert.equal(done.status, 'DONE');
  const stored = await a.db.clusterInstall.findUnique({ where: { id: installB.id } });
  assert.equal(stored.secretEnc, null, 'the install secret is forgotten');
});

test('the first-run setup is closed on an installed node', async () => {
  const status = await cluster.request(b, 'GET', '/api/setup/status', { apiKey: false });
  assert.equal(status.json.needsSetup, false);
  const attempt = await cluster.request(b, 'POST', '/api/setup/password', { apiKey: false, body: { username: 'intruder', password: 'longenough' } });
  assert.equal(attempt.status, 403);
});

test('a third node installed through the second is linked with the first by the mesh, over the channel', async () => {
  const created = await createInstall(b, { address: 'node-c.example.org', name: 'Node C' });
  assert.equal(created.status, 201, created.text);
  const out = path.join(work, 'node-c');
  mkdirSync(out);
  const result = await bootstrap(tokenOf(created.json.command), out);
  assert.equal(result.code, 0, result.stderr);
  c = await startInstalled('c', out);
  await cluster.waitPaired(b, c, 120_000);
  await cluster.waitPaired(a, c, 120_000);
  const sa = await cluster.status(a);
  const cOnA = cluster.peerOf(sa, c);
  assert.ok(cOnA.introducedBy, 'introduced by B');
  assert.equal(cOnA.tls.locked, true, 'the introduced link runs over the channel only');
  await cluster.converged([a, b, c], { timeoutMs: 180_000 });
});

test('without an address, the new server is named by the IP its setup came from', async () => {
  const created = await createInstall(a, { name: 'Homelab' });
  assert.equal(created.status, 201, created.text);
  const out = mkdtempSync(path.join(work, 'ip-only-'));
  try {
    const result = await bootstrap(tokenOf(created.json.command), out);
    assert.equal(result.code, 0, result.stderr);
    const env = parseEnv(path.join(out, '.env'));
    assert.equal(env.CLUSTER_MTLS_URL, 'https://127.0.0.1:4100', 'the address the request came from');
    assert.equal(existsSync(path.join(out, 'Caddyfile')), false, 'no domain: no web server of its own');
    assert.match(readFileSync(path.join(out, 'compose.env'), 'utf8'), /^COMPOSE_PROFILES=blue$/m);
  } finally {
    await cluster.admin(a, 'DELETE', `/cluster/node-installs/${created.json.id}`);
  }
});

test('several servers can be added at the same time, each with its own key', async () => {
  const created = await Promise.all(['Spare 1', 'Spare 2', 'Spare 3'].map((name) => createInstall(a, { name })));
  for (const entry of created) assert.equal(entry.status, 201, entry.text);
  const outs = created.map(() => mkdtempSync(path.join(work, 'parallel-')));
  try {
    const results = await Promise.all(created.map((entry, index) => bootstrap(tokenOf(entry.json.command), outs[index])));
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const secrets = outs.map((out) => parseEnv(path.join(out, '.env')).CLUSTER_SECRET);
    assert.equal(new Set(secrets).size, 3, 'every server has secrets of its own');
    // A key works for its own install only.
    const swapped = withBody(tokenOf(created[0].json.command), (body) => ({ ...body, i: created[1].json.id }));
    const refused = await bootstrap(swapped, mkdtempSync(path.join(work, 'swapped-')));
    assert.notEqual(refused.code, 0);
  } finally {
    for (const entry of created) await cluster.admin(a, 'DELETE', `/cluster/node-installs/${entry.json.id}`);
  }
  assert.equal((await setupRoute(a)).status, 404, 'closed again once every install is used up or revoked');
});

test('renewing a certificate keeps every link up', async () => {
  const before = await cluster.status(a);
  const renewed = await cluster.admin(a, 'POST', '/cluster/certificate/rotate');
  assert.equal(renewed.status, 200, renewed.text);
  assert.notEqual(renewed.json.pin, before.channel.mtls.pin);
  assert.equal(renewed.json.peers, 2);
  for (const node of [b, c]) {
    await waitFor(async () => cluster.peerOf(await cluster.status(node), a)?.tls.pin === renewed.json.pin, { timeoutMs: 15_000, label: `${node.name} to pin A's new certificate` });
  }
  const anna = await cluster.login(c, 'install-carla');
  assert.ok(anna.token);
  await cluster.converged([a, b, c], { timeoutMs: 60_000 });
  const after = await cluster.status(a);
  for (const node of [b, c]) assert.equal(cluster.peerOf(after, node).health, 'ONLINE');
});

// ─── Links made before the channel ───────────────────────────────────────────

test('links made before the channel move onto it by themselves and are then locked', async () => {
  const l1 = await cluster.addNode('l1');
  const l2 = await cluster.addNode('l2');
  await Promise.all([cluster.start(l1), cluster.start(l2)]);
  await cluster.pair(l1, l2);
  await cluster.waitPaired(l1, l2);
  const legacy = cluster.peerOf(await cluster.status(l1), l2);
  assert.equal(legacy.tls, null, 'paired without the channel');

  // Both get the channel; nothing else changes.
  for (const node of [l1, l2]) {
    await cluster.stop(node);
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    node.mtlsPort = port;
    Object.assign(node.overrides, { CLUSTER_MTLS_PORT: String(port), CLUSTER_MTLS_BIND_ADDRESS: '127.0.0.1', CLUSTER_MTLS_URL: `https://127.0.0.1:${port}` });
  }
  await Promise.all([cluster.start(l1), cluster.start(l2)]);
  await waitFor(async () => {
    const [s1, s2] = await Promise.all([cluster.status(l1), cluster.status(l2)]);
    return cluster.peerOf(s1, l2)?.tls?.locked === true && cluster.peerOf(s2, l1)?.tls?.locked === true;
  }, { timeoutMs: 90_000, label: 'the legacy link to be locked to the channel' });
  const user = await cluster.login(l1, 'install-lena');
  assert.ok(user.token);
  await cluster.converged([l1, l2], { timeoutMs: 60_000 });
  // Locked: a session over the public path is refused now.
  const s2 = await cluster.status(l2);
  const viaPublic = await fetch(`${l2.url}/cluster/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ v: 2, from: (await cluster.status(l1)).node.id, to: s2.node.id, e: randomBytes(32).toString('base64url'), n: randomBytes(16).toString('base64url'), mac: randomBytes(32).toString('base64url') }),
  });
  assert.equal(viaPublic.status, 403);
  await Promise.all([cluster.stop(l1), cluster.stop(l2)]);
});

// ─── The first-run setup ─────────────────────────────────────────────────────

test('the first-run setup cannot be used to inject settings or to take over a server with administrators', async () => {
  // Run from a copy of the build, so the setup writes that copy's env file.
  const appDir = path.join(work, 'setup-node');
  mkdirSync(appDir);
  const extracted = await run('tar', ['-xzf', path.join(work, 'node-c', 'state/bundle.tgz'), '-C', appDir, '--strip-components=1']);
  assert.equal(extracted.code, 0, extracted.stderr);
  // The test's own administrator is named in the environment, but no
  // password is set anywhere — the state of a server before its setup.
  const s = await cluster.addNode('setup', { ADMIN_PASSWORD_HASH: '', RATE_LIMIT_AUTH_MAX: '1000' }, { appDir });
  await cluster.start(s);
  const setup = (body) => cluster.request(s, 'POST', '/api/setup/password', { apiKey: false, body });
  assert.equal((await cluster.request(s, 'GET', '/api/setup/status', { apiKey: false })).json.needsSetup, true);

  for (const username of ['x\nNODE_OPTIONS=--import=data:text/javascript,process.exit(9)', 'a$&b', 'ab', 'a b', 'x'.repeat(65)]) {
    assert.equal((await setup({ username, password: 'longenough' })).status, 400, JSON.stringify(username));
  }
  assert.equal((await setup({ username: ['admin'], password: 'longenough' })).status, 400);
  assert.equal((await setup({ username: 'admin', password: 'x'.repeat(300) })).status, 400);
  assert.equal(existsSync(path.join(appDir, '.env')), false, 'nothing was written by the refused requests');

  // An administrator in the database closes the setup.
  await cluster.login(s, 'db-admin');
  const { stableUid } = await s.db.user.findUnique({ where: { username: 'db-admin' } });
  await s.db.admin.create({ data: { stableUid, passwordHash: '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345' } });
  assert.equal((await cluster.request(s, 'GET', '/api/setup/status', { apiKey: false })).json.needsSetup, false);
  assert.equal((await setup({ username: 'takeover', password: 'longenough' })).status, 403);
  await s.db.admin.deleteMany({});

  // Two at once: exactly one wins.
  const [first, second] = await Promise.all([
    setup({ username: 'first-admin', password: 'longenough' }),
    setup({ username: 'second-admin', password: 'longenough' }),
  ]);
  const outcomes = [first.status, second.status];
  assert.equal(outcomes.filter((code) => code === 200).length, 1, `exactly one setup succeeds (${outcomes})`);
  assert.ok(outcomes.every((code) => [200, 403, 409].includes(code)), `the other is refused (${outcomes})`);
  assert.equal((await setup({ username: 'later', password: 'longenough' })).status, 403);
  const written = readFileSync(path.join(appDir, '.env'), 'utf8');
  assert.equal(written.match(/^ADMIN_USERNAME=/gm).length, 1);
  assert.match(written, /^ADMIN_PASSWORD_HASH=\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/m, 'the hash is written exactly, $ and all');
  assert.doesNotMatch(written, /NODE_OPTIONS/);
  assert.equal(statSync(path.join(appDir, '.env')).mode & 0o777, 0o600);
  await cluster.stop(s);
});

test('nothing of the installs leaked into the logs', async () => {
  const secretOfB = installToken.decodeInstallToken(tokenOf(installB.command)).token.secret.toString('base64url');
  for (const node of [a, b, c].filter(Boolean)) {
    const log = cluster.logText(node);
    assert.ok(!log.includes(secretOfB), `${node.name}: install secret`);
    assert.ok(!log.includes('pokyhnode1.'), `${node.name}: install token`);
    assert.ok(!log.includes(cluster.secrets.jwt), `${node.name}: JWT secret`);
  }
});
