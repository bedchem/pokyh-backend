import { createHash, randomUUID } from 'crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { z } from 'zod';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ClusterError } from './errors';
import { ownBuild } from './provision';
import type { UpdateAdvert } from './protocol';
import { recordEvent, state, type PeerRuntime } from './runtime';
import { RpcError, rpc } from './transport';
import {
  ciFromCheckRuns,
  decideRollout,
  githubRepo,
  normalizeRepo,
  parseAdvertisedRefs,
  validBranch,
  type CiState,
  type RolloutDecision,
  type RolloutNode,
} from './rollout';
import { SETTINGS_ID, loadSettings, type UpdateSettings } from './updateSettings';
import { buildInfo } from './version';

// Updates that roll out by themselves, one node at a time, without a leader.
//
// Every node watches the configured git branch (git's own HTTP protocol, any
// host) and, for GitHub, whether the newest commit's checks passed. Every
// node then works out the same order of all nodes for that commit — sorted
// by SHA-256(commit, node id), so it changes from version to version and
// needs nobody to decide it — and updates itself when every node before it
// runs the new version, is not updated by Pokyh (e.g. Dokploy), or has been
// unreachable for longer than CLUSTER_UPDATE_SKIP_OFFLINE_MINUTES. A node
// whose update fails stops the rollout there; the nodes after it keep their
// version until an administrator decides. With a single node, it is simply
// the first.
//
// The first node builds the new version from git; the others take its build
// over the cluster channel (sha-256 checked). This process never touches
// Docker: it asks the updater (deploy/node/updater.mjs) by writing a file in
// POKYH_UPDATE_DIR, and the updater switches containers without downtime.

const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TICK_MS = 15_000;
const CHUNK_BYTES = 512 * 1024;
const MAX_BUILD_BYTES = 512 * 1024 * 1024;
const MAX_REFS_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
// The updater writes its heartbeat every 10 s.
const UPDATER_FRESH_MS = 60_000;

export type LocalState = 'idle' | 'fetching' | 'requested' | 'preparing' | 'building' | 'starting' | 'switching' | 'done' | 'failed';
const BUSY: LocalState[] = ['fetching', 'requested', 'preparing', 'building', 'starting', 'switching'];

// ─── Settings ────────────────────────────────────────────────────────────────

export async function saveSettings(input: { repo: string; branch: string; auto: boolean; requireCi: boolean }, actor: string): Promise<UpdateSettings> {
  const repo = normalizeRepo(input.repo);
  if (repo === null) throw new ClusterError('The repository must be an https address like https://github.com/owner/name');
  const branch = input.branch.trim();
  if (!validBranch(branch)) throw new ClusterError('The branch name is not valid');
  if (input.requireCi && repo && !githubRepo(repo)) {
    throw new ClusterError('Checks can only be verified for repositories on github.com — turn "only with passed checks" off for other hosts');
  }
  const current = await loadSettings();
  const data = {
    repo,
    branch,
    auto: input.auto,
    requireCi: input.requireCi,
    // A release by hand belongs to the repository and branch it was made for.
    approvedCommit: repo === current.repo && branch === current.branch ? current.approvedCommit : '',
    updatedBy: actor.slice(0, 100),
  };
  await prisma.updateSettings.upsert({ where: { id: SETTINGS_ID }, create: { id: SETTINGS_ID, ...data }, update: data });
  recordEvent('info', `Update settings changed by ${actor}: ${repo || 'no repository'}${repo ? ` (${branch})` : ''}, ${input.auto ? 'automatic' : 'by hand'}`);
  upstream.checkedAt = 0;
  return loadSettings();
}

// ─── The branch on the git host ──────────────────────────────────────────────

