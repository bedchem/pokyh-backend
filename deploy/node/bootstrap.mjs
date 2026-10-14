// Pokyh node bootstrap — the part of the one-line installer that talks to the
// cluster. install.sh runs it once on the new server, inside a throw-away
// Node.js container, with the install token on stdin and the installation
// directory (/opt/pokyh) mounted at /out.
//
// What it does, and what protects each step:
//   1. Reads the token: the inviting node's channel address, the pin of its
//      certificate, the install id and a 256-bit secret (never sent).
//   2. Connects to the inviting node over TLS 1.3 and accepts exactly the
//      certificate with that pin — no certificate authority, DNS answer or
//      proxy can stand in for it.
//   3. Proves knowledge of the token (HMAC over a fresh nonce and the time)
//      and receives the shared configuration, sealed with AES-256-GCM under a
//      key derived from the secret and bound to this request. It can be
//      fetched once; it is kept in state/provision.json (0600) so a run that
//      fails later can resume.
//   4. Downloads the inviting node's build and checks it against the SHA-256
//      that came inside the sealed configuration.
//   5. Generates this node's own secrets (database password, CLUSTER_SECRET)
//      and writes .env (0600), compose.env, the Caddyfile and the one-time
//      join instruction the backend picks up and deletes at its first start.
//
// No dependency beyond Node.js. The key derivation, proof and sealing mirror
// src/cluster/installToken.ts; tests/clusterInstall checks that both agree.

import { X509Certificate, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';

const LABEL = 'pokyh-cluster/v1';
const TOKEN_PREFIX = 'pokyhnode1.';
const CHANNEL_PATH = '/cluster/v1';
const TIMEOUT_MS = 20_000;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const MAX_CLOCK_DIFFERENCE_MS = 60_000;

const NODE_ID = /^[A-Za-z0-9-]{8,36}$/;
const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PIN = /^[A-Za-z0-9+/]{43}=$/;
const DOMAIN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
// Names end up in the env file: no control characters, nothing but plain text.
const NAME = /^[\p{L}\p{N} ._-]{0,120}$/u;
const ENV_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;

// Settings that belong to this node alone. A shared configuration never
// carries them (src/cluster/sharedEnv.ts); they are refused here as well.
const NODE_LOCAL = new Set([
  'NODE_ENV', 'PORT', 'TRUST_PROXY', 'DATABASE_URL', 'MYSQL_ROOT_PASSWORD',
  'LEARN_REDIS_URL', 'LEARN_AI_OLLAMA_BASE_URL', 'BACKUP_DIR',
  'CLUSTER_ENABLED', 'CLUSTER_SECRET', 'CLUSTER_NODE_NAME', 'CLUSTER_ADVERTISE_URL', 'CLUSTER_PUBLIC_PATH',
  'CLUSTER_PORT', 'CLUSTER_BIND_ADDRESS', 'CLUSTER_ALLOWLIST', 'CLUSTER_MTLS_PORT', 'CLUSTER_MTLS_BIND_ADDRESS',
  'CLUSTER_MTLS_URL', 'CLUSTER_BOOTSTRAP_DIR', 'CLUSTER_MTLS_ENDPOINTS', 'CLUSTER_RELAY_KEYS', 'CLUSTER_RELAY_LABEL', 'CLUSTER_RELAY_POOL_SIZE',
]);
const NODE_LOCAL_PREFIXES = ['DB_', 'BACKEND_'];
// Variables that change how programs start or where they look for code. The
// cluster never sends them; were one to arrive, it is refused all the same.
const PROCESS_CONTROL = /^(NODE_|NPM_|LD_|DYLD_|PRISMA_|BASH_|PYTHON|PERL|RUBY|OPENSSL_|SSL_|GIT_)|^(PATH|HOME|SHELL|ENV|IFS|TMPDIR|HOSTNAME|USER)$/;

export class BootstrapError extends Error {}

// ─── Endpoints (mirror of src/cluster/endpoints.ts) ──────────────────────────

const SERVER_NAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;

export function parseEndpoint(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 300) return null;
  let url;
  try { url = new URL(text.trim()); } catch { return null; }
  const port = writtenPort(text);
  if (url.protocol !== 'https:' || !url.hostname || port === null || url.username || url.password) return null;
  if ((url.pathname !== '/' && url.pathname !== '') || url.hash) return null;
  if ([...url.searchParams.keys()].some((key) => key !== 'sni') || url.searchParams.getAll('sni').length > 1) return null;
  const sni = url.searchParams.get('sni')?.toLowerCase();
  if (sni !== undefined && (!SERVER_NAME.test(sni) || isIP(sni) !== 0)) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const base = `https://${url.hostname}:${port}`;
  return sni && sni !== host ? { url: base, sni } : { url: base };
}

