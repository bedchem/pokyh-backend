import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const invite = await loadTs('src/cluster/invite.ts');

const sample = () => ({
  address: 'https://node1.example.org',
  nodeId: '6f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f',
  name: 'Graz',
  secret: invite.newInviteSecret(),
  expiresAt: new Date(Date.now() + 15 * 60_000),
});

test('an invite code carries address, node, secret and expiry intact', () => {
  const original = sample();
  const code = invite.encodeInvite(original);
  assert.match(code, /^pokyh1\.[A-Za-z0-9_-]+$/, 'safe to paste anywhere');
  const decoded = invite.decodeInvite(code);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.invite.address, original.address);
  assert.equal(decoded.invite.nodeId, original.nodeId);
  assert.equal(decoded.invite.name, original.name);
  assert.equal(decoded.invite.secret, original.secret);
  assert.equal(Math.floor(decoded.invite.expiresAt.getTime() / 1000), Math.floor(original.expiresAt.getTime() / 1000));
});

test('whitespace from copying across lines is ignored', () => {
  const code = invite.encodeInvite(sample());
  const wrapped = `  ${code.slice(0, 30)}\n${code.slice(30)}  `;
  assert.equal(invite.decodeInvite(wrapped).ok, true);
});

test('every secret is fresh and strong', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const secret = invite.newInviteSecret();
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/, '256 bits');
    seen.add(secret);
  }
  assert.equal(seen.size, 50);
});

test('an expired code is refused', () => {
  const code = invite.encodeInvite({ ...sample(), expiresAt: new Date(Date.now() - 1000) });
  const decoded = invite.decodeInvite(code);
  assert.equal(decoded.ok, false);
  assert.match(decoded.error, /expired/);
});

test('damaged or foreign codes are refused with a reason', () => {
  const code = invite.encodeInvite(sample());
  for (const bad of ['', 'hello', `${code.slice(0, -6)}`, 'pokyh1.', 'pokyh1.e30', `pokyh1.${Buffer.from('[1,2]').toString('base64url')}`, `pokyh1.${'A'.repeat(3000)}`]) {
    const decoded = invite.decodeInvite(bad);
    assert.equal(decoded.ok, false, `expected "${bad.slice(0, 20)}" to be refused`);
    assert.ok(decoded.error.length > 0);
  }
  const tampered = JSON.parse(Buffer.from(code.slice(7), 'base64url').toString('utf8'));
  for (const change of [{ s: 'short' }, { n: 'x' }, { v: 2 }, { e: 'soon' }, { a: '' }]) {
    const decoded = invite.decodeInvite(`pokyh1.${Buffer.from(JSON.stringify({ ...tampered, ...change })).toString('base64url')}`);
    assert.equal(decoded.ok, false, `expected ${JSON.stringify(change)} to be refused`);
  }
});
