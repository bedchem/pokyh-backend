// Indirection points that let ordinary services cooperate with the cluster
// layer without importing it (which would create import cycles and couple a
// standalone deployment to cluster code). Until the cluster layer registers
// itself, every hook behaves exactly like a single-node deployment.
//
// There is no leader. Background work is shared out instead:
//
//   ownsClusterWork(key)  for work done per item (a notification, a
//                         subscription to poll, an idempotent clean-up): true
//                         on exactly one of the nodes that can currently be
//                         reached, chosen by the key. Spreads the work over
//                         all nodes and moves a node's share to the others the
//                         moment it goes away. While nodes cannot see each
//                         other, each side carries on — a notification may then
//                         go out twice rather than not at all.
//   mayRunExclusiveJob(name)  for work that must happen once and only once
//                         (archiving, the school-year rollover): true on one
//                         node, and only while every linked node is reachable,
//                         so two separated halves can never both run it.

export interface WorkPolicy {
  owns: (key: string) => boolean;
  exclusive: (job: string) => boolean;
}

let policy: WorkPolicy = { owns: () => true, exclusive: () => true };

export function setWorkPolicy(next: WorkPolicy): void {
  policy = next;
}

export function ownsClusterWork(key: string): boolean {
  try {
    return policy.owns(key);
  } catch {
    return true;
  }
}

export function mayRunExclusiveJob(job: string): boolean {
  try {
    return policy.exclusive(job);
  } catch {
    return false;
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
