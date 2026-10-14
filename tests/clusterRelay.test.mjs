import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { after, test } from 'node:test';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadTs } from './helpers/loadTs.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rp = await loadTs('src/cluster/relayProtocol.ts');
const x509 = await loadTs('src/cluster/x509.ts');
const relay = await import(pathToFileURL(path.join(REPO, 'deploy/relay/relay.mjs')).href);

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

// A real ClientHello, as a node's TLS client sends it.
function captureClientHello(servername) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.once('data', (data) => { resolve(data); socket.destroy(); server.close(); });
    });
    server.listen(0, '127.0.0.1', () => {
      const client = tls.connect({ host: '127.0.0.1', port: server.address().port, servername, rejectUnauthorized: false, minVersion: 'TLSv1.3' });
      client.on('error', () => {});
    });
  });
}

test('both sides read the server name of a real ClientHello', async () => {
  const hello = await captureClientHello('node-a-1234abcd.pokyh-relay');
  for (const read of [rp.readServerName, relay.readServerName]) {
    assert.deepEqual(read(hello), { status: 'ok', name: 'node-a-1234abcd.pokyh-relay' });
    assert.deepEqual(read(hello.subarray(0, 3)), { status: 'more' });
    assert.deepEqual(read(hello.subarray(0, hello.length - 5)), { status: 'more' });
    assert.deepEqual(read(Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n')), { status: 'invalid' });
    const damaged = Buffer.from(hello);
    damaged.writeUInt16BE(0xffff, 3);
    assert.equal(read(damaged).status, 'invalid');
  }
  const unnamed = await captureClientHello(undefined);
  assert.deepEqual(rp.readServerName(unnamed), { status: 'ok', name: null });
});

test('the relay key the relay writes is the one nodes read', () => {
  const secret = randomBytes(32);
  const cert = relay.createCertificate('relay-test');
  const text = relay.encodeKey({
    name: 'vps1', pin: relay.pinOf(cert.certPem), secret,
    control: ['https://vps.example.org:4100?sni=relay-control.pokyh'], ports: ['https://vps.example.org:4100'], domain: 'cluster.example.org',
  });
  const decoded = rp.decodeRelayKey(text);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.key.name, 'vps1');
  assert.ok(decoded.key.secret.equals(secret));
  assert.equal(decoded.key.pin, x509.certificatePin(cert.certPem), 'the relay\'s certificate pin is computed alike');
  assert.equal(x509.inspectNodeCertificate(cert.certPem).pin, decoded.key.pin, 'the relay\'s certificate is a valid P-256 certificate');
  assert.deepEqual(decoded.key.control, [{ url: 'https://vps.example.org:4100', sni: 'relay-control.pokyh' }]);
  const route = rp.routeName(rp.routeLabel('Node Wien', '3fa2c1d4-0000-4000-8000-000000000000'), decoded.key);
  assert.equal(route, 'node-wien-3fa2c1d4.cluster.example.org');
  assert.deepEqual(rp.relayEndpoints(decoded.key, route, { ports: true, sni: true }).map((e) => (e.sni ? `${e.url}?sni=${e.sni}` : e.url)), [
    `https://vps.example.org:4100?sni=${route}`,
    `https://${route}:443`,
  ]);
  assert.deepEqual(rp.relayEndpoints(decoded.key, route, { ports: false, sni: true }).length, 1);
  assert.equal(rp.decodeRelayKey(`${text.slice(0, -4)}AAAA`).ok, false);
  assert.equal(rp.decodeRelayKey('pokyhnode1.abc').ok, false);
  for (const s of [secret, randomBytes(32)]) {
    const ts = rp.parkProof(s, route, 1700000000000, 'nonce-nonce-nonce-1', 'PIN').toString('base64url');
    const js = relay.parkProof(s, route, 1700000000000, 'nonce-nonce-nonce-1', 'PIN').toString('base64url');
    assert.equal(ts, js, 'the park proof is computed alike on both sides');
  }
});

// ─── The relay itself ────────────────────────────────────────────────────────

function replaying(socket, head) {
  const duplex = new Duplex({
    read() { socket.resume(); },
    write(chunk, _encoding, callback) { socket.write(chunk, callback); },
    final(callback) { socket.end(); callback(); },
    destroy(err, callback) { socket.destroy(err ?? undefined); callback(err); },
  });
  if (head.length > 0) duplex.push(head);
  socket.on('data', (chunk) => { if (!duplex.push(chunk)) socket.pause(); });
  socket.on('end', () => duplex.push(null));
  socket.on('error', (err) => duplex.destroy(err));
  return duplex;
}

function readLine(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(0x0a);
      if (end < 0) return;
      socket.off('data', onData);
      socket.pause();
      resolve({ line: buffer.subarray(0, end).toString(), rest: buffer.subarray(end + 1) });
    };
    socket.on('data', onData);
    socket.once('close', () => reject(new Error('closed')));
    socket.resume();
  });
}

