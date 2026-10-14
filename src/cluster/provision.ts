import { createHash, randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import express, { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { isIP } from 'net';
import { z } from 'zod';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { formatEndpoint, publicOrigin } from './endpoints';
import { ClusterError } from './errors';
import {
  deriveInstallKeys,
  encodeInstallToken,
  installProof,
  newInstallSecret,
  proofMatches,
  sealInstallPayload,
  type InstallPurpose,
} from './installToken';
import { ownChannel } from './pairing';
import { recordEvent, state } from './runtime';
import { sharedEnvironment } from './sharedEnv';
import { createPendingPeer, deletePeer, setPeerStatus, unwrap, wrap } from './store';
import { collectFiles, createTarGz } from './tarball';
import { loadSettings as loadUpdateSettings } from './updateSettings';

// The one-line node installer, on the node that invites.
//
// An administrator asks for a command (admin API), giving only a name — and,
// optionally, the new server's domain or IP. This node opens a pairing window
// that only the mutually authenticated channel can complete, records the
// install with its secret in wrapped form, and returns
//
//   curl -fsSL https://<this node's public address>/setup -o pokyh.sh \
//     && echo '<sha256>  pokyh.sh' | sha256sum -c - && sh pokyh.sh '<key>'
//
// /setup exists only while an install is open; at any other time it answers
// 404 like any unknown path. The script is fixed by its hash, so nothing on
// the way (a CDN, a proxy) can change it. On the new server it sets up Docker
// and runs its bootstrap (deploy/node/bootstrap.mjs), which — over the public
// address, or over this node's pinned channel —
//
//   POST /setup/provision   proves knowledge of the key and receives this
//                           node's shared configuration, sealed under a key
//                           only the key's holder can derive, bound to the
//                           request — once;
//   POST /setup/bundle      downloads the running build of this node, whose
//                           hash came with the sealed configuration.
//
// Neither path has to be trusted for these: what matters is the key. The
// new node then pairs over the channel, both certificates bound into the
// handshake.
//
// The new node then starts and pairs through the window with the one-time
// secret derived from the token, over the channel, with both certificates
// bound into the handshake. Nothing secret is ever logged; the token itself
// is never stored.

const APP_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLE_PREFIX = 'pokyh-app';
// deploy/relay too: an installed node can set up relays in turn.
const BUNDLE_ENTRIES = ['dist', 'admin/dist', 'prisma/schema.prisma', 'package.json', 'package-lock.json', 'scripts', 'entrypoint.sh', 'deploy/node', 'deploy/relay'];
const REQUIRED_FILES = [
  'dist/index.js',
  'admin/dist/index.html',
  'prisma/schema.prisma',
  'package.json',
  'package-lock.json',
  'entrypoint.sh',
  'deploy/node/Dockerfile',
  'deploy/node/compose.yml',
  'deploy/node/install.sh',
  'deploy/node/bootstrap.mjs',
];
const BOOTSTRAP_MARKER = '__POKYH_BOOTSTRAP__';
// After the configuration was handed over: time for the build and the start.
const AFTER_PROVISION_MS = 60 * 60 * 1000;
// How far the new server's clock may be off when it asks.
const MAX_REQUEST_SKEW_MS = 10 * 60 * 1000;

const SECRET_CONTEXT = (id: string) => `install:${id}`;

// ─── What is handed out ──────────────────────────────────────────────────────

interface Bundle {
  data: Buffer;
  sha256: string;
}

let bundle: Bundle | null = null;
let script: { text: string; sha256: string } | null = null;

function requireBuiltServer(): void {
  // Under ts-node the compiled build may be older than the running code, and
  // nodes have to run exactly the same version.
  if (__filename.endsWith('.ts')) {
    throw new ClusterError('One-line installs are available on a built server only (npm run build && npm start, or the Docker image)', 409);
  }
  const missing = REQUIRED_FILES.filter((file) => !existsSync(path.join(APP_ROOT, file)));
  if (missing.length > 0) {
    throw new ClusterError(`This server's build is incomplete for one-line installs (missing: ${missing.join(', ')})`, 500);
  }
}

// This node's own build, as the new server runs it. Built once per process:
// the files do not change while the server runs.
function currentBundle(): Bundle {
  if (!bundle) {
    requireBuiltServer();
    const data = createTarGz(APP_ROOT, collectFiles(APP_ROOT, BUNDLE_ENTRIES), BUNDLE_PREFIX);
    bundle = { data, sha256: createHash('sha256').update(data).digest('hex') };
  }
  return bundle;
}

// The same build, for nodes updating to this node's version (updates.ts).
export function ownBuild(): Bundle {
  return currentBundle();
}

// The installer with its bootstrap embedded; the same text for everybody,
// with nothing secret in it.
export function installScript(): { text: string; sha256: string } {
  if (!script) {
    requireBuiltServer();
    const template = readFileSync(path.join(APP_ROOT, 'deploy/node/install.sh'), 'utf8');
    const bootstrap = readFileSync(path.join(APP_ROOT, 'deploy/node/bootstrap.mjs'), 'utf8');
    if (!template.includes(BOOTSTRAP_MARKER) || bootstrap.includes('POKYH_BOOTSTRAP_END')) {
      throw new ClusterError('The installer template is damaged', 500);
    }
    const text = template.replace(BOOTSTRAP_MARKER, bootstrap.trimEnd());
    script = { text, sha256: createHash('sha256').update(text).digest('hex') };
  }
  return script;
}

// ─── Installs (admin side) ───────────────────────────────────────────────────

let openInstalls = 0;
let openUntil = 0;

// Open while an install is OPEN or PROVISIONED and not expired — checked
// against the clock too, so it closes on time even between two refreshes.
export function installWindowOpen(): boolean {
  return openInstalls > 0 && Date.now() < openUntil;
}

export async function refreshInstallWindows(): Promise<void> {
  const where = { status: { in: ['OPEN', 'PROVISIONED'] }, expiresAt: { gt: new Date() } };
  const [count, latest] = await Promise.all([
    prisma.clusterInstall.count({ where }),
    prisma.clusterInstall.aggregate({ where, _max: { expiresAt: true } }),
  ]);
  openInstalls = count;
  openUntil = latest._max.expiresAt?.getTime() ?? 0;
}

// Strict on purpose: these end up in the new server's Caddyfile and env file.
const DOMAIN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
export const SETUP_PATH = '/setup';
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const NODE_NAME = /^[\p{L}\p{N} ._-]{1,120}$/u;

export interface InstallRequest {
  name: string;
  // Optional: the new server's domain (it then serves HTTPS itself) or IP;
  // empty: its public IP is taken from where its setup comes from.
  address: string;
  withAi: boolean;
  acmeEmail: string;
  // This node's public address, as the administrator's browser shows it.
  origin: string;
  createdBy: string;
}

export interface CreatedInstall {
  id: string;
  command: string;
  expiresAt: string;
  address: string;
  name: string;
  // This node's certificate pin, as the command pins it.
  pin: string;
  scriptSha256: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function createInstall(input: InstallRequest): Promise<CreatedInstall> {
  const channel = ownChannel();
  if (!channel) {
    throw new ClusterError('The mutually authenticated channel is not running on this node — set CLUSTER_MTLS_PORT (and CLUSTER_MTLS_URL if this node\'s address cannot be derived) and open that port to the other servers', 409);
  }
  const origin = publicOrigin(input.origin);
  if (!origin) throw new ClusterError('Open the admin panel under this node\'s public https address to create the command');
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new ClusterError('Give the new server a name');
  if (!NODE_NAME.test(name)) throw new ClusterError('The name may contain letters, digits, spaces, dot, dash and underscore only');
  const address = input.address.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (address && !DOMAIN.test(address) && isIP(address) === 0) {
    throw new ClusterError('The address must be a domain name (node2.example.org) or an IP address — or leave it empty');
  }
  const acmeEmail = isIP(address) === 0 && address ? input.acmeEmail.trim() : '';
  if (acmeEmail && !EMAIL.test(acmeEmail)) throw new ClusterError('The e-mail address for the certificate is not valid');

  const built = installScript();
  currentBundle();

  const id = randomUUID();
  const secret = newInstallSecret();
  const keys = deriveInstallKeys(secret, id);
  const expiresAt = new Date(Date.now() + config.cluster.installTtlMinutes * 60_000);
  // Room for the installation itself after the command was started late.
  const peer = await createPendingPeer({
    role: 'HOST',
    address: '',
    name,
    secret: keys.pairSecret,
    createdBy: input.createdBy,
    tlsRequired: true,
    expiresAt: new Date(expiresAt.getTime() + AFTER_PROVISION_MS),
  });
  await prisma.clusterInstall.create({
    data: {
      id,
      secretEnc: wrap(secret, SECRET_CONTEXT(id)),
      status: 'OPEN',
      peerId: peer.id,
      // The new server's domain or IP as entered (empty: detected).
      domain: address,
      name,
      withAi: input.withAi,
      acmeEmail,
      expiresAt,
      createdBy: input.createdBy,
    },
  });
  await refreshInstallWindows();

  const token = encodeInstallToken({
    url: channel.url,
    endpoints: channel.endpoints.map(formatEndpoint),
    pin: channel.pin,
    nodeId: state.nodeId,
    id,
    secret,
    expiresAt,
    web: origin,
  });
  const command = [
    `curl -fsSL --proto '=${origin.startsWith('https:') ? 'https' : 'http,https'}' -o pokyh.sh ${shellQuote(`${origin}${SETUP_PATH}`)}`,
    `echo ${shellQuote(`${built.sha256}  pokyh.sh`)} | sha256sum -c -`,
    `sh pokyh.sh ${shellQuote(token)}`,
  ].join(' && ');
  recordEvent('info', `One-line install for ${name} created (valid until ${expiresAt.toISOString().slice(11, 16)} UTC)`);
  return { id, command, expiresAt: expiresAt.toISOString(), address, name, pin: channel.pin, scriptSha256: built.sha256 };
}

export async function listInstalls() {
  const rows = await prisma.clusterInstall.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    address: row.domain,
    name: row.name,
    withAi: row.withAi,
    failures: row.failures,
    expiresAt: row.expiresAt.toISOString(),
    provisionedAt: row.provisionedAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  }));
}

