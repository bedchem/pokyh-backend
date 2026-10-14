import { prisma } from '../db';
import { config } from '../config';
import { supersedes, type ReplicationScope } from './scopeRules';

// This node's copy of the cluster-wide replication scope (scopeRules.ts),
// kept in cluster_node. Without a stored setting, CLUSTER_REPLICATE_LEARN
// applies (as version 0).

let current: ReplicationScope = { learn: config.cluster.replicateLearn, version: 0, by: '', actor: null };

export function replicationScope(): ReplicationScope {
  return current;
}

export async function loadScope(nodeId: string): Promise<ReplicationScope> {
  const row = await prisma.clusterNode.findUnique({
    where: { id: 1 },
    select: { scopeLearn: true, scopeVersion: true, scopeBy: true, scopeActor: true },
  });
  current = row && row.scopeLearn !== null && row.scopeBy
    ? { learn: row.scopeLearn, version: Number(row.scopeVersion), by: row.scopeBy, actor: row.scopeActor }
    : { learn: config.cluster.replicateLearn, version: 0, by: nodeId, actor: null };
  return current;
}

async function save(next: ReplicationScope): Promise<void> {
  await prisma.clusterNode.update({
    where: { id: 1 },
    data: { scopeLearn: next.learn, scopeVersion: BigInt(next.version), scopeBy: next.by, scopeActor: next.actor },
  });
  current = next;
}

// An administrator's choice on this node.
export async function setScope(learn: boolean, actor: string, nodeId: string): Promise<ReplicationScope> {
  const next = { learn, version: Math.max(Date.now(), current.version + 1), by: nodeId, actor: actor.slice(0, 100) };
  await save(next);
  return next;
}

// A peer's setting; taken over when it is newer. Returns the previous scope
// when it changed.
export async function adoptScope(candidate: ReplicationScope): Promise<ReplicationScope | null> {
  if (!supersedes(candidate, current)) return null;
  const previous = current;
  await save(candidate);
  return previous;
}
