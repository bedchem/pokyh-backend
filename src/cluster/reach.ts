import { randomUUID } from 'crypto';
import { prisma } from '../db';
import { config } from '../config';
import { formatEndpoint, mergeEndpoints, parseEndpoint, parseEndpointList, type Endpoint } from './endpoints';

// How the other nodes reach this node's mutually authenticated channel — in
// this order:
//   1. CLUSTER_MTLS_URL and CLUSTER_MTLS_ENDPOINTS from the environment;
//   2. the ways an administrator set in the admin panel, each switchable
//      (direct, through a proxy by port, through a proxy on 443 by server
//      name);
//   3. the relays this node is registered at (relayClient.ts).
// When none is set, the address is derived from CLUSTER_ADVERTISE_URL or
// PUBLIC_BASE_URL and CLUSTER_MTLS_PORT. The resulting list travels to the
// other nodes over authenticated paths only; they try it in order.

export type ReachKind = 'direct' | 'proxy-port' | 'proxy-sni';

export interface ReachEntry {
  id: string;
  kind: ReachKind;
  endpoint: string;
  enabled: boolean;
  // For the proxy kinds: where the proxy forwards to (this node as the
  // proxy reaches it, e.g. its VPN address and port), for the configuration
  // shown in the panel.
  backend: string;
}

export const MAX_REACH_ENTRIES = 8;
const BACKEND = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]{1,253}):\d{1,5}$/;

let entries: ReachEntry[] = [];
let relayEndpoints: Endpoint[] = [];

export function envEndpoints(): { endpoints: Endpoint[]; invalid: string[] } {
  return parseEndpointList([config.cluster.mtlsUrl, ...config.cluster.mtlsEndpoints.split(/[\s,]+/)].filter(Boolean));
}

export function panelEntries(): ReachEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

export function relayReach(): Endpoint[] {
  return [...relayEndpoints];
}

// Returns true when the list changed.
export function setRelayEndpoints(next: Endpoint[]): boolean {
  const before = relayEndpoints.map(formatEndpoint).join(' ');
  relayEndpoints = [...next];
  return relayEndpoints.map(formatEndpoint).join(' ') !== before;
}

export function ownEndpoints(derived: string | null): Endpoint[] {
  const panel = entries
    .filter((entry) => entry.enabled)
    .map((entry) => parseEndpoint(entry.endpoint))
    .filter((endpoint): endpoint is Endpoint => endpoint !== null);
  const merged = mergeEndpoints(envEndpoints().endpoints, panel, relayEndpoints);
  if (merged.length === 0 && derived) {
    const fallback = parseEndpoint(derived);
    if (fallback) return [fallback];
  }
  return merged;
}

// Checks and normalises what the panel sends. Throws with a reason.
export function validateEntries(input: Array<Partial<ReachEntry>>): ReachEntry[] {
  if (!Array.isArray(input) || input.length > MAX_REACH_ENTRIES) throw new Error(`At most ${MAX_REACH_ENTRIES} ways can be set`);
  const seen = new Set<string>();
  return input.map((raw, index) => {
    const kind = raw.kind;
    if (kind !== 'direct' && kind !== 'proxy-port' && kind !== 'proxy-sni') throw new Error(`Way ${index + 1}: unknown kind`);
    const endpoint = parseEndpoint(String(raw.endpoint ?? ''));
    if (!endpoint) throw new Error(`Way ${index + 1}: enter an address of the form https://host:port`);
    if (kind === 'proxy-sni' && (endpoint.sni || /^[\d.]+$|:/.test(new URL(endpoint.url).hostname))) {
      throw new Error(`Way ${index + 1}: on 443 by server name, the address must be a domain name (e.g. https://node1.cluster.example.org:443)`);
    }
    const key = formatEndpoint(endpoint);
    if (seen.has(key)) throw new Error(`Way ${index + 1}: listed twice`);
    seen.add(key);
    const backend = String(raw.backend ?? '').trim();
    if (backend && !BACKEND.test(backend)) throw new Error(`Way ${index + 1}: the address behind the proxy must be host:port`);
    return {
      id: typeof raw.id === 'string' && /^[0-9a-f-]{36}$/.test(raw.id) ? raw.id : randomUUID(),
      kind,
      endpoint: key,
      enabled: raw.enabled !== false,
      backend: kind === 'direct' ? '' : backend,
    };
  });
}

export async function loadReach(): Promise<void> {
  const row = await prisma.clusterNode.findUnique({ where: { id: 1 }, select: { reachConfig: true } });
  entries = [];
  if (!row?.reachConfig) return;
  try {
    const parsed = JSON.parse(row.reachConfig) as { entries?: Array<Partial<ReachEntry>> };
    entries = validateEntries(parsed.entries ?? []);
  } catch {
    entries = [];
  }
}

export async function saveReach(next: Array<Partial<ReachEntry>>): Promise<ReachEntry[]> {
  const valid = validateEntries(next);
  await prisma.clusterNode.update({ where: { id: 1 }, data: { reachConfig: JSON.stringify({ v: 1, entries: valid }) } });
  entries = valid;
  return panelEntries();
}