export function connectTarget(endpoint) {
  const url = new URL(endpoint.url);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return { host, port: writtenPort(endpoint.url) ?? 443, servername: endpoint.sni ?? (isIP(host) === 0 ? host.toLowerCase() : undefined) };
}

function describe(endpoint) {
  return endpoint.sni ? `${endpoint.url} (${endpoint.sni})` : endpoint.url;
}

// ─── Token and keys (mirror of src/cluster/installToken.ts) ─────────────────

const WRITTEN_PORT = /^https:\/\/(?:\[[^\]]*\]|[^/:?#@\[\]]+):(\d{1,5})(?=[/?#]|$)/i;

function writtenPort(text) {
  const match = WRITTEN_PORT.exec(String(text).trim());
  const port = match ? Number(match[1]) : 0;
  return port >= 1 && port <= 65_535 ? port : null;
}

export function isChannelUrl(value) {
  try {
    const url = new URL(value);
    const port = writtenPort(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && port !== null
      && !url.username && !url.password && (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash
      && `https://${url.hostname}:${port}` === value;
  } catch {
    return false;
  }
}

export function decodeToken(text, now = Date.now()) {
  const trimmed = String(text).replace(/\s+/g, '');
  if (!trimmed.startsWith(TOKEN_PREFIX)) throw new BootstrapError('This is not a Pokyh install token');
  if (trimmed.length > 2048) throw new BootstrapError('The install token is too long');
  let body;
  try {
    body = JSON.parse(Buffer.from(trimmed.slice(TOKEN_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new BootstrapError('The install token is damaged or incomplete');
  }
  const { v, a, f, n, i, s, e, x, w } = body ?? {};
  if (v !== 1) throw new BootstrapError('The install token comes from a different Pokyh version');
  if (typeof a !== 'string' || a.length > 255 || !isChannelUrl(a) || typeof f !== 'string' || !PIN.test(f)
    || typeof n !== 'string' || !NODE_ID.test(n) || typeof i !== 'string' || !INSTALL_ID.test(i)
    || typeof s !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(s) || !Number.isInteger(e) || e <= 0) {
    throw new BootstrapError('The install token is damaged or incomplete');
  }
  const listed = Array.isArray(x) ? x.slice(0, 8).map(parseEndpoint) : [parseEndpoint(a)];
  if (listed.some((endpoint) => endpoint === null) || listed.length === 0) throw new BootstrapError('The install token is damaged or incomplete');
  if (w !== undefined && (typeof w !== 'string' || w.length > 255 || !/^https?:\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/.test(w))) throw new BootstrapError('The install token is damaged or incomplete');
  return { url: a, endpoints: listed, web: w ?? null, pin: f, nodeId: n, id: i, secret: Buffer.from(s, 'base64url'), expiresAt: new Date(e * 1000), expired: e * 1000 <= now };
}

function derive(secret, id, purpose) {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.from(id, 'utf8'), Buffer.from(`${LABEL}/install/${purpose}`, 'utf8'), 32));
}

export function deriveKeys(secret, id) {
  return { auth: derive(secret, id, 'auth'), enc: derive(secret, id, 'encrypt'), pairSecret: derive(secret, id, 'pair').toString('base64url') };
}

function fields(parts) {
  return Buffer.concat(parts.flatMap((part) => {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length, 0);
    return [length, bytes];
  }));
}

export function proof(authKey, purpose, id, timestamp, nonce) {
  return createHmac('sha256', authKey).update(fields([`${LABEL}/install/${purpose}`, id, String(timestamp), nonce])).digest();
}

export function openPayload(encKey, id, nonce, sealed) {
  const iv = Buffer.from(String(sealed?.iv ?? ''), 'base64url');
  const body = Buffer.from(String(sealed?.ct ?? ''), 'base64url');
  if (iv.length !== 12 || body.length < 16) throw new BootstrapError('The sealed configuration is malformed');
  const decipher = createDecipheriv('aes-256-gcm', encKey, iv);
  decipher.setAAD(fields([`${LABEL}/install/payload`, id, nonce]));
  decipher.setAuthTag(body.subarray(body.length - 16));
  try {
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  } catch {
    throw new BootstrapError('The configuration failed authentication — it was not sealed for this token');
  }
}

export function pinOf(certificate) {
  const x509 = certificate instanceof X509Certificate ? certificate : new X509Certificate(certificate);
  return createHash('sha256').update(x509.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
}

// ─── Checking what arrived ───────────────────────────────────────────────────

export function isNodeLocal(key) {
  return NODE_LOCAL.has(key) || NODE_LOCAL_PREFIXES.some((prefix) => key.startsWith(prefix)) || PROCESS_CONTROL.test(key);
}

// Inside the stack the app listens on these ports (not published; Caddy and
// the edge forwarder reach it there). What the outside sees is chosen per
// install (installOptions.ts).
const APP_PORT = 4000;
const APP_CHANNEL_PORT = 4100;

// An IPv4/IPv6 address or CIDR range (src/cluster/installOptions.ts).
export function validSource(text) {
  if (typeof text !== 'string') return false;
  const slash = text.indexOf('/');
  const address = slash >= 0 ? text.slice(0, slash) : text;
  const family = isIP(address);
  if (family === 0) return false;
  if (slash < 0) return true;
  const bits = text.slice(slash + 1);
  return /^\d{1,3}$/.test(bits) && Number(bits) <= (family === 4 ? 32 : 128);
}

function validOptions(node) {
  const portOk = (value) => Number.isInteger(value) && value >= 1 && value <= 65_535;
  const bindOk = (value) => typeof value === 'string' && (value === '' || isIP(value) !== 0);
  const sourcesOk = (value) => Array.isArray(value) && value.length <= 16 && value.every(validSource);
  if (!['none', 'domain', 'proxy'].includes(node.web)) return 'web access';
  if (node.web === 'domain' && !node.domain) return 'web access without a domain';
  if (!portOk(node.clusterPort) || !bindOk(node.clusterBind) || !sourcesOk(node.clusterFrom)) return 'cluster port';
  if (node.web === 'proxy' && (!portOk(node.apiPort) || node.apiPort === node.clusterPort)) return 'API port';
  if (!bindOk(node.apiBind) || !sourcesOk(node.apiFrom)) return 'API address';
  return null;
}

export function validatePayload(payload, token) {
  const fail = (what) => { throw new BootstrapError(`The configuration from the cluster is unusable (${what})`); };
  if (!payload || payload.v !== 1) fail('version');
  const node = payload.node ?? {};
  if (typeof node.domain !== 'string' || (node.domain !== '' && !DOMAIN.test(node.domain))) fail('domain');
  if (node.address !== undefined && (typeof node.address !== 'string' || (node.address !== '' && isIP(node.address) === 0))) fail('address');
  const update = payload.update ?? { repo: '', branch: 'main' };
  if (typeof update.repo !== 'string' || (update.repo !== '' && !/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~-]+){2,4}$/.test(update.repo))) fail('update.repo');
  if (typeof update.branch !== 'string' || !/^[A-Za-z0-9._/-]{1,200}$/.test(update.branch) || update.branch.includes('..')) fail('update.branch');
  if (typeof node.name !== 'string' || !NAME.test(node.name)) fail('name');
  const optionsProblem = validOptions(node);
  if (optionsProblem) fail(optionsProblem);
  if (typeof node.withAi !== 'boolean') fail('AI choice');
  if (typeof node.acmeEmail !== 'string' || (node.acmeEmail !== '' && !EMAIL.test(node.acmeEmail))) fail('e-mail');
  if (!payload.env || typeof payload.env !== 'object' || Array.isArray(payload.env)) fail('settings');
  for (const [key, value] of Object.entries(payload.env)) {
    if (!ENV_KEY.test(key) || typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/.test(value)) fail(`setting ${key.slice(0, 64)}`);
  }
  const bundle = payload.bundle ?? {};
  if (typeof bundle.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(bundle.sha256)) fail('build hash');
  if (!Number.isInteger(bundle.bytes) || bundle.bytes <= 0 || bundle.bytes > MAX_BUNDLE_BYTES) fail('build size');
  const cluster = payload.cluster ?? {};
  if (cluster.url !== token.url || cluster.nodeId !== token.nodeId) fail('cluster node');
  if (cluster.endpoints !== undefined && (!Array.isArray(cluster.endpoints) || cluster.endpoints.length > 8 || cluster.endpoints.some((item) => parseEndpoint(item) === null))) fail('cluster node addresses');
  if (typeof cluster.name !== 'string' || cluster.name.length > 120 || /[\x00-\x1f\x7f]/.test(cluster.name)) fail('cluster node name');
  if (typeof cluster.cert !== 'string' || cluster.cert.length > 4096) fail('certificate');
  let certPin;
  try { certPin = pinOf(cluster.cert); } catch { fail('certificate'); }
  // The certificate handed over is the very one this connection was pinned to.
  if (certPin !== token.pin) fail('certificate does not match the pin');
  if (!Number.isInteger(cluster.pairingUntil) || cluster.pairingUntil <= 0) fail('pairing window');
  if (!Number.isFinite(payload.t)) fail('time');
  return payload;
}

// ─── Files this node is set up with ──────────────────────────────────────────

function envLine(key, value) {
  return `${key}=${value}\n`;
}

// The address the other nodes reach this one at: its domain, else its IP.
export function channelHost(node) {
  if (node.domain) return node.domain;
  if (node.address) return isIP(node.address) === 6 ? `[${node.address}]` : node.address;
  return '';
}

export function buildEnvFile({ payload, secrets, generatedAt }) {
  const { node } = payload;
  const host = channelHost(node);
  const channelUrl = host ? `https://${host}:${node.clusterPort}` : '';
  const local = {
    NODE_ENV: 'production',
    PORT: String(APP_PORT),
    // Only Caddy reaches the API port (it is not published); it passes the
    // client address on. Behind the administrator's proxy, that proxy's
    // addresses are trusted as well, so the real client arrives.
    TRUST_PROXY: ['uniquelocal', ...(node.web === 'proxy' ? node.apiFrom : [])].join(','),
    DB_HOST: 'mysql',
    DB_PORT: '3306',
    DB_USER: 'root',
    DB_PASSWORD: secrets.mysqlRootPassword,
    DB_NAME: 'pokyh',
    MYSQL_ROOT_PASSWORD: secrets.mysqlRootPassword,
    DATABASE_URL: `mysql://root:${secrets.mysqlRootPassword}@mysql:3306/pokyh`,
    DB_AUTO_PUSH: 'true',
    CLUSTER_ENABLED: 'true',
    CLUSTER_NODE_NAME: node.name || (node.domain ? node.domain.split('.')[0] : 'node'),
    CLUSTER_SECRET: secrets.clusterSecret,
    CLUSTER_PUBLIC_PATH: 'false',
    CLUSTER_PORT: '0',
    CLUSTER_MTLS_PORT: String(APP_CHANNEL_PORT),
    CLUSTER_MTLS_BIND_ADDRESS: '0.0.0.0',
    CLUSTER_MTLS_URL: channelUrl,
    CLUSTER_ADVERTISE_URL: channelUrl,
    CLUSTER_BOOTSTRAP_DIR: '/app/data/bootstrap',
    // The channel port belongs to the edge forwarder (deploy/node/edge.mjs),
    // which names each client in a PROXY protocol line.
    CLUSTER_MTLS_PROXY_PROTOCOL: 'true',
    // Shared with the updater (blue/green updates, src/cluster/updates.ts).
    POKYH_UPDATE_DIR: '/app/data/update',
    POKYH_ACTIVATION_FILE: '/app/data/update/active',
  };
  const shared = Object.fromEntries(Object.entries(payload.env).filter(([key]) => !isNodeLocal(key)));
  shared.LEARN_AI_ENABLED = node.withAi ? 'true' : 'false';
  // PUBLIC_BASE_URL follows the cluster exactly: links stored in replicated
  // data must not point at one particular node, so an empty value (relative
  // links) stays empty here as well.

  let text = `# Pokyh node ${node.name || node.domain || host} — written by the one-line installer on ${generatedAt}.\n`;
  text += '# Keep this file private (mode 0600). Settings below "shared" came from the\n';
  text += `# cluster node ${(payload.cluster.name || payload.cluster.url).replace(/[^\p{L}\p{N} .:/_-]/gu, '')} and must stay equal on every node.\n\n`;
  text += '# ── This node ──\n';
  for (const [key, value] of Object.entries(local)) text += envLine(key, value);
  text += '\n# ── Shared with the cluster ──\n';
  for (const key of Object.keys(shared).sort()) text += envLine(key, shared[key]);
  return text;
}

// Both colours of a blue/green update; only those that answer /readyz get
// requests, so a version that is still starting (or failing) never does.
// While one goes away, a request is retried at the other.
function upstreamBlock() {
  let text = `\treverse_proxy app-blue:${APP_PORT} app-green:${APP_PORT} {\n`;
  text += '\t\thealth_uri /readyz\n';
  text += '\t\thealth_interval 1s\n';
  text += '\t\thealth_timeout 2s\n';
  text += '\t\thealth_passes 2\n';
  text += '\t\thealth_fails 1\n';
  text += '\t\tlb_policy round_robin\n';
  text += '\t\tlb_try_duration 15s\n';
  text += '\t\tlb_try_interval 250ms\n';
  text += '\t\tfail_duration 10s\n';
  // A colour that just went away must not hold a request up for long.
  text += '\t\ttransport http {\n\t\t\tdial_timeout 1s\n\t\t}\n';
  text += '\t}\n';
  return text;
}

// The colour that is not running fails its health check every second; that
// is expected and would only flood the log.
const QUIET_HEALTH_LOG = '\tlog default {\n\t\texclude http.handlers.reverse_proxy.health_checker.active\n\t}';

export function renderCaddyfile({ domain, acmeEmail, tlsInternal }) {
  const global = [];
  if (acmeEmail) global.push(`\temail ${acmeEmail}`);
  global.push(QUIET_HEALTH_LOG);
  let text = '# Written by the Pokyh node installer.\n';
  text += `{\n${global.join('\n')}\n}\n\n`;
  text += `${domain} {\n`;
  if (tlsInternal) text += '\ttls internal\n';
  text += '\tencode zstd gzip\n';
  text += '\theader Strict-Transport-Security "max-age=31536000"\n';
  text += upstreamBlock();
  text += '}\n';
  return text;
}

// Behind the administrator's own proxy: plain HTTP on the gateway's port (the
// proxy does TLS), the proxy's addresses trusted for the client address.
export const GATEWAY_PORT = 8080;
export function renderGatewayCaddyfile({ trusted }) {
  let text = '# Written by the Pokyh node installer (behind your proxy).\n';
  text += '{\n';
  text += `${QUIET_HEALTH_LOG}\n`;
  text += '\tservers {\n';
  text += `\t\ttrusted_proxies static private_ranges${trusted.length > 0 ? ` ${trusted.join(' ')}` : ''}\n`;
  text += '\t}\n';
  text += '}\n\n';
  text += `:${GATEWAY_PORT} {\n`;
  text += '\tencode zstd gzip\n';
  text += upstreamBlock();
  text += '}\n';
  return text;
}

// Sizes the AI runtime for this host and decides whether it fits at all.
export function aiPlan({ withAi, memKb, cpus }) {
  const memGb = Math.floor(memKb / (1024 * 1024));
  if (!withAi) return { enabled: false, note: '' };
  if (memGb < 12) return { enabled: false, note: `The AI runtime needs at least 12 GB of memory; this server has ${memGb} GB, so it is left out` };
  return {
    enabled: true,
    memLimit: `${Math.min(10, memGb - 4)}g`,
    cpus: String(Math.max(1, Math.min(4, cpus))),
    threads: String(Math.max(1, Math.min(4, cpus))),
    note: '',
  };
}

export function renderComposeEnv({ ai, node = { web: 'none', clusterPort: APP_CHANNEL_PORT, clusterBind: '', apiPort: 0, apiBind: '' }, home = '/opt/pokyh', runtime = { repo: '', branch: 'main' } }) {
  const webProfile = node.web === 'domain' ? ['web'] : node.web === 'proxy' ? ['gateway'] : [];
  const profiles = ['blue', ...webProfile, ...(ai.enabled ? ['ai'] : [])];
  let text = '# Stack settings for compose.yml (not secret). Written by the installer;\n';
  text += '# the updater changes POKYH_IMAGE_* and COMPOSE_PROFILES (blue/green).\n';
  text += 'COMPOSE_PROJECT_NAME=pokyh\n';
  text += `POKYH_HOME=${home}\n`;
  text += `COMPOSE_PROFILES=${profiles.join(',')}\n`;
  // The only source the updater takes its own files from (updater.mjs).
  text += `POKYH_RUNTIME_REPO=${runtime.repo}\nPOKYH_RUNTIME_BRANCH=${runtime.branch}\n`;
  // Where the outside reaches this server (chosen when the command was made).
  text += `POKYH_CLUSTER_PORT=${node.clusterPort}\nPOKYH_CLUSTER_BIND=${node.clusterBind || '0.0.0.0'}\n`;
  if (node.web === 'proxy') text += `POKYH_API_PORT=${node.apiPort}\nPOKYH_API_BIND=${node.apiBind || '0.0.0.0'}\n`;
  if (ai.enabled) text += `OLLAMA_MEM_LIMIT=${ai.memLimit}\nOLLAMA_CPUS=${ai.cpus}\nOLLAMA_NUM_THREAD=${ai.threads}\n`;
  return text;
}

export function joinInstruction(payload, keys) {
  return {
    v: 1,
    url: payload.cluster.url,
    endpoints: payload.cluster.endpoints ?? [payload.cluster.url],
    nodeId: payload.cluster.nodeId,
    name: payload.cluster.name,
    cert: payload.cluster.cert,
    secret: keys.pairSecret,
    pairingUntil: payload.cluster.pairingUntil,
  };
}

// ─── Network ─────────────────────────────────────────────────────────────────

function hostOf(url) {
  return url.hostname.replace(/^\[|\]$/g, '');
}

// Reads the certificate the node presents on one of its ways and returns it if
// its pin matches; also returns the way that worked. Nothing else is sent.
function fetchOne(endpoint, pin, timeoutMs) {
  const target = connectTarget(endpoint);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: target.host, port: target.port, servername: target.servername, minVersion: 'TLSv1.3', rejectUnauthorized: false });
    const timer = setTimeout(() => { socket.destroy(); reject(new BootstrapError('no answer')); }, timeoutMs);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const cert = socket.getPeerX509Certificate();
      socket.end();
      if (!cert || pinOf(cert) !== pin) {
        reject(new BootstrapError('presented a certificate other than the pinned one — refusing to continue'));
        return;
      }
      resolve(cert.toString());
    });
    socket.once('error', (err) => { clearTimeout(timer); reject(new BootstrapError(err.message)); });
  });
}

