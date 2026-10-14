import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const net = await loadTs('src/cluster/netpolicy.ts');

test('without an allowlist every address may connect', () => {
  const open = net.parseAllowlist([]);
  assert.equal(open.list, null);
  assert.equal(net.isAllowed(open, '203.0.113.9'), true);
});

test('single addresses and ranges, IPv4 and IPv6', () => {
  const list = net.parseAllowlist(['203.0.113.10', '10.0.0.0/8', '2001:db8::/32', '::1']);
  assert.equal(list.size, 4);
  assert.deepEqual(list.invalid, []);
  assert.equal(net.isAllowed(list, '203.0.113.10'), true);
  assert.equal(net.isAllowed(list, '203.0.113.11'), false);
  assert.equal(net.isAllowed(list, '10.200.3.4'), true);
  assert.equal(net.isAllowed(list, '11.0.0.1'), false);
  assert.equal(net.isAllowed(list, '2001:db8:1::5'), true);
  assert.equal(net.isAllowed(list, '2001:db9::5'), false);
  assert.equal(net.isAllowed(list, '::1'), true);
});

test('an IPv4 client on an IPv6 socket is matched by its IPv4 address', () => {
  const list = net.parseAllowlist(['10.0.0.0/8']);
  assert.equal(net.isAllowed(list, '::ffff:10.1.2.3'), true);
  assert.equal(net.isAllowed(list, '::ffff:192.168.1.1'), false);
});

test('unusable entries are reported and never widen the list', () => {
  const list = net.parseAllowlist(['not-an-ip', '10.0.0.0/33', '1.2.3.4/x', 'a/b/c']);
  assert.equal(list.size, 0);
  assert.equal(list.invalid.length, 4);
  assert.notEqual(list.list, null, 'a list of only bad entries still refuses everyone');
  assert.equal(net.isAllowed(list, '10.0.0.1'), false);
});

test('a missing or malformed client address is refused when a list is set', () => {
  const list = net.parseAllowlist(['10.0.0.1']);
  assert.equal(net.isAllowed(list, undefined), false);
  assert.equal(net.isAllowed(list, 'garbage'), false);
});
