import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { createSessionMemo } = await loadTs('src/webuntis/memo.ts');

// A clock the test moves by hand.
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('requests asking at the same time share one lookup', async () => {
  const memo = createSessionMemo({ maxSessions: 10, idleMs: 60_000 });
  let loads = 0;
  const gate = deferred();
  const load = () => { loads += 1; return gate.promise; };
  const asked = [1, 2, 3, 4, 5].map(() => memo.get('s1', 'token', load, () => 60_000));
  gate.resolve('tok');
  assert.deepEqual(await Promise.all(asked), ['tok', 'tok', 'tok', 'tok', 'tok']);
  assert.equal(loads, 1);
});

test('a kept value is answered until it runs out, then looked up again', async () => {
  const c = clock();
  const memo = createSessionMemo({ maxSessions: 10, idleMs: 60_000, now: c.now });
  let loads = 0;
  const load = async () => `tok${++loads}`;
  assert.equal(await memo.get('s1', 'token', load, () => 1_000), 'tok1');
  c.advance(999);
  assert.equal(await memo.get('s1', 'token', load, () => 1_000), 'tok1');
  c.advance(1);
  assert.equal(await memo.get('s1', 'token', load, () => 1_000), 'tok2');
  assert.equal(loads, 2);
});

test('a failed lookup is not kept', async () => {
  const memo = createSessionMemo({ maxSessions: 10, idleMs: 60_000 });
  let loads = 0;
  const load = async () => { loads += 1; return undefined; };
  const ttl = (v) => (v ? 60_000 : 0);
  assert.equal(await memo.get('s1', 'csrf', load, ttl), undefined);
  assert.equal(await memo.get('s1', 'csrf', load, ttl), undefined);
  assert.equal(loads, 2);
});

test('a rejected lookup reaches every caller and is not kept', async () => {
  const memo = createSessionMemo({ maxSessions: 10, idleMs: 60_000 });
  let loads = 0;
  const load = async () => { loads += 1; throw new Error('down'); };
  const asked = [memo.get('s1', 'k', load, () => 60_000), memo.get('s1', 'k', load, () => 60_000)];
  for (const p of asked) await assert.rejects(p, /down/);
  await assert.rejects(memo.get('s1', 'k', load, () => 60_000), /down/);
  assert.equal(loads, 2);
});

test('sessions and keys stay apart', async () => {
  const memo = createSessionMemo({ maxSessions: 10, idleMs: 60_000 });
  await memo.get('s1', 'token', async () => 'a', () => 60_000);
  await memo.get('s2', 'token', async () => 'b', () => 60_000);
  memo.keep('s1', 'tenant', 't1', 60_000);
  assert.equal(memo.peek('s1', 'token'), 'a');
  assert.equal(memo.peek('s2', 'token'), 'b');
  assert.equal(memo.peek('s1', 'tenant'), 't1');
  assert.equal(memo.peek('s2', 'tenant'), undefined);
});

test('keep with no lifetime keeps nothing', () => {
  const memo = createSessionMemo({ maxSessions: 10, idleMs: 60_000 });
  memo.keep('s1', 'token', 'tok', 0);
  assert.equal(memo.peek('s1', 'token'), undefined);
});

test('forgetting a key during its lookup: the old answer is dropped, the new lookup is kept', async () => {
  const memo = createSessionMemo({ maxSessions: 10, idleMs: 60_000 });
  const stale = deferred();
  const first = memo.get('s1', 'csrf', () => stale.promise, () => 60_000);
  memo.forget('s1', 'csrf');
  const second = memo.get('s1', 'csrf', async () => 'new', () => 60_000);
  assert.equal(await second, 'new');
  stale.resolve('old');
  assert.equal(await first, 'old');
  assert.equal(memo.peek('s1', 'csrf'), 'new');
});

test('forgetting a session drops all it kept', async () => {
  const memo = createSessionMemo({ maxSessions: 10, idleMs: 60_000 });
  memo.keep('s1', 'token', 'tok', 60_000);
  memo.keep('s1', 'tenant', 't', 60_000);
  memo.forget('s1');
  assert.equal(memo.peek('s1', 'token'), undefined);
  assert.equal(memo.peek('s1', 'tenant'), undefined);
});

test('idle sessions are dropped once there are too many', () => {
  const c = clock();
  const memo = createSessionMemo({ maxSessions: 2, idleMs: 1_000, now: c.now });
  memo.keep('old', 'token', 'tok', 60_000);
  c.advance(2_000);
  memo.keep('a', 'token', 'tok', 60_000);
  memo.keep('b', 'token', 'tok', 60_000);
  memo.keep('c', 'token', 'tok', 60_000);
  assert.equal(memo.peek('old', 'token'), undefined);
  assert.equal(memo.peek('a', 'token'), 'tok');
});
