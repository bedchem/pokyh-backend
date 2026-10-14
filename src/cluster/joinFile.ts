import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../utils/logger';
import { parseEndpointList, type Endpoint } from './endpoints';
import { isChannelUrl } from './installToken';
import { inspectNodeCertificate } from './x509';

// The node side of the one-line installer (provision.ts, deploy/node/).
//
// The installer leaves a one-time join instruction in CLUSTER_BOOTSTRAP_DIR:
// which node to pair with, where its mutually authenticated channel is, its
// certificate, and the pairing secret derived from the install token. At
// start-up the node takes it over — into the database, where the secret is
// wrapped — and deletes the file at once. It then reports its progress in
// status.json in the same directory, which the installer shows on the
// server's console until the node holds the cluster's data.

const JOIN_FILE = 'join.json';
const STATUS_FILE = 'status.json';
const STATUS_EVERY_MS = 2_000;
// Kept up to date for a while after the node caught up, then left alone.
const STATUS_AFTER_SYNC_MS = 5 * 60 * 1000;

const joinSchema = z.object({
  v: z.literal(1),
  url: z.string().max(255),
  endpoints: z.array(z.string().max(300)).max(8).optional(),
  nodeId: z.string().regex(/^[A-Za-z0-9-]{8,36}$/),
  name: z.string().max(120),
  cert: z.string().max(4096),
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  pairingUntil: z.number().int().positive(),
});

export interface BootstrapJoin {
  url: string;
  endpoints: Endpoint[];
  nodeId: string;
  name: string;
  certPem: string;
  pin: string;
  secret: string;
  expiresAt: Date;
}

export interface BootstrapStatus {
  state: 'starting' | 'joining' | 'paired' | 'synced' | 'failed';
  message: string;
  peerName: string;
  rowsReceived: number;
  ownPin: string;
}

export interface BootstrapHooks {
  join(input: BootstrapJoin): Promise<void>;
  status(peerNodeId: string): Promise<BootstrapStatus>;
}

function dir(): string | null {
  return config.cluster.bootstrapDir ? path.resolve(config.cluster.bootstrapDir) : null;
}

function writeStatus(target: string, status: BootstrapStatus & { peerNodeId: string }): void {
  const file = path.join(target, STATUS_FILE);
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...status, at: new Date().toISOString() })}\n`, { mode: 0o644 });
  renameSync(temporary, file);
}

function readPreviousTarget(target: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(target, STATUS_FILE), 'utf8')) as { peerNodeId?: unknown; state?: unknown };
    return typeof parsed.peerNodeId === 'string' && parsed.state !== 'synced' ? parsed.peerNodeId : null;
  } catch {
    return null;
  }
}

let timer: NodeJS.Timeout | null = null;

// Takes over a waiting join instruction and starts reporting progress. Never
// throws: a problem here is reported in the status file and the log.
export async function runBootstrap(hooks: BootstrapHooks): Promise<void> {
  const target = dir();
  if (!target || !existsSync(target)) return;
  const joinPath = path.join(target, JOIN_FILE);
  let peerNodeId = readPreviousTarget(target);

  if (existsSync(joinPath)) {
    let join: BootstrapJoin | null = null;
    let problem = '';
    try {
      const parsed = joinSchema.parse(JSON.parse(readFileSync(joinPath, 'utf8')));
      if (!isChannelUrl(parsed.url)) throw new Error('the channel address is not usable');
      const endpoints = parseEndpointList(parsed.endpoints ?? [parsed.url]).endpoints;
      if (endpoints.length === 0) throw new Error('the channel addresses are not usable');
      const facts = inspectNodeCertificate(parsed.cert);
      join = {
        url: parsed.url,
        endpoints,
        nodeId: parsed.nodeId,
        name: parsed.name,
        certPem: facts.pem,
        pin: facts.pin,
        secret: parsed.secret,
        expiresAt: new Date(parsed.pairingUntil * 1000),
      };
    } catch (err) {
      problem = err instanceof Error ? err.message.split('\n')[0]! : String(err);
    }
    // The instruction holds a secret: gone from disk whatever happens next.
    try { rmSync(joinPath, { force: true }); } catch (err) {
      logger.error('The installer\'s join instruction could not be deleted', { action: 'cluster_bootstrap_cleanup_failed', message: err instanceof Error ? err.message : String(err) });
    }
    if (!join) {
      logger.error('The installer\'s join instruction is unusable', { action: 'cluster_bootstrap_invalid', message: problem });
      writeStatus(target, { state: 'failed', message: `The join instruction is unusable: ${problem}`, peerName: '', rowsReceived: 0, ownPin: '', peerNodeId: '' });
      return;
    }
    try {
      await hooks.join(join);
      peerNodeId = join.nodeId;
      logger.info('Joining the cluster as set up by the one-line installer', { action: 'cluster_bootstrap_join', peer: join.nodeId });
    } catch (err) {
      const message = err instanceof Error ? err.message.split('\n')[0]! : String(err);
      logger.error('Joining the cluster as set up by the installer failed', { action: 'cluster_bootstrap_join_failed', message });
      writeStatus(target, { state: 'failed', message, peerName: join.name, rowsReceived: 0, ownPin: '', peerNodeId: join.nodeId });
      return;
    }
  }

  if (!peerNodeId || timer) return;
  const followed = peerNodeId;
  let syncedSince: number | null = null;
  let finished = false;
  const report = async () => {
    try {
      const status = await hooks.status(followed);
      if (status.state === 'synced') syncedSince ??= Date.now();
      else syncedSince = null;
      writeStatus(target, { ...status, peerNodeId: followed });
      if (status.state === 'failed' || (syncedSince !== null && Date.now() - syncedSince > STATUS_AFTER_SYNC_MS)) {
        finished = true;
        stopBootstrap();
      }
    } catch (err) {
      logger.warn('Installer status could not be written', { action: 'cluster_bootstrap_status_failed', message: err instanceof Error ? err.message : String(err) });
    }
  };
  await report();
  if (!finished && !timer) {
    timer = setInterval(() => { void report(); }, STATUS_EVERY_MS);
    timer.unref();
  }
}

export function stopBootstrap(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
