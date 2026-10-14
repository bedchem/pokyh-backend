import { createPublicKey, X509Certificate } from 'crypto';
import express, { type Router } from 'express';
import https from 'https';
import net from 'net';
import { Duplex } from 'stream';
import tls, { type TLSSocket } from 'tls';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { connectTarget, endpointKey, type Endpoint } from './endpoints';
import { isAllowed, parseAllowlist } from './netpolicy';
import { CLUSTER_PATH } from './protocol';
import { parseProxyHeader } from './proxyProtocol';
import { unwrap, wrap } from './store';
import { certificatePin, createNodeCertificate, inspectNodeCertificate, type NodeCertificate } from './x509';

// The mutually authenticated channel between nodes (CLUSTER_MTLS_PORT).
//
// Every node holds its own certificate (x509.ts) and presents it on both ends
// of every connection. Nothing here relies on a certificate authority: a
// node accepts exactly the certificates it pinned, learned only over
// authenticated paths, and refuses everything else.
//
//   Connection   TLS 1.3 only. A client that presents no certificate, or one
//                nobody pinned, is disconnected right after the handshake —
//                before a single byte of HTTP is read — unless a pairing or an
//                install is open at that moment, and then it can reach only
//                the few endpoints those need (router.ts).
//   Outgoing     The peer's certificate is the only trust anchor and its pin
//                is checked again; a different certificate ends the connection
//                before any request data is written.
//
// Inside this channel the existing frame layer (crypto.ts, transport.ts) keeps
// running with its own keys, and its handshakes are bound to the two
// certificates of the connection — two independent layers, both mutually
// authenticated.

const KEY_CONTEXT = (nodeId: string) => `tls-key:${nodeId}`;
const PROBE_CACHE_MS = 10 * 60 * 1000;

// ─── This node's identity ────────────────────────────────────────────────────

export interface NodeIdentity {
  certPem: string;
  keyPem: string;
  pin: string;
  notAfter: Date;
}

let identity: NodeIdentity | null = null;

export function ownIdentity(): NodeIdentity | null {
  return identity;
}

function keyMatchesCertificate(keyPem: string, certPem: string): boolean {
  try {
    const fromKey = createPublicKey(keyPem).export({ type: 'spki', format: 'der' });
    const fromCert = new X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' });
    return fromKey.equals(fromCert);
  } catch {
    return false;
  }
}

