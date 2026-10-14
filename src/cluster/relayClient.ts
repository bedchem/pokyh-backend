import { randomBytes } from 'crypto';
import net from 'net';
import tls, { type TLSSocket } from 'tls';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { connectTarget, endpointKey, type Endpoint } from './endpoints';
import { ClusterError } from './errors';
import { mtlsState, noteRelayedConnection, ownIdentity } from './mtls';
import { setRelayEndpoints } from './reach';
import { decodeRelayKey, parkProof, relayEndpoints, routeLabel, routeName, type RelayKey } from './relayProtocol';
import { recordEvent, state } from './runtime';
import { unwrapShared, wrapShared } from './store';
import { certificatePin } from './x509';

// This node's side of the Pokyh relays (relayProtocol.ts): for every relay
// the cluster uses, a few connections are kept parked at the relay, each
// proving the registration secret; a connection the relay hands over is
// passed to this node's own mutually authenticated listener, which treats it
// like any other — the certificate pinned for the calling node decides.
//
// Relays come from the replicated `relays` table (added in the admin panel on
// any node, used by all) and from CLUSTER_RELAY_KEYS (this node only). The
// endpoints under which this node is reachable through them are announced to
// the other nodes as soon as a connection is parked, and withdrawn when none
// is left.

const TICK_MS = 1_000;
const RECONCILE_MS = 15_000;
const CONNECT_TIMEOUT_MS = 8_000;
// Parked connections are renewed before a NAT router or firewall on the way
// forgets them.
const RECYCLE_MS = 4 * 60 * 1000;
const MAX_BACKOFF_MS = 60_000;
const LINE_LIMIT = 4096;

interface RelayRuntime {
  pin: string;
  source: 'panel' | 'env';
  rowId: string | null;
  key: RelayKey;
  name: string;
  enabled: boolean;
  usePorts: boolean;
  useSni: boolean;
  route: string;
  parked: Set<TLSSocket>;
  opening: number;
  failures: number;
  retryAt: number;
  lastError: string | null;
  lastParkedAt: number | null;
  handedOver: number;
  goodControl: string | null;
}

const relays = new Map<string, RelayRuntime>();
const unreadable = new Map<string, { rowId: string; name: string; error: string }>();
const parkedSince = new WeakMap<TLSSocket, number>();
const timers: NodeJS.Timeout[] = [];
let onEndpointsChanged: () => void = () => {};

export function setRelayEndpointsHook(hook: () => void): void {
  onEndpointsChanged = hook;
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200);
}

function label(): string {
  return config.cluster.relayLabel || routeLabel(state.nodeName, state.nodeId);
}

// ─── Which relays ────────────────────────────────────────────────────────────

interface Desired {
  source: 'panel' | 'env';
  rowId: string | null;
  key: RelayKey;
  name: string;
  enabled: boolean;
  usePorts: boolean;
  useSni: boolean;
}

export async function reconcileRelays(): Promise<void> {
  const desired = new Map<string, Desired>();
  for (const text of config.cluster.relayKeys) {
    const decoded = decodeRelayKey(text);
    if (!decoded.ok) {
      logger.warn('A relay key in CLUSTER_RELAY_KEYS is unusable', { action: 'cluster_relay_key_invalid', message: decoded.error });
      continue;
    }
    desired.set(decoded.key.pin, { source: 'env', rowId: null, key: decoded.key, name: decoded.key.name, enabled: true, usePorts: true, useSni: true });
  }
  unreadable.clear();
  for (const row of await prisma.relay.findMany({ orderBy: { createdAt: 'asc' } })) {
    if (desired.has(row.relayPin)) continue;
    let key: RelayKey | null = null;
    try {
      const decoded = decodeRelayKey(unwrapShared(row.keyEnc, `relay:${row.relayPin}`).toString('utf8'));
      if (decoded.ok && decoded.key.pin === row.relayPin) key = decoded.key;
    } catch {
      key = null;
    }
    if (!key) {
      unreadable.set(row.relayPin, { rowId: row.id, name: row.name, error: 'The relay key cannot be read on this node — is JWT_SECRET the same on every node?' });
      continue;
    }
    desired.set(row.relayPin, { source: 'panel', rowId: row.id, key, name: row.name || key.name, enabled: row.enabled, usePorts: row.usePorts, useSni: row.useSni });
  }

  for (const [pin, runtime] of relays) {
    if (!desired.has(pin)) {
      closeParked(runtime);
      relays.delete(pin);
    }
  }
  const route = label();
  for (const [pin, want] of desired) {
    const existing = relays.get(pin);
    const routeOf = routeName(route, want.key);
    if (!existing) {
      relays.set(pin, {
        pin, ...want, route: routeOf, parked: new Set(), opening: 0, failures: 0, retryAt: 0,
        lastError: null, lastParkedAt: null, handedOver: 0, goodControl: null,
      });
      continue;
    }
    const keyChanged = existing.key.secret.compare(want.key.secret) !== 0
      || existing.key.control.map(endpointKey).join() !== want.key.control.map(endpointKey).join();
    if (keyChanged || existing.route !== routeOf || (existing.enabled && !want.enabled)) closeParked(existing);
    Object.assign(existing, want, { route: routeOf });
  }
  publishEndpoints();
}