// Ends an install that is still open; its pairing window goes with it.
export async function revokeInstall(id: string): Promise<{ peerId: string | null }> {
  const row = await prisma.clusterInstall.findUnique({ where: { id } });
  if (!row) throw new ClusterError('Install not found', 404);
  if (row.status !== 'OPEN' && row.status !== 'PROVISIONED') throw new ClusterError('This install is no longer open', 409);
  await prisma.clusterInstall.update({ where: { id }, data: { status: 'REVOKED', secretEnc: null } });
  const peer = await prisma.clusterPeer.findUnique({ where: { id: row.peerId } });
  if (peer?.status === 'PENDING') await deletePeer(peer.id);
  await refreshInstallWindows();
  recordEvent('warn', `One-line install for ${row.name || row.domain} revoked`);
  return { peerId: peer?.status === 'PENDING' ? peer.id : null };
}

// The new node paired through the install's window: the install is done and
// its secret is forgotten.
export async function completeInstallFor(peerRowId: string): Promise<void> {
  const updated = await prisma.clusterInstall.updateMany({
    where: { peerId: peerRowId, status: { in: ['OPEN', 'PROVISIONED'] } },
    data: { status: 'DONE', secretEnc: null },
  });
  if (updated.count > 0) {
    await refreshInstallWindows();
    recordEvent('info', 'A server set up with the one-line installer joined the cluster');
  }
}