// Loads the stored certificate, or creates one on first use. A stored key
// that can no longer be read (CLUSTER_SECRET or JWT_SECRET changed) is
// replaced; peers that pinned the old certificate have to be invited again,
// exactly as for unreadable link keys.
export async function loadOrCreateIdentity(nodeId: string): Promise<NodeIdentity> {
  const row = await prisma.clusterNode.findUnique({ where: { id: 1 }, select: { tlsCert: true, tlsKeyEnc: true } });
  if (row?.tlsCert && row.tlsKeyEnc) {
    try {
      const keyPem = unwrap(row.tlsKeyEnc, KEY_CONTEXT(nodeId)).toString('utf8');
      const facts = inspectNodeCertificate(row.tlsCert);
      if (!keyMatchesCertificate(keyPem, row.tlsCert)) throw new Error('stored key does not belong to the certificate');
      identity = { certPem: row.tlsCert, keyPem, pin: facts.pin, notAfter: facts.notAfter };
      return identity;
    } catch (err) {
      logger.error('Stored cluster certificate is unusable; a new one is created', {
        action: 'cluster_certificate_replaced',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const created = createNodeCertificate(`pokyh-node-${nodeId}`);
  await saveIdentity(nodeId, created);
  return identity!;
}

async function saveIdentity(nodeId: string, created: NodeCertificate): Promise<void> {
  await prisma.clusterNode.update({
    where: { id: 1 },
    data: { tlsCert: created.certPem, tlsKeyEnc: wrap(Buffer.from(created.keyPem, 'utf8'), KEY_CONTEXT(nodeId)) },
  });
  identity = { certPem: created.certPem, keyPem: created.keyPem, pin: created.pin, notAfter: created.notAfter };
}

// Switches to a new certificate: stored first, then used by the listener and
// by every new outgoing connection.
export async function replaceIdentity(nodeId: string, next: NodeCertificate): Promise<void> {
  await saveIdentity(nodeId, next);
  if (server && identity) server.setSecureContext({ key: identity.keyPem, cert: identity.certPem, minVersion: 'TLSv1.3' });
  if (identity) secureContext = tls.createSecureContext({ key: identity.keyPem, cert: identity.certPem, minVersion: 'TLSv1.3' });
  resetClientAgents();
}

// The address other nodes reach this node's channel at, or null when the
// channel is off or no host name is known.
export function ownChannelUrl(fallbackHostUrl: string): string | null {
  if (config.cluster.mtlsPort === 0) return null;
  if (config.cluster.mtlsUrl) return config.cluster.mtlsUrl;
  for (const candidate of [config.cluster.advertiseUrl, fallbackHostUrl, config.publicBaseUrl]) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (!url.hostname) continue;
      const host = url.hostname.includes(':') && !url.hostname.startsWith('[') ? `[${url.hostname}]` : url.hostname;
      return `https://${host}:${config.cluster.mtlsPort}`;
    } catch {
      continue;
    }
  }
  return null;
}

// ─── Who may connect ─────────────────────────────────────────────────────────

export interface TlsGate {
  // A certificate pinned for an active peer (or announced for a pairing).
  isPinned(pin: string): boolean;
  // A pairing window is open, so an unknown certificate may try to pair.
  pairingOpen(): boolean;
  // An install is open, so a client without a certificate may fetch it.
  installOpen(): boolean;
}

let gate: TlsGate = { isPinned: () => false, pairingOpen: () => false, installOpen: () => false };

export function setTlsGate(next: TlsGate): void {
  gate = next;
}

export interface ClientCertificate {
  pin: string;
  pem: string;
}

const clientCertificates = new WeakMap<TLSSocket, ClientCertificate | null>();

// The certificate the client of this connection presented, if any.
export function clientCertificateOf(socket: unknown): ClientCertificate | null {
  return clientCertificates.get(socket as TLSSocket) ?? null;
}

let refusedLoggedAt = 0;

function admit(socket: TLSSocket): void {
  let presented: ClientCertificate | null = null;
  try {
    const cert = socket.getPeerX509Certificate();
    if (cert) presented = { pin: certificatePin(cert), pem: cert.toString() };
  } catch {
    presented = null;
  }
  const allowed = presented
    ? gate.isPinned(presented.pin) || gate.pairingOpen()
    : gate.installOpen();
  if (!allowed) {
    if (Date.now() - refusedLoggedAt > 60_000) {
      refusedLoggedAt = Date.now();
      logger.warn('Cluster channel: connection with an unknown or missing certificate refused', {
        action: 'cluster_tls_refused',
        certificate: presented ? 'unknown' : 'none',
      });
    }
    socket.destroy();
    return;
  }
  clientCertificates.set(socket, presented);
}

// ─── Listener ────────────────────────────────────────────────────────────────

let server: https.Server | null = null;
// With a forwarder in front (PROXY protocol): the socket listening on the
// port, which hands each connection to `server` once TLS is up.
let proxyListener: net.Server | null = null;
let secureContext: tls.SecureContext | null = null;
// The client address of connections set up by the PROXY protocol path.
const forwardedAddresses = new WeakMap<object, string>();
const proxyFrom = parseAllowlist(config.cluster.mtlsProxyFrom);

export const mtlsState = {
  listening: false,
  error: null as string | null,
};

// A stream that first replays bytes already read from a socket, then
// carries the socket on: TLS over a connection whose first line was read.
function replaying(socket: net.Socket, head: Buffer): Duplex {
  const duplex = new Duplex({
    read() { socket.resume(); },
    write(chunk, _encoding, callback) { socket.write(chunk, callback); },
    final(callback) { socket.end(); callback(); },
    destroy(err, callback) { socket.destroy(err ?? undefined); callback(err); },
  });
  if (head.length > 0) duplex.push(head);
  socket.on('data', (chunk: Buffer) => { if (!duplex.push(chunk)) socket.pause(); });
  socket.on('end', () => duplex.push(null));
  socket.on('error', (err) => duplex.destroy(err));
  socket.on('close', () => duplex.destroy());
  return duplex;
}

const isLoopback = (address: string | undefined) => /^(127\.|::1$|::ffff:127\.)/.test(address ?? '');

// One connection through the forwarder: read its PROXY line, then run TLS on
// the rest. A connection that is not from a trusted forwarder may not name a
// client; one from this node itself (a relay hand-over) needs no line.
function acceptForwarded(socket: net.Socket): void {
  socket.setTimeout(15_000, () => socket.destroy());
  let head = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const parsed = parseProxyHeader(head);
    if (parsed.status === 'more') return;
    socket.off('data', onData);
    socket.pause();
    let address: string | undefined;
    let rest = head;
    if (parsed.status === 'ok') {
      if (!isAllowed(proxyFrom, socket.remoteAddress)) { socket.destroy(); return; }
      address = parsed.address ?? socket.remoteAddress;
      rest = head.subarray(parsed.length);
    } else if (parsed.status === 'none' && isLoopback(socket.remoteAddress)) {
      address = clientAddressOf(socket);
    } else {
      socket.destroy();
      return;
    }
    if (!server || !secureContext) { socket.destroy(); return; }
    const secure = new tls.TLSSocket(replaying(socket, rest), {
      isServer: true,
      secureContext,
      requestCert: true,
      rejectUnauthorized: false,
      server,
    });
    if (address) forwardedAddresses.set(secure, address);
    secure.once('secure', () => {
      socket.setTimeout(0);
      admit(secure);
      if (!secure.destroyed) server?.emit('secureConnection', secure);
    });
    secure.on('error', () => secure.destroy());
  };
  socket.on('data', onData);
  socket.on('error', () => socket.destroy());
}

// Resolves once the channel listens (or failed to), so whatever depends on it
// — a join set up by the installer — starts only then.
export function startMtlsListener(router: Router): Promise<void> {
  if (!config.cluster.enabled || config.cluster.mtlsPort === 0 || server || !identity) return Promise.resolve();
  if (config.cluster.mtlsPort === config.port || config.cluster.mtlsPort === config.cluster.port) {
    mtlsState.error = 'CLUSTER_MTLS_PORT must differ from PORT and CLUSTER_PORT';
    logger.error(mtlsState.error, { action: 'cluster_tls_listener_failed' });
    return Promise.resolve();
  }
  const app = express();
  app.disable('x-powered-by');
  // The socket address is the caller; no proxy header is believed here.
  app.set('trust proxy', false);
  app.use(CLUSTER_PATH, router);
  app.use((_req, res) => { res.status(404).json({ error: 'Not found' }); });

  const created = https.createServer({
    key: identity.keyPem,
    cert: identity.certPem,
    minVersion: 'TLSv1.3',
    // Every client is asked for its certificate; whether it is acceptable is
    // decided by pin (admit), since no certificate authority is involved.
    requestCert: true,
    rejectUnauthorized: false,
  }, app);
  if (!config.cluster.mtlsProxyProtocol) created.on('secureConnection', admit);
  created.on('tlsClientError', () => { /* failed handshakes: nothing to serve */ });
  created.keepAliveTimeout = 15_000;
  created.headersTimeout = 20_000;
  created.requestTimeout = config.cluster.syncTimeoutMs + 10_000;
  server = created;
  secureContext = tls.createSecureContext({ key: identity.keyPem, cert: identity.certPem, minVersion: 'TLSv1.3' });
  const listening: net.Server = config.cluster.mtlsProxyProtocol ? net.createServer(acceptForwarded) : created;
  if (config.cluster.mtlsProxyProtocol) proxyListener = listening;
  return new Promise((resolve) => {
    listening.listen(config.cluster.mtlsPort, config.cluster.mtlsBindAddress, () => {
      mtlsState.listening = true;
      mtlsState.error = null;
      logger.info(`Cluster channel (mutual TLS) listening on ${config.cluster.mtlsBindAddress}:${config.cluster.mtlsPort}${config.cluster.mtlsProxyProtocol ? ' behind a forwarder' : ''}`, { action: 'cluster_tls_listener_started' });
      resolve();
    });
    listening.on('error', (err) => {
      mtlsState.listening = false;
      mtlsState.error = err.message.split('\n')[0]!.slice(0, 200);
      logger.error('Cluster channel (mutual TLS) failed', { action: 'cluster_tls_listener_failed', message: mtlsState.error });
      server = null;
      proxyListener = null;
      resolve();
    });
  });
}

export function stopMtlsListener(): Promise<void> {
  const active = server;
  server = null;
  proxyListener?.close();
  proxyListener = null;
  mtlsState.listening = false;
  resetClientAgents();
  if (!active) return Promise.resolve();
  return new Promise((resolve) => {
    active.close(() => resolve());
    active.closeIdleConnections();
    setTimeout(() => { active.closeAllConnections(); resolve(); }, 3_000).unref();
  });
}

// ─── Connections handed over by a relay ──────────────────────────────────────
// A relay's connection reaches the listener through a local hand-over
// connection (relayClient.ts); its client address is the one the relay
// reported, recorded here by the local port of that hand-over.

const relayed = new Map<string, { address: string; at: number }>();
const RELAYED_TTL_MS = 60_000;

function normalizeAddress(address: string | undefined): string {
  return (address ?? '').replace(/^::ffff:/, '');
}

export function noteRelayedConnection(localAddress: string | undefined, localPort: number | undefined, clientAddress: string): void {
  if (!localAddress || !localPort) return;
  const now = Date.now();
  for (const [key, entry] of relayed) if (now - entry.at > RELAYED_TTL_MS) relayed.delete(key);
  relayed.set(`${normalizeAddress(localAddress)}|${localPort}`, { address: clientAddress, at: now });
}

// The client address of a connection: as the relay reported it for relayed
// connections, else the socket's own.
export function clientAddressOf(socket: { remoteAddress?: string; remotePort?: number } | null | undefined): string | undefined {
  if (!socket) return undefined;
  const forwarded = forwardedAddresses.get(socket);
  if (forwarded) return forwarded;
  const entry = relayed.get(`${normalizeAddress(socket.remoteAddress)}|${socket.remotePort}`);
  return entry ? entry.address : socket.remoteAddress;
}

// ─── Outgoing ────────────────────────────────────────────────────────────────

export interface PinnedTarget {
  // The first way to reach the node (for messages); `endpoints` lists all.
  url: string;
  pin: string;
  // The pinned certificate itself; fetched and checked against the pin when
  // only the pin is known (an install token, an invite code).
  certPem?: string | null;
  // A previous certificate still accepted for a while after it was replaced.
  previous?: { pin: string; certPem: string } | null;
  // Every way to reach the node, in its order of preference.
  endpoints?: Endpoint[];
}

export class TlsChannelError extends Error {
  constructor(message: string, public readonly code: 'unreachable' | 'pin' | 'too_large' | 'no_identity' = 'unreachable') {
    super(message);
    this.name = 'TlsChannelError';
  }
}

// How long establishing a connection (TCP and TLS) may take on one path
// before the next one is tried.
const CONNECT_TIMEOUT_MS = 3_000;
// A node that answers on a lower-ranked path is offered its preferred paths
// again after this long (a VPN back up, a direct route restored).
const RECHECK_PREFERRED_MS = 5 * 60 * 1000;

function endpointsOf(target: PinnedTarget): Endpoint[] {
  return target.endpoints && target.endpoints.length > 0 ? target.endpoints : [{ url: target.url }];
}

// Per peer certificate: the path that worked last.
const lastGood = new Map<string, { key: string; since: number }>();

function attemptOrder(target: PinnedTarget): Endpoint[] {
  const list = endpointsOf(target);
  const good = lastGood.get(target.pin);
  if (!good) return list;
  const index = list.findIndex((endpoint) => endpointKey(endpoint) === good.key);
  if (index <= 0 || Date.now() - good.since > RECHECK_PREFERRED_MS) return list;
  return [list[index]!, ...list.slice(0, index), ...list.slice(index + 1)];
}

function noteWorked(target: PinnedTarget, endpoint: Endpoint): void {
  const key = endpointKey(endpoint);
  const good = lastGood.get(target.pin);
  if (!good || good.key !== key) lastGood.set(target.pin, { key, since: Date.now() });
}

// The path last used successfully towards the node with this pin.
export function currentPathTo(pin: string): string | null {
  return lastGood.get(pin)?.key ?? null;
}

function describe(endpoint: Endpoint): string {
  return endpoint.sni ? `${endpoint.url} (${endpoint.sni})` : endpoint.url;
}

const probed = new Map<string, { pem: string; at: number }>();

function probeOne(endpoint: Endpoint, pin: string, timeoutMs: number): Promise<string> {
  const target = connectTarget(endpoint);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: target.host,
      port: target.port,
      servername: target.servername,
      minVersion: 'TLSv1.3',
      rejectUnauthorized: false,
      ...(identity ? { key: identity.keyPem, cert: identity.certPem } : {}),
    });
    const timer = setTimeout(() => { socket.destroy(); reject(new TlsChannelError('no answer')); }, Math.min(timeoutMs, CONNECT_TIMEOUT_MS));
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const cert = socket.getPeerX509Certificate();
      socket.end();
      if (!cert) { reject(new TlsChannelError('no certificate presented', 'pin')); return; }
      if (certificatePin(cert) !== pin) { reject(new TlsChannelError('a certificate other than the pinned one was presented', 'pin')); return; }
      resolve(cert.toString());
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new TlsChannelError(err.message.split('\n')[0]!.slice(0, 200)));
    });
  });
}

