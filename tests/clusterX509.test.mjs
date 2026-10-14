import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { X509Certificate, createPublicKey } from 'node:crypto';
import https from 'node:https';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const x509 = await loadTs('src/cluster/x509.ts');

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, (error, stdout) => resolve({ code: error ? error.code : 0, stdout }));
  });
}

async function server(identity, onRequest = (req, res) => res.end('ok')) {
  const srv = https.createServer({ key: identity.keyPem, cert: identity.certPem, minVersion: 'TLSv1.3', requestCert: true, rejectUnauthorized: false }, onRequest);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { srv, port: srv.address().port };
}

// The client side exactly as mtls.ts configures it: the pinned certificate is
// the only trust anchor and its pin is checked again.
function pinnedCall(port, client, serverCertPem, expectedPin) {
  return new Promise((resolve) => {
    const req = https.request({
      host: '127.0.0.1', port, method: 'POST', path: '/', agent: false, minVersion: 'TLSv1.3',
      key: client.keyPem, cert: client.certPem, ca: [serverCertPem],
      checkServerIdentity: (_host, cert) => (x509.certificatePin(cert.raw) === expectedPin ? undefined : new Error('pin mismatch')),
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (err) => resolve({ error: err.message }));
    req.end('request-body');
  });
}

test('a node certificate is a self-signed P-256 end-entity certificate for both TLS roles', () => {
  const cert = x509.createNodeCertificate('pokyh-node-test');
  const parsed = new X509Certificate(cert.certPem);
  assert.equal(parsed.subject, 'CN=pokyh-node-test');
  assert.equal(parsed.issuer, 'CN=pokyh-node-test');
  assert.ok(parsed.verify(parsed.publicKey), 'self-signed');
  assert.equal(parsed.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
  assert.equal(parsed.ca, false, 'not a certificate authority');
  assert.match(parsed.keyUsage?.join(',') ?? '', /1\.3\.6\.1\.5\.5\.7\.3\.1/, 'server authentication');
  assert.match(parsed.keyUsage?.join(',') ?? '', /1\.3\.6\.1\.5\.5\.7\.3\.2/, 'client authentication');
  assert.match(cert.pin, x509.PIN_PATTERN);
  assert.ok(createPublicKey(cert.keyPem).export({ type: 'spki', format: 'der' })
    .equals(parsed.publicKey.export({ type: 'spki', format: 'der' })), 'key belongs to the certificate');
  assert.ok(new Date(parsed.validTo).getTime() - Date.now() > 9 * 365 * 24 * 3600 * 1000);
});

test('every certificate has its own key, serial and pin', () => {
  const a = x509.createNodeCertificate('a');
  const b = x509.createNodeCertificate('a');
  assert.notEqual(a.pin, b.pin);
  assert.notEqual(new X509Certificate(a.certPem).serialNumber, new X509Certificate(b.certPem).serialNumber);
});

test('inspecting a certificate yields its pin and refuses anything else', () => {
  const cert = x509.createNodeCertificate('ok');
  assert.equal(x509.inspectNodeCertificate(cert.certPem).pin, cert.pin);
  assert.throws(() => x509.inspectNodeCertificate('not a certificate'), /cannot be parsed/);
  assert.throws(() => x509.inspectNodeCertificate('x'.repeat(5000)), /too long/);
  // A changed byte inside the signed part breaks the self-signature.
  const der = new X509Certificate(cert.certPem).raw;
  const tampered = Buffer.from(der);
  tampered[tampered.length - 80] ^= 0x01;
  const pem = `-----BEGIN CERTIFICATE-----\n${tampered.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  assert.throws(() => x509.inspectNodeCertificate(pem), /self-signed|parsed/);
  // Outside its validity period.
  const old = x509.createNodeCertificate('old', 1, new Date(Date.now() - 10 * 24 * 3600 * 1000));
  assert.throws(() => x509.inspectNodeCertificate(old.certPem), /validity/);
});

test('mutual TLS with pinned certificates admits exactly the pinned client', async () => {
  const a = x509.createNodeCertificate('a');
  const b = x509.createNodeCertificate('b');
  const stranger = x509.createNodeCertificate('stranger');
  const seen = [];
  const { srv, port } = await server(a, (req, res) => {
    const presented = req.socket.getPeerX509Certificate();
    seen.push(presented ? x509.certificatePin(presented) : null);
    res.end(req.socket.getProtocol());
  });
  try {
    const ok = await pinnedCall(port, b, a.certPem, a.pin);
    assert.equal(ok.body, 'TLSv1.3');
    const unknown = await pinnedCall(port, stranger, a.certPem, a.pin);
    assert.equal(unknown.status, 200);
    assert.deepEqual(seen, [b.pin, stranger.pin], 'the server sees exactly which certificate each client holds');
  } finally {
    srv.close();
  }
});

test('a server with another certificate is refused before any request data is sent', async () => {
  const real = x509.createNodeCertificate('real');
  const impostor = x509.createNodeCertificate('impostor');
  const client = x509.createNodeCertificate('client');
  let reached = 0;
  const { srv, port } = await server(impostor, (req, res) => { reached++; res.end('stolen'); });
  try {
    // Pinned to the real node; the impostor presents its own certificate.
    const withRealAnchor = await pinnedCall(port, client, real.certPem, real.pin);
    assert.ok(withRealAnchor.error, 'connection must fail');
    // Even if the impostor's certificate were accepted as anchor, the pin check stops it.
    const withImpostorAnchor = await pinnedCall(port, client, impostor.certPem, real.pin);
    assert.match(withImpostorAnchor.error ?? '', /pin mismatch/);
    assert.equal(reached, 0, 'no request reached the impostor');
  } finally {
    srv.close();
  }
});

test('the pin is the one curl --pinnedpubkey checks', { skip: process.platform === 'win32' }, async (t) => {
  const probe = await run('curl', ['--version']);
  if (probe.code !== 0) { t.skip('curl not available'); return; }
  const node = x509.createNodeCertificate('curl');
  const other = x509.createNodeCertificate('other');
  const { srv, port } = await server(node, (req, res) => res.end('script'));
  try {
    const right = await run('curl', ['-fsSk', '--max-time', '5', '--pinnedpubkey', `sha256//${node.pin}`, `https://127.0.0.1:${port}/`]);
    assert.equal(right.code, 0);
    assert.equal(right.stdout, 'script');
    const wrong = await run('curl', ['-fsSk', '--max-time', '5', '--pinnedpubkey', `sha256//${other.pin}`, `https://127.0.0.1:${port}/`]);
    assert.equal(wrong.code, 90, 'curl refuses a different public key even with -k');
  } finally {
    srv.close();
  }
});

test('without session resumption every new connection is held to the pin again', async () => {
  const node = x509.createNodeCertificate('node');
  const client = x509.createNodeCertificate('client');
  const { srv, port } = await server(node, (req, res) => res.end('ok'));
  srv.keepAliveTimeout = 30;
  let checks = 0;
  // As mtls.ts builds its agents.
  const agent = new https.Agent({
    keepAlive: true, maxCachedSessions: 0, key: client.keyPem, cert: client.certPem, ca: [node.certPem], minVersion: 'TLSv1.3',
    checkServerIdentity: (_host, cert) => { checks++; return x509.certificatePin(cert.raw) === node.pin ? undefined : new Error('pin'); },
  });
  try {
    for (let i = 0; i < 3; i++) {
      const seen = await new Promise((resolve, reject) => {
        const req = https.request({ host: '127.0.0.1', port, method: 'POST', path: '/', agent }, (res) => {
          const presented = res.socket.getPeerX509Certificate();
          res.resume();
          res.on('end', () => resolve({ reused: res.socket?.isSessionReused?.() ?? false, pin: presented ? x509.certificatePin(presented) : null }));
        });
        req.on('error', reject);
        req.end('x');
      });
      assert.equal(seen.pin, node.pin, `connection ${i + 1} shows the server certificate`);
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    assert.equal(checks, 3, 'the pin was checked on every new connection');
  } finally {
    agent.destroy();
    srv.close();
  }
});