// Expires installs that ran out of time or whose pairing window is gone.
export async function expireInstalls(): Promise<void> {
  const open = await prisma.clusterInstall.findMany({ where: { status: { in: ['OPEN', 'PROVISIONED'] } } });
  const now = Date.now();
  for (const row of open) {
    const peer = await prisma.clusterPeer.findUnique({ where: { id: row.peerId }, select: { id: true, status: true } });
    const windowGone = !peer || peer.status === 'EXPIRED' || peer.status === 'LOCKED' || peer.status === 'REMOVED';
    const unused = row.status === 'OPEN' && row.expiresAt.getTime() <= now;
    if (!windowGone && !unused) continue;
    await prisma.clusterInstall.update({ where: { id: row.id }, data: { status: peer?.status === 'LOCKED' ? 'LOCKED' : 'EXPIRED', secretEnc: null } });
    if (peer?.status === 'PENDING') await deletePeer(peer.id);
  }
  await refreshInstallWindows();
}

// ─── The new server's requests (cluster channel) ─────────────────────────────

const requestSchema = z.object({
  i: z.string().uuid(),
  t: z.number().int(),
  n: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/),
  mac: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

// Nonces already used, per install, for as long as a request may be late.
const usedNonces = new Map<string, Map<string, number>>();

function nonceIsFresh(id: string, nonce: string): boolean {
  const now = Date.now();
  let seen = usedNonces.get(id);
  if (!seen) { seen = new Map(); usedNonces.set(id, seen); }
  for (const [value, at] of seen) if (now - at > 2 * MAX_REQUEST_SKEW_MS) seen.delete(value);
  if (seen.has(nonce) || seen.size > 256) return false;
  seen.set(nonce, now);
  return true;
}

function refuse(res: Response, status: number, error = status === 404 ? 'Not found' : 'Rejected'): void {
  res.status(status).json({ error });
}

type Verified = { id: string; nonce: string; keys: ReturnType<typeof deriveInstallKeys>; row: NonNullable<Awaited<ReturnType<typeof prisma.clusterInstall.findUnique>>> };

async function verifyRequest(req: Request, res: Response, purpose: InstallPurpose): Promise<Verified | null> {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) { refuse(res, 400); return null; }
  const { i: id, t, n: nonce, mac } = parsed.data;
  const row = await prisma.clusterInstall.findUnique({ where: { id } });
  if (!row || !row.secretEnc || (row.status !== 'OPEN' && row.status !== 'PROVISIONED') || row.expiresAt.getTime() <= Date.now()) {
    refuse(res, 404);
    return null;
  }
  let keys: ReturnType<typeof deriveInstallKeys>;
  try {
    keys = deriveInstallKeys(unwrap(row.secretEnc, SECRET_CONTEXT(id)), id);
  } catch {
    refuse(res, 404);
    return null;
  }
  if (!proofMatches(installProof(keys.auth, purpose, id, t, nonce), mac)) {
    const updated = await prisma.clusterInstall.update({ where: { id }, data: { failures: { increment: 1 } } });
    if (updated.failures >= config.cluster.pairingMaxFailures) {
      await prisma.clusterInstall.update({ where: { id }, data: { status: 'LOCKED', secretEnc: null } });
      await setPeerStatus(row.peerId, 'LOCKED').catch(() => {});
      await refreshInstallWindows();
      recordEvent('error', `One-line install for ${row.name || row.domain} locked after repeated wrong proofs`);
    }
    logger.warn('Cluster node install: request with a wrong proof refused', { action: 'cluster_install_rejected', installId: id });
    refuse(res, 403);
    return null;
  }
  // From here on the caller holds the token, so it may learn why it failed.
  if (Math.abs(Date.now() - t) > MAX_REQUEST_SKEW_MS) { refuse(res, 403, 'clock'); return null; }
  if (!nonceIsFresh(id, nonce)) { refuse(res, 403, 'replay'); return null; }
  return { id, nonce, keys, row };
}