async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error('the answer is larger than allowed');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function fetchBranchHead(repo: string, branch: string): Promise<string> {
  const response = await fetch(`${repo}.git/info/refs?service=git-upload-pack`, {
    headers: { 'user-agent': 'git/2.45.0 (pokyh-cluster)', accept: 'application/x-git-upload-pack-advertisement' },
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status >= 300 && response.status < 400) throw new Error(`the repository answers with a redirect (${response.status}) — enter its current address`);
  if (response.status === 401 || response.status === 403 || response.status === 404) throw new Error('the repository was not found or is not public');
  if (!response.ok) throw new Error(`the git host answered ${response.status}`);
  if (!(response.headers.get('content-type') ?? '').startsWith('application/x-git-upload-pack-advertisement')) {
    throw new Error('the address is not a git repository');
  }
  const refs = parseAdvertisedRefs(await readLimited(response, MAX_REFS_BYTES));
  const head = refs.get(`refs/heads/${branch}`);
  if (!head) throw new Error(`the branch ${branch} does not exist in the repository`);
  return head;
}

async function fetchCi(repo: string, commit: string): Promise<{ state: CiState; detail: string }> {
  const github = githubRepo(repo);
  if (!github) return { state: 'unsupported', detail: 'checks can be verified for github.com only' };
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'pokyh-cluster',
    'x-github-api-version': '2022-11-28',
  };
  if (config.cluster.update.githubToken) headers['authorization'] = `Bearer ${config.cluster.update.githubToken}`;
  const response = await fetch(`https://api.github.com/repos/${github.owner}/${github.name}/commits/${commit}/check-runs?per_page=100`, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status === 403 || response.status === 429) return { state: 'error', detail: 'GitHub limits requests right now; trying again later' };
  if (!response.ok) return { state: 'error', detail: `GitHub answered ${response.status}` };
  return ciFromCheckRuns(JSON.parse((await readLimited(response, 4 * 1024 * 1024)).toString('utf8')));
}

// ─── This node ───────────────────────────────────────────────────────────────

interface UpdaterStatus {
  id: string;
  state: string;
  message: string;
  commit: string | null;
  source: string;
  at: string;
}

interface Local {
  state: LocalState;
  target: string | null;
  message: string | null;
  requestId: string | null;
  failed: string | null;
  failedMessage: string | null;
  source: 'git' | 'bundle' | 'rollback' | null;
  since: number;
}

const upstream: {
  commit: string | null;
  checkedAt: number;
  error: string | null;
  ci: { state: CiState; detail: string; commit: string; checkedAt: number } | null;
} = { commit: null, checkedAt: 0, error: null, ci: null };

const local: Local = { state: 'idle', target: null, message: null, requestId: null, failed: null, failedMessage: null, source: null, since: 0 };
let build: { sha256: string; bytes: number } | null = null;
let timer: NodeJS.Timeout | null = null;
let ticking = false;
let startedAt = Date.now();
let lastDecision: RolloutDecision | null = null;
let lastTarget: string | null = null;
// The updater report this node has acted on last (followUpdater).
let settledId: string | null = null;