// ─── Parking ─────────────────────────────────────────────────────────────────

function closeParked(runtime: RelayRuntime): void {
  for (const socket of runtime.parked) socket.destroy();
  runtime.parked.clear();
}

function readLine(socket: TLSSocket, timeoutMs: number | null): Promise<{ line: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = timeoutMs ? setTimeout(() => finish(new Error('no answer from the relay')), timeoutMs) : null;
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(0x0a);
      if (end >= 0) finish(null, buffer.subarray(0, end).toString('utf8'), buffer.subarray(end + 1));
      else if (buffer.length > LINE_LIMIT) finish(new Error('the relay sent too much'));
    };
    const onClose = () => finish(new Error('the relay closed the connection'));
    function finish(err: Error | null, line = '', rest = Buffer.alloc(0)) {
      if (timer) clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onClose);
      // Whatever follows the line stays buffered until the next reader (or
      // the hand-over's pipe) takes it.
      socket.pause();
      if (err) reject(err); else resolve({ line, rest });
    }
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onClose);
    socket.resume();
  });
}

function connectControl(runtime: RelayRuntime, endpoint: Endpoint): Promise<TLSSocket> {
  const own = ownIdentity()!;
  const target = connectTarget(endpoint);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: target.host,
      port: target.port,
      servername: target.servername,
      minVersion: 'TLSv1.3',
      // The relay's certificate is checked against the key's pin below,
      // before anything is sent.
      rejectUnauthorized: false,
      key: own.keyPem,
      cert: own.certPem,
    });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('the relay does not answer')); }, CONNECT_TIMEOUT_MS);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const presented = socket.getPeerX509Certificate();
      if (!presented || certificatePin(presented) !== runtime.key.pin) {
        socket.destroy();
        reject(new Error('the relay presented a certificate other than the one in its key'));
        return;
      }
      resolve(socket);
    });
    socket.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function listenerHost(): string {
  const bind = config.cluster.mtlsBindAddress;
  if (bind === '0.0.0.0' || bind === '') return '127.0.0.1';
  if (bind === '::') return '::1';
  return bind;
}

// The relay handed a connection over: pass it to this node's own listener.
function handOver(runtime: RelayRuntime, socket: TLSSocket, rest: Buffer, from: string): void {
  runtime.parked.delete(socket);
  runtime.handedOver += 1;
  const local = net.connect({ host: listenerHost(), port: config.cluster.mtlsPort });
  const close = () => { socket.destroy(); local.destroy(); };
  local.once('connect', () => {
    noteRelayedConnection(local.localAddress, local.localPort, from);
    if (rest.length > 0) local.write(rest);
    socket.pipe(local);
    local.pipe(socket);
  });
  local.once('error', close);
  local.once('close', close);
  socket.once('error', close);
  socket.once('close', close);
}

