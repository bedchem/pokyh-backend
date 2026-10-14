import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadTs } from './helpers/loadTs.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = await loadTs('src/cluster/installToken.ts');
const shared = await loadTs('src/cluster/sharedEnv.ts');
const tarball = await loadTs('src/cluster/tarball.ts');
const invite = await loadTs('src/cluster/invite.ts');
const x509 = await loadTs('src/cluster/x509.ts');
const bootstrap = await import(pathToFileURL(path.join(REPO, 'deploy/node/bootstrap.mjs')).href);

function run(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

const node = x509.createNodeCertificate('inviting');

function sampleToken(overrides = {}) {
  return {
    url: 'https://node1.example.org:4100',
    pin: node.pin,
    nodeId: '6f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f',
    id: randomUUID(),
    secret: token.newInstallSecret(),
    expiresAt: new Date(Date.now() + 30 * 60_000),
    ...overrides,
  };
}

function samplePayload(t, overrides = {}) {
  return {
    v: 1,
    t: Date.now(),
    node: { name: 'Graz 2', domain: 'node2.example.org', withAi: false, acmeEmail: 'ops@example.org' },
    env: { JWT_SECRET: 'j'.repeat(40), API_KEY: 'k'.repeat(30), ADMIN_PASSWORD_HASH: '$2b$12$abc$def' },
    bundle: { sha256: 'a'.repeat(64), bytes: 1234 },
    cluster: { url: t.url, nodeId: t.nodeId, name: 'Graz', cert: node.certPem, pairingUntil: Math.floor(Date.now() / 1000) + 3600 },
    ...overrides,
  };
}

// ─── Token ───────────────────────────────────────────────────────────────────

test('an install token carries channel, pin, ids, secret and expiry intact', () => {
  const original = sampleToken();
  const encoded = token.encodeInstallToken(original);
  assert.match(encoded, /^pokyhnode1\.[A-Za-z0-9_-]+$/, 'safe inside single quotes in a shell command');
  const decoded = token.decodeInstallToken(`  ${encoded.slice(0, 20)}\n${encoded.slice(20)} `);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.token.url, original.url);
  assert.equal(decoded.token.pin, original.pin);
  assert.equal(decoded.token.id, original.id);
  assert.ok(decoded.token.secret.equals(original.secret));
});

test('a damaged, foreign or expired token is refused', () => {
  const good = sampleToken();
  const encode = (body) => `pokyhnode1.${Buffer.from(JSON.stringify(body)).toString('base64url')}`;
  const body = JSON.parse(Buffer.from(token.encodeInstallToken(good).slice(11), 'base64url').toString());
  assert.equal(token.decodeInstallToken('pokyh1.abc').ok, false);
  assert.equal(token.decodeInstallToken(encode({ ...body, a: 'http://node1.example.org:4100' })).ok, false, 'plain http');
  assert.equal(token.decodeInstallToken(encode({ ...body, a: 'https://node1.example.org' })).ok, false, 'no explicit port');
  assert.equal(token.decodeInstallToken(encode({ ...body, a: 'https://node1.example.org:4100/x' })).ok, false, 'with a path');
  assert.equal(token.decodeInstallToken(encode({ ...body, f: 'short' })).ok, false, 'bad pin');
  assert.equal(token.decodeInstallToken(encode({ ...body, s: 'tooshort' })).ok, false, 'bad secret');
  assert.equal(token.decodeInstallToken(encode({ ...body, v: 2 })).ok, false, 'other version');
  const expired = token.decodeInstallToken(token.encodeInstallToken({ ...good, expiresAt: new Date(Date.now() - 1000) }));
  assert.equal(expired.ok, false);
  assert.match(expired.error, /expired/);
});

// ─── Keys, proof and sealing ─────────────────────────────────────────────────