export async function handleInstallScript(_req: Request, res: Response): Promise<void> {
  if (!installWindowOpen()) { refuse(res, 404); return; }
  try {
    const built = installScript();
    res.status(200).type('text/plain; charset=utf-8').setHeader('Cache-Control', 'no-store');
    res.send(built.text);
  } catch {
    refuse(res, 404);
  }
}

export async function handleProvision(req: Request, res: Response): Promise<void> {
  const verified = await verifyRequest(req, res, 'provision');
  if (!verified) return;
  const { id, nonce, keys, row } = verified;
  if (row.status !== 'OPEN') { refuse(res, 409, 'used'); return; }
  const channel = ownChannel();
  if (!channel) { refuse(res, 503, 'channel'); return; }

  // Handed over exactly once.
  const now = new Date();
  const claimed = await prisma.clusterInstall.updateMany({
    where: { id, status: 'OPEN' },
    data: { status: 'PROVISIONED', provisionedAt: now, expiresAt: new Date(now.getTime() + AFTER_PROVISION_MS) },
  });
  if (claimed.count !== 1) { refuse(res, 409, 'used'); return; }
  const peer = await prisma.clusterPeer.findUnique({ where: { id: row.peerId }, select: { pairingExpiresAt: true } });
  const pairingUntil = peer?.pairingExpiresAt && peer.pairingExpiresAt.getTime() > now.getTime() + AFTER_PROVISION_MS
    ? peer.pairingExpiresAt
    : new Date(now.getTime() + AFTER_PROVISION_MS);
  await prisma.clusterPeer.updateMany({ where: { id: row.peerId, status: 'PENDING' }, data: { pairingExpiresAt: pairingUntil } });

  // The admin login as it is in effect now: the first-run setup changes it
  // without touching the process environment.
  // Where the new server's setup came from: its public address, unless the
  // administrator named one.
  const seen = String(res.locals['clientAddress'] ?? '').replace(/^::ffff:/, '');
  const domain = row.domain && isIP(row.domain) === 0 ? row.domain : '';
  const ip = row.domain && isIP(row.domain) !== 0 ? row.domain : isIP(seen) !== 0 ? seen : '';
  const shared = sharedEnvironment({
    ...process.env,
    ADMIN_USERNAME: config.adminUsername || process.env['ADMIN_USERNAME'],
    ADMIN_USERNAMES: config.adminUsernames.join(',') || process.env['ADMIN_USERNAMES'],
    ADMIN_PASSWORD_HASH: config.adminPasswordHash || process.env['ADMIN_PASSWORD_HASH'],
  });
  const built = currentBundle();
  // Where updates come from; the new server's updater trusts this repository
  // and branch for its own files (deploy/node/updater.mjs).
  const updates = await loadUpdateSettings();
  const payload = {
    v: 1,
    t: Date.now(),
    node: { name: row.name, domain, address: ip, withAi: row.withAi, acmeEmail: row.acmeEmail },
    env: shared.values,
    update: { repo: updates.repo, branch: updates.branch },
    bundle: { sha256: built.sha256, bytes: built.data.length },
    cluster: {
      url: channel.url,
      endpoints: channel.endpoints.map(formatEndpoint),
      nodeId: state.nodeId,
      name: state.nodeName,
      cert: channel.certPem,
      pairingUntil: Math.floor(pairingUntil.getTime() / 1000),
    },
  };
  const sealed = sealInstallPayload(keys.enc, id, nonce, Buffer.from(JSON.stringify(payload), 'utf8'));
  await refreshInstallWindows();
  if (shared.skipped.length > 0) {
    recordEvent('warn', `Not handed over (value cannot be written safely): ${shared.skipped.slice(0, 5).join(', ')}`);
  }
  recordEvent('info', `Configuration handed over to the new server ${row.name}${ip ? ` (${ip})` : ''}`);
  logger.info('Cluster node install: configuration handed over', { action: 'cluster_install_provisioned', installId: id, sharedSettings: Object.keys(shared.values).length });
  res.setHeader('Cache-Control', 'no-store');
  res.json(sealed);
}