async function startRelay(overrides = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pokyh-relay-test-'));
  dirs.push(dir);
  const settings = {
    dataDir: dir, port: 0, bind: '127.0.0.1', name: 'test', publicEndpoints: ['https://127.0.0.1:4100'], domain: 'cluster.example.org',
    maxRoutes: 16, maxParked: 4, maxSplices: 64, idleMs: 60_000, ...overrides,
  };
  const state = relay.loadOrCreateState(dir, settings);
  const server = relay.createRelay(settings, state);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const key = rp.decodeRelayKey(state.relayKey).key;
  return { server, port, key, dir, state };
}

// A node parking at the relay: as relayClient.ts does it.
async function park(port, key, identity, route, { secret = key.secret, nonce = randomBytes(18).toString('base64url'), t = Date.now(), noCert = false } = {}) {
  const socket = tls.connect({
    host: '127.0.0.1', port, servername: rp.RELAY_CONTROL_NAME, rejectUnauthorized: false, minVersion: 'TLSv1.3',
    ...(noCert ? {} : { key: identity.keyPem, cert: identity.certPem }),
  });
  await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
  assert.equal(x509.certificatePin(socket.getPeerX509Certificate()), key.pin, 'the node checks the relay against the key');
  socket.write(`${JSON.stringify({ op: 'park', route, t, n: nonce, mac: rp.parkProof(secret, route, t, nonce, identity.pin).toString('base64url') })}\n`);
  const reply = JSON.parse((await readLine(socket)).line);
  return { socket, reply, nonce };
}

// What the node does with a handed-over connection: here, serve TLS on it.
function serveHandedOver(socket, identity, onSecure) {
  readLine(socket).then(({ line, rest }) => {
    const go = JSON.parse(line);
    assert.equal(go.op, 'go');
    const server = new tls.TLSSocket(replaying(socket, rest), {
      isServer: true, secureContext: tls.createSecureContext({ key: identity.keyPem, cert: identity.certPem, minVersion: 'TLSv1.3' }),
      requestCert: true, rejectUnauthorized: false,
    });
    server.on('secure', () => onSecure(server, go));
    server.on('error', () => {});
  }).catch(() => {});
}

test('the relay creates its identity once, privately', async () => {
  const { server, dir, state } = await startRelay();
  server.close();
  for (const file of ['relay.key', 'secret', 'relay-key.txt']) assert.equal(statSync(path.join(dir, file)).mode & 0o777, 0o600, file);
  const again = relay.loadOrCreateState(dir, { name: 'test', publicEndpoints: ['https://127.0.0.1:4100'], domain: '' });
  assert.equal(again.pin, state.pin, 'the same identity after a restart');
  assert.ok(again.secret.equals(state.secret));
});

