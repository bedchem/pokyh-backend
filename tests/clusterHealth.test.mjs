import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const health = await loadTs('src/cluster/health.ts');
const thresholds = { suspectAfterFailures: 2, offlineAfterFailures: 4 };

test('a peer degrades step by step and recovers at once', () => {
  assert.equal(health.healthAfter(0, thresholds), 'ONLINE');
  assert.equal(health.healthAfter(1, thresholds), 'ONLINE', 'one lost heartbeat is tolerated');
  assert.equal(health.healthAfter(2, thresholds), 'SUSPECT');
  assert.equal(health.healthAfter(3, thresholds), 'SUSPECT');
  assert.equal(health.healthAfter(4, thresholds), 'OFFLINE');
  assert.equal(health.healthAfter(400, thresholds), 'OFFLINE');
  assert.equal(health.healthAfter(0, thresholds), 'ONLINE');
});

test('thresholds that overlap still pass through SUSPECT', () => {
  const tight = { suspectAfterFailures: 3, offlineAfterFailures: 3 };
  assert.equal(health.healthAfter(3, tight), 'SUSPECT');
  assert.equal(health.healthAfter(4, tight), 'OFFLINE');
});

test('every node that sees the same set of nodes gives a piece of work to the same owner', () => {
  const nodes = ['node-a', 'node-b', 'node-c'];
  for (let i = 0; i < 200; i++) {
    const key = `todo:${i}`;
    const owner = health.rendezvousOwner(key, nodes);
    assert.ok(nodes.includes(owner));
    assert.equal(health.rendezvousOwner(key, [...nodes].reverse()), owner, 'the order nodes are listed in does not matter');
  }
  assert.equal(health.rendezvousOwner('x', ['only']), 'only', 'a standalone node owns everything');
  assert.equal(health.rendezvousOwner('x', []), null);
});

test('work spreads over the nodes and only a lost node\'s share moves', () => {
  const nodes = ['node-a', 'node-b', 'node-c'];
  const counts = new Map(nodes.map((node) => [node, 0]));
  let moved = 0;
  for (let i = 0; i < 3000; i++) {
    const key = `push-sub:${i}`;
    const owner = health.rendezvousOwner(key, nodes);
    counts.set(owner, counts.get(owner) + 1);
    const without = health.rendezvousOwner(key, ['node-a', 'node-c']);
    if (owner !== 'node-b') assert.equal(without, owner, 'work of the nodes that stay does not move');
    else moved++;
  }
  for (const count of counts.values()) assert.ok(count > 800 && count < 1200, `share ${count} of 3000 is roughly a third`);
  assert.equal(moved, counts.get('node-b'));
});

test('clock difference is estimated around the midpoint of the exchange', () => {
  assert.equal(health.estimateSkewMs(1000, 1100, 1050), 0);
  assert.equal(health.estimateSkewMs(1000, 1100, 6050), 5000);
  assert.equal(health.estimateSkewMs(1000, 1100, 50), -1000);
});

test('peer addresses are accepted the way an operator types them', () => {
  const url = (input) => {
    const result = health.normalizePeerAddress(input);
    assert.equal(result.ok, true, `${input}: ${result.error}`);
    return result.url;
  };
  assert.equal(url('10.0.0.5'), 'http://10.0.0.5:4000');
  assert.equal(url(' 10.0.0.5:4100 '), 'http://10.0.0.5:4100');
  assert.equal(url('node2.example.org'), 'http://node2.example.org:4000');
  assert.equal(url('http://10.0.0.5:4000/'), 'http://10.0.0.5:4000');
  assert.equal(url('https://node2.example.org'), 'https://node2.example.org');
  assert.equal(url('[2001:db8::5]:4000'), 'http://[2001:db8::5]:4000');
  assert.equal(url('2001:db8::5'), 'http://[2001:db8::5]:4000');
});

test('unusable peer addresses are rejected with a reason', () => {
  for (const input of ['', '   ', 'ftp://10.0.0.5', 'http://user:pw@10.0.0.5', 'http://10.0.0.5/path', 'http://10.0.0.5/?a=1', '10.0.0.5 4000', 'x'.repeat(300)]) {
    const result = health.normalizePeerAddress(input);
    assert.equal(result.ok, false, `expected "${input}" to be rejected`);
    assert.ok(result.error.length > 0);
  }
});
