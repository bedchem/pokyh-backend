import type { Request, Response } from 'express';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  ReplayWindow,
  SESSION_ID_BYTES,
  decodeRequest,
  encodeRequest,
  generateEphemeral,
  openFrame,
  randomToken,
  safeEqual,
  sealFrame,
  sessionAcceptMac,
  sessionInitMac,
  sessionKeys,
  sharedSecret,
  HANDSHAKE_NONCE_BYTES,
} from './crypto';
import type { ChannelBinding } from './crypto';
import { packPayload, unpackPayload } from './framing';
import { TlsChannelError, ownIdentity, postPinnedJson, requestPinned, type ClientCertificate, type PinnedTarget } from './mtls';
import { CLUSTER_PATH, b64, sessionAcceptSchema, sessionInitSchema } from './protocol';
import { ownPathWays } from './reach';
import { peerByNodeId, state, type Channel, type ClientSession, type PeerRuntime } from './runtime';

// The encrypted request/response channel between two paired nodes.
//
// A node opens a session with a peer by an authenticated ephemeral key
// exchange and then sends sealed frames over HTTP POST requests. The HTTP
// layer only moves opaque bytes: confidentiality, integrity, peer
// authentication and replay protection all come from the frame layer. Each
// call's content is compressed and padded (framing.ts) before it is sealed.
//
// With a pinned certificate for the peer the calls run over the mutually
// authenticated channel (mtls.ts) and the session is bound to the two
// certificates of the connection — a second, independent layer. Until both
// directions have worked there once, a failed attempt falls back to the
// other path for a while; after that the link is locked to the channel and
// nothing else is accepted from that peer or tried towards it — except the
// ways through a node's web proxy that node explicitly offers (reach.ts,
// "proxy-path"): tried only while the channel fails, without certificate
// binding, but with the same end-to-end encryption and authentication.

export class RpcError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'RpcError';
  }
}

export type RpcHandler = (peer: PeerRuntime, method: string, params: unknown) => Promise<unknown>;

let rpcHandler: RpcHandler | null = null;

export function setRpcHandler(handler: RpcHandler): void {
  rpcHandler = handler;
}

// Told when a direction of a link first works over the mutually
// authenticated channel; index.ts locks the link once both have.
export type ChannelHook = (peer: PeerRuntime, direction: 'in' | 'out') => void;

let onChannelVerified: ChannelHook = () => {};

export function setChannelHook(hook: ChannelHook): void {
  onChannelVerified = hook;
}

// How a request reached this node: through which entry point, and with
// which client certificate (mutually authenticated channel only). Set by the
// cluster router.
export interface ChannelContext {
  entry: 'public' | 'dedicated' | 'mtls';
  client: ClientCertificate | null;
}

export function channelContextOf(res: Response): ChannelContext {
  return (res.locals['clusterChannel'] as ChannelContext | undefined) ?? { entry: 'public', client: null };
}

const TLS_RETRY_MS = config.cluster.channelRetrySeconds * 1000;

export function pinnedTargetOf(peer: PeerRuntime): PinnedTarget | null {
  if (!peer.tls) return null;
  const previous = peer.tls.previous && peer.tls.previous.until > Date.now()
    ? { pin: peer.tls.previous.pin, certPem: peer.tls.previous.certPem }
    : null;
  return { url: peer.tls.url, endpoints: peer.tls.endpoints, pin: peer.tls.pin, certPem: peer.tls.certPem, previous };
}

export function pinAccepted(peer: PeerRuntime, pin: string): boolean {
  if (!peer.tls) return false;
  if (peer.tls.pin === pin) return true;
  return Boolean(peer.tls.previous && peer.tls.previous.until > Date.now() && peer.tls.previous.pin === pin);
}

function channelFor(peer: PeerRuntime): Channel {
  if (!peer.tls) return 'plain';
  if (Date.now() >= peer.tlsRetryAt) return 'tls';
  if (!peer.tlsLocked) return 'plain';
  return peer.paths.length > 0 ? 'path' : 'tls';
}