export async function fetchPinnedCertificate(endpoints, pin, timeoutMs = TIMEOUT_MS) {
  const failures = [];
  let impostor = false;
  for (const endpoint of endpoints) {
    try {
      return { certPem: await fetchOne(endpoint, pin, Math.min(timeoutMs, 8_000)), endpoint };
    } catch (err) {
      if (/pinned/.test(err.message)) impostor = true;
      failures.push(`${describe(endpoint)}: ${err.message}`);
    }
  }
  if (impostor) throw new BootstrapError(`The cluster node presented a certificate other than the pinned one — refusing to continue (${failures.join('; ')})`);
  throw new BootstrapError(`The cluster node cannot be reached from this server (${failures.join('; ')}) — is its port open to the internet?`);
}

function requestOne(endpoint, pin, certPem, pathname, body, { maxBytes, file }) {
  const target = connectTarget(endpoint);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: target.host,
      port: target.port,
      servername: target.servername,
      method: 'POST',
      path: `${CHANNEL_PATH}${pathname}`,
      headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
      agent: false,
      minVersion: 'TLSv1.3',
      ca: [certPem],
      checkServerIdentity: (_host, cert) => (pinOf(cert.raw) === pin ? undefined : new Error('certificate other than the pinned one')),
    }, (res) => {
      const hash = createHash('sha256');
      const chunks = [];
      let size = 0;
      const out = file && res.statusCode === 200 ? fs.createWriteStream(file, { mode: 0o600 }) : null;
      out?.on('error', (err) => { res.destroy(); reject(new BootstrapError(`The build could not be saved: ${err.message}`)); });
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { res.destroy(); out?.destroy(); reject(new BootstrapError('The answer is larger than allowed')); return; }
        hash.update(chunk);
        if (out) out.write(chunk); else chunks.push(chunk);
      });
      res.on('end', () => {
        const finish = () => resolve({ status: res.statusCode ?? 0, date: res.headers.date ?? '', body: Buffer.concat(chunks), sha256: hash.digest('hex'), bytes: size });
        if (out) out.end(finish); else finish();
      });
      res.on('error', (err) => reject(new BootstrapError(err.message)));
    });
    req.setTimeout(file ? 10 * 60_000 : TIMEOUT_MS, () => req.destroy(new BootstrapError('The cluster node stopped answering')));
    req.on('error', (err) => reject(err instanceof BootstrapError ? err : new BootstrapError(`Request to the cluster node failed: ${err.message}`)));
    req.end(body);
  });
}