// Opens a connection only to read the certificate the node presents, and
// returns it if it carries the expected pin. No request is sent.
export async function probeCertificate(target: PinnedTarget, timeoutMs: number): Promise<string> {
  const cached = probed.get(target.pin);
  if (cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached.pem;
  const failures: string[] = [];
  for (const endpoint of attemptOrder(target)) {
    try {
      const pem = await probeOne(endpoint, target.pin, timeoutMs);
      probed.set(target.pin, { pem, at: Date.now() });
      noteWorked(target, endpoint);
      return pem;
    } catch (err) {
      failures.push(`${describe(endpoint)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new TlsChannelError(`the other node cannot be reached (${failures.join('; ')})`);
}

const agents = new Map<string, https.Agent>();

// The pin of the certificate each outgoing connection was verified with,
// recorded at the handshake: a kept-alive connection no longer exposes the
// peer's certificate for later requests.
const serverPins = new WeakMap<object, string>();

class PinRecordingAgent extends https.Agent {
  override createConnection(...args: Parameters<https.Agent['createConnection']>): ReturnType<https.Agent['createConnection']> {
    const socket = super.createConnection(...args) as TLSSocket | null | undefined;
    socket?.once('secureConnect', () => {
      const presented = socket.getPeerX509Certificate();
      if (presented) serverPins.set(socket, certificatePin(presented));
    });
    return socket;
  }
}

function resetClientAgents(): void {
  for (const agent of agents.values()) agent.destroy();
  agents.clear();
}

function agentFor(target: PinnedTarget, endpoint: Endpoint, certPem: string): https.Agent {
  const own = identity;
  if (!own) throw new TlsChannelError('this node has no certificate yet', 'no_identity');
  const accepted = [target.pin, ...(target.previous ? [target.previous.pin] : [])];
  const key = `${endpointKey(endpoint)}|${accepted.join(',')}|${own.pin}`;
  let agent = agents.get(key);
  if (!agent) {
    agent = new PinRecordingAgent({
      keepAlive: true,
      maxSockets: 8,
      // No TLS session resumption: a resumed session skips the certificate
      // check, so every new connection makes a full handshake and is held to
      // the pin again. Kept-alive connections carry the load.
      maxCachedSessions: 0,
      key: own.keyPem,
      cert: own.certPem,
      // The pinned certificate is the only trust anchor.
      ca: [certPem, ...(target.previous ? [target.previous.certPem] : [])],
      minVersion: 'TLSv1.3',
      checkServerIdentity: (_host, cert) => (accepted.includes(certificatePin(cert.raw))
        ? undefined
        : new Error('the other node presented a certificate other than the pinned one')),
    });
    agents.set(key, agent);
  }
  return agent;
}

export interface TlsReply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  // Pin of the certificate the server presented on this connection.
  serverPin: string;
}

interface RequestOptions {
  contentType: string;
  timeoutMs: number;
  maxBytes: number;
}

function requestOnce(target: PinnedTarget, endpoint: Endpoint, certPem: string, path: string, body: Buffer, options: RequestOptions): Promise<TlsReply> {
  const agent = agentFor(target, endpoint, certPem);
  const connect = connectTarget(endpoint);
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = https.request({
      agent,
      host: connect.host,
      port: connect.port,
      servername: connect.servername,
      method: 'POST',
      path: `${CLUSTER_PATH}${path}`,
      headers: { 'content-type': options.contentType, 'content-length': String(body.length) },
    }, (res) => {
      answered = true;
      const serverPin = (res.socket && serverPins.get(res.socket)) || '';
      const declared = Number(res.headers['content-length'] ?? '0');
      if (declared > options.maxBytes) {
        res.destroy();
        reject(new TlsChannelError('answer exceeds the size limit', 'too_large'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxBytes) {
          res.destroy();
          reject(new TlsChannelError('answer exceeds the size limit', 'too_large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), serverPin });
      });
      res.on('error', (err) => reject(new TlsChannelError(err.message.split('\n')[0]!.slice(0, 200))));
    });
    // Establishing a new connection gets a short limit of its own, so a dead
    // path is left quickly for the next one.
    req.on('socket', (socket: TLSSocket) => {
      if (req.reusedSocket) return;
      const timer = setTimeout(() => req.destroy(new TlsChannelError('connection timed out')), Math.min(CONNECT_TIMEOUT_MS, options.timeoutMs));
      socket.once('secureConnect', () => clearTimeout(timer));
      socket.once('close', () => clearTimeout(timer));
    });
    req.setTimeout(options.timeoutMs, () => req.destroy(new TlsChannelError('no answer from the other node')));
    req.on('error', (err) => {
      if (answered) return;
      reject(err instanceof TlsChannelError ? err : new TlsChannelError(err.message.split('\n')[0]!.slice(0, 200)));
    });
    req.end(body);
  });
}

// One request to a pinned node, over the first of its paths that works.
// Only failures to reach it lead to the next path; any answer is final.
export async function requestPinned(target: PinnedTarget, path: string, body: Buffer, options: RequestOptions): Promise<TlsReply> {
  const certPem = target.certPem ?? await probeCertificate(target, options.timeoutMs);
  const failures: string[] = [];
  for (const endpoint of attemptOrder(target)) {
    try {
      const reply = await requestOnce(target, endpoint, certPem, path, body, options);
      noteWorked(target, endpoint);
      return reply;
    } catch (err) {
      if (err instanceof TlsChannelError && (err.code === 'too_large' || err.code === 'no_identity')) throw err;
      failures.push(`${describe(endpoint)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new TlsChannelError(failures.length === 1 ? failures[0]! : `no path to the other node worked (${failures.join('; ')})`);
}

export async function postPinnedJson(
  target: PinnedTarget,
  path: string,
  payload: unknown,
  timeoutMs: number,
): Promise<{ status: number; json: unknown; serverPin: string }> {
  const reply = await requestPinned(target, path, Buffer.from(JSON.stringify(payload), 'utf8'), {
    contentType: 'application/json',
    timeoutMs,
    maxBytes: 65_536,
  });
  let json: unknown = null;
  try {
    json = JSON.parse(reply.body.toString('utf8'));
  } catch {
    json = null;
  }
  return { status: reply.status, json, serverPin: reply.serverPin };
}

// The certificate behind a pin, as the channel saw it (for storing it once a
// pairing that started from a pin alone has completed).
export function certificateForPin(target: PinnedTarget): string | null {
  if (target.certPem) return target.certPem;
  return probed.get(target.pin)?.pem ?? null;
}