function updateDir(): string | null {
  return config.deploy.updateDir || null;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeAtomic(file: string, text: string): void {
  writeFileSync(`${file}.tmp`, text, { mode: 0o640 });
  renameSync(`${file}.tmp`, file);
}

// Whether Pokyh's updater looks after this node (it writes a heartbeat).
export function selfUpdating(): boolean {
  const dir = updateDir();
  if (!dir || !config.deploy.color) return false;
  const beat = readJson(path.join(dir, 'updater.json')) as { at?: unknown } | null;
  const at = typeof beat?.at === 'string' ? Date.parse(beat.at) : Number.NaN;
  return Number.isFinite(at) && Math.abs(Date.now() - at) < UPDATER_FRESH_MS;
}

function readUpdaterStatus(): UpdaterStatus | null {
  const dir = updateDir();
  if (!dir) return null;
  const raw = readJson(path.join(dir, 'status.json')) as Partial<UpdaterStatus> | null;
  if (!raw || typeof raw.id !== 'string' || typeof raw.state !== 'string') return null;
  return {
    id: raw.id,
    state: raw.state,
    message: typeof raw.message === 'string' ? raw.message.slice(0, 800) : '',
    commit: typeof raw.commit === 'string' && COMMIT.test(raw.commit) ? raw.commit : null,
    source: typeof raw.source === 'string' ? raw.source : '',
    at: typeof raw.at === 'string' ? raw.at : '',
  };
}

function rememberFailure(commit: string, why: string): void {
  local.failed = commit;
  local.failedMessage = why;
  const dir = updateDir();
  if (dir) {
    try {
      writeAtomic(path.join(dir, 'failed.json'), `${JSON.stringify({ commit, message: why, at: new Date().toISOString() })}\n`);
    } catch {
      // Kept in memory; after a restart the rollout simply tries again.
    }
  }
}

function loadFailure(): void {
  const dir = updateDir();
  if (!dir) return;
  const raw = readJson(path.join(dir, 'failed.json')) as { commit?: unknown; message?: unknown } | null;
  if (raw && typeof raw.commit === 'string' && COMMIT.test(raw.commit)) {
    local.failed = raw.commit;
    local.failedMessage = typeof raw.message === 'string' ? raw.message.slice(0, 800) : null;
  }
}

// Follows the updater's report on the request this node made. A report that
// came to an end (done, failed) is acted on once: after "retry" the old
// failure must not count again.
function followUpdater(): void {
  const status = readUpdaterStatus();
  if (!status || status.id === settledId) return;
  const terminal = status.state === 'done' || status.state === 'failed';
  if (!local.requestId) {
    // After the switch (or a restart), the new process reads what the
    // updater did; its outcome is known already and recorded nothing new.
    const request = readJson(path.join(updateDir()!, 'request.json')) as { id?: unknown } | null;
    if (request?.id !== status.id) return;
    local.requestId = status.id;
    local.target = status.commit;
    local.source = status.source === 'bundle' || status.source === 'git' || status.source === 'rollback' ? status.source : null;
    if (terminal) {
      local.state = status.state as LocalState;
      local.message = status.message || null;
      settledId = status.id;
      return;
    }
  }
  if (status.id !== local.requestId) return;
  if (['preparing', 'building', 'starting', 'switching', 'done', 'failed'].includes(status.state)) local.state = status.state as LocalState;
  local.message = status.message || null;
  if (!terminal) return;
  settledId = status.id;
  if (local.state === 'failed') {
    if (local.target && local.source !== 'rollback') rememberFailure(local.target, status.message);
    recordEvent('error', `Update on this node failed: ${status.message}`);
    logger.error('Cluster update failed on this node', { action: 'cluster_update_failed', commit: local.target, message: status.message });
  }
}

function peerOfflineFor(peer: PeerRuntime, now: number): number {
  if (peer.health === 'ONLINE') return 0;
  return now - (peer.lastSeenAt ?? startedAt);
}

function rolloutNodes(): RolloutNode[] {
  const now = Date.now();
  const own = buildInfo().commit;
  const nodes: RolloutNode[] = [{
    id: state.nodeId,
    name: state.nodeName,
    commit: own,
    selfUpdating: selfUpdating(),
    online: true,
    offlineForMs: 0,
    failed: local.failed,
    updating: BUSY.includes(local.state),
  }];
  for (const peer of state.peers.values()) {
    const remote = peer.remote.update;
    nodes.push({
      id: peer.nodeId,
      name: peer.remote.name ?? peer.name,
      commit: remote?.commit ?? '',
      selfUpdating: remote?.self === true,
      online: peer.health === 'ONLINE',
      offlineForMs: peerOfflineFor(peer, now),
      failed: remote?.failed ?? null,
      updating: remote ? BUSY.includes(remote.state as LocalState) : false,
    });
  }
  return nodes;
}

// The commit this node should run, if any.
function targetOf(settings: UpdateSettings): { commit: string | null; why: string } {
  if (!settings.repo) return { commit: null, why: 'no repository is set' };
  if (!upstream.commit) return { commit: null, why: upstream.error ?? 'the branch has not been checked yet' };
  if (settings.requireCi) {
    const ci = upstream.ci;
    if (!ci || ci.commit !== upstream.commit) return { commit: null, why: 'waiting for the checks' };
    if (ci.state !== 'success') return { commit: null, why: `checks: ${ci.detail}` };
  }
  if (!settings.auto && settings.approvedCommit !== upstream.commit) return { commit: null, why: 'a new version is ready and waits to be released' };
  return { commit: upstream.commit, why: '' };
}

async function pollUpstream(settings: UpdateSettings, force: boolean): Promise<void> {
  const due = Date.now() - upstream.checkedAt >= config.cluster.update.pollMinutes * 60_000;
  if (!settings.repo || (!force && !due)) return;
  upstream.checkedAt = Date.now();
  try {
    const head = await fetchBranchHead(settings.repo, settings.branch);
    if (head !== upstream.commit) {
      upstream.commit = head;
      if (head !== buildInfo().commit) recordEvent('info', `New version on ${settings.branch}: ${head.slice(0, 7)}`);
    }
    upstream.error = null;
  } catch (err) {
    upstream.error = `Branch check failed: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn('Cluster update: branch check failed', { action: 'cluster_update_poll_failed', message: upstream.error });
    return;
  }
  const ci = upstream.ci;
  if (settings.requireCi && upstream.commit && (!ci || ci.commit !== upstream.commit || ci.state === 'pending' || ci.state === 'error' || ci.state === 'none')) {
    try {
      const result = await fetchCi(settings.repo, upstream.commit);
      upstream.ci = { ...result, commit: upstream.commit, checkedAt: Date.now() };
    } catch (err) {
      upstream.ci = { state: 'error', detail: err instanceof Error ? err.message : String(err), commit: upstream.commit, checkedAt: Date.now() };
    }
  }
}

// The new version's build from a node that already runs it, in chunks over
// the cluster channel; checked against the hash it announced.
async function fetchBuildFrom(peer: PeerRuntime, sha256: string, bytes: number, file: string): Promise<void> {
  if (bytes <= 0 || bytes > MAX_BUILD_BYTES) throw new Error('the announced build size is not plausible');
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < bytes) {
    const reply = z.object({ total: z.number().int(), data: z.string().max(CHUNK_BYTES * 2) })
      .parse(await rpc<unknown>(peer, 'update.build', { sha256, offset }, 60_000));
    if (reply.total !== bytes) throw new Error('the build changed while it was being fetched');
    const chunk = Buffer.from(reply.data, 'base64');
    if (chunk.length === 0 || chunk.length > CHUNK_BYTES) throw new Error('a chunk of the build is malformed');
    parts.push(chunk);
    offset += chunk.length;
  }
  const data = Buffer.concat(parts);
  if (data.length !== bytes || createHash('sha256').update(data).digest('hex') !== sha256) throw new Error('the build does not match its hash');
  writeFileSync(`${file}.part`, data, { mode: 0o640 });
  renameSync(`${file}.part`, file);
}

async function startUpdate(target: string, settings: UpdateSettings): Promise<void> {
  const dir = updateDir()!;
  local.state = 'fetching';
  local.target = target;
  local.message = null;
  local.since = Date.now();
  let request: Record<string, unknown> | null = null;
  // A node that already runs the new version hands over its build.
  const holders = [...state.peers.values()].filter((peer) => peer.health === 'ONLINE' && peer.remote.update?.commit === target && peer.remote.update.build);
  for (const peer of holders) {
    const advertised = peer.remote.update!.build!;
    const file = path.join(dir, `bundle-${advertised.sha256}.tgz`);
    try {
      await fetchBuildFrom(peer, advertised.sha256, advertised.bytes, file);
      request = { source: 'bundle', commit: target, sha256: advertised.sha256 };
      recordEvent('info', `Took the build of ${target.slice(0, 7)} from ${peer.remote.name ?? peer.name}`);
      break;
    } catch (err) {
      rmSync(`${file}.part`, { force: true });
      logger.warn('Cluster update: build could not be taken from a peer', { action: 'cluster_update_build_fetch_failed', peer: peer.nodeId, message: err instanceof Error ? err.message : String(err) });
    }
  }
  if (!request) {
    if (!settings.repo) {
      local.state = 'idle';
      return;
    }
    request = { source: 'git', repo: settings.repo, commit: target };
  }
  const id = randomUUID();
  writeAtomic(path.join(dir, 'request.json'), `${JSON.stringify({ id, ...request, healthTimeoutSeconds: config.cluster.update.healthTimeoutSeconds, at: new Date().toISOString() })}\n`);
  local.requestId = id;
  local.source = request['source'] as Local['source'];
  local.state = 'requested';
  recordEvent('info', `Updating this node to ${target.slice(0, 7)} (${request['source'] === 'bundle' ? 'build from the cluster' : 'built from git'})`);
  logger.info('Cluster update requested', { action: 'cluster_update_requested', commit: target, source: request['source'] });
}

async function tick(force = false): Promise<void> {
  if (ticking || !state.started) return;
  ticking = true;
  try {
    const settings = await loadSettings();
    await pollUpstream(settings, force);
    if (updateDir()) followUpdater();
    // The updater went away while this node waited for it.
    if (local.state === 'requested' && !selfUpdating() && Date.now() - local.since > 2 * UPDATER_FRESH_MS) {
      local.state = 'failed';
      local.message = 'the updater does not answer';
      if (local.target) rememberFailure(local.target, local.message);
    }
    const { commit: target } = targetOf(settings);
    // A newer version than the one just finished (or failed): ready again.
    if (target !== lastTarget) {
      if (lastTarget !== null && (local.state === 'done' || local.state === 'failed')) local.state = 'idle';
      lastTarget = target;
    }
    if (!target) {
      lastDecision = null;
      return;
    }
    const decision = decideRollout({ target, selfId: state.nodeId, nodes: rolloutNodes(), skipOfflineMs: config.cluster.update.skipOfflineMinutes * 60_000 });
    if (decision.action !== lastDecision?.action && (decision.action === 'blocked' || decision.action === 'manual')) {
      recordEvent(decision.action === 'blocked' ? 'warn' : 'info', `Update to ${target.slice(0, 7)}: ${decision.reason}`);
    }
    lastDecision = decision;
    if (decision.action === 'update' && !BUSY.includes(local.state) && updateDir()) await startUpdate(target, settings);
  } catch (err) {
    logger.warn('Cluster update round failed', { action: 'cluster_update_tick_failed', message: err instanceof Error ? err.message : String(err) });
  } finally {
    ticking = false;
  }
}

// ─── Start / stop, heartbeat, calls ──────────────────────────────────────────

export function startUpdates(): void {
  if (timer) return;
  startedAt = Date.now();
  const dir = updateDir();
  if (dir) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Reported through selfUpdating() — no updater can use it either.
    }
    loadFailure();
  }
  // This node's own build, offered to nodes that update after it.
  setTimeout(() => {
    if (!buildInfo().commit) return;
    try {
      const own = ownBuild();
      build = { sha256: own.sha256, bytes: own.data.length };
    } catch {
      build = null;
    }
  }, 5_000).unref();
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  setTimeout(() => void tick(true), 10_000).unref();
}

export function stopUpdates(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function updateAdvert(): UpdateAdvert {
  const commit = buildInfo().commit;
  return {
    commit: commit || null,
    self: selfUpdating(),
    state: local.state,
    target: local.target,
    failed: local.failed,
    build: commit ? build : null,
  };
}

// A node updating to this node's version fetches the build (update.build).
export function handleBuildCall(params: unknown): { total: number; data: string } {
  const input = z.object({ sha256: z.string().regex(SHA256), offset: z.number().int().min(0) }).parse(params);
  if (!build || build.sha256 !== input.sha256) throw new RpcError('not_found', 'this node does not run that build');
  const own = ownBuild();
  if (own.sha256 !== input.sha256 || input.offset >= own.data.length) throw new RpcError('bad_request', 'no such part of the build');
  return { total: own.data.length, data: own.data.subarray(input.offset, input.offset + CHUNK_BYTES).toString('base64') };
}

// ─── Administration ──────────────────────────────────────────────────────────

export async function updateStatus() {
  const settings = await loadSettings();
  const info = buildInfo();
  const target = targetOf(settings);
  const nodes = state.started ? rolloutNodes() : [];
  const updater = updateDir() ? (readJson(path.join(updateDir()!, 'updater.json')) as { at?: string; active?: string } | null) : null;
  return {
    settings,
    defaults: {
      pollMinutes: config.cluster.update.pollMinutes,
      skipOfflineMinutes: config.cluster.update.skipOfflineMinutes,
      healthTimeoutSeconds: config.cluster.update.healthTimeoutSeconds,
    },
    upstream: {
      commit: upstream.commit,
      checkedAt: upstream.checkedAt ? new Date(upstream.checkedAt).toISOString() : null,
      error: upstream.error,
      ci: upstream.ci ? { state: upstream.ci.state, detail: upstream.ci.detail, commit: upstream.ci.commit } : null,
    },
    target: target.commit,
    targetWhy: target.why,
    self: {
      nodeId: state.nodeId,
      commit: info.commit || null,
      builtAt: info.builtAt || null,
      color: config.deploy.color || null,
      selfUpdating: selfUpdating(),
      updaterSeenAt: typeof updater?.at === 'string' ? updater.at : null,
      state: local.state,
      message: local.message,
      failed: local.failed,
      failedMessage: local.failedMessage,
      canRollBack: selfUpdating() && !BUSY.includes(local.state),
    },
    nodes: nodes.map((node) => ({ id: node.id, name: node.name, commit: node.commit || null, selfUpdating: node.selfUpdating, online: node.online, failed: node.failed })),
    decision: lastDecision && target.commit ? lastDecision : null,
  };
}

export async function checkNow(): Promise<void> {
  upstream.checkedAt = 0;
  await tick(true);
}

export async function releaseCommit(commit: string, actor: string): Promise<void> {
  if (!COMMIT.test(commit)) throw new ClusterError('Not a commit');
  const settings = await loadSettings();
  if (!settings.repo) throw new ClusterError('Set the repository first');
  if (commit !== upstream.commit) throw new ClusterError('This is no longer the newest commit of the branch — check again');
  await prisma.updateSettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, repo: settings.repo, branch: settings.branch, auto: settings.auto, requireCi: settings.requireCi, approvedCommit: commit, updatedBy: actor.slice(0, 100) },
    update: { approvedCommit: commit, updatedBy: actor.slice(0, 100) },
  });
  recordEvent('info', `${actor} released ${commit.slice(0, 7)} for the rollout`);
  void tick();
}

export function retryUpdate(actor: string): void {
  local.failed = null;
  local.failedMessage = null;
  if (local.state === 'failed') local.state = 'idle';
  const dir = updateDir();
  if (dir) rmSync(path.join(dir, 'failed.json'), { force: true });
  recordEvent('info', `${actor} cleared the failed update on this node; the rollout continues`);
  void tick();
}

export function rollBack(actor: string): void {
  const dir = updateDir();
  if (!dir || !selfUpdating()) throw new ClusterError('This node is not updated by Pokyh\'s updater', 409);
  if (BUSY.includes(local.state)) throw new ClusterError('An update is in progress on this node', 409);
  const id = randomUUID();
  writeAtomic(path.join(dir, 'request.json'), `${JSON.stringify({ id, source: 'rollback', healthTimeoutSeconds: config.cluster.update.healthTimeoutSeconds, at: new Date().toISOString() })}\n`);
  local.requestId = id;
  local.source = 'rollback';
  local.target = null;
  local.state = 'requested';
  local.since = Date.now();
  // Staying on the previous version: no automatic update to the version just left.
  const current = buildInfo().commit;
  if (current) rememberFailure(current, `rolled back by ${actor}`);
  recordEvent('warn', `${actor} rolled this node back to its previous version`);
}