test('the bootstrap on the new server derives exactly the keys of the inviting node', () => {
  const t = sampleToken();
  const server = token.deriveInstallKeys(t.secret, t.id);
  const client = bootstrap.deriveKeys(t.secret, t.id);
  assert.ok(server.auth.equals(client.auth));
  assert.ok(server.enc.equals(client.enc));
  assert.equal(server.pairSecret, client.pairSecret);
  assert.match(server.pairSecret, /^[A-Za-z0-9_-]{43}$/, 'the format of an invite secret');
  assert.ok(!server.auth.equals(server.enc), 'separate keys per purpose');
  const decoded = bootstrap.decodeToken(token.encodeInstallToken(t));
  assert.equal(decoded.id, t.id);
  assert.equal(decoded.pin, t.pin);
});

test('a proof is bound to purpose, install, time and nonce', () => {
  const t = sampleToken();
  const keys = token.deriveInstallKeys(t.secret, t.id);
  const now = Date.now();
  const presented = bootstrap.proof(keys.auth, 'provision', t.id, now, 'nonce-aaaaaaaaaaaaaaaaaaaa').toString('base64url');
  assert.ok(token.proofMatches(token.installProof(keys.auth, 'provision', t.id, now, 'nonce-aaaaaaaaaaaaaaaaaaaa'), presented));
  assert.ok(!token.proofMatches(token.installProof(keys.auth, 'bundle', t.id, now, 'nonce-aaaaaaaaaaaaaaaaaaaa'), presented), 'purpose');
  assert.ok(!token.proofMatches(token.installProof(keys.auth, 'provision', randomUUID(), now, 'nonce-aaaaaaaaaaaaaaaaaaaa'), presented), 'install');
  assert.ok(!token.proofMatches(token.installProof(keys.auth, 'provision', t.id, now + 1, 'nonce-aaaaaaaaaaaaaaaaaaaa'), presented), 'time');
  assert.ok(!token.proofMatches(token.installProof(keys.auth, 'provision', t.id, now, 'nonce-bbbbbbbbbbbbbbbbbbbb'), presented), 'nonce');
  const other = token.deriveInstallKeys(token.newInstallSecret(), t.id);
  assert.ok(!token.proofMatches(token.installProof(other.auth, 'provision', t.id, now, 'nonce-aaaaaaaaaaaaaaaaaaaa'), presented), 'secret');
  assert.ok(!token.proofMatches(token.installProof(keys.auth, 'provision', t.id, now, 'nonce-aaaaaaaaaaaaaaaaaaaa'), 'x'), 'garbage');
});

test('the sealed configuration opens only for this token, this install and this request', () => {
  const t = sampleToken();
  const keys = token.deriveInstallKeys(t.secret, t.id);
  const plaintext = Buffer.from(JSON.stringify({ JWT_SECRET: 'top secret' }));
  const sealed = token.sealInstallPayload(keys.enc, t.id, 'nonce-1', plaintext);
  assert.ok(!Buffer.from(sealed.ct, 'base64url').toString('latin1').includes('top secret'), 'nothing readable on the wire');
  assert.ok(bootstrap.openPayload(keys.enc, t.id, 'nonce-1', sealed).equals(plaintext));
  assert.throws(() => bootstrap.openPayload(keys.enc, t.id, 'nonce-2', sealed), /authentication/, 'another request');
  assert.throws(() => bootstrap.openPayload(keys.enc, randomUUID(), 'nonce-1', sealed), /authentication/, 'another install');
  const otherKeys = token.deriveInstallKeys(token.newInstallSecret(), t.id);
  assert.throws(() => bootstrap.openPayload(otherKeys.enc, t.id, 'nonce-1', sealed), /authentication/, 'another token');
  const body = Buffer.from(sealed.ct, 'base64url');
  body[3] ^= 1;
  assert.throws(() => bootstrap.openPayload(keys.enc, t.id, 'nonce-1', { ...sealed, ct: body.toString('base64url') }), /authentication/, 'altered');
  assert.ok(token.openInstallPayload(keys.enc, t.id, 'nonce-1', sealed).equals(plaintext), 'the server side opens it as well');
});

