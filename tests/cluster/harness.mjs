import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Infrastructure for the multi-node end-to-end test: a throw-away MySQL
// server, several backend processes that each own one database on it, and
// helpers to talk to them.
//
// Isolation is deliberate and complete. Every node runs in its own temporary
// working directory with an explicitly constructed environment, so neither a
// developer's `.env` nor a locally running stack is read, written or
// contacted. Everything created here is removed again by `teardown()`.

const require = createRequire(import.meta.url);
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { PrismaClient } = require(path.join(REPO, 'node_modules', '@prisma', 'client'));
const jwt = require(path.join(REPO, 'node_modules', 'jsonwebtoken'));

const MYSQL_IMAGE = 'mysql:8.0.40';
const ADMIN_USERNAME = 'clusteradmin';
// Never used to sign in — it only has to be non-empty so the first-run setup
// endpoint stays closed. Tests authenticate with tokens they mint themselves.
const ADMIN_PASSWORD_HASH = '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(check, { timeoutMs = 30_000, intervalMs = 200, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await check();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) {
      const detail = last instanceof Error ? last.message : JSON.stringify(last);
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}${detail ? ` (last: ${detail})` : ''}`);
    }
    await sleep(intervalMs);
  }
}

function envKeys(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter(Boolean);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export class Cluster {
  constructor() {
    this.root = mkdtempSync(path.join(os.tmpdir(), 'pokyh-cluster-e2e-'));
    this.suffix = randomBytes(4).toString('hex');
    this.container = null;
    // The container whose own client programs are used for backup/restore.
    this.clientContainer = process.env.CLUSTER_E2E_MYSQL_CONTAINER ?? null;
    this.mysqlUrl = null;
    this.nodes = new Map();
    this.proxies = [];
    this.secrets = {
      jwt: randomBytes(32).toString('hex'),
      refresh: randomBytes(32).toString('hex'),
      apiKey: randomBytes(24).toString('hex'),
      serverKey: randomBytes(24).toString('hex'),
    };
    this.adminToken = jwt.sign({ role: 'admin', sub: 'admin-panel', username: ADMIN_USERNAME }, this.secrets.jwt, { expiresIn: '2h' });
  }

  // ── MySQL ────────────────────────────────────────────────────────────────

  async startMysql() {
    if (process.env.CLUSTER_E2E_MYSQL_URL) {
      // An already running throw-away server, for quick repeated runs.
      this.mysqlUrl = process.env.CLUSTER_E2E_MYSQL_URL.replace(/\/$/, '');
    } else {
      const password = randomBytes(12).toString('hex');
      this.container = `pokyh-cluster-e2e-${this.suffix}`;
      execFileSync('docker', [
        'run', '-d', '--rm', '--name', this.container,
        '-e', `MYSQL_ROOT_PASSWORD=${password}`,
        '-p', '127.0.0.1::3306',
        '--tmpfs', '/var/lib/mysql:rw,size=1g',
        MYSQL_IMAGE,
      ], { stdio: 'pipe' });
      this.clientContainer = this.container;
      const mapping = execFileSync('docker', ['port', this.container, '3306/tcp'], { encoding: 'utf8' }).trim().split('\n')[0];
      this.mysqlUrl = `mysql://root:${password}@127.0.0.1:${mapping.split(':').pop()}`;
    }
    const probe = new PrismaClient({ datasources: { db: { url: `${this.mysqlUrl}/mysql` } }, log: [] });
    try {
      await waitFor(async () => {
        await probe.$queryRawUnsafe('SELECT 1');
        return true;
      }, { timeoutMs: 120_000, intervalMs: 1_000, label: 'MySQL to accept connections' });
    } finally {
      await probe.$disconnect().catch(() => {});
    }
    this.adminDb = new PrismaClient({ datasources: { db: { url: `${this.mysqlUrl}/mysql` } }, log: [] });
  }

  // ── Nodes ────────────────────────────────────────────────────────────────

  // Options: `mtls` gives the node its mutually authenticated channel on a
  // port of its own; `appDir` runs the server from that directory (an
  // unpacked install bundle) instead of this repository's build.
  async addNode(name, overrides = {}, { mtls = false, appDir = null } = {}) {
    const database = `pokyh_e2e_${this.suffix}_${name}`;
    await this.adminDb.$executeRawUnsafe(`CREATE DATABASE \`${database}\``);
    const dir = appDir ?? path.join(this.root, name);
    mkdirSync(dir, { recursive: true });
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    if (!existsSync(path.join(dir, 'prisma'))) symlinkSync(path.join(REPO, 'prisma'), path.join(dir, 'prisma'), linkType);
    if (!existsSync(path.join(dir, 'node_modules'))) symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), linkType);
    if (!appDir) writeFileSync(path.join(dir, 'package.json'), '{"name":"pokyh-cluster-e2e-node","private":true}\n');
    this.installClientShims(dir);

    const port = await freePort();
    const mtlsPort = mtls ? await freePort() : null;
    const databaseUrl = `${this.mysqlUrl}/${database}`;
    if (mtlsPort) {
      overrides = {
        CLUSTER_MTLS_PORT: String(mtlsPort),
        CLUSTER_MTLS_BIND_ADDRESS: '127.0.0.1',
        CLUSTER_MTLS_URL: `https://127.0.0.1:${mtlsPort}`,
        ...overrides,
      };
    }
    const node = {
      name,
      dir,
      entry: path.join(appDir ?? REPO, 'dist', 'index.js'),
      port,
      mtlsPort,
      channelUrl: mtlsPort ? `https://127.0.0.1:${mtlsPort}` : null,
      database,
      databaseUrl,
      url: `http://127.0.0.1:${port}`,
      process: null,
      overrides,
      db: new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: [] }),
      serverKey: overrides.SERVER_KEY ?? this.secrets.serverKey,
    };
    this.nodes.set(name, node);
    return node;
  }

  // The backup service shells out to `mysqldump` and `mysql`. Which client a
  // developer machine has installed (if any) is not something a test should
  // depend on, so each node gets stand-ins on its PATH that run the client
  // programs shipped inside the throw-away server container itself. The
  // application code under test — spawning, piping, compression, verification
  // and the cluster handling around a restore — runs unchanged.
  installClientShims(dir) {
    if (!this.clientContainer) return;
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const shim = `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const tool = require('node:path').basename(process.argv[1]);
const args = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--host') { args.push('--host', '127.0.0.1'); i++; }
  else if (process.argv[i] === '--port') { args.push('--port', '3306'); i++; }
  else args.push(process.argv[i]);
}
const child = spawn('docker', ['exec', '-i', '-e', 'MYSQL_PWD=' + (process.env.MYSQL_PWD || ''), ${JSON.stringify(this.clientContainer)}, tool, ...args], { stdio: 'inherit' });
child.on('error', () => process.exit(127));
child.on('exit', (code) => process.exit(code === null ? 1 : code));
`;
    for (const tool of ['mysqldump', 'mysql']) writeFileSync(path.join(bin, tool), shim, { mode: 0o755 });
  }

  environmentFor(node) {
    // Start from every variable a real deployment might define, blanked, so
    // that nothing can be inherited from a developer's own `.env`.
    const env = {};
    for (const key of [...envKeys(path.join(REPO, '.env.example')), ...envKeys(path.join(REPO, '.env'))]) env[key] = '';
    Object.assign(env, {
      PATH: `${path.join(node.dir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? '',
      NODE_ENV: 'test',
      PORT: String(node.port),
      DATABASE_URL: node.databaseUrl,
      JWT_SECRET: this.secrets.jwt,
      REFRESH_TOKEN_SECRET: this.secrets.refresh,
      API_KEY: this.secrets.apiKey,
      SERVER_KEY: this.secrets.serverKey,
      ADMIN_USERNAME,
      ADMIN_USERNAMES: ADMIN_USERNAME,
      ADMIN_PASSWORD_HASH,
      // The suites act with signed admin tokens; the second-factor
      // requirement is tested per account where it is switched on.
      ADMIN_REQUIRE_SECOND_FACTOR: 'false',
      DB_AUTO_PUSH: 'true',
      BACKUP_ENABLED: 'false',
      BACKUP_DIR: path.join(node.dir, 'backups'),
      SCHOOL_YEAR_ROLLOVER_AUTO: 'false',
      LEARN_LEGAL_GATE_ENABLED: 'false',
      LEARN_AI_ENABLED: 'false',
      MENSA_IMPORT_URL: 'http://127.0.0.1:9/unreachable.json',
      RATE_LIMIT_GLOBAL_MAX: '1000000',
      RATE_LIMIT_WRITE_MAX: '1000000',
      RATE_LIMIT_READ_MAX: '1000000',
      RATE_LIMIT_SSE_MAX: '1000000',
      CLUSTER_NODE_NAME: `node-${node.name}`,
      CLUSTER_HEARTBEAT_INTERVAL_MS: '500',
      CLUSTER_REQUEST_TIMEOUT_MS: '2000',
      CLUSTER_SYNC_INTERVAL_MS: '200',
      CLUSTER_SUSPECT_AFTER_FAILURES: '2',
      CLUSTER_OFFLINE_AFTER_FAILURES: '4',
      ...node.overrides,
    });
    return env;
  }

  // waitForCluster false: only until the node answers. Its cluster status is
  // read through the admin API, which a node that requires the authenticator
  // app keeps closed until the owner has set one up.
  async start(node, { waitForCluster = true } = {}) {
    if (node.process) return;
    const logFile = path.join(node.dir, 'node.log');
    const child = spawn(process.execPath, [node.entry], {
      cwd: node.dir,
      env: this.environmentFor(node),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => appendFileSync(logFile, chunk));
    child.stderr.on('data', (chunk) => appendFileSync(logFile, chunk));
    node.process = child;
    node.exited = new Promise((resolve) => child.once('exit', () => { node.process = null; resolve(); }));
    await waitFor(async () => {
      if (!node.process) throw new Error(`node ${node.name} exited during start-up:\n${this.logTail(node)}`);
      const res = await fetch(`${node.url}/readyz`).catch(() => null);
      return res?.ok === true;
    }, { timeoutMs: 180_000, intervalMs: 500, label: `node ${node.name} to become ready` });
    if (!waitForCluster) return;
    // The database being ready comes first; the cluster layer starts right
    // after it.
    await waitFor(async () => (await this.status(node)).running === true, {
      timeoutMs: 60_000, intervalMs: 200, label: `the cluster layer of node ${node.name} to start`,
    });
    node.nodeId = (await this.status(node)).node.id;
  }

  async stop(node, signal = 'SIGTERM') {
    if (!node.process) return;
    node.process.kill(signal);
    await Promise.race([node.exited, sleep(20_000)]);
    if (node.process) {
      node.process.kill('SIGKILL');
      await node.exited;
    }
  }

  logTail(node, lines = 40) {
    const file = path.join(node.dir, 'node.log');
    if (!existsSync(file)) return '(no log)';
    return readFileSync(file, 'utf8').trim().split('\n').slice(-lines).join('\n');
  }

  logText(node) {
    const file = path.join(node.dir, 'node.log');
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  }

  // ── HTTP helpers ─────────────────────────────────────────────────────────

  async request(node, method, pathname, { body, token, headers = {}, apiKey = true } = {}) {
    const res = await fetch(`${node.url}${pathname}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(apiKey ? { 'x-api-key': this.secrets.apiKey } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json, text };
  }

  admin(node, method, pathname, body) {
    return this.request(node, method, `/api/admin${pathname}`, { body, token: this.adminToken, apiKey: false });
  }

  // Signs a user in the way the web frontend does (trusted server-to-server
  // call), which creates the account on first use.
  async login(node, username, { klasseId = 0, klasseName = '' } = {}) {
    const res = await this.request(node, 'POST', '/auth/login', {
      body: { username, klasseId, klasseName },
      headers: { 'x-server-key': node.serverKey },
    });
    if (res.status !== 200) throw new Error(`login of ${username} on ${node.name} failed: ${res.status} ${res.text}`);
    return { token: res.json.token, refreshToken: res.json.refreshToken, user: res.json.user };
  }

  async status(node) {
    const res = await this.admin(node, 'GET', '/cluster');
    if (res.status !== 200) throw new Error(`cluster status of ${node.name}: HTTP ${res.status} ${res.text}`);
    return res.json;
  }

  // A node's entry for another one: by node id once known (addresses may be
  // anything — a relay, a proxy, a dead first choice), else by port.
  peerOf(status, other) {
    const byId = other.nodeId ? status.peers.find((peer) => peer.nodeId === other.nodeId) : undefined;
    if (byId) return byId;
    return status.peers.find((peer) => peer.address.endsWith(`:${other.port}`)
      || (other.proxyPort && peer.address.endsWith(`:${other.proxyPort}`))
      || (other.mtlsPort && peer.address.endsWith(`:${other.mtlsPort}`)));
  }

  // Links two nodes the way an operator does: an invite code created on A,
  // used on B. `addressOfB` is the address B announces for itself, which
  // lets a test route A's traffic to B through a recording proxy;
  // `tamper` changes the code before B uses it.
  async pair(a, b, { addressOfB, tamper } = {}) {
    const invite = await this.admin(a, 'POST', '/cluster/invites', { ownAddress: `http://127.0.0.1:${a.port}` });
    if (invite.status !== 201) throw new Error(`invite on ${a.name}: HTTP ${invite.status} ${invite.text}`);
    const code = tamper ? tamper(invite.json.code) : invite.json.code;
    const join = await this.admin(b, 'POST', '/cluster/join', { code, ownAddress: addressOfB ?? `http://127.0.0.1:${b.port}` });
    return { invite, join, code: invite.json.code };
  }

  async waitPaired(a, b, timeoutMs = 60_000) {
    await waitFor(async () => {
      const [sa, sb] = await Promise.all([this.status(a), this.status(b)]);
      const pa = this.peerOf(sa, b);
      const pb = this.peerOf(sb, a);
      return pa?.status === 'ACTIVE' && pb?.status === 'ACTIVE' && pa.health === 'ONLINE' && pb.health === 'ONLINE';
    }, { timeoutMs, label: `${a.name} and ${b.name} to be paired and online` });
  }

  // ── Data comparison ──────────────────────────────────────────────────────

  async replicatedTables(node) {
    const rows = await node.db.$queryRawUnsafe(
      "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'",
    );
    const local = new Set(['request_logs', 'frontend_activity_logs', 'backup_config', '_prisma_migrations']);
    return rows.map((row) => row.name).filter((name) => !name.startsWith('cluster_') && !local.has(name)).sort();
  }

  // One digest per replicated table, independent of row order.
  async snapshot(node) {
    const result = {};
    for (const table of await this.replicatedTables(node)) {
      const rows = await node.db.$queryRawUnsafe(`SELECT * FROM \`${table}\``);
      const lines = rows.map((row) => JSON.stringify(row, (_key, value) => {
        if (typeof value === 'bigint') return value.toString();
        if (value && value.type === 'Buffer' && Array.isArray(value.data)) return `bin:${createHash('sha256').update(Buffer.from(value.data)).digest('hex')}`;
        return value;
      })).sort();
      result[table] = { count: rows.length, digest: createHash('sha256').update(lines.join('\n')).digest('hex'), lines };
    }
    return result;
  }

  async differences(nodes) {
    const snapshots = await Promise.all(nodes.map((node) => this.snapshot(node)));
    const diffs = [];
    for (const table of Object.keys(snapshots[0])) {
      const digests = snapshots.map((snapshot) => snapshot[table]?.digest);
      if (new Set(digests).size > 1) {
        diffs.push(`${table}: ${nodes.map((node, index) => `${node.name}=${snapshots[index][table]?.count}`).join(' ')}`);
      }
    }
    return diffs;
  }

  // Only queues towards the given nodes count: a node that a test stopped on
  // purpose legitimately has rows waiting for it.
  async idle(nodes) {
    for (const node of nodes) {
      const status = await this.status(node);
      if (status.node.deferredChanges > 0) return `${node.name} still has ${status.node.deferredChanges} change(s) set aside`;
      for (const other of nodes) {
        const peer = other === node ? null : this.peerOf(status, other);
        if (peer?.status === 'ACTIVE' && peer.fullTransfer) return `${node.name} is still transferring everything to ${peer.name}`;
        if (peer?.status === 'ACTIVE' && peer.pendingRows > 0) return `${node.name} still has ${peer.pendingRows} change(s) waiting for ${peer.name}`;
      }
    }
    return null;
  }

  // Waits until every node has delivered everything and all hold identical data.
  async converged(nodes, { timeoutMs = 60_000, label = 'nodes to converge' } = {}) {
    let detail = '';
    try {
      await waitFor(async () => {
        const busy = await this.idle(nodes);
        if (busy) { detail = busy; return false; }
        const diffs = await this.differences(nodes);
        if (diffs.length > 0) { detail = diffs.join('; '); return false; }
        // Stable for a moment, not just between two batches.
        await sleep(600);
        return (await this.idle(nodes)) === null && (await this.differences(nodes)).length === 0;
      }, { timeoutMs, intervalMs: 300, label });
    } catch (err) {
      throw new Error(`${err.message} — ${detail}`);
    }
  }

  // Runs SQL that the application's own database client cannot send (trigger
  // DDL), the same way the server itself does.
  runSql(node, sql) {
    execFileSync(process.execPath, [path.join(REPO, 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'execute', '--stdin', '--url', node.databaseUrl], {
      input: sql,
      cwd: node.dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
  }

  // ── Recording proxy ──────────────────────────────────────────────────────
  // Sits between two nodes and keeps every request body it forwards, so a
  // test can inspect and replay exactly what travelled over the network.

  async recordingProxy(target) {
    const captured = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        captured.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
        const upstream = http.request({
          host: '127.0.0.1', port: target.port, method: req.method, path: req.url,
          headers: { ...req.headers, host: `127.0.0.1:${target.port}` },
        }, (reply) => {
          res.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(res);
        });
        upstream.on('error', () => { res.writeHead(502); res.end(); });
        upstream.end(body);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    target.proxyPort = port;
    this.proxies.push(server);
    return { port, captured };
  }

  // ── Teardown ─────────────────────────────────────────────────────────────

  async teardown() {
    for (const node of this.nodes.values()) await this.stop(node, 'SIGKILL').catch(() => {});
    for (const proxy of this.proxies) proxy.close();
    for (const node of this.nodes.values()) {
      await node.db.$disconnect().catch(() => {});
      if (this.adminDb) await this.adminDb.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${node.database}\``).catch(() => {});
    }
    if (this.adminDb) await this.adminDb.$disconnect().catch(() => {});
    if (this.container) {
      try { execFileSync('docker', ['rm', '-f', this.container], { stdio: 'pipe' }); } catch { /* already gone */ }
    }
    if (!process.env.CLUSTER_E2E_KEEP) rmSync(this.root, { recursive: true, force: true });
  }
}