test('a node reached through the relay talks TLS end to end; the relay carries only ciphertext', async () => {
  const { server, port, key } = await startRelay();
  const node = x509.createNodeCertificate('node');
  const caller = x509.createNodeCertificate('caller');
  const route = rp.routeName('node-x', key);
  try {
    const parked = await park(port, key, node, route);
    assert.deepEqual(parked.reply, { ok: true });
    const seen = new Promise((resolve) => serveHandedOver(parked.socket, node, (secure, go) => {
      secure.once('data', (data) => { secure.end(`echo:${data}`); resolve({ go, clientPin: x509.certificatePin(secure.getPeerX509Certificate()) }); });
    }));

    // A recording hop in front of the relay: everything the relay receives.
    const recorded = [];
    const tap = net.createServer((client) => {
      const upstream = net.connect(port, '127.0.0.1');
      client.on('data', (data) => { recorded.push(Buffer.from(data)); upstream.write(data); });
      upstream.on('data', (data) => { recorded.push(Buffer.from(data)); client.write(data); });
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
      client.on('error', () => {});
      upstream.on('error', () => {});
    });
    await new Promise((resolve) => tap.listen(0, '127.0.0.1', resolve));
    const marker = `SECRET-${randomBytes(8).toString('hex')}`;
    const answer = await new Promise((resolve, reject) => {
      const client = tls.connect({
        host: '127.0.0.1', port: tap.address().port, servername: route, minVersion: 'TLSv1.3',
        key: caller.keyPem, cert: caller.certPem, ca: [node.certPem],
        checkServerIdentity: (_h, cert) => (x509.certificatePin(cert.raw) === node.pin ? undefined : new Error('pin')),
      }, () => client.write(marker));
      let text = '';
      client.on('data', (data) => { text += data; });
      client.on('end', () => resolve(text));
      client.on('error', reject);
    });
    tap.close();
    assert.equal(answer, `echo:${marker}`);
    const result = await seen;
    assert.equal(result.clientPin, caller.pin, 'the node sees the caller\'s own certificate: TLS ran end to end');
    assert.match(result.go.from, /127\.0\.0\.1/, 'the relay reports the caller\'s address');
    assert.ok(!Buffer.concat(recorded).includes(marker), 'nothing readable passed the relay');
  } finally {
    server.close();
  }
});

test('the relay refuses nodes without the key, foreign routes, replays and taken routes', async () => {
  const { server, port, key } = await startRelay();
  const node = x509.createNodeCertificate('node');
  const other = x509.createNodeCertificate('other');
  const route = rp.routeName('node-y', key);
  try {
    assert.equal((await park(port, key, node, route, { secret: randomBytes(32) })).reply.error, 'rejected', 'wrong registration secret');
    assert.equal((await park(port, key, node, 'node-y.elsewhere.org')).reply.error, 'protocol', 'route outside the relay\'s names');
    assert.equal((await park(port, key, node, route, { t: Date.now() - 3_600_000 })).reply.error, 'clock');
    const first = await park(port, key, node, route);
    assert.deepEqual(first.reply, { ok: true });
    assert.equal((await park(port, key, node, route, { nonce: first.nonce })).reply.error, 'replay');
    assert.equal((await park(port, key, other, route)).reply.error, 'route-in-use', 'another node cannot take a route in use');
    await assert.rejects(park(port, key, node, route, { noCert: true }).then((r) => { if (!r.reply.ok) throw new Error(r.reply.error); }), /certificate/);
    // A caller for a name nobody registered is dropped without an answer.
    const dropped = await new Promise((resolve) => {
      const client = tls.connect({ host: '127.0.0.1', port, servername: 'nobody.pokyh-relay', rejectUnauthorized: false });
      client.on('error', () => resolve(true));
      client.on('close', () => resolve(true));
      client.on('secureConnect', () => resolve(false));
    });
    assert.equal(dropped, true);
    first.socket.destroy();
  } finally {
    server.close();
  }
});

test('the relay installer, with the relay embedded, is valid shell and pins Docker\'s key', async (t) => {
  const { execFile } = await import('node:child_process');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const run = (file, args) => new Promise((resolve) => execFile(file, args, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
  const template = readFileSync(path.join(REPO, 'deploy/relay/install.sh'), 'utf8');
  const code = readFileSync(path.join(REPO, 'deploy/relay/relay.mjs'), 'utf8');
  assert.ok(!code.includes('POKYH_RELAY_END'), 'the relay cannot end the heredoc early');
  const rendered = template.replace('__POKYH_RELAY__', code.trimEnd());
  assert.match(rendered, /DOCKER_KEY_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88/);
  assert.match(rendered, /--read-only --cap-drop ALL --security-opt no-new-privileges/, 'the relay container runs locked down');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pokyh-relay-sh-'));
  dirs.push(dir);
  const file = path.join(dir, 'pokyh-relay.sh');
  writeFileSync(file, rendered);
  assert.equal((await run('sh', ['-n', file])).code, 0);
  if ((await run('shellcheck', ['--version'])).code === 0) {
    const checked = await run('shellcheck', ['-s', 'sh', file]);
    assert.equal(checked.code, 0, checked.stdout);
  } else {
    t.diagnostic('shellcheck not installed — skipped the lint');
  }
  for (const args of [['--port', 'x'], ['--public'], ['--proxy-only'], ['--host', 'bad host!'], ['--domain', '-x-'], ['--nonsense']]) {
    const result = await run('sh', [file, ...args]);
    assert.notEqual(result.code, 0, args.join(' '));
  }
});