// ─── What is shared ──────────────────────────────────────────────────────────

test('only cluster-wide settings are shared; node secrets and process controls never', () => {
  const env = {
    JWT_SECRET: 'j', REFRESH_TOKEN_SECRET: 'r', API_KEY: 'a', SERVER_KEY: 's', ADMIN_PASSWORD_HASH: '$2b$x', ADMIN_USERNAME: 'admin',
    VAPID_PUBLIC_KEY: 'vp', VAPID_PRIVATE_KEY: 'vk', WEBUNTIS_BASE: 'w', LEARN_AI_ENABLED: 'true', RATE_LIMIT_AUTH_MAX: '10',
    CLUSTER_HEARTBEAT_INTERVAL_MS: '5000',
    DATABASE_URL: 'mysql://root:pw@mysql/pokyh', DB_PASSWORD: 'pw', MYSQL_ROOT_PASSWORD: 'pw', CLUSTER_SECRET: 'cs',
    CLUSTER_ADVERTISE_URL: 'https://a', CLUSTER_MTLS_URL: 'https://a:4100', CLUSTER_NODE_NAME: 'a', PORT: '4000',
    TRUST_PROXY: 'loopback', PUBLIC_BASE_URL: 'https://a', LEARN_REDIS_URL: 'redis://x', LEARN_AI_OLLAMA_BASE_URL: 'http://o',
    BACKUP_DIR: '/x', NODE_OPTIONS: '--require /tmp/x.js', PATH: '/bin', HOME: '/root', LD_PRELOAD: '/x.so', UNKNOWN_SETTING: 'x',
    CORS_ORIGIN: 'https://ok\nINJECTED=1',
  };
  const result = shared.sharedEnvironment(env);
  for (const key of ['JWT_SECRET', 'REFRESH_TOKEN_SECRET', 'API_KEY', 'SERVER_KEY', 'ADMIN_PASSWORD_HASH', 'ADMIN_USERNAME',
    'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'WEBUNTIS_BASE', 'LEARN_AI_ENABLED', 'RATE_LIMIT_AUTH_MAX', 'CLUSTER_HEARTBEAT_INTERVAL_MS',
    'PUBLIC_BASE_URL']) {
    assert.equal(result.values[key], env[key], `${key} is shared`);
  }
  for (const key of ['DATABASE_URL', 'DB_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'CLUSTER_SECRET', 'CLUSTER_ADVERTISE_URL', 'CLUSTER_MTLS_URL',
    'CLUSTER_NODE_NAME', 'PORT', 'TRUST_PROXY', 'LEARN_REDIS_URL', 'LEARN_AI_OLLAMA_BASE_URL', 'BACKUP_DIR',
    'NODE_OPTIONS', 'PATH', 'HOME', 'LD_PRELOAD', 'UNKNOWN_SETTING']) {
    assert.equal(result.values[key], undefined, `${key} stays on its node`);
  }
  assert.equal(result.values.CORS_ORIGIN, undefined, 'a multi-line value is never handed over');
  assert.deepEqual(result.skipped, ['CORS_ORIGIN']);
});

