// Failure detection, leader choice and peer address handling. Pure logic with
// no timers, sockets or database access, so every transition is testable.

export type Health = 'UNKNOWN' | 'ONLINE' | 'SUSPECT' | 'OFFLINE';

export interface HealthThresholds {
  suspectAfterFailures: number;
  offlineAfterFailures: number;
}

// A single failed heartbeat is ordinary network noise, so a peer only becomes
// SUSPECT after a few consecutive failures and OFFLINE after more. One
// successful exchange makes it ONLINE again immediately.
export function healthAfter(consecutiveFailures: number, thresholds: HealthThresholds): Health {
  if (consecutiveFailures <= 0) return 'ONLINE';
  if (consecutiveFailures >= Math.max(thresholds.offlineAfterFailures, thresholds.suspectAfterFailures + 1)) return 'OFFLINE';
  if (consecutiveFailures >= thresholds.suspectAfterFailures) return 'SUSPECT';
  return 'ONLINE';
}

// Jobs that must run once per deployment (notifications, archiving, the
// school-year rollover) run on the leader: the smallest node id among this
// node and every peer it can currently reach. All nodes that see the same set
// of reachable nodes agree on the same leader without exchanging any votes,
// and when the leader goes offline the next node takes over by itself.
export function electLeader(selfId: string, reachablePeerIds: string[]): string {
  let leader = selfId;
  for (const id of reachablePeerIds) {
    if (id < leader) leader = id;
  }
  return leader;
}

// Estimates how far the peer's clock is ahead (+) or behind (-) of ours,
// assuming the request and the response took equally long.
export function estimateSkewMs(sentAt: number, receivedAt: number, peerTime: number): number {
  return Math.round(peerTime - (sentAt + (receivedAt - sentAt) / 2));
}

export const DEFAULT_PEER_PORT = 4000;

export type AddressResult = { ok: true; url: string } | { ok: false; error: string };

// Accepts what an operator would naturally type — "10.0.0.5", "10.0.0.5:4000",
// "node2.example.org", "[2001:db8::5]:4000" or a full http(s) URL — and
// returns the canonical base URL of that node.
export function normalizePeerAddress(input: string): AddressResult {
  const raw = input.trim();
  if (!raw) return { ok: false, error: 'Address is required' };
  if (raw.length > 255) return { ok: false, error: 'Address is too long' };
  if (/\s/.test(raw)) return { ok: false, error: 'Address must not contain spaces' };

  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    // A bare IPv6 address needs brackets before a port can be told apart.
    const bareIpv6 = !candidate.startsWith('[') && (candidate.match(/:/g) ?? []).length > 1;
    candidate = `http://${bareIpv6 ? `[${candidate}]` : candidate}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, error: 'Address is not a valid host, IP address or URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http:// and https:// addresses are supported' };
  }
  if (!url.hostname) return { ok: false, error: 'Address has no host' };
  if (url.username || url.password) return { ok: false, error: 'Address must not contain credentials' };
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    return { ok: false, error: 'Address must not contain a path or query' };
  }
  const explicitPort = url.port !== '';
  const usesDefaultWebPort = !explicitPort && /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (!explicitPort && !usesDefaultWebPort) url.port = String(DEFAULT_PEER_PORT);
  return { ok: true, url: url.origin };
}
