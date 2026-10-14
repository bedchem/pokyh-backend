// Pokyh relay — lets cluster nodes that cannot accept connections from the
// internet (a homelab behind NAT, no VPN) be reached anyway, without ever
// seeing what they exchange. Runs on a server with a public address (a VPS),
// started by deploy/relay/install.sh; no dependency beyond Node.js.
//
// How it works (protocol: src/cluster/relayProtocol.ts):
//   - A node keeps a few TLS connections open to the relay ("parked"),
//     proving with an HMAC that it holds the relay's registration secret and
//     naming the route (a server name) it wants to be reached under.
//   - Anybody connecting to the relay is told nothing until it sends a TLS
//     ClientHello. The relay reads the server name from it — without
//     terminating TLS — and splices the connection onto a parked connection
//     of the node registered under that name. Unknown names are dropped.
//   - The two nodes then run their own mutually authenticated TLS through the
//     relay, end to end. The relay sees only ciphertext; it cannot read,
//     change or impersonate anything, only refuse to carry it.
//
// A relay is a path, not a leader: a cluster may use several, nodes register
// themselves, and every other path between nodes keeps working without it.
//
// Settings (environment):
//   RELAY_DATA     state directory (identity, secret, key)   /data
//   RELAY_PORT     port to listen on                         4100
//   RELAY_BIND     address to listen on                      0.0.0.0
//   RELAY_PUBLIC   how nodes reach it by port, comma separated (https://vps.example.org:4100)
//   RELAY_DOMAIN   domain a proxy forwards on 443 by server name (optional)
//   RELAY_NAME     shown in the admin panel
//   RELAY_MAX_ROUTES, RELAY_MAX_PARKED, RELAY_MAX_SPLICES, RELAY_IDLE_MS