export async function handleBundle(req: Request, res: Response): Promise<void> {
  const verified = await verifyRequest(req, res, 'bundle');
  if (!verified) return;
  const built = currentBundle();
  logger.info('Cluster node install: build downloaded', { action: 'cluster_install_bundle', installId: verified.id, bytes: built.data.length });
  res.status(200)
    .type('application/gzip')
    .setHeader('Cache-Control', 'no-store')
    .setHeader('X-Pokyh-Sha256', built.sha256)
    .send(built.data);
}

// ─── The public setup address ────────────────────────────────────────────────
// Served on the ordinary API port (and so through whatever proxy or CDN is in
// front of it), ahead of the API key. While no install is open, every path
// below it answers 404 — exactly like a path that does not exist.

export function createSetupRouter(): Router {
  const router = Router();
  router.use((req: Request, res: Response, next) => {
    if (!installWindowOpen()) {
      res.status(404).json({ error: 'Route not found' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.locals['clientAddress'] = req.ip;
    next();
  });
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });
  const smallJson = express.json({ limit: '8kb' });
  router.get('/', limiter, handleInstallScript);
  router.post('/provision', limiter, smallJson, handleProvision);
  router.post('/bundle', limiter, smallJson, handleBundle);
  router.use((_req: Request, res: Response) => { res.status(404).json({ error: 'Route not found' }); });
  return router;
}