async function openParked(runtime: RelayRuntime): Promise<void> {
  const own = ownIdentity();
  if (!own) return;
  const order = [...runtime.key.control].sort((a, b) => Number(endpointKey(b) === runtime.goodControl) - Number(endpointKey(a) === runtime.goodControl));
  let socket: TLSSocket | null = null;
  let lastError = 'no way to reach the relay';
  for (const endpoint of order) {
    try {
      socket = await connectControl(runtime, endpoint);
      runtime.goodControl = endpointKey(endpoint);
      break;
    } catch (err) {
      lastError = message(err);
    }
  }
  if (!socket) throw new Error(lastError);

  const nonce = randomBytes(18).toString('base64url');
  const t = Date.now();
  const route = runtime.route;
  socket.write(`${JSON.stringify({ op: 'park', route, t, n: nonce, mac: parkProof(runtime.key.secret, route, t, nonce, own.pin).toString('base64url') })}\n`);
  let reply: { ok?: boolean; error?: string };
  try {
    const { line } = await readLine(socket, CONNECT_TIMEOUT_MS);
    reply = JSON.parse(line) as { ok?: boolean; error?: string };
  } catch (err) {
    socket.destroy();
    throw err;
  }
  if (!reply.ok) {
    socket.destroy();
    const reasons: Record<string, string> = {
      rejected: 'the relay refused the key (registration secret)',
      'route-in-use': `another node is registered as ${route} — set CLUSTER_RELAY_LABEL`,
      clock: 'the clocks of this node and the relay differ too much',
      full: 'the relay is at its limit',
    };
    throw new Error(reasons[reply.error ?? ''] ?? `the relay refused (${reply.error ?? 'unknown'})`);
  }
  if (runtime.parked.size >= config.cluster.relayPoolSize || relays.get(runtime.pin) !== runtime || !runtime.enabled) {
    socket.destroy();
    return;
  }
  socket.setKeepAlive(true, 30_000);
  runtime.parked.add(socket);
  parkedSince.set(socket, Date.now());
  const first = runtime.lastParkedAt === null;
  runtime.lastParkedAt = Date.now();
  runtime.failures = 0;
  runtime.lastError = null;
  if (first) {
    recordEvent('info', `Reachable through relay ${runtime.name || 'relay'} as ${route}`);
    logger.info('Registered at a cluster relay', { action: 'cluster_relay_parked', relay: runtime.name, route });
  }
  publishEndpoints();
  socket.once('close', () => {
    runtime.parked.delete(socket);
    publishEndpoints();
  });
  readLine(socket, null).then(({ line, rest }) => {
    let go: { op?: string; from?: string };
    try { go = JSON.parse(line) as { op?: string; from?: string }; } catch { socket.destroy(); return; }
    if (go.op !== 'go') { socket.destroy(); return; }
    handOver(runtime, socket, rest, typeof go.from === 'string' ? go.from.slice(0, 64) : 'relay');
  }).catch(() => socket.destroy());
}

function tick(): void {
  if (!state.started || !mtlsState.listening || !ownIdentity()) return;
  const now = Date.now();
  for (const runtime of relays.values()) {
    if (!runtime.enabled) continue;
    for (const socket of runtime.parked) {
      if (now - (parkedSince.get(socket) ?? now) > RECYCLE_MS) socket.destroy();
    }
    while (runtime.parked.size + runtime.opening < config.cluster.relayPoolSize && now >= runtime.retryAt) {
      runtime.opening += 1;
      openParked(runtime)
        .catch((err) => {
          runtime.failures += 1;
          runtime.lastError = message(err);
          runtime.retryAt = Date.now() + Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(runtime.failures, 6));
          if (runtime.failures === 1 || runtime.failures % 10 === 0) {
            logger.warn('Cluster relay registration failed', { action: 'cluster_relay_failed', relay: runtime.name, message: runtime.lastError });
          }
          publishEndpoints();
        })
        .finally(() => { runtime.opening -= 1; });
      if (runtime.failures > 0) break;
    }
  }
}

// The endpoints of every relay this node is currently parked at.
function publishEndpoints(): void {
  const list: Endpoint[] = [];
  for (const runtime of relays.values()) {
    if (!runtime.enabled || runtime.parked.size === 0) continue;
    list.push(...relayEndpoints(runtime.key, runtime.route, { ports: runtime.usePorts, sni: runtime.useSni }));
  }
  if (setRelayEndpoints(list)) onEndpointsChanged();
}

