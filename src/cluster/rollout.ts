import { createHash } from 'crypto';

// The pure part of the cluster's updates (updates.ts): where updates come
// from, what the git host and GitHub answer, and in which order the nodes
// update. No database, no network — tested on its own (tests/clusterUpdates).

const BRANCH = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;

// https://host/owner/name (no credentials, no query) without a trailing .git,
// '' for empty input, null when unusable.
export function normalizeRepo(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return '';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  const pathname = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
  if (!/^(\/[A-Za-z0-9._~-]+){2,4}$/.test(pathname) || pathname.split('/').some((part) => part === '.' || part === '..')) return null;
  return `${url.origin}${pathname}`;
}

export function validBranch(value: string): boolean {
  return BRANCH.test(value) && !value.endsWith('.lock');
}

export function githubRepo(repo: string): { owner: string; name: string } | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(repo);
  return match ? { owner: match[1]!, name: match[2]! } : null;
}

// Parses git's ref advertisement (smart HTTP, "info/refs?service=git-upload-pack"):
// pkt-lines of "<sha> <ref>", the first with capabilities after a NUL.
export function parseAdvertisedRefs(body: Buffer): Map<string, string> {
  const refs = new Map<string, string>();
  let offset = 0;
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(head)) throw new Error('the answer is not a git ref advertisement');
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) throw new Error('the git ref advertisement is truncated');
    let line = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    if (line.startsWith('#')) continue;
    line = line.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const match = /^([0-9a-f]{40}) (refs\/\S+)$/.exec(line);
    if (match) refs.set(match[2]!, match[1]!);
  }
  return refs;
}

export type CiState = 'success' | 'pending' | 'failure' | 'none' | 'unsupported' | 'error';

// Reads GitHub's answer for a commit's check runs
// (GET /repos/{owner}/{repo}/commits/{sha}/check-runs).
export function ciFromCheckRuns(body: unknown): { state: CiState; detail: string } {
  const value = body as { total_count?: unknown; check_runs?: unknown } | null;
  if (!value || typeof value.total_count !== 'number' || !Array.isArray(value.check_runs)) throw new Error('GitHub\'s answer about the checks is malformed');
  const runs = value.check_runs.slice(0, 100).map((run: { name?: unknown; status?: unknown; conclusion?: unknown }) => ({
    name: typeof run?.name === 'string' ? run.name.slice(0, 100) : 'check',
    status: typeof run?.status === 'string' ? run.status : '',
    conclusion: typeof run?.conclusion === 'string' ? run.conclusion : null,
  }));
  if (value.total_count === 0 || runs.length === 0) return { state: 'none', detail: 'no checks ran for this commit' };
  const failed = runs.filter((run) => run.status === 'completed' && !['success', 'neutral', 'skipped'].includes(run.conclusion ?? ''));
  if (failed.length > 0) return { state: 'failure', detail: `${failed.map((run) => run.name).slice(0, 3).join(', ')}: ${failed[0]!.conclusion ?? 'failed'}` };
  const open = runs.filter((run) => run.status !== 'completed');
  if (open.length > 0 || value.total_count > runs.length) return { state: 'pending', detail: `${open.length || 'some'} check(s) still running` };
  return { state: 'success', detail: `${runs.length} check(s) passed` };
}

export interface RolloutNode {
  id: string;
  name: string;
  commit: string;
  // Updated by Pokyh's updater (false: e.g. Dokploy, or an older version).
  selfUpdating: boolean;
  online: boolean;
  offlineForMs: number;
  // The commit this node failed to update to, if any.
  failed: string | null;
  updating: boolean;
}

export type NodeRolloutState = 'done' | 'updating' | 'failed' | 'manual' | 'skipped' | 'waiting' | 'next';

export interface RolloutDecision {
  action: 'none' | 'update' | 'wait' | 'blocked' | 'manual' | 'failed';
  reason: string;
  order: Array<{ id: string; name: string; state: NodeRolloutState }>;
}

export function rolloutOrder(target: string, ids: string[]): string[] {
  const rank = (id: string) => createHash('sha256').update(`${target}:${id}`).digest('hex');
  return [...ids].sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : a < b ? -1 : 1));
}

// Pure: what the node `selfId` does about `target`, given what it knows of
// every node (itself included).
export function decideRollout(input: { target: string; selfId: string; nodes: RolloutNode[]; skipOfflineMs: number }): RolloutDecision {
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const order = rolloutOrder(input.target, [...byId.keys()]);
  const states = new Map<string, NodeRolloutState>();
  let blocking: { kind: 'failed' | 'wait'; node: RolloutNode } | null = null;
  for (const id of order) {
    const node = byId.get(id)!;
    let nodeState: NodeRolloutState;
    if (node.commit === input.target) nodeState = 'done';
    else if (!node.selfUpdating) nodeState = 'manual';
    else if (node.failed === input.target) nodeState = 'failed';
    else if (node.updating) nodeState = 'updating';
    else if (!node.online && node.offlineForMs >= input.skipOfflineMs) nodeState = 'skipped';
    else nodeState = blocking ? 'waiting' : 'next';
    states.set(id, nodeState);
    if (!blocking && nodeState === 'failed') blocking = { kind: 'failed', node };
    else if (!blocking && (nodeState === 'updating' || nodeState === 'next')) blocking = { kind: 'wait', node };
  }
  const list = order.map((id) => ({ id, name: byId.get(id)!.name, state: states.get(id)! }));
  const self = byId.get(input.selfId);
  const label = (node: RolloutNode) => node.name || node.id.slice(0, 8);
  if (!self) return { action: 'none', reason: 'this node is not part of the rollout', order: list };
  const own = states.get(self.id)!;
  if (own === 'done') return { action: 'none', reason: 'this node runs the newest version', order: list };
  if (own === 'manual') return { action: 'manual', reason: 'this node is not updated by Pokyh — deploy the new version where it runs', order: list };
  if (own === 'failed') return { action: 'failed', reason: 'the update failed on this node; the rollout waits for an administrator', order: list };
  if (own === 'updating') return { action: 'none', reason: 'this node is updating', order: list };
  if (blocking && blocking.node.id !== self.id) {
    if (blocking.kind === 'failed') return { action: 'blocked', reason: `the update failed on ${label(blocking.node)}; the rollout stopped there`, order: list };
    return { action: 'wait', reason: `waiting for ${label(blocking.node)}`, order: list };
  }
  return { action: 'update', reason: 'this node is next', order: list };
}