// One request over the first way that delivers it (the one that answered
// the certificate check first).
async function pinnedRequest(ways, pin, certPem, pathname, payload, options) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const failures = [];
  for (const endpoint of ways) {
    try {
      return await requestOne(endpoint, pin, certPem, pathname, body, options);
    } catch (err) {
      failures.push(`${describe(endpoint)}: ${err.message}`);
    }
  }
  throw new BootstrapError(`Request to the cluster node failed (${failures.join('; ')})`);
}

// A request to the inviting node's public address (normal TLS with the
// system's certificate authorities). Its answer protects itself: the
// configuration is sealed with the key, the build checked by hash.
function publicRequest(base, pathname, payload, { maxBytes, file }) {
  const url = new URL(`${base}/setup${pathname}`);
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(body.length) } }, (res) => {
      const hash = createHash('sha256');
      const chunks = [];
      let size = 0;
      const out = file && res.statusCode === 200 ? fs.createWriteStream(file, { mode: 0o600 }) : null;
      out?.on('error', (err) => { res.destroy(); reject(new BootstrapError(`The build could not be saved: ${err.message}`)); });
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { res.destroy(); out?.destroy(); reject(new BootstrapError('The answer is larger than allowed')); return; }
        hash.update(chunk);
        if (out) out.write(chunk); else chunks.push(chunk);
      });
      res.on('end', () => {
        const finish = () => resolve({ status: res.statusCode ?? 0, date: res.headers.date ?? '', body: Buffer.concat(chunks), sha256: hash.digest('hex'), bytes: size });
        if (out) out.end(finish); else finish();
      });
      res.on('error', (err) => reject(new BootstrapError(err.message)));
    });
    req.setTimeout(file ? 10 * 60_000 : TIMEOUT_MS, () => req.destroy(new BootstrapError('no answer')));
    req.on('error', (err) => reject(err instanceof BootstrapError ? err : new BootstrapError(err.message)));
    req.end(body);
  });
}

