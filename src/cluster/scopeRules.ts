import { createHash } from 'crypto';
import type { Catalog } from './catalog';

// What the nodes of a cluster exchange, and which of two settings wins. Pure,
// tested on its own (tests/clusterScope).
//
// Pokyh Learn (every table named learn_*) can be left out of the exchange —
// the same for all nodes: each node then keeps its own Learn data. The
// setting travels with the heartbeat; the newest one wins everywhere.

export interface ReplicationScope {
  // Exchange Pokyh Learn's tables.
  learn: boolean;
  // When it was set (ms since 1970); 0 = the CLUSTER_REPLICATE_LEARN default.
  version: number;
  // The node it was set on — settles equal versions the same way everywhere.
  by: string;
  // The administrator who set it, for the panel.
  actor: string | null;
}

export const LEARN_TABLE_PREFIX = 'learn_';

export function isLearnTable(table: string): boolean {
  return table.toLowerCase().startsWith(LEARN_TABLE_PREFIX);
}

// Whether a table is exchanged under a scope.
export function exchangedIn(scope: Pick<ReplicationScope, 'learn'>): (table: string) => boolean {
  return (table) => scope.learn || !isLearnTable(table);
}

// True when `candidate` replaces `current`: a newer setting, or — between
// defaults of the same age — the one of the higher node id. A candidate that
// says the same as the current setting changes nothing.
export function supersedes(candidate: ReplicationScope, current: ReplicationScope): boolean {
  const newer = candidate.version !== current.version ? candidate.version > current.version : candidate.by > current.by;
  return newer && (candidate.learn !== current.learn || candidate.version !== current.version);
}

// The fingerprint of a catalog's signature lines ("c|table|…", "u|table|…").
export function fingerprintOf(lines: string[]): string {
  return createHash('sha256').update([...lines].sort().join('\n')).digest('hex').slice(0, 32);
}

// The part of a catalog that is exchanged with the other nodes. Every table
// stays captured — only what is sent, accepted and compared is limited — and
// the fingerprint covers the kept tables only, so two nodes replicate only
// while they agree on what to exchange.
export function restrictCatalog(catalog: Catalog, keep: (table: string) => boolean): Catalog {
  const ordered = catalog.ordered.filter((table) => keep(table.name));
  if (ordered.length === catalog.ordered.length) return catalog;
  const tables = new Map(ordered.map((table) => [table.name, table]));
  const signature = catalog.signature.filter((line) => keep(line.split('|')[1] ?? ''));
  return { tables, ordered, fingerprint: fingerprintOf(signature), signature };
}
