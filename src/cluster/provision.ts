import { createHash, randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { curlTarget, formatEndpoint, isPublicEndpoint } from './endpoints';
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

// The one-line node installer, on the node that invites.
//
// An administrator asks for a command (admin API). This node opens a pairing
// window that only the mutually authenticated channel can complete, records
// the install with its secret in wrapped form, and returns
//
//   curl --pinnedpubkey <this node's pin> … install.sh && sha256sum -c … && sh install.sh <token>
//
// On the new server the script (deploy/node/install.sh) sets up Docker, then
// its bootstrap (deploy/node/bootstrap.mjs) reaches this node over the
// channel, pinned to this node's certificate, and
//
//   POST /provision         proves knowledge of the token and receives this
//                           node's shared configuration, sealed under a key
//                           only the token's holder can derive — once;
//   POST /provision/bundle  downloads the running build of this node, whose
//                           hash came with the sealed configuration.
//
// The new node then starts and pairs through the window with the one-time
// secret derived from the token, over the channel, with both certificates
// bound into the handshake. Nothing secret is ever logged; the token itself
// is never stored.

const APP_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLE_PREFIX = 'pokyh-app';
const BUNDLE_ENTRIES = ['dist', 'admin/dist', 'prisma/schema.prisma', 'package.json', 'package-lock.json', 'scripts', 'entrypoint.sh', 'deploy/node'];
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

export function installWindowOpen(): boolean {
  return openInstalls > 0;
}

export async function refreshInstallWindows(): Promise<void> {
  openInstalls = await prisma.clusterInstall.count({
    where: { status: { in: ['OPEN', 'PROVISIONED'] }, expiresAt: { gt: new Date() } },
  });
}

// Strict on purpose: these end up in the new server's Caddyfile and env file.
const DOMAIN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const NODE_NAME = /^[\p{L}\p{N} ._-]{1,120}$/u;

export interface InstallRequest {
  domain: string;
  name: string;
  withAi: boolean;
  acmeEmail: string;
  createdBy: string;
}

export interface CreatedInstall {
  id: string;
  command: string;
  expiresAt: string;
  domain: string;
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
  const domain = input.domain.trim().toLowerCase().replace(/\.$/, '');
  if (!DOMAIN.test(domain)) throw new ClusterError('Enter the new server\'s domain name (e.g. node2.example.org), without https:// or a port');
  const acmeEmail = input.acmeEmail.trim();
  if (acmeEmail && !EMAIL.test(acmeEmail)) throw new ClusterError('The e-mail address for the certificate is not valid');
  const name = input.name.trim().slice(0, 120) || domain.split('.')[0]!;
  if (!NODE_NAME.test(name)) throw new ClusterError('The node name may contain letters, digits, spaces, dot, dash and underscore only');

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
      domain,
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
  });
  // The new server downloads through a way that works from anywhere; the
  // bootstrap then tries every way the token lists.
  const download = channel.endpoints.find(isPublicEndpoint) ?? channel.endpoints[0]!;
  const target = curlTarget(download, '/cluster/v1/install.sh');
  const command = [
    `curl -fsSk --proto '=https' --pinnedpubkey ${shellQuote(`sha256//${channel.pin}`)}${target.connectTo ? ` --connect-to ${shellQuote(target.connectTo)}` : ''} -o pokyh-install.sh ${shellQuote(target.url)}`,
    `echo ${shellQuote(`${built.sha256}  pokyh-install.sh`)} | sha256sum -c -`,
    `sh pokyh-install.sh ${shellQuote(token)}`,
  ].join(' && ');
  recordEvent('info', `One-line install for ${domain} created (valid until ${expiresAt.toISOString().slice(11, 16)} UTC)`);
  return { id, command, expiresAt: expiresAt.toISOString(), domain, name, pin: channel.pin, scriptSha256: built.sha256 };
}

export async function listInstalls() {
  const rows = await prisma.clusterInstall.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    domain: row.domain,
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
  recordEvent('warn', `One-line install for ${row.domain} revoked`);
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
      recordEvent('error', `One-line install for ${row.domain} locked after repeated wrong proofs`);
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
  const shared = sharedEnvironment({
    ...process.env,
    ADMIN_USERNAME: config.adminUsername || process.env['ADMIN_USERNAME'],
    ADMIN_USERNAMES: config.adminUsernames.join(',') || process.env['ADMIN_USERNAMES'],
    ADMIN_PASSWORD_HASH: config.adminPasswordHash || process.env['ADMIN_PASSWORD_HASH'],
  });
  const built = currentBundle();
  const payload = {
    v: 1,
    t: Date.now(),
    node: { name: row.name, domain: row.domain, withAi: row.withAi, acmeEmail: row.acmeEmail },
    env: shared.values,
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
  recordEvent('info', `Configuration handed over to the new server ${row.domain}`);
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