import { X509Certificate, createHash, createHmac, generateKeyPairSync, hkdfSync, randomBytes, sign, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { isIP } from 'node:net';
import net from 'node:net';
import path from 'node:path';
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';

const LABEL = 'pokyh-cluster/v1';
const KEY_PREFIX = 'pokyhrelay1.';
export const CONTROL_NAME = 'relay-control.pokyh';
const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;

const HELLO_TIMEOUT_MS = 10_000;
const CONTROL_LINE_LIMIT = 4096;
const WAIT_FOR_PARKED_MS = 5_000;
const NONCE_TTL_MS = 10 * 60 * 1000;
const MAX_CLOCK_DIFFERENCE_MS = 5 * 60 * 1000;
const NEW_CONNECTIONS_PER_IP = 200;
const RATE_WINDOW_MS = 10_000;

function intEnv(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

export const isServerName = (value) => HOSTNAME.test(value) && isIP(value) === 0;

function log(level, message, fields = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), level, message, ...fields })}\n`);
}

// ─── Certificate (mirror of src/cluster/x509.ts) ─────────────────────────────

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let value = n; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
const sequence = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const encoded = [part & 0x7f];
    for (let value = Math.floor(part / 128); value > 0; value = Math.floor(value / 128)) encoded.unshift((value & 0x7f) | 0x80);
    bytes.push(...encoded);
  }
  return tlv(0x06, Buffer.from(bytes));
}
function unsignedInteger(bytes) {
  let value = bytes;
  while (value.length > 1 && value[0] === 0 && (value[1] & 0x80) === 0) value = value.subarray(1);
  if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
  return tlv(0x02, value);
}
function time(date) {
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  const year = date.getUTCFullYear();
  const rest = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return year < 2050 ? tlv(0x17, Buffer.from(`${pad(year % 100)}${rest}`)) : tlv(0x18, Buffer.from(`${pad(year, 4)}${rest}`));
}

export function createCertificate(commonName) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const notBefore = new Date(Math.floor(Date.now() / 1000) * 1000 - 3600_000);
  const notAfter = new Date(notBefore.getTime() + 3650 * 24 * 3600_000);
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x01;
  const algorithm = sequence(oid('1.2.840.10045.4.3.2'));
  const name = sequence(set(sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName)))));
  const tbs = sequence(
    tlv(0xa0, unsignedInteger(Buffer.from([2]))), unsignedInteger(serial), algorithm, name,
    sequence(time(notBefore), time(notAfter)), name, spki,
    tlv(0xa3, sequence(
      sequence(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, sequence())),
      sequence(oid('2.5.29.15'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, tlv(0x03, Buffer.from([0x07, 0x80])))),
      sequence(oid('2.5.29.37'), tlv(0x04, sequence(oid('1.3.6.1.5.5.7.3.1'), oid('1.3.6.1.5.5.7.3.2')))),
    )),
  );
  const der = sequence(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, privateKey)])));
  const certPem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { certPem, keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

export function pinOf(certificate) {
  const x509 = certificate instanceof X509Certificate ? certificate : new X509Certificate(certificate);
  return createHash('sha256').update(x509.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
}

// ─── Protocol (mirror of src/cluster/relayProtocol.ts) ───────────────────────

function fields(parts) {
  return Buffer.concat(parts.flatMap((part) => {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length, 0);
    return [length, bytes];
  }));
}

export function parkProof(secret, route, timestamp, nonce, nodePin) {
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), Buffer.from(`${LABEL}/relay/park`, 'utf8'), 32));
  return createHmac('sha256', key).update(fields(['park', route, String(timestamp), nonce, nodePin])).digest();
}

export function encodeKey({ name, pin, secret, control, ports, domain }) {
  const body = { v: 1, n: name, f: pin, s: secret.toString('base64url'), c: control, p: ports, d: domain };
  return KEY_PREFIX + Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

export function readServerName(data) {
  if (data.length < 5) return { status: 'more' };
  if (data[0] !== 0x16 || data[1] !== 0x03) return { status: 'invalid' };
  const recordLength = data.readUInt16BE(3);
  if (recordLength < 4 || recordLength > 16_384) return { status: 'invalid' };
  if (data.length < 5 + recordLength) return { status: 'more' };
  const record = data.subarray(5, 5 + recordLength);
  if (record[0] !== 0x01) return { status: 'invalid' };
  const helloLength = (record[1] << 16) | (record[2] << 8) | record[3];
  if (4 + helloLength > record.length) return { status: 'invalid' };
  const hello = record.subarray(4, 4 + helloLength);
  let at = 2 + 32;
  const skip = (lengthBytes) => {
    if (at + lengthBytes > hello.length) return false;
    const length = lengthBytes === 1 ? hello[at] : hello.readUInt16BE(at);
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
        const nameType = hello[entry];
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

// ─── State ───────────────────────────────────────────────────────────────────

export function loadOrCreateState(dir, settings) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = (name) => path.join(dir, name);
  const write = (name, text) => {
    fs.writeFileSync(`${file(name)}.tmp`, text, { mode: 0o600 });
    fs.renameSync(`${file(name)}.tmp`, file(name));
  };
  if (!fs.existsSync(file('relay.key')) || !fs.existsSync(file('relay.crt'))) {
    const created = createCertificate(`pokyh-relay-${randomBytes(6).toString('hex')}`);
    write('relay.key', created.keyPem);
    write('relay.crt', created.certPem);
  }
  if (!fs.existsSync(file('secret'))) write('secret', `${randomBytes(32).toString('base64url')}\n`);
  const keyPem = fs.readFileSync(file('relay.key'), 'utf8');
  const certPem = fs.readFileSync(file('relay.crt'), 'utf8');
  const secret = Buffer.from(fs.readFileSync(file('secret'), 'utf8').trim(), 'base64url');
  if (secret.length !== 32) throw new Error('the stored secret is damaged');
  const pin = pinOf(certPem);
  const control = [
    ...settings.publicEndpoints.map((url) => `${url}?sni=${CONTROL_NAME}`),
    ...(settings.domain ? [`https://relay-control.${settings.domain}:443`] : []),
  ];
  const relayKey = encodeKey({ name: settings.name, pin, secret, control, ports: settings.publicEndpoints, domain: settings.domain });
  write('relay-key.txt', `${relayKey}\n`);
  return { keyPem, certPem, secret, pin, relayKey };
}

// ─── Relay ───────────────────────────────────────────────────────────────────

// A stream that first replays the bytes already read from a socket, then
// carries the socket on: lets a TLS server take over a connection whose
// ClientHello has been inspected.
function replaying(socket, head) {
  const duplex = new Duplex({
    read() { socket.resume(); },
    write(chunk, _encoding, callback) { socket.write(chunk, callback); },
    final(callback) { socket.end(); callback(); },
    destroy(err, callback) { socket.destroy(err ?? undefined); callback(err); },
  });
  duplex.push(head);
  socket.on('data', (chunk) => { if (!duplex.push(chunk)) socket.pause(); });
  socket.on('end', () => duplex.push(null));
  socket.on('error', (err) => duplex.destroy(err));
  socket.on('close', () => duplex.destroy());
  return duplex;
}

