import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { ApnsClient, buildPayload, classify, isDeviceToken, isEnvironment, providerToken } = await loadTs('src/services/apns.ts');

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
// Same format as the .p8 file Apple hands out.
const p8 = privateKey.export({ type: 'pkcs8', format: 'pem' });
const deviceToken = 'a'.repeat(64);

const alert = {
  title: 'Neue Mitteilung',
  titleKey: 'push.messages.new.one',
  titleArgs: ['1'],
  body: 'Tippe um sie zu sehen',
  bodyKey: 'push.tapToOpen',
  thread: 'messages',
  url: '/messages',
};

function decodeJwt(jwt) {
  const [header, claims, signature] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url')),
    claims: JSON.parse(Buffer.from(claims, 'base64url')),
    signingInput: `${header}.${claims}`,
    signature: Buffer.from(signature, 'base64url'),
  };
}

function verifies(jwt) {
  const { signingInput, signature } = decodeJwt(jwt);
  return verify('sha256', Buffer.from(signingInput), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
}

// A local cleartext HTTP/2 server standing in for Apple: `respond` decides each answer.
async function fakeApns(respond) {
  const requests = [];
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { body += chunk; });
    stream.on('end', () => {
      const request = { headers, body: body ? JSON.parse(body) : null };
      requests.push(request);
      const answer = respond(request, requests.length);
      if (!answer) return; // never answer: lets the client time out
      stream.respond({ ':status': answer.status, 'content-type': 'application/json' });
      stream.end(answer.reason ? JSON.stringify({ reason: answer.reason }) : '');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${server.address().port}`;
  return { host, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

function client(host, extra = {}) {
  return new ApnsClient({
    keyId: 'KEY1234567',
    teamId: 'TEAM123456',
    key: p8,
    topic: 'dev.example.app',
    hosts: { sandbox: host, production: host },
    timeoutMs: 2000,
    tokenTtlMs: 50 * 60 * 1000,
    ...extra,
  });
}

test('the provider token is an ES256 JWT Apple can check with the key', () => {
  const now = Date.UTC(2026, 9, 29, 12, 0, 0);
  const jwt = providerToken('KEY1234567', 'TEAM123456', privateKey, now);
  const { header, claims, signature } = decodeJwt(jwt);
  assert.deepEqual(header, { alg: 'ES256', kid: 'KEY1234567' });
  assert.deepEqual(claims, { iss: 'TEAM123456', iat: now / 1000 });
  // Raw r||s, 64 bytes for P-256, not DER.
  assert.equal(signature.length, 64);
  assert.ok(verifies(jwt));
});

test('device tokens and environments are checked', () => {
  assert.ok(isDeviceToken(deviceToken));
  assert.ok(isDeviceToken('0123456789ABCDEF'.repeat(5)));
  assert.equal(isDeviceToken('xyz'), false);
  assert.equal(isDeviceToken('a'.repeat(63)), false);
  assert.equal(isDeviceToken(`${'a'.repeat(64)}/../`), false);
  assert.ok(isEnvironment('sandbox'));
  assert.ok(isEnvironment('production'));
  assert.equal(isEnvironment('development'), false);
});

test('the payload carries string keys, thread and deep link', () => {
  const payload = JSON.parse(buildPayload(alert));
  assert.deepEqual(payload.aps.alert, {
    title: 'Neue Mitteilung',
    'title-loc-key': 'push.messages.new.one',
    'title-loc-args': ['1'],
    body: 'Tippe um sie zu sehen',
    'loc-key': 'push.tapToOpen',
  });
  assert.equal(payload.aps['thread-id'], 'messages');
  assert.equal(payload.aps.sound, 'default');
  assert.equal(payload.url, '/messages');
});

test('a free text body goes out as is, without a key', () => {
  const payload = JSON.parse(buildPayload({ ...alert, bodyKey: undefined, body: 'Turnsachen mitnehmen' }));
  assert.equal(payload.aps.alert.body, 'Turnsachen mitnehmen');
  assert.equal(payload.aps.alert['loc-key'], undefined);
});

test('long texts are cut so the payload stays under 4 KB', () => {
  const long = 'ä'.repeat(5000);
  const json = buildPayload({ ...alert, title: long, titleArgs: [long], body: long, bodyKey: undefined });
  assert.ok(Buffer.byteLength(json) <= 4096, `payload is ${Buffer.byteLength(json)} bytes`);
  const payload = JSON.parse(json);
  assert.ok(payload.aps.alert['title-loc-args'][0].endsWith('…'));
  assert.ok(payload.aps.alert.body.endsWith('…'));
});

test("Apple's answers map to what we do next", () => {
  assert.deepEqual(classify(200, ''), { kind: 'sent' });
  assert.equal(classify(410, 'Unregistered').kind, 'gone');
  assert.equal(classify(400, 'BadDeviceToken').kind, 'gone');
  assert.equal(classify(400, 'DeviceTokenNotForTopic').kind, 'gone');
  assert.equal(classify(400, 'PayloadTooLarge').kind, 'failed');
  assert.equal(classify(403, 'ExpiredProviderToken').kind, 'refreshToken');
  assert.equal(classify(403, 'InvalidProviderToken').kind, 'failed');
  assert.equal(classify(429, 'TooManyRequests').kind, 'retryLater');
  assert.equal(classify(503, '').kind, 'retryLater');
});

test('a push reaches the device with the headers Apple wants', async () => {
  const apple = await fakeApns(() => ({ status: 200 }));
  const apns = client(apple.host);
  try {
    const outcome = await apns.send({ token: deviceToken, environment: 'sandbox' }, alert, 'messages');
    assert.deepEqual(outcome, { kind: 'sent' });
    const [{ headers, body }] = apple.requests;
    assert.equal(headers[':method'], 'POST');
    assert.equal(headers[':path'], `/3/device/${deviceToken}`);
    assert.equal(headers['apns-topic'], 'dev.example.app');
    assert.equal(headers['apns-push-type'], 'alert');
    assert.equal(headers['apns-priority'], '10');
    assert.equal(headers['apns-collapse-id'], 'messages');
    assert.match(headers.authorization, /^bearer /);
    assert.ok(verifies(headers.authorization.slice('bearer '.length)));
    assert.equal(body.aps.alert['title-loc-key'], 'push.messages.new.one');
  } finally {
    apns.close();
    await apple.close();
  }
});

test('each environment goes to its own gateway', async () => {
  const sandbox = await fakeApns(() => ({ status: 200 }));
  const production = await fakeApns(() => ({ status: 200 }));
  const apns = client(sandbox.host, { hosts: { sandbox: sandbox.host, production: production.host } });
  try {
    await apns.send({ token: deviceToken, environment: 'production' }, alert);
    await apns.send({ token: deviceToken, environment: 'sandbox' }, alert);
    await apns.send({ token: deviceToken, environment: 'production' }, alert);
    assert.equal(sandbox.requests.length, 1);
    assert.equal(production.requests.length, 2);
  } finally {
    apns.close();
    await sandbox.close();
    await production.close();
  }
});

test('a token Apple no longer knows comes back as gone', async () => {
  const apple = await fakeApns(() => ({ status: 410, reason: 'Unregistered' }));
  const apns = client(apple.host);
  try {
    const outcome = await apns.send({ token: deviceToken, environment: 'production' }, alert);
    assert.deepEqual(outcome, { kind: 'gone', reason: 'Unregistered' });
  } finally {
    apns.close();
    await apple.close();
  }
});

test('an expired provider token is renewed and the push sent again', async () => {
  let now = Date.UTC(2026, 9, 29, 12, 0, 0);
  const apple = await fakeApns((_req, n) => (n === 1 ? { status: 403, reason: 'ExpiredProviderToken' } : { status: 200 }));
  const apns = client(apple.host, { now: () => now });
  try {
    now += 1000;
    const outcome = await apns.send({ token: deviceToken, environment: 'production' }, alert);
    assert.deepEqual(outcome, { kind: 'sent' });
    assert.equal(apple.requests.length, 2);
    const [first, second] = apple.requests.map((r) => r.headers.authorization);
    assert.notEqual(first, second);
  } finally {
    apns.close();
    await apple.close();
  }
});

test('it gives up after one renewal instead of looping', async () => {
  const apple = await fakeApns(() => ({ status: 403, reason: 'ExpiredProviderToken' }));
  const apns = client(apple.host);
  try {
    const outcome = await apns.send({ token: deviceToken, environment: 'production' }, alert);
    assert.equal(outcome.kind, 'failed');
    assert.equal(apple.requests.length, 2);
  } finally {
    apns.close();
    await apple.close();
  }
});

test('the provider token is reused until its time is up', async () => {
  let now = Date.UTC(2026, 9, 29, 12, 0, 0);
  const apple = await fakeApns(() => ({ status: 200 }));
  const apns = client(apple.host, { now: () => now, tokenTtlMs: 20 * 60 * 1000 });
  try {
    await apns.send({ token: deviceToken, environment: 'production' }, alert);
    now += 19 * 60 * 1000;
    await apns.send({ token: deviceToken, environment: 'production' }, alert);
    now += 2 * 60 * 1000;
    await apns.send({ token: deviceToken, environment: 'production' }, alert);
    const iats = apple.requests.map((r) => decodeJwt(r.headers.authorization.slice(7)).claims.iat);
    assert.equal(iats[0], iats[1]);
    assert.ok(iats[2] > iats[1]);
  } finally {
    apns.close();
    await apple.close();
  }
});

test('no answer in time is a retry later, not a hang', async () => {
  const apple = await fakeApns(() => null);
  const apns = client(apple.host, { timeoutMs: 200 });
  try {
    const outcome = await apns.send({ token: deviceToken, environment: 'production' }, alert);
    assert.deepEqual(outcome, { kind: 'retryLater', reason: 'timeout' });
  } finally {
    apns.close();
    await apple.close();
  }
});

test('an unreachable gateway is a retry later', async () => {
  const apns = client('http://127.0.0.1:1', { timeoutMs: 500 });
  try {
    const outcome = await apns.send({ token: deviceToken, environment: 'production' }, alert);
    assert.equal(outcome.kind, 'retryLater');
  } finally {
    apns.close();
  }
});