export async function startRelays(): Promise<void> {
  await reconcileRelays().catch((err) => logger.warn('Cluster relays could not be loaded', { action: 'cluster_relay_load_failed', message: message(err) }));
  timers.push(setInterval(tick, TICK_MS));
  timers.push(setInterval(() => { void reconcileRelays().catch(() => {}); }, RECONCILE_MS));
}

export function stopRelays(): void {
  for (const timer of timers.splice(0)) clearInterval(timer);
  for (const runtime of relays.values()) closeParked(runtime);
  relays.clear();
  setRelayEndpoints([]);
}

// ─── Administration ──────────────────────────────────────────────────────────

export interface RelayStatus {
  id: string | null;
  pin: string;
  name: string;
  source: 'panel' | 'env';
  enabled: boolean;
  usePorts: boolean;
  useSni: boolean;
  route: string;
  domain: string;
  ports: string[];
  parked: number;
  handedOver: number;
  lastParkedAt: string | null;
  error: string | null;
  endpoints: string[];
}

export function relayStatus(): RelayStatus[] {
  const list: RelayStatus[] = [...relays.values()].map((runtime) => ({
    id: runtime.rowId,
    pin: runtime.pin,
    name: runtime.name,
    source: runtime.source,
    enabled: runtime.enabled,
    usePorts: runtime.usePorts,
    useSni: runtime.useSni,
    route: runtime.route,
    domain: runtime.key.domain,
    ports: runtime.key.ports.map((endpoint) => endpoint.url),
    parked: runtime.parked.size,
    handedOver: runtime.handedOver,
    lastParkedAt: runtime.lastParkedAt ? new Date(runtime.lastParkedAt).toISOString() : null,
    error: runtime.enabled ? runtime.lastError : null,
    endpoints: relayEndpoints(runtime.key, runtime.route, { ports: runtime.usePorts, sni: runtime.useSni }).map((endpoint) => endpoint.sni ? `${endpoint.url}?sni=${endpoint.sni}` : endpoint.url),
  }));
  for (const [pin, entry] of unreadable) {
    list.push({
      id: entry.rowId, pin, name: entry.name, source: 'panel', enabled: false, usePorts: false, useSni: false, route: '', domain: '',
      ports: [], parked: 0, handedOver: 0, lastParkedAt: null, error: entry.error, endpoints: [],
    });
  }
  return list;
}

// Adds a relay for the whole cluster (the row is replicated).
export async function addRelay(text: string, createdBy: string): Promise<{ id: string; name: string }> {
  const decoded = decodeRelayKey(text);
  if (!decoded.ok) throw new ClusterError(decoded.error);
  const key = decoded.key;
  const keyEnc = wrapShared(Buffer.from(text.replace(/\s+/g, ''), 'utf8'), `relay:${key.pin}`);
  const row = await prisma.relay.upsert({
    where: { relayPin: key.pin },
    create: { relayPin: key.pin, name: key.name, keyEnc, createdBy },
    update: { keyEnc, name: key.name },
  });
  await reconcileRelays();
  recordEvent('info', `Relay ${key.name} added; every node registers at it`);
  return { id: row.id, name: row.name };
}

export async function updateRelay(id: string, input: { enabled?: boolean; usePorts?: boolean; useSni?: boolean; name?: string }): Promise<void> {
  const row = await prisma.relay.findUnique({ where: { id } });
  if (!row) throw new ClusterError('Relay not found (relays from CLUSTER_RELAY_KEYS are changed in the env file)', 404);
  await prisma.relay.update({
    where: { id },
    data: {
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.usePorts !== undefined ? { usePorts: input.usePorts } : {}),
      ...(input.useSni !== undefined ? { useSni: input.useSni } : {}),
      ...(input.name !== undefined ? { name: input.name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 60) } : {}),
    },
  });
  await reconcileRelays();
}

export async function removeRelay(id: string): Promise<void> {
  const row = await prisma.relay.findUnique({ where: { id } });
  if (!row) throw new ClusterError('Relay not found (relays from CLUSTER_RELAY_KEYS are removed in the env file)', 404);
  await prisma.relay.delete({ where: { id } });
  await reconcileRelays();
  recordEvent('warn', `Relay ${row.name || 'relay'} removed from the cluster`);
}