test('the new node\'s env file has its own secrets, the shared ones, and nothing smuggled in', () => {
  const t = sampleToken();
  const payload = bootstrap.validatePayload(samplePayload(t, {
    env: {
      JWT_SECRET: 'j'.repeat(40), ADMIN_PASSWORD_HASH: '$2b$12$abc$def', LEARN_AI_ENABLED: 'true',
      // Never sent by a correct node — refused all the same.
      DATABASE_URL: 'mysql://evil', CLUSTER_SECRET: 'evil', NODE_OPTIONS: '--import=data:text/javascript,evil', PATH: '/evil', LD_PRELOAD: '/evil.so',
    },
  }), t);
  const text = bootstrap.buildEnvFile({ payload, secrets: { mysqlRootPassword: 'pw_AAAA', clusterSecret: 'cs_BBBB' }, generatedAt: 'now' });
  const lines = text.split('\n').filter((line) => line && !line.startsWith('#'));
  const keys = lines.map((line) => line.slice(0, line.indexOf('=')));
  assert.equal(new Set(keys).size, keys.length, 'every setting appears once');
  const env = Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  assert.equal(env.DATABASE_URL, 'mysql://root:pw_AAAA@mysql:3306/pokyh');
  assert.equal(env.MYSQL_ROOT_PASSWORD, 'pw_AAAA');
  assert.equal(env.CLUSTER_SECRET, 'cs_BBBB');
  assert.equal(env.JWT_SECRET, 'j'.repeat(40));
  assert.equal(env.ADMIN_PASSWORD_HASH, '$2b$12$abc$def', 'a $ stays a $');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.PATH, undefined);
  assert.equal(env.LD_PRELOAD, undefined);
  assert.equal(env.LEARN_AI_ENABLED, 'false', 'the AI follows the choice for this server');
  assert.equal(env.CLUSTER_MTLS_URL, 'https://node2.example.org:4100');
  assert.equal(env.CLUSTER_PUBLIC_PATH, 'false', 'the node-to-node channel exists on the pinned port only');
  assert.equal(env.CLUSTER_BOOTSTRAP_DIR, '/app/data/bootstrap');
  assert.equal(env.PUBLIC_BASE_URL, undefined, 'no cluster-wide address: links stay relative, never this node\'s own domain');
  const withPublic = bootstrap.buildEnvFile({
    payload: { ...payload, env: { ...payload.env, PUBLIC_BASE_URL: 'https://api.example.org' } },
    secrets: { mysqlRootPassword: 'pw', clusterSecret: 'cs' },
    generatedAt: 'now',
  });
  assert.equal(withPublic.match(/^PUBLIC_BASE_URL=/gm).length, 1);
  assert.match(withPublic, /^PUBLIC_BASE_URL=https:\/\/api\.example\.org$/m, 'the cluster-wide address wins');
});

test('a configuration that does not fit is refused before anything is written', () => {
  const t = sampleToken();
  const refuse = (overrides, pattern) => assert.throws(() => bootstrap.validatePayload(samplePayload(t, overrides), t), pattern);
  refuse({ node: { name: 'x\nNODE_OPTIONS=evil', domain: 'node2.example.org', withAi: false, acmeEmail: '' } }, /name/);
  refuse({ node: { name: 'x', domain: 'node2.example.org\n', withAi: false, acmeEmail: '' } }, /domain/);
  refuse({ node: { name: 'x', domain: 'node2.example.org', withAi: false, acmeEmail: 'a}@b.cd' } }, /e-mail/);
  refuse({ env: { CORS_ORIGIN: 'a\nb' } }, /setting/);
  refuse({ env: { 'lower case': 'x' } }, /setting/);
  refuse({ bundle: { sha256: 'xyz', bytes: 1 } }, /hash/);
  const stranger = x509.createNodeCertificate('stranger');
  refuse({ cluster: { url: t.url, nodeId: t.nodeId, name: 'Graz', cert: stranger.certPem, pairingUntil: 1 } }, /pin/);
  refuse({ cluster: { url: 'https://other.example.org:4100', nodeId: t.nodeId, name: 'Graz', cert: node.certPem, pairingUntil: 1 } }, /cluster node/);
  refuse({ cluster: { url: t.url, nodeId: t.nodeId, name: 'Graz\nX=1', cert: node.certPem, pairingUntil: 1 } }, /name/);
});

