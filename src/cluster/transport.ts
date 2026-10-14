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
import { packPayload, unpackPayload } from './framing';
import { CLUSTER_PATH, b64, sessionAcceptSchema, sessionInitSchema } from './protocol';
import { peerByNodeId, state, type ClientSession, type PeerRuntime } from './runtime';

// The encrypted request/response channel between two paired nodes.
//
// A node opens a session with a peer by an authenticated ephemeral key
// exchange and then sends sealed frames over plain HTTP POST requests. The
// HTTP layer only moves opaque bytes: confidentiality, integrity, peer
// authentication and replay protection all come from the frame layer, so the
// channel does not depend on TLS being available between two IP addresses —
// and gains a second, independent layer where it runs through an HTTPS
// reverse proxy. Each call's content is compressed and padded (framing.ts)
// before it is sealed.

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
export async function openSession(baseUrl: string, peerNodeId: string, linkKey: Buffer): Promise<ClientSession> {
  const ephemeral = generateEphemeral();
  const init = { from: state.nodeId, to: peerNodeId, e: ephemeral.publicKey, n: randomToken(HANDSHAKE_NONCE_BYTES) };
  const reply = await postJson(baseUrl, '/session', {
    v: 2,
    from: init.from,
    to: init.to,
    e: b64(init.e),
    n: b64(init.n),
    mac: b64(sessionInitMac(linkKey, init)),
  }, config.cluster.requestTimeoutMs);
  if (reply.status !== 200) throw new RpcError('handshake', `session handshake refused (HTTP ${reply.status})`);
  const parsed = sessionAcceptSchema.safeParse(reply.json);
  if (!parsed.success) throw new RpcError('handshake', 'session handshake answer is malformed');
  const accept = { sid: parsed.data.sid, e: parsed.data.e, n: parsed.data.n };
  if (!safeEqual(parsed.data.mac, sessionAcceptMac(linkKey, init, accept))) {
    throw new RpcError('handshake', 'peer could not prove knowledge of the link key');
  }
  const keys = sessionKeys(linkKey, sharedSecret(ephemeral.privateKey, accept.e), init, accept);
  return { sid: accept.sid, c2s: keys.c2s, s2c: keys.s2c, counter: 0n, createdAt: Date.now() };
}

function ensureSession(peer: PeerRuntime): Promise<ClientSession> {
  const current = peer.session;
  if (current && Date.now() - current.createdAt < SESSION_MAX_AGE_MS && current.counter < MAX_FRAMES_PER_SESSION) {
    return Promise.resolve(current);
  }
  peer.session = null;
  if (!peer.handshake) {
    peer.handshake = openSession(peer.baseUrl, peer.nodeId, peer.linkKey)
      .then((session) => {
        peer.session = session;
        return session;
      })
      .finally(() => {
        peer.handshake = null;
      });
  }
  return peer.handshake;
}

// Sends one authenticated, encrypted call to a peer and returns its result.
export async function rpc<T>(peer: PeerRuntime, method: string, params: unknown, timeoutMs = config.cluster.requestTimeoutMs): Promise<T> {
  const plaintext = Buffer.from(JSON.stringify({ m: method, p: params }), 'utf8');
  if (plaintext.length > config.cluster.maxMessageBytes) throw new RpcError('too_large', 'message exceeds the configured size limit');
  const packed = await packPayload(plaintext);

  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await ensureSession(peer);
    const counter = session.counter;
    session.counter += 1n;
    const body = encodeRequest(session.sid, counter, sealFrame(session.c2s, 'c2s', session.sid, counter, packed));
    const res = await fetch(`${peer.baseUrl}${CLUSTER_PATH}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) {
      // The peer no longer knows this session (it restarted, or the session
      // aged out). A fresh handshake settles it.
      if (peer.session === session) peer.session = null;
      continue;
    }
    if (res.status !== 200) throw new RpcError('http', `peer answered HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_FRAME_BYTES) throw new RpcError('too_large', 'answer exceeds the configured size limit');
    const sealed = Buffer.from(await res.arrayBuffer());
    if (sealed.length > MAX_FRAME_BYTES) throw new RpcError('too_large', 'answer exceeds the configured size limit');
    let opened: Buffer;
    try {
      opened = openFrame(session.s2c, 's2c', session.sid, counter, sealed);
    } catch {
      if (peer.session === session) peer.session = null;
      throw new RpcError('integrity', 'answer failed authentication');
    }
    const content = await unpackPayload(opened, config.cluster.maxMessageBytes).catch(() => {
      throw new RpcError('integrity', 'answer could not be unpacked');
    });
    const reply = JSON.parse(content.toString('utf8')) as { ok: boolean; r?: T; e?: string; msg?: string };
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

  const init = { from: body.from, to: body.to, e: body.e, n: body.n };
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

export function sweepSessions(): void {
  const now = Date.now();
  for (const [key, session] of state.serverSessions) {
    if (now - session.lastUsedAt > SESSION_IDLE_MS || now - session.createdAt > SESSION_MAX_AGE_MS * 2) {
      state.serverSessions.delete(key);
    }
  }
}
