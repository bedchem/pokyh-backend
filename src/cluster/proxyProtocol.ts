import { isIP } from 'net';

// The PROXY protocol, version 1 (HAProxy's text form): a forwarder in front
// of the cluster channel (deploy/node/edge.mjs) prepends one line naming the
// original client, so the channel still knows who is calling. Pure, tested on
// its own (tests/clusterUpdates).
//
//   PROXY TCP4 203.0.113.7 10.0.0.2 51234 4100\r\n
//
// Only accepted from forwarders the node trusts (CLUSTER_MTLS_PROXY_FROM);
// it changes nothing about authentication, which rests on the pinned
// certificates alone.

export const MAX_HEADER_BYTES = 107;

export type ProxyHeader =
  | { status: 'more' }
  | { status: 'none' }
  | { status: 'invalid' }
  | { status: 'ok'; address: string | null; port: number | null; length: number };

export function parseProxyHeader(data: Buffer): ProxyHeader {
  const prefix = Buffer.from('PROXY ');
  const compared = data.subarray(0, Math.min(data.length, prefix.length));
  if (!prefix.subarray(0, compared.length).equals(compared)) return { status: 'none' };
  const end = data.indexOf('\r\n');
  if (end < 0) return data.length > MAX_HEADER_BYTES ? { status: 'invalid' } : { status: 'more' };
  if (end + 2 > MAX_HEADER_BYTES + 1) return { status: 'invalid' };
  const parts = data.subarray(0, end).toString('ascii').split(' ');
  if (parts[1] === 'UNKNOWN') return { status: 'ok', address: null, port: null, length: end + 2 };
  if (parts.length !== 6) return { status: 'invalid' };
  const [, family, source, destination, sourcePort, destinationPort] = parts as [string, string, string, string, string, string];
  const expected = family === 'TCP4' ? 4 : family === 'TCP6' ? 6 : 0;
  if (expected === 0 || isIP(source) !== expected || isIP(destination) !== expected) return { status: 'invalid' };
  const port = Number(sourcePort);
  const dport = Number(destinationPort);
  if (!/^\d{1,5}$/.test(sourcePort) || !/^\d{1,5}$/.test(destinationPort) || port > 65_535 || dport > 65_535) return { status: 'invalid' };
  return { status: 'ok', address: source, port, length: end + 2 };
}

export function formatProxyHeader(source: { address: string; port: number }, destination: { address: string; port: number }): string {
  const src = source.address.replace(/^::ffff:/, '');
  const dst = destination.address.replace(/^::ffff:/, '');
  const family = isIP(src) === 6 || isIP(dst) === 6 ? 'TCP6' : 'TCP4';
  if (isIP(src) === 0 || isIP(dst) === 0 || (family === 'TCP6' && (isIP(src) !== 6 || isIP(dst) !== 6))) return 'PROXY UNKNOWN\r\n';
  return `PROXY ${family} ${src} ${dst} ${source.port} ${destination.port}\r\n`;
}