// The ways through the peer's web proxy, the one that worked last first.
function pathOrder(peer: PeerRuntime): string[] {
  return peer.pathActive && peer.paths.includes(peer.pathActive)
    ? [peer.pathActive, ...peer.paths.filter((way) => way !== peer.pathActive)]
    : [...peer.paths];
}

async function openPathSession(peer: PeerRuntime): Promise<ClientSession> {
  const failures: string[] = [];
  for (const way of pathOrder(peer)) {
    try {
      const session = await openSession({ baseUrl: way, nodeId: peer.nodeId, linkKey: peer.linkKey, tls: null });
      peer.pathActive = way;
      return { ...session, channel: 'path' };
    } catch (err) {
      failures.push(`${way}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new RpcError('handshake', `no way through the web proxy works (${failures.join('; ') || 'none offered'})`);
}

function fallBack(peer: PeerRuntime, err: unknown): void {
  peer.tlsRetryAt = Date.now() + TLS_RETRY_MS;
  logger.warn('Cluster channel (mutual TLS) not usable yet for a peer; using the other path for now', {
    action: 'cluster_tls_fallback',
    peer: peer.nodeId,
    message: err instanceof Error ? err.message.split('\n')[0] : String(err),
  });
}

const SESSION_MAX_AGE_MS = 60 * 60 * 1000;
const SESSION_IDLE_MS = 15 * 60 * 1000;
const MAX_SERVER_SESSIONS_PER_PEER = 4;
const MAX_FRAMES_PER_SESSION = 1n << 40n;
// A sealed frame: the padded package plus the authentication tag.
export const MAX_FRAME_BYTES = config.cluster.maxMessageBytes + 2 * 65_536;

// ─── Client side ─────────────────────────────────────────────────────────────

export async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}${CLUSTER_PATH}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json: unknown = null;
  try {
    const text = await res.text();
    if (text.length <= 65_536) json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

// Runs the session handshake against `baseUrl`. Succeeds only when the other
// side proves knowledge of the same link key.
export interface SessionTarget {
  baseUrl: string;
  nodeId: string;
  linkKey: Buffer;
  // Set: the session runs over the mutually authenticated channel.
  tls: PinnedTarget | null;
}

export async function openSession(target: SessionTarget): Promise<ClientSession> {
  const own = ownIdentity();
  if (target.tls && !own) throw new RpcError('handshake', 'this node has no certificate yet');
  const ephemeral = generateEphemeral();
  // The server's certificate is pinned: the channel refuses any other, so the
  // pin is what this side observes.
  const binding: ChannelBinding | undefined = target.tls && own ? { client: own.pin, server: target.tls.pin } : undefined;
  const init = { from: state.nodeId, to: target.nodeId, e: ephemeral.publicKey, n: randomToken(HANDSHAKE_NONCE_BYTES), tls: binding };
  const message = {
    v: binding ? 3 : 2,
    from: init.from,
    to: init.to,
    e: b64(init.e),
    n: b64(init.n),
    mac: b64(sessionInitMac(target.linkKey, init)),
  };
  const reply = target.tls
    ? await postPinnedJson(target.tls, '/session', message, config.cluster.requestTimeoutMs)
    : { ...(await postJson(target.baseUrl, '/session', message, config.cluster.requestTimeoutMs)), serverPin: '' };
  if (reply.status !== 200) throw new RpcError('handshake', `session handshake refused (HTTP ${reply.status})`);
  if (binding && reply.serverPin !== binding.server) throw new RpcError('handshake', 'the other node answered with a certificate other than the pinned one');
  const parsed = sessionAcceptSchema.safeParse(reply.json);
  if (!parsed.success) throw new RpcError('handshake', 'session handshake answer is malformed');
  const accept = { sid: parsed.data.sid, e: parsed.data.e, n: parsed.data.n };
  if (!safeEqual(parsed.data.mac, sessionAcceptMac(target.linkKey, init, accept))) {
    throw new RpcError('handshake', 'peer could not prove knowledge of the link key');
  }
  const keys = sessionKeys(target.linkKey, sharedSecret(ephemeral.privateKey, accept.e), init, accept);
  return { channel: binding ? 'tls' : 'plain', sid: accept.sid, c2s: keys.c2s, s2c: keys.s2c, counter: 0n, createdAt: Date.now() };
}

function ensureSession(peer: PeerRuntime, channel: Channel): Promise<ClientSession> {
  const current = peer.session;
  if (current && current.channel === channel && Date.now() - current.createdAt < SESSION_MAX_AGE_MS && current.counter < MAX_FRAMES_PER_SESSION) {
    return Promise.resolve(current);
  }
  peer.session = null;
  if (!peer.handshake || peer.handshake.channel !== channel) {
    const opening = channel === 'path'
      ? openPathSession(peer)
      : openSession({
        baseUrl: peer.baseUrl,
        nodeId: peer.nodeId,
        linkKey: peer.linkKey,
        tls: channel === 'tls' ? pinnedTargetOf(peer) : null,
      });
    const promise = opening.then((session) => {
      peer.session = session;
      return session;
    });
    const entry = { channel, promise };
    peer.handshake = entry;
    promise.finally(() => { if (peer.handshake === entry) peer.handshake = null; }).catch(() => {});
  }
  return peer.handshake.promise;
}

async function send(peer: PeerRuntime, channel: Channel, body: Buffer, timeoutMs: number): Promise<{ status: number; sealed: Buffer | null }> {
  if (channel === 'tls') {
    try {
      const reply = await requestPinned(pinnedTargetOf(peer)!, '/rpc', body, {
        contentType: 'application/octet-stream',
        timeoutMs,
        maxBytes: MAX_FRAME_BYTES,
      });
      return { status: reply.status, sealed: reply.status === 200 ? reply.body : null };
    } catch (err) {
      if (err instanceof TlsChannelError && err.code === 'too_large') throw new RpcError('too_large', 'answer exceeds the configured size limit');
      throw err;
    }
  }
  const base = channel === 'path' ? peer.pathActive : peer.baseUrl;
  if (!base) throw new RpcError('session', 'no way through the web proxy is in use');
  const res = await fetch(`${base}${CLUSTER_PATH}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(body),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status !== 200) return { status: res.status, sealed: null };
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_FRAME_BYTES) throw new RpcError('too_large', 'answer exceeds the configured size limit');
  const sealed = Buffer.from(await res.arrayBuffer());
  if (sealed.length > MAX_FRAME_BYTES) throw new RpcError('too_large', 'answer exceeds the configured size limit');
  return { status: 200, sealed };
}

// Sends one authenticated, encrypted call to a peer and returns its result.
export async function rpc<T>(peer: PeerRuntime, method: string, params: unknown, timeoutMs = config.cluster.requestTimeoutMs): Promise<T> {
  const plaintext = Buffer.from(JSON.stringify({ m: method, p: params }), 'utf8');
  if (plaintext.length > config.cluster.maxMessageBytes) throw new RpcError('too_large', 'message exceeds the configured size limit');
  const packed = await packPayload(plaintext);

  let channel = channelFor(peer);
  for (let attempt = 0; attempt < 3; attempt++) {
    let session: ClientSession;
    let answer: { status: number; sealed: Buffer | null };
    let counter: bigint;
    try {
      session = await ensureSession(peer, channel);
      counter = session.counter;
      session.counter += 1n;
      const body = encodeRequest(session.sid, counter, sealFrame(session.c2s, 'c2s', session.sid, counter, packed));
      answer = await send(peer, channel, body, timeoutMs);
    } catch (err) {
      // Not locked to the channel yet: whatever went wrong there, the call
      // goes the other way and the channel is tried again later. Locked: only
      // a way through the peer's web proxy it offers, if any.
      if (channel === 'tls' && !(err instanceof RpcError && err.code === 'too_large')) {
        if (!peer.tlsLocked) {
          fallBack(peer, err);
          channel = 'plain';
          continue;
        }
        if (peer.paths.length > 0) {
          fallBack(peer, err);
          channel = 'path';
          continue;
        }
      }
      throw err;
    }
    if (answer.status === 401) {
      // The peer no longer knows this session (it restarted, or the session
      // aged out). A fresh handshake settles it.
      if (peer.session === session) peer.session = null;
      continue;
    }
    if (answer.status !== 200 || !answer.sealed) throw new RpcError('http', `peer answered HTTP ${answer.status}`);
    let opened: Buffer;
    try {
      opened = openFrame(session.s2c, 's2c', session.sid, counter, answer.sealed);
    } catch {
      if (peer.session === session) peer.session = null;
      throw new RpcError('integrity', 'answer failed authentication');
    }
    const content = await unpackPayload(opened, config.cluster.maxMessageBytes).catch(() => {
      throw new RpcError('integrity', 'answer could not be unpacked');
    });
    const reply = JSON.parse(content.toString('utf8')) as { ok: boolean; r?: T; e?: string; msg?: string };
    if (channel === 'tls' && !peer.tlsOutOk) {
      peer.tlsOutOk = true;
      onChannelVerified(peer, 'out');
    }
    if (!reply.ok) throw new RpcError(reply.e ?? 'remote', reply.msg ?? 'peer reported an error');
    return reply.r as T;
  }
  throw new RpcError('session', 'no session could be established');
}

// ─── Server side ─────────────────────────────────────────────────────────────

function refuse(res: Response, status: number): void {
  // Deliberately uniform: an unauthenticated caller learns nothing about why.
  res.status(status).json({ error: status === 404 ? 'Not found' : 'Rejected' });
}

export function handleSession(req: Request, res: Response): void {
  const parsed = sessionInitSchema.safeParse(req.body);
  if (!parsed.success) { refuse(res, 400); return; }
  const body = parsed.data;
  const peer = body.to === state.nodeId ? peerByNodeId(body.from) : undefined;
  if (!peer) { refuse(res, 404); return; }

  // Over the mutually authenticated channel the caller must present the
  // certificate pinned for that peer, and the session is bound to both
  // certificates. A link locked to the channel is accepted nowhere else.
  const context = channelContextOf(res);
  let binding: ChannelBinding | undefined;
  if (context.entry === 'mtls') {
    const own = ownIdentity();
    if (body.v !== 3 || !own || !context.client || !pinAccepted(peer, context.client.pin)) { refuse(res, 403); return; }
    binding = { client: context.client.pin, server: own.pin };
  } else if (body.v !== 2 || (peer.tlsLocked && ownPathWays().length === 0)) {
    // A locked link comes in here only through a way this node offers
    // through its web proxy.
    refuse(res, 403);
    return;
  }

  const init = { from: body.from, to: body.to, e: body.e, n: body.n, tls: binding };
  if (!safeEqual(body.mac, sessionInitMac(peer.linkKey, init))) { refuse(res, 403); return; }

  let keys;
  const ephemeral = generateEphemeral();
  const accept = { sid: randomToken(SESSION_ID_BYTES), e: ephemeral.publicKey, n: randomToken(HANDSHAKE_NONCE_BYTES) };
  try {
    keys = sessionKeys(peer.linkKey, sharedSecret(ephemeral.privateKey, init.e), init, accept);
  } catch {
    refuse(res, 400);
    return;
  }

  const mine = [...state.serverSessions.entries()]
    .filter(([, session]) => session.peerRowId === peer.rowId)
    .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  while (mine.length >= MAX_SERVER_SESSIONS_PER_PEER) state.serverSessions.delete(mine.shift()![0]);

  const now = Date.now();
  state.serverSessions.set(accept.sid.toString('hex'), {
    peerRowId: peer.rowId,
    channelPin: binding ? binding.client : null,
    sid: accept.sid,
    c2s: keys.c2s,
    s2c: keys.s2c,
    replay: new ReplayWindow(),
    createdAt: now,
    lastUsedAt: now,
  });

  res.json({
    sid: b64(accept.sid),
    e: b64(accept.e),
    n: b64(accept.n),
    mac: b64(sessionAcceptMac(peer.linkKey, init, accept)),
  });
  if (binding && !peer.tlsInOk) {
    peer.tlsInOk = true;
    onChannelVerified(peer, 'in');
  }
}

export async function handleRpc(req: Request, res: Response): Promise<void> {
  const decoded = Buffer.isBuffer(req.body) ? decodeRequest(req.body) : null;
  if (!decoded) { refuse(res, 400); return; }
  const key = decoded.sid.toString('hex');
  const session = state.serverSessions.get(key);
  const peer = session ? state.peers.get(session.peerRowId) : undefined;
  if (!session || !peer || Date.now() - session.createdAt > SESSION_MAX_AGE_MS * 2) {
    if (session) state.serverSessions.delete(key);
    refuse(res, 401);
    return;
  }
  // A session is used only over the kind of connection it was opened on —
  // over the channel, only with the very same client certificate.
  const context = channelContextOf(res);
  const presented = context.entry === 'mtls' ? context.client?.pin ?? null : null;
  if (session.channelPin !== presented) { refuse(res, 401); return; }

  let plaintext: Buffer;
  try {
    plaintext = openFrame(session.c2s, 'c2s', session.sid, decoded.counter, decoded.sealed);
  } catch {
    refuse(res, 401);
    return;
  }
  // Checked only after the frame proved authentic, so a forged request can
  // never use up a counter that a genuine one still needs.
  if (!session.replay.accept(decoded.counter)) { refuse(res, 401); return; }
  session.lastUsedAt = Date.now();

  let reply: { ok: true; r: unknown } | { ok: false; e: string; msg: string };
  try {
    const content = await unpackPayload(plaintext, config.cluster.maxMessageBytes);
    const call = JSON.parse(content.toString('utf8')) as { m?: unknown; p?: unknown };
    if (typeof call.m !== 'string' || !rpcHandler) throw new RpcError('bad_request', 'malformed call');
    reply = { ok: true, r: await rpcHandler(peer, call.m, call.p) };
  } catch (err) {
    const code = err instanceof RpcError ? err.code : 'internal';
    if (!(err instanceof RpcError)) {
      logger.warn('Cluster call failed', {
        action: 'cluster_rpc_failed',
        peer: peer.nodeId,
        message: err instanceof Error ? err.message.split('\n')[0] : String(err),
      });
    }
    reply = { ok: false, e: code, msg: err instanceof RpcError ? err.message : 'internal error' };
  }

  const packed = await packPayload(Buffer.from(JSON.stringify(reply), 'utf8'));
  const sealed = sealFrame(session.s2c, 's2c', session.sid, decoded.counter, packed);
  res.status(200).type('application/octet-stream').send(sealed);
}

export function dropSessionsOf(peerRowId: string): void {
  for (const [key, session] of state.serverSessions) {
    if (session.peerRowId === peerRowId) state.serverSessions.delete(key);
  }
}

// Once this node no longer offers a way through its web proxy, sessions that
// locked links opened that way end at once (not when they age out).
export function dropUnpinnedSessionsOfLockedPeers(): number {
  let dropped = 0;
  for (const [key, session] of state.serverSessions) {
    if (session.channelPin !== null) continue;
    const peer = state.peers.get(session.peerRowId);
    if (peer?.tlsLocked) {
      state.serverSessions.delete(key);
      dropped += 1;
    }
  }
  return dropped;
}

export function sweepSessions(): void {
  const now = Date.now();
  for (const [key, session] of state.serverSessions) {
    if (now - session.lastUsedAt > SESSION_IDLE_MS || now - session.createdAt > SESSION_MAX_AGE_MS * 2) {
      state.serverSessions.delete(key);
    }
  }
}
