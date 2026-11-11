import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// Fetches an operator-supplied JSON source, or a picture a link names. Bounded
// in time and size and limited to plain web URLs, so a slow, endless or
// mistyped source can only fail the one request that asked for it. Without a
// redirect unless asked for: then every address on the way is checked as the
// first one was.
const FETCH_IDLE_TIMEOUT_MS = 10_000;
const FETCH_TOTAL_TIMEOUT_MS = 30_000;
const FETCH_MAX_BYTES = 5 * 1024 * 1024;

export class BlockedAddressError extends Error {}

const BLOCKED = 'Diese Adresse zeigt ins interne Netz und ist für den Import nicht erlaubt';

function isInternalV4(address: string): boolean {
  const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19))
    || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

// The 16 bits of each group of an IPv6 address, `::` and a dotted end expanded.
function v6Groups(address: string): number[] | null {
  let text = address.toLowerCase().split('%')[0]!;
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted[1]!.split('.').map(Number);
    text = `${text.slice(0, -dotted[1]!.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  if (fill < 0) return null;
  const groups = [...left, ...Array<string>(fill).fill('0'), ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const v4Of = (high: number, low: number) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

/**
 * Loopback, private, link-local (cloud metadata), carrier-grade NAT, reserved
 * and multicast ranges: what a server can reach but the internet cannot. An
 * IPv6 address that carries an IPv4 one is judged by that one, however it is
 * written. What cannot be read counts as internal.
 */
export function isInternalAddress(address: string): boolean {
  if (net.isIPv4(address)) return isInternalV4(address);
  const g = v6Groups(address);
  if (!g) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const startsZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), :: and ::1.
  if (startsZero && (g5 === 0xffff || g5 === 0)) return (g5 === 0 && g6 === 0 && g7 <= 1) || isInternalV4(v4Of(g6, g7));
  // 64:ff9b::a.b.c.d (NAT64), 2002:a.b.c.d:: (6to4).
  if (g0 === 0x64 && g1 === 0xff9b) return isInternalV4(v4Of(g6, g7));
  if (g0 === 0x2002) return isInternalV4(v4Of(g1, g2));
  // fc00::/7 (unique local), fe80::/10 (link-local), fec0::/10 (site-local), ff00::/8 (multicast).
  return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0 || (g0 & 0xff00) === 0xff00;
}

/** The host of a URL names the inside by itself; a name is only known once resolved. */
export function isInternalUrl(parsed: URL): boolean {
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || (net.isIP(host) !== 0 && isInternalAddress(host));
}

// Resolves like the default lookup, but refuses a name that leads to an
// internal address. Used for the connection itself, so a name that changes
// its answer between a check and the request (DNS rebinding) is caught too.
const publicLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '', 0);
      return;
    }
    const list = addresses as unknown as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => isInternalAddress(a.address))) {
      callback(new BlockedAddressError(BLOCKED), '', 0);
      return;
    }
    if (options.all) (callback as unknown as (e: null, all: dns.LookupAddress[]) => void)(null, list);
    else callback(null, list[0]!.address, list[0]!.family);
  });
};

export async function fetchUrl(url: string, options: { publicOnly?: boolean } = {}): Promise<string> {
  return (await fetchBytes(url, options)).toString('utf8');
}

export interface FetchOptions {
  /** Refuse the internal network, by name and by what the name resolves to. */
  publicOnly?: boolean;
  /** Bytes the answer may have at most (5 MB unless said). */
  maxBytes?: number;
  /** Redirects to follow (none unless said), each one checked like the first address. */
  redirects?: number;
  /** What the request accepts. */
  accept?: string;
}

const MAX_REDIRECTS = 5;

export function fetchBytes(url: string, { publicOnly = false, maxBytes = FETCH_MAX_BYTES, redirects = 0, accept }: FetchOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('invalid URL'));
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      reject(new Error('unsupported URL scheme'));
      return;
    }
    if (publicOnly && isInternalUrl(parsed)) {
      reject(new BlockedAddressError(BLOCKED));
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = { 'User-Agent': 'pokyh-backend/1.0', ...(accept ? { Accept: accept } : {}) };
    const req = lib.get(parsed, { headers, ...(publicOnly ? { lookup: publicLookup } : {}) }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location && redirects > 0) {
        res.resume();
        let next: string;
        try {
          next = new URL(location, parsed).toString();
        } catch {
          fail(new Error('invalid redirect'));
          return;
        }
        settled = true;
        fetchBytes(next, { publicOnly, maxBytes, redirects: Math.min(redirects, MAX_REDIRECTS) - 1, accept }).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        fail(new Error(`unexpected HTTP status ${status}`));
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      res.on('data', (c: Buffer) => {
        if (settled) return;
        received += c.length;
        if (received > maxBytes) {
          // Refused, not cut short: a too large answer is never taken in part,
          // and the stopped connection is no error left for nobody to catch.
          fail(new Error('response too large'));
          res.destroy();
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks));
      });
      res.on('error', fail);
      res.on('close', () => { if (!res.complete) fail(new Error('response cut short')); });
    });
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    // setTimeout only sees silence; a source that drips forever meets the total.
    const total = setTimeout(() => { fail(new Error('fetch timeout')); req.destroy(); }, FETCH_TOTAL_TIMEOUT_MS);
    req.on('close', () => clearTimeout(total));
    req.on('error', fail);
    req.setTimeout(FETCH_IDLE_TIMEOUT_MS, () => { fail(new Error('fetch timeout')); req.destroy(); });
  });
}
