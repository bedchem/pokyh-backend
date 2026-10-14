import { createHmac, hkdfSync, timingSafeEqual } from 'crypto';
import { formatEndpoint, isServerName, parseEndpointList, type Endpoint } from './endpoints';

// The protocol between nodes and a Pokyh relay (deploy/relay/relay.mjs).
// Pure, with no dependency beyond Node itself, so it is tested on its own
// (tests/clusterRelay); the relay mirrors it and the tests check both agree.
//
// A relay lets a node that cannot accept connections from the internet (a
// homelab behind NAT, without a VPN) be reached anyway. The node keeps a few
// connections open *to* the relay ("parked"); when another node connects to
// the relay, the relay reads the server name from the TLS ClientHello —
// without terminating TLS — and splices the connection onto one of the parked
// connections of the node registered under that name. The two nodes then run
// their own mutually authenticated TLS through it, end to end: the relay only
// ever sees ciphertext and cannot read, alter or impersonate anything; it can
// only drop connections. A relay is a path, not a leader: a cluster may use
// several, each node registers itself, and every other path keeps working.
//
// Everything a node needs is in the relay key an administrator pastes into
// the panel or CLUSTER_RELAY_KEYS:
//   - where nodes park (control endpoints) and where others reach a node
//     through the relay (by port, with the node's name as server name; or on
//     443 under a domain the administrator's proxy forwards to the relay);
//   - the pin of the relay's own certificate, so a node parks only at the
//     real relay;
//   - a 256-bit registration secret: only nodes holding it may park.

export const RELAY_KEY_PREFIX = 'pokyhrelay1.';
// Server name of control connections when the relay is reached by port.
export const RELAY_CONTROL_NAME = 'relay-control.pokyh';
const LABEL = 'pokyh-cluster/v1';
const PIN = /^[A-Za-z0-9+/]{43}=$/;

export interface RelayKey {
  name: string;
  pin: string;
  secret: Buffer;
  control: Endpoint[];
  ports: Endpoint[];
  // Domain whose names the administrator's proxy forwards to the relay on
  // 443 (route names are <label>.<domain>); empty when not used.
  domain: string;
}

export function encodeRelayKey(key: RelayKey): string {
  const body = {
    v: 1,
    n: key.name,
    f: key.pin,
    s: key.secret.toString('base64url'),
    c: key.control.map(formatEndpoint),
    p: key.ports.map(formatEndpoint),
    d: key.domain,
  };
  return RELAY_KEY_PREFIX + Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

export type DecodedRelayKey = { ok: true; key: RelayKey } | { ok: false; error: string };

const damaged: DecodedRelayKey = { ok: false, error: 'Relay key is damaged or incomplete' };

export function decodeRelayKey(text: string): DecodedRelayKey {
  const trimmed = text.replace(/\s+/g, '');
  if (!trimmed.startsWith(RELAY_KEY_PREFIX)) return { ok: false, error: 'This is not a Pokyh relay key' };
  if (trimmed.length > 4096) return { ok: false, error: 'Relay key is too long' };
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(Buffer.from(trimmed.slice(RELAY_KEY_PREFIX.length), 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return damaged;
    body = parsed as Record<string, unknown>;
  } catch {
    return damaged;
  }
  const { v, n, f, s, c, p, d } = body;
  if (v !== 1) return { ok: false, error: 'Relay key comes from a different Pokyh version' };
  if (typeof n !== 'string' || n.length > 60 || /[\x00-\x1f\x7f]/.test(n)) return damaged;
  if (typeof f !== 'string' || !PIN.test(f)) return damaged;
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(s)) return damaged;
  if (!Array.isArray(c) || !Array.isArray(p) || !c.every((x) => typeof x === 'string') || !p.every((x) => typeof x === 'string')) return damaged;
  if (typeof d !== 'string' || (d !== '' && !isServerName(d))) return damaged;
  const control = parseEndpointList(c as string[]);
  const ports = parseEndpointList(p as string[]);
  if (control.invalid.length > 0 || ports.invalid.length > 0 || control.endpoints.length === 0) return damaged;
  if (ports.endpoints.length === 0 && d === '') return { ok: false, error: 'Relay key names no way to reach nodes through the relay' };
  return { ok: true, key: { name: n, pin: f, secret: Buffer.from(s, 'base64url'), control: control.endpoints, ports: ports.endpoints, domain: d } };
}

// The name a node is registered under at a relay, made from a label of the
// node's choosing (its name, by default).
export function routeLabel(nodeName: string, nodeId: string): string {
  const slug = nodeName.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const suffix = nodeId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8);
  return `${slug || 'node'}-${suffix}`;
}

