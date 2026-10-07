// Indirection points that let ordinary services cooperate with the cluster
// layer without importing it (which would create import cycles and couple a
// standalone deployment to cluster code). Until the cluster layer registers
// itself, every hook behaves exactly like a single-node deployment.

let leaderCheck: () => boolean = () => true;

export function setLeaderCheck(check: () => boolean): void {
  leaderCheck = check;
}

// True when this node should run jobs that must happen only once across the
// whole deployment. Always true on a standalone node.
export function isClusterLeader(): boolean {
  try {
    return leaderCheck();
  } catch {
    return true;
  }
}

export type RestoreWrapper = (restore: () => Promise<void>) => Promise<void>;

let restoreWrapper: RestoreWrapper = (restore) => restore();

export function setRestoreWrapper(wrapper: RestoreWrapper): void {
  restoreWrapper = wrapper;
}

// Runs a full-database restore. In a cluster the registered wrapper pauses
// replication around it and rebuilds the replication metadata afterwards.
export function runDatabaseRestore(restore: () => Promise<void>): Promise<void> {
  return restoreWrapper(restore);
}