function readLine(stream, limit, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(0x0a);
      if (end >= 0) finish(null, buffer.subarray(0, end).toString('utf8'), buffer.subarray(end + 1));
      else if (buffer.length > limit) finish(new Error('line too long'));
    };
    const onEnd = () => finish(new Error('closed'));
    function finish(err, line, rest) {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onEnd);
      if (err) reject(err); else resolve({ line, rest });
    }
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onEnd);
  });
}

export function createRelay(settings, state) {
  const routes = new Map();
  const nonces = new Map();
  const perIp = new Map();
  let splices = 0;
  const secureContext = tls.createSecureContext({ key: state.keyPem, cert: state.certPem, minVersion: 'TLSv1.3' });
  const controlNames = new Set([CONTROL_NAME, ...(settings.domain ? [`relay-control.${settings.domain}`] : [])]);
  const routeSuffix = settings.domain ? `.${settings.domain}` : null;

  function allowedRoute(name) {
    if (!isServerName(name) || controlNames.has(name)) return false;
    return name.endsWith('.pokyh-relay') || (routeSuffix !== null && name.endsWith(routeSuffix));
  }

  function rateLimited(address) {
    const now = Date.now();
    if (perIp.size > 50_000) {
      for (const [key, value] of perIp) if (now - value.since > RATE_WINDOW_MS) perIp.delete(key);
    }
    const entry = perIp.get(address);
    if (!entry || now - entry.since > RATE_WINDOW_MS) { perIp.set(address, { since: now, count: 1 }); return false; }
    entry.count += 1;
    return entry.count > NEW_CONNECTIONS_PER_IP;
  }

  async function park(socket, head) {
    const control = new tls.TLSSocket(replaying(socket, head), {
      isServer: true, secureContext, requestCert: true, rejectUnauthorized: false,
    });
    control.on('error', () => control.destroy());
    const refuse = (error) => { control.end(`${JSON.stringify({ ok: false, error })}\n`); };
    try {
      await new Promise((resolve, reject) => {
        control.once('secure', resolve);
        control.once('error', reject);
        setTimeout(() => reject(new Error('timeout')), HELLO_TIMEOUT_MS);
      });
      const presented = control.getPeerX509Certificate();
      if (!presented) { refuse('certificate'); return; }
      const nodePin = pinOf(presented);
      const { line, rest } = await readLine(control, CONTROL_LINE_LIMIT, HELLO_TIMEOUT_MS);
      if (rest.length > 0) { refuse('protocol'); return; }
      let message;
      try { message = JSON.parse(line); } catch { refuse('protocol'); return; }
      const { op, route, t, n, mac } = message ?? {};
      if (op !== 'park' || typeof route !== 'string' || !allowedRoute(route) || !Number.isInteger(t)
        || typeof n !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(n) || typeof mac !== 'string') { refuse('protocol'); return; }
      const expected = parkProof(state.secret, route, t, n, nodePin);
      const presentedMac = Buffer.from(mac, 'base64url');
      if (presentedMac.length !== expected.length || !timingSafeEqual(presentedMac, expected)) {
        log('warn', 'park refused: wrong registration proof', { route });
        refuse('rejected');
        return;
      }
      if (Math.abs(Date.now() - t) > MAX_CLOCK_DIFFERENCE_MS) { refuse('clock'); return; }
      const now = Date.now();
      for (const [value, at] of nonces) if (now - at > NONCE_TTL_MS) nonces.delete(value);
      if (nonces.has(n)) { refuse('replay'); return; }
      nonces.set(n, now);

      let entry = routes.get(route);
      if (entry && entry.pin !== nodePin && entry.parked.size > 0) { refuse('route-in-use'); return; }
      if (!entry) {
        if (routes.size >= settings.maxRoutes) { refuse('full'); return; }
        entry = { pin: nodePin, parked: new Set(), waiting: [] };
        routes.set(route, entry);
      }
      entry.pin = nodePin;
      if (entry.parked.size >= settings.maxParked) { refuse('full'); return; }
      control.write(`${JSON.stringify({ ok: true })}\n`);
      control.setKeepAlive?.(true, 30_000);
      socket.setKeepAlive(true, 30_000);
      entry.parked.add(control);
      const waiter = entry.waiting.shift();
      if (waiter) waiter();
      control.once('close', () => {
        entry.parked.delete(control);
        if (entry.parked.size === 0 && entry.waiting.length === 0) setTimeout(() => {
          if (routes.get(route) === entry && entry.parked.size === 0) routes.delete(route);
        }, 60_000).unref();
      });
      // A parked connection only waits; anything it sends ends it.
      control.once('data', () => { if (!control.spliced) control.destroy(); });
    } catch {
      control.destroy();
    }
  }

  function takeParked(entry) {
    for (const candidate of entry.parked) {
      entry.parked.delete(candidate);
      if (!candidate.destroyed) return candidate;
    }
    return null;
  }

  async function route(socket, head, name, address) {
    const entry = routes.get(name);
    if (!entry) { socket.destroy(); return; }
    let parked = takeParked(entry);
    if (!parked) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, WAIT_FOR_PARKED_MS);
        entry.waiting.push(() => { clearTimeout(timer); resolve(); });
      });
      parked = takeParked(entry);
    }
    if (!parked || socket.destroyed) { socket.destroy(); parked?.destroy(); return; }
    if (splices >= settings.maxSplices) { socket.destroy(); parked.destroy(); return; }
    splices += 1;
    parked.spliced = true;
    parked.removeAllListeners('data');
    parked.write(`${JSON.stringify({ op: 'go', from: address })}\n`);
    parked.write(head);
    socket.pipe(parked);
    parked.pipe(socket);
    socket.resume();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      splices -= 1;
      socket.destroy();
      parked.destroy();
    };
    socket.setTimeout(settings.idleMs, close);
    parked.setTimeout?.(settings.idleMs, close);
    socket.once('close', close);
    socket.once('error', close);
    parked.once('close', close);
    parked.once('error', close);
  }

  function accept(socket) {
    const address = socket.remoteAddress ?? '';
    if (rateLimited(address)) { socket.destroy(); return; }
    socket.setNoDelay(true);
    let head = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const result = readServerName(head);
      if (result.status === 'more') return;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.pause();
      if (result.status !== 'ok' || !result.name) { socket.destroy(); return; }
      if (controlNames.has(result.name)) void park(socket, head);
      else if (allowedRoute(result.name)) void route(socket, head, result.name, address);
      else socket.destroy();
    };
    socket.on('data', onData);
    socket.on('error', () => socket.destroy());
  }

  const server = net.createServer({ pauseOnConnect: false }, accept);
  server.status = () => ({
    routes: [...routes.entries()].map(([name, entry]) => ({ name, parked: entry.parked.size })),
    splices,
  });
  return server;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export function settingsFromEnv(env = process.env) {
  const publicEndpoints = (env.RELAY_PUBLIC ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  for (const endpoint of publicEndpoints) {
    const url = new URL(endpoint);
    const port = /^https:\/\/[^/:?#@]+:(\d{1,5})$/i.exec(endpoint)?.[1];
    if (url.protocol !== 'https:' || !port || `https://${url.hostname}:${port}` !== endpoint) throw new Error(`RELAY_PUBLIC entry is not https://host:port: ${endpoint}`);
  }
  const domain = (env.RELAY_DOMAIN ?? '').trim().toLowerCase();
  if (domain && !isServerName(domain)) throw new Error('RELAY_DOMAIN is not a domain name');
  if (publicEndpoints.length === 0 && !domain) throw new Error('Set RELAY_PUBLIC and/or RELAY_DOMAIN');
  return {
    dataDir: env.RELAY_DATA || '/data',
    port: intEnv('RELAY_PORT', 4100, 1, 65_535),
    bind: env.RELAY_BIND || '0.0.0.0',
    name: (env.RELAY_NAME || 'relay').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 60) || 'relay',
    publicEndpoints,
    domain,
    maxRoutes: intEnv('RELAY_MAX_ROUTES', 256, 1, 10_000),
    maxParked: intEnv('RELAY_MAX_PARKED', 16, 1, 256),
    maxSplices: intEnv('RELAY_MAX_SPLICES', 2048, 1, 100_000),
    idleMs: intEnv('RELAY_IDLE_MS', 15 * 60 * 1000, 10_000, 24 * 3600 * 1000),
  };
}

export async function main() {
  const settings = settingsFromEnv();
  const state = loadOrCreateState(settings.dataDir, settings);
  const server = createRelay(settings, state);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(settings.port, settings.bind, resolve);
  });
  log('info', 'relay listening', { port: settings.port, bind: settings.bind, pin: state.pin, keyFile: path.join(settings.dataDir, 'relay-key.txt') });
  const stop = () => { server.close(); setTimeout(() => process.exit(0), 1000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log('error', 'relay could not start', { message: err.message });
    process.exit(1);
  });
}