function signedRequest(token, keys, purpose) {
  const nonce = randomBytes(24).toString('base64url');
  const t = Date.now();
  return { nonce, body: { i: token.id, t, n: nonce, mac: proof(keys.auth, purpose, token.id, t, nonce).toString('base64url') } };
}

// The cluster resolves conflicting changes by time, so this server's clock
// has to agree with the cluster's. Checked against the Date of each answer.
export function clockDifferenceMs(dateHeader, now = Date.now()) {
  const remote = Date.parse(dateHeader);
  return Number.isFinite(remote) ? Math.abs(now - remote) : 0;
}

function checkClock(reply) {
  const difference = clockDifferenceMs(reply.date);
  if (difference > MAX_CLOCK_DIFFERENCE_MS) {
    throw new BootstrapError(`This server's clock differs from the cluster by about ${Math.round(difference / 1000)} s — the cluster resolves conflicts by time. Synchronise the clock (NTP) and run the same command again`);
  }
}

function explainRefusal(status, body) {
  let error = '';
  try { error = JSON.parse(body.toString('utf8')).error ?? ''; } catch { /* not JSON */ }
  if (status === 404) return 'The install command is no longer valid (expired, used or revoked) — create a new one in the admin panel';
  if (status === 409) return 'This install command was already used — create a new one in the admin panel';
  if (status === 403 && error === 'clock') return 'This server\'s clock differs from the cluster by more than ten minutes — synchronise the time and run the command again';
  if (status === 403) return 'The cluster node refused the install token';
  if (status === 429) return 'Too many attempts — wait a minute and run the command again';
  return `The cluster node answered HTTP ${status}`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { text += chunk; if (text.length > 4096) process.stdin.destroy(); });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('close', () => resolve(text));
  });
}

