import { isIP } from 'net';

// The ways a node's mutually authenticated channel can be reached. Pure, with
// no dependency beyond Node itself, so it is tested on its own
// (tests/clusterEndpoints).
//
// A node may be reachable in several ways at once — directly (public address,
// VPN address), through a reverse proxy that passes the TLS connection on
// untouched (by port, or by server name on a shared port such as 443), or
// through a Pokyh relay. It announces all of them, in its order of
// preference; the others try them in turn and stay with the one that works.
//
// None of this decides whom to trust: whichever way a connection takes, it
// ends at the node's own certificate, which the other side has pinned. A
// path only has to deliver the bytes.
//
// Written form: `https://host:port`, optionally with `?sni=name` when the
// server name to present differs from the host connected to (a relay or a
// proxy that routes by name on a shared port).

export interface Endpoint {
  url: string;
  sni?: string;
}

export const MAX_ENDPOINTS = 8;
const MAX_TEXT = 300;
const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;

export function isServerName(value: string): boolean {
  return HOSTNAME.test(value) && isIP(value) === 0;
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

// The port as written. URL drops a port equal to the scheme's default (443),
// but an endpoint always names its port, so it is read from the text.
const WRITTEN_PORT = /^https:\/\/(?:\[[^\]]*\]|[^/:?#@\[\]]+):(\d{1,5})(?=[/?#]|$)/i;

export function writtenPort(text: string): number | null {
  const match = WRITTEN_PORT.exec(text.trim());
  if (!match) return null;
  const port = Number(match[1]);
  return port >= 1 && port <= 65_535 ? port : null;
}

// Accepts the written form; anything else (other schemes, paths, user info,
// a missing port, a malformed server name) is refused.
export function parseEndpoint(text: string): Endpoint | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT) return null;
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  const port = writtenPort(text);
  if (url.protocol !== 'https:' || !url.hostname || port === null || url.username || url.password) return null;
  if ((url.pathname !== '/' && url.pathname !== '') || url.hash) return null;
  const params = [...url.searchParams.keys()];
  if (params.some((key) => key !== 'sni') || url.searchParams.getAll('sni').length > 1) return null;
  const sni = url.searchParams.get('sni')?.toLowerCase();
  if (sni !== undefined && !isServerName(sni)) return null;
  const base = `https://${url.hostname}:${port}`;
  return sni && sni !== hostOf(url).toLowerCase() ? { url: base, sni } : { url: base };
}

export function formatEndpoint(endpoint: Endpoint): string {
  return endpoint.sni ? `${endpoint.url}?sni=${endpoint.sni}` : endpoint.url;
}

export function endpointKey(endpoint: Endpoint): string {
  return formatEndpoint(endpoint);
}

// Parses a list (comma or whitespace separated, or an array), keeping order,
// dropping duplicates and stopping at the maximum.
export function parseEndpointList(input: string | string[] | undefined | null): { endpoints: Endpoint[]; invalid: string[] } {
  const items = Array.isArray(input) ? input : (input ?? '').split(/[\s,]+/);
  const endpoints: Endpoint[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const item = typeof raw === 'string' ? raw.trim() : '';
    if (!item) continue;
    const parsed = parseEndpoint(item);
    if (!parsed) { invalid.push(item.slice(0, 80)); continue; }
    const key = endpointKey(parsed);
    if (seen.has(key)) continue;
    seen.add(key);
    if (endpoints.length < MAX_ENDPOINTS) endpoints.push(parsed);
  }
  return { endpoints, invalid };
}

export function mergeEndpoints(...lists: Endpoint[][]): Endpoint[] {
  const out: Endpoint[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const endpoint of list) {
      const key = endpointKey(endpoint);
      if (seen.has(key) || out.length >= MAX_ENDPOINTS) continue;
      seen.add(key);
      out.push(endpoint);
    }
  }
  return out;
}

export interface ConnectTarget {
  host: string;
  port: number;
  // The TLS server name to present, if any (never an IP address).
  servername: string | undefined;
}

export function connectTarget(endpoint: Endpoint): ConnectTarget {
  const url = new URL(endpoint.url);
  const host = hostOf(url);
  return {
    host,
    port: writtenPort(endpoint.url) ?? 443,
    servername: endpoint.sni ?? (isIP(host) === 0 ? host.toLowerCase() : undefined),
  };
}

// Whether an address can be expected to work from anywhere on the internet,
// as opposed to a loopback, private, VPN or link-local one. Names count as
// public (they may resolve to anything, but someone chose to publish them).
export function isPublicEndpoint(endpoint: Endpoint): boolean {
  const { host } = connectTarget(endpoint);
  const family = isIP(host);
  if (family === 0) return !/(^localhost$|\.local$|\.internal$|\.lan$|\.home\.arpa$)/i.test(host);
  if (family === 4) {
    const [a, b] = host.split('.').map(Number) as [number, number];
    return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  const lower = host.toLowerCase();
  return !(lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd'));
}

// The public address an administrator's browser shows the admin panel under
// (https://host[:port], nothing else; plain http only on this machine, for
// development). Returns the canonical origin or null.
export function publicOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password) return null;
  return url.origin;
}

// A way to this node through the administrator's own web proxy, on the
// API's public address (api.example.org/cluster-node/name): the proxy ends
// TLS there and passes the path on to this node's cluster entry. Nothing on
// that way is trusted — the frames are end-to-end encrypted and
// authenticated with the link key — but there is no certificate pinning, so
// it is used only after every pinned way failed. https://host[:port][/path]
// (http only on this machine, for tests). Returns the canonical form or null.
const PATH_SEGMENT = /^[A-Za-z0-9._~-]{1,64}$/;
export function parsePathWay(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  if (url.search || url.hash || url.username || url.password || value.length > 255) return null;
  // "." and ".." are resolved by the URL parser; written ones are refused.
  if (/\/\.\.?(\/|$)/.test(value.trim().replace(/^[a-z]+:\/\/[^/]*/i, ''))) return null;
  const segments = url.pathname.replace(/\/+$/, '').split('/').filter((part) => part !== '');
  if (segments.length > 4 || !segments.every((part) => PATH_SEGMENT.test(part) && part !== '.' && part !== '..')) return null;
  return `${url.origin}${segments.length > 0 ? `/${segments.join('/')}` : ''}`;
}

// The command-line form curl needs for this endpoint: the URL to request and,
// when the server name differs from the host connected to, the --connect-to
// mapping that sends the request there while presenting the server name.
export function curlTarget(endpoint: Endpoint, path: string): { url: string; connectTo: string | null } {
  const target = connectTarget(endpoint);
  if (!endpoint.sni) return { url: `${endpoint.url}${path}`, connectTo: null };
  const connectHost = isIP(target.host) === 6 ? `[${target.host}]` : target.host;
  return {
    url: `https://${endpoint.sni}:${target.port}${path}`,
    connectTo: `${endpoint.sni}:${target.port}:${connectHost}:${target.port}`,
  };
}