export function routeName(label: string, key: RelayKey): string {
  return `${label}.${key.domain || 'pokyh-relay'}`;
}

// The endpoints under which a node is reachable through this relay.
export function relayEndpoints(key: RelayKey, route: string, options: { ports: boolean; sni: boolean }): Endpoint[] {
  const out: Endpoint[] = [];
  if (options.ports) for (const port of key.ports) out.push({ url: port.url, sni: route });
  if (options.sni && key.domain) out.push({ url: `https://${route}:443` });
  return out;
}

// ─── Parking ─────────────────────────────────────────────────────────────────

function fields(parts: string[]): Buffer {
  return Buffer.concat(parts.flatMap((part) => {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length, 0);
    return [length, bytes];
  }));
}

// Proves, for one parked connection, that the node holds the relay's
// registration secret; bound to the route, the time, a fresh nonce and the
// certificate the node presented on that very connection.
export function parkProof(secret: Buffer, route: string, timestamp: number, nonce: string, nodePin: string): Buffer {
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), Buffer.from(`${LABEL}/relay/park`, 'utf8'), 32));
  return createHmac('sha256', key).update(fields(['park', route, String(timestamp), nonce, nodePin])).digest();
}

export function parkProofMatches(expected: Buffer, presented: string): boolean {
  const bytes = Buffer.from(presented, 'base64url');
  return bytes.length === expected.length && timingSafeEqual(bytes, expected);
}

// ─── Reading the server name of a ClientHello ────────────────────────────────

export type ServerNameResult =
  | { status: 'more' }
  | { status: 'ok'; name: string | null }
  | { status: 'invalid' };

// Reads the server name from the first TLS record of a connection, without
// consuming or answering anything. 'more' asks for more bytes.
export function readServerName(data: Buffer): ServerNameResult {
  if (data.length < 5) return { status: 'more' };
  if (data[0] !== 0x16 || data[1] !== 0x03) return { status: 'invalid' };
  const recordLength = data.readUInt16BE(3);
  if (recordLength < 4 || recordLength > 16_384) return { status: 'invalid' };
  if (data.length < 5 + recordLength) return { status: 'more' };
  const record = data.subarray(5, 5 + recordLength);
  if (record[0] !== 0x01) return { status: 'invalid' };
  const helloLength = (record[1]! << 16) | (record[2]! << 8) | record[3]!;
  // A ClientHello split over several records is not supported.
  if (4 + helloLength > record.length) return { status: 'invalid' };
  const hello = record.subarray(4, 4 + helloLength);
  let at = 2 + 32;
  const skip = (lengthBytes: 1 | 2): boolean => {
    if (at + lengthBytes > hello.length) return false;
    const length = lengthBytes === 1 ? hello[at]! : hello.readUInt16BE(at);
    at += lengthBytes + length;
    return at <= hello.length;
  };
  if (!skip(1) || !skip(2) || !skip(1)) return { status: 'invalid' };
  if (at === hello.length) return { status: 'ok', name: null };
  if (at + 2 > hello.length) return { status: 'invalid' };
  const extensionsEnd = at + 2 + hello.readUInt16BE(at);
  if (extensionsEnd > hello.length) return { status: 'invalid' };
  at += 2;
  while (at + 4 <= extensionsEnd) {
    const type = hello.readUInt16BE(at);
    const length = hello.readUInt16BE(at + 2);
    const start = at + 4;
    if (start + length > extensionsEnd) return { status: 'invalid' };
    if (type === 0x0000) {
      if (length < 2) return { status: 'invalid' };
      const listEnd = start + 2 + hello.readUInt16BE(start);
      let entry = start + 2;
      while (entry + 3 <= listEnd && listEnd <= start + length) {
        const nameType = hello[entry]!;
        const nameLength = hello.readUInt16BE(entry + 1);
        if (entry + 3 + nameLength > listEnd) return { status: 'invalid' };
        if (nameType === 0) {
          const name = hello.subarray(entry + 3, entry + 3 + nameLength).toString('ascii').toLowerCase();
          return isServerName(name) ? { status: 'ok', name } : { status: 'invalid' };
        }
        entry += 3 + nameLength;
      }
      return { status: 'ok', name: null };
    }
    at = start + length;
  }
  return { status: 'ok', name: null };
}