// Ownership is handed to the backend's account only where this runs as root
// (always, under install.sh); otherwise the files stay with the caller.
const AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

function writePrivate(file, text, uid) {
  fs.writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
  if (uid !== undefined && AS_ROOT) fs.chownSync(`${file}.tmp`, uid, uid);
  fs.renameSync(`${file}.tmp`, file);
}

function log(message) {
  process.stdout.write(`    ${message}\n`);
}

export async function main({ out = process.env.POKYH_OUT || '/out', tokenText } = {}) {
  const token = decodeToken(tokenText ?? await readStdin());
  const keys = deriveKeys(token.secret, token.id);
  const appUid = Number(process.env.POKYH_APP_UID || 10001);
  const stateDir = path.join(out, 'state');
  const bootstrapDir = path.join(out, 'data', 'bootstrap');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(bootstrapDir, { recursive: true, mode: 0o700 });
  const provisionFile = path.join(stateDir, 'provision.json');

  // Two ways to the inviting node: its public address (as the admin panel
  // shows it) and its pinned channel. The public one is tried first — the
  // channel may not be reachable from outside yet. Whatever answers, the key
  // decides: the configuration is sealed with it, the build fixed by the
  // hash inside it, the inviting node's certificate checked against the pin.
  let channel = null;
  const viaChannel = async () => {
    if (!channel) {
      const reached = await fetchPinnedCertificate(token.endpoints, token.pin);
      channel = { certPem: reached.certPem, ways: [reached.endpoint, ...token.endpoints.filter((endpoint) => endpoint !== reached.endpoint)] };
      log(`Connected to ${describe(reached.endpoint)} — certificate matches the pin`);
    }
    return channel;
  };
  // A refusal by the node itself is final; anything else on the public way
  // (unreachable, not this cluster's node, an answer that does not verify)
  // makes the bootstrap try the channel instead.
  const FINAL = new Set([403, 409, 429]);
  const ask = async (purpose, pathname, options, accept) => {
    let publicError = null;
    if (token.web) {
      const request = signedRequest(token, keys, purpose);
      let reply = null;
      try {
        reply = await publicRequest(token.web, pathname, request.body, options);
      } catch (err) {
        publicError = `${token.web} cannot be reached: ${err.message}`;
      }
      if (reply && FINAL.has(reply.status)) throw new BootstrapError(explainRefusal(reply.status, reply.body));
      if (reply && reply.status === 200) {
        try {
          const result = accept(reply, request.nonce);
          log(`Reached ${token.web}`);
          return result;
        } catch (err) {
          publicError = `the answer from ${token.web} does not verify (${err.message})`;
        }
      } else if (reply) {
        publicError = `${token.web}: ${explainRefusal(reply.status, reply.body)}`;
      }
      if (options.file) fs.rmSync(options.file, { force: true });
      log(`${publicError} — trying the cluster channel`);
    }
    const request = signedRequest(token, keys, purpose);
    let reply;
    try {
      const { certPem: pinned, ways } = await viaChannel();
      reply = await pinnedRequest(ways, token.pin, pinned, pathname === '/bundle' ? '/provision/bundle' : '/provision', request.body, options);
    } catch (err) {
      throw new BootstrapError(publicError ? `${publicError}; over the cluster channel: ${err.message}` : err.message);
    }
    if (reply.status !== 200) throw new BootstrapError(explainRefusal(reply.status, reply.body));
    return accept(reply, request.nonce);
  };

  let payload;
  if (fs.existsSync(provisionFile)) {
    payload = validatePayload(JSON.parse(fs.readFileSync(provisionFile, 'utf8')), token);
    log('Using the configuration received earlier');
  } else {
    if (token.expired) throw new BootstrapError('The install key has expired — create a new one-line command in the admin panel');
    payload = await ask('provision', '/provision', { maxBytes: 1024 * 1024 }, (reply, nonce) => {
      const sealed = JSON.parse(reply.body.toString('utf8'));
      const opened = validatePayload(JSON.parse(openPayload(keys.enc, token.id, nonce, sealed).toString('utf8')), token);
      // Kept before anything else can fail: it can be fetched only once.
      writePrivate(provisionFile, JSON.stringify(opened));
      checkClock(reply);
      return opened;
    });
    log(`Configuration received from ${payload.cluster.name || token.url} (${Object.keys(payload.env).length} shared settings)`);
  }

  // The cluster node's exact build, verified against the sealed hash.
  const bundleFile = path.join(stateDir, 'bundle.tgz');
  const haveBundle = fs.existsSync(bundleFile)
    && createHash('sha256').update(fs.readFileSync(bundleFile)).digest('hex') === payload.bundle.sha256;
  if (!haveBundle) {
    const partial = `${bundleFile}.part`;
    try {
      const reply = await ask('bundle', '/bundle', { maxBytes: MAX_BUNDLE_BYTES, file: partial }, (answer) => {
        if (answer.sha256 !== payload.bundle.sha256 || answer.bytes !== payload.bundle.bytes) {
          throw new BootstrapError('The downloaded build does not match the hash the cluster sealed — refusing to install it');
        }
        return answer;
      });
      checkClock(reply);
      fs.renameSync(partial, bundleFile);
      log(`Build downloaded and verified (${(reply.bytes / 1024 / 1024).toFixed(1)} MB, sha256 ${reply.sha256.slice(0, 16)}…)`);
    } catch (err) {
      fs.rmSync(partial, { force: true });
      throw err;
    }
  }

  // This node's own secrets: generated once, kept across a resumed run.
  const secretsFile = path.join(stateDir, 'node-secrets.json');
  let secrets;
  if (fs.existsSync(secretsFile)) {
    secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
  } else {
    secrets = { mysqlRootPassword: randomBytes(24).toString('base64url'), clusterSecret: randomBytes(48).toString('base64url') };
    writePrivate(secretsFile, JSON.stringify(secrets));
  }

  const ai = aiPlan({ withAi: payload.node.withAi, memKb: Number(process.env.POKYH_MEM_KB || 0), cpus: Number(process.env.POKYH_CPUS || 1) });
  if (ai.note) log(ai.note);
  const effective = ai.enabled || !payload.node.withAi ? payload : { ...payload, node: { ...payload.node, withAi: false } };
  writePrivate(path.join(out, '.env'), buildEnvFile({ payload: effective, secrets, generatedAt: new Date().toISOString() }));
  const { node } = payload;
  writePrivate(path.join(out, 'compose.env'), renderComposeEnv({ ai, node, home: process.env.POKYH_HOME_ON_HOST || '/opt/pokyh', runtime: payload.update ?? { repo: '', branch: 'main' } }));
  if (node.web === 'domain') {
    fs.writeFileSync(path.join(out, 'Caddyfile'), renderCaddyfile({
      domain: node.domain,
      acmeEmail: node.acmeEmail,
      tlsInternal: process.env.POKYH_TLS_INTERNAL === '1',
    }), { mode: 0o644 });
  } else if (node.web === 'proxy') {
    fs.writeFileSync(path.join(out, 'Caddyfile'), renderGatewayCaddyfile({ trusted: node.apiFrom }), { mode: 0o644 });
  }

  // The backend takes this over at its first start and deletes it at once.
  if (AS_ROOT) fs.chownSync(bootstrapDir, appUid, appUid);
  if (!fs.existsSync(path.join(bootstrapDir, 'status.json'))) {
    writePrivate(path.join(bootstrapDir, 'join.json'), JSON.stringify(joinInstruction(payload, keys)), appUid);
  }

  const safeName = (payload.node.name || '').replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 120);
  const safePeer = (payload.cluster.name || '').replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 120);
  const summary = [
    `domain=${node.domain}`,
    `address=${node.address ?? ''}`,
    `name=${safeName}`,
    `peer=${safePeer}`,
    `ai=${ai.enabled ? 'yes' : 'no'}`,
    `web=${node.web}`,
    `cluster_port=${node.clusterPort}`,
    `cluster_from=${node.clusterFrom.join(' ')}`,
    `api_port=${node.web === 'proxy' ? node.apiPort : ''}`,
    `api_from=${node.web === 'proxy' ? node.apiFrom.join(' ') : ''}`,
  ];
  fs.writeFileSync(path.join(stateDir, 'summary'), `${summary.join('\n')}\n`, { mode: 0o600 });
  log(`Configuration for ${safeName || payload.node.domain} written`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`\n  ✗ ${err instanceof BootstrapError ? err.message : `Unexpected error: ${err?.message ?? err}`}\n`);
    process.exit(1);
  });
}