test('the Caddyfile, compose settings and AI sizing follow the choices', () => {
  const caddy = bootstrap.renderCaddyfile({ domain: 'node2.example.org', acmeEmail: 'ops@example.org', tlsInternal: false });
  assert.match(caddy, /email ops@example\.org/);
  assert.match(caddy, /^node2\.example\.org \{$/m);
  assert.match(caddy, /reverse_proxy app-blue:4000 app-green:4000/, 'both colours of a blue\/green update');
  assert.match(caddy, /health_uri \/readyz/, 'only to a colour that is ready');
  assert.match(caddy, /lb_try_duration/);
  assert.doesNotMatch(caddy, /tls internal/);
  assert.match(bootstrap.renderCaddyfile({ domain: 'a.b', acmeEmail: '', tlsInternal: true }), /tls internal/);
  assert.deepEqual(bootstrap.aiPlan({ withAi: false, memKb: 64e6, cpus: 8 }), { enabled: false, note: '' });
  assert.equal(bootstrap.aiPlan({ withAi: true, memKb: 8 * 1024 * 1024, cpus: 8 }).enabled, false, 'too little memory');
  const big = bootstrap.aiPlan({ withAi: true, memKb: 32 * 1024 * 1024, cpus: 8 });
  assert.deepEqual([big.enabled, big.memLimit, big.cpus], [true, '10g', '4']);
  assert.match(bootstrap.renderComposeEnv({ ai: big, web: true }), /^COMPOSE_PROFILES=blue,web,ai$/m);
  const plain = bootstrap.renderComposeEnv({ ai: { enabled: false }, web: false, runtime: { repo: 'https://github.com/bedchem/pokyh-backend', branch: 'main' } });
  assert.match(plain, /^COMPOSE_PROFILES=blue$/m, 'no domain: no Caddy');
  assert.match(plain, /^POKYH_RUNTIME_REPO=https:\/\/github\.com\/bedchem\/pokyh-backend$/m);
  assert.match(plain, /^POKYH_RUNTIME_BRANCH=main$/m);
  assert.match(plain, /^POKYH_HOME=\/opt\/pokyh$/m);
  assert.equal(bootstrap.clockDifferenceMs(new Date(Date.now() - 120_000).toUTCString()) > 100_000, true);
  assert.equal(bootstrap.clockDifferenceMs('garbage'), 0);
});

// ─── The bundle ──────────────────────────────────────────────────────────────

test('the bundle is a deterministic archive that tar unpacks exactly', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pokyh-tar-'));
  try {
    const deep = path.join('dist', 'a'.repeat(60), 'b'.repeat(60));
    mkdirSync(path.join(root, deep), { recursive: true });
    writeFileSync(path.join(root, deep, 'file.js'), 'console.log(1)\n');
    writeFileSync(path.join(root, 'entrypoint.sh'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(path.join(root, 'empty.txt'), '');
    const binary = Buffer.alloc(1500, 7);
    writeFileSync(path.join(root, 'dist', 'blob.bin'), binary);
    const files = tarball.collectFiles(root, ['dist', 'entrypoint.sh', 'empty.txt']);
    const first = tarball.createTarGz(root, files, 'pokyh-app');
    const second = tarball.createTarGz(root, files, 'pokyh-app');
    assert.ok(first.equals(second), 'same files, same archive');
    const archive = path.join(root, 'bundle.tgz');
    writeFileSync(archive, first);
    const listed = await run('tar', ['-tzf', archive]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.ok(listed.stdout.includes(`pokyh-app/${deep.split(path.sep).join('/')}/file.js`), 'a path longer than 100 bytes survives');
    const out = path.join(root, 'out');
    mkdirSync(out);
    const extracted = await run('tar', ['-xzf', archive, '-C', out, '--strip-components=1']);
    assert.equal(extracted.code, 0, extracted.stderr);
    assert.equal(readFileSync(path.join(out, deep, 'file.js'), 'utf8'), 'console.log(1)\n');
    assert.ok(readFileSync(path.join(out, 'dist', 'blob.bin')).equals(binary));
    assert.equal(readFileSync(path.join(out, 'empty.txt'), 'utf8'), '');
    assert.ok((statSync(path.join(out, 'entrypoint.sh')).mode & 0o111) !== 0, 'executable stays executable');
    assert.throws(() => tarball.createTarGz(root, ['../outside'], 'p'), /unsafe/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Invite codes name the channel ──────────────────────────────────────────

test('an invite code can name the inviting node\'s channel and certificate pin', () => {
  const base = {
    address: 'https://node1.example.org', nodeId: '6f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f', name: 'Graz',
    secret: invite.newInviteSecret(), expiresAt: new Date(Date.now() + 60_000),
  };
  const withChannel = invite.decodeInvite(invite.encodeInvite({ ...base, channel: { url: 'https://node1.example.org:4100', pin: node.pin } }));
  assert.equal(withChannel.ok, true);
  assert.deepEqual(withChannel.invite.channel, { url: 'https://node1.example.org:4100', pin: node.pin });
  const without = invite.decodeInvite(invite.encodeInvite(base));
  assert.equal(without.invite.channel, null);
  const body = JSON.parse(Buffer.from(invite.encodeInvite(base).slice(7), 'base64url').toString());
  const half = `pokyh1.${Buffer.from(JSON.stringify({ ...body, c: 'https://x:4100' })).toString('base64url')}`;
  assert.equal(invite.decodeInvite(half).ok, false, 'a channel without pin is damaged');
});

// ─── The installer script ────────────────────────────────────────────────────

test('the installer, with its bootstrap embedded, is valid shell and pins Docker\'s key', async (t) => {
  const template = readFileSync(path.join(REPO, 'deploy/node/install.sh'), 'utf8');
  const code = readFileSync(path.join(REPO, 'deploy/node/bootstrap.mjs'), 'utf8');
  assert.ok(template.includes('__POKYH_BOOTSTRAP__'));
  assert.ok(!code.includes('POKYH_BOOTSTRAP_END'), 'the bootstrap cannot end the heredoc early');
  const rendered = template.replace('__POKYH_BOOTSTRAP__', code.trimEnd());
  assert.match(rendered, /DOCKER_KEY_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88/);
  assert.match(rendered, /<<'POKYH_BOOTSTRAP_END'/, 'quoted heredoc: no expansion inside the bootstrap');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pokyh-install-'));
  try {
    const file = path.join(dir, 'pokyh-install.sh');
    writeFileSync(file, rendered);
    const syntax = await run('sh', ['-n', file]);
    assert.equal(syntax.code, 0, syntax.stderr);
    const lint = await run('shellcheck', ['--version']);
    if (lint.code === 0) {
      const checked = await run('shellcheck', ['-s', 'sh', file]);
      assert.equal(checked.code, 0, checked.stdout);
    } else {
      t.diagnostic('shellcheck not installed — skipped the lint');
    }
    // The embedded bootstrap is byte-identical to the shipped one.
    const embedded = rendered.split("<<'POKYH_BOOTSTRAP_END'\n")[1].split('\nPOKYH_BOOTSTRAP_END')[0];
    assert.equal(createHash('sha256').update(embedded).digest('hex'), createHash('sha256').update(code.trimEnd()).digest('hex'));
    // Without a token it explains itself and changes nothing.
    const usage = await run('sh', [file]);
    assert.notEqual(usage.code, 0);
    assert.match(usage.stderr, /Usage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Several ways to the inviting node ───────────────────────────────────────

test('the token carries every way to the inviting node, and the bootstrap reads them alike', async () => {
  const ep = await loadTs('src/cluster/endpoints.ts');
  const ways = ['https://203.0.113.10:4100', 'https://a.cluster.example.org:443', 'https://vps.example.org:4100?sni=a-1.pokyh-relay'];
  const t = sampleToken({ url: 'https://203.0.113.10:4100', endpoints: ways });
  const encoded = token.encodeInstallToken(t);
  const server = token.decodeInstallToken(encoded);
  assert.equal(server.ok, true);
  assert.deepEqual(server.token.endpoints, ways);
  const client = bootstrap.decodeToken(encoded);
  assert.deepEqual(client.endpoints, ways.map((way) => ep.parseEndpoint(way)));
  assert.equal(bootstrap.connectTarget(client.endpoints[1]).port, 443, 'port 443 is kept although URL drops it');
  assert.equal(bootstrap.connectTarget(client.endpoints[2]).servername, 'a-1.pokyh-relay');
  for (const input of [...ways, 'https://h:1', 'https://[fd00::1]:4100', 'http://x:1', 'https://x', 'https://x:443/p', 'https://x:4100?sni=1.2.3.4']) {
    assert.deepEqual(bootstrap.parseEndpoint(input), ep.parseEndpoint(input), input);
  }
  assert.equal(token.isChannelUrl('https://a.cluster.example.org:443'), true);
  assert.equal(token.isChannelUrl('https://a.cluster.example.org'), false);
  // A token whose list holds something unusable is refused as a whole.
  const body = JSON.parse(Buffer.from(encoded.slice(11), 'base64url').toString());
  assert.throws(() => bootstrap.decodeToken(`pokyhnode1.${Buffer.from(JSON.stringify({ ...body, x: ['http://evil:1'] })).toString('base64url')}`), /damaged/);
});

// ─── Address: domain, IP, or detected ───────────────────────────────────────

test('the token names the inviting node\'s public address, and the bootstrap reads it', () => {
  const t = sampleToken({ web: 'https://api.pokyh.com' });
  const encoded = token.encodeInstallToken(t);
  assert.equal(token.decodeInstallToken(encoded).token.web, 'https://api.pokyh.com');
  assert.equal(bootstrap.decodeToken(encoded).web, 'https://api.pokyh.com');
  assert.equal(bootstrap.decodeToken(token.encodeInstallToken(sampleToken())).web, null, 'older tokens: channel only');
  const body = JSON.parse(Buffer.from(encoded.slice(11), 'base64url').toString());
  const encode = (value) => `pokyhnode1.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
  for (const bad of ['https://api.pokyh.com/setup', 'javascript:alert(1)', 'https://a b', 42]) {
    assert.equal(token.decodeInstallToken(encode({ ...body, w: bad })).ok, false, String(bad));
    assert.throws(() => bootstrap.decodeToken(encode({ ...body, w: bad })), /damaged/, String(bad));
  }
});

test('a node without a domain is reached at its IP and serves no web of its own', () => {
  const t = sampleToken();
  const ipOnly = samplePayload(t, { node: { name: 'Homelab', domain: '', address: '203.0.113.20', withAi: false, acmeEmail: '' } });
  assert.doesNotThrow(() => bootstrap.validatePayload(ipOnly, t));
  const env = Object.fromEntries(bootstrap.buildEnvFile({ payload: ipOnly, secrets: { mysqlRootPassword: 'pw', clusterSecret: 'cs' }, generatedAt: 'now' })
    .split('\n').filter((line) => /^[A-Z]/.test(line)).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  assert.equal(env.CLUSTER_MTLS_URL, 'https://203.0.113.20:4100');
  assert.equal(env.CLUSTER_NODE_NAME, 'Homelab');
  assert.equal(env.CLUSTER_MTLS_PROXY_PROTOCOL, 'true', 'the edge forwarder names each client');
  assert.equal(env.POKYH_ACTIVATION_FILE, '/app/data/update/active');
  assert.equal(bootstrap.channelHost({ domain: '', address: '2001:db8::5' }), '[2001:db8::5]');
  assert.equal(bootstrap.channelHost({ domain: '', address: '' }), '', 'unknown: reached through relays only');
  assert.throws(() => bootstrap.validatePayload(samplePayload(t, { node: { name: 'x', domain: '', address: 'not-an-ip', withAi: false, acmeEmail: '' } }), t), /address/);
  assert.throws(() => bootstrap.validatePayload(samplePayload(t, { update: { repo: 'http://evil.example/x/y', branch: 'main' } }), t), /update/);
  assert.throws(() => bootstrap.validatePayload(samplePayload(t, { update: { repo: '', branch: '../x' } }), t), /update/);
});
