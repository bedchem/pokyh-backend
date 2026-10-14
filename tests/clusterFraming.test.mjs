import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const framing = await loadTs('src/cluster/framing.ts');
const MAX = 16 * 1024 * 1024;

test('packages round-trip unchanged, small and large', async () => {
  for (const content of [Buffer.alloc(0), Buffer.from('{"m":"hb"}'), Buffer.from(JSON.stringify({ rows: Array.from({ length: 2000 }, (_, i) => ({ i, t: 'Mathematik Hausübung' })) })), randomBytes(200_000)]) {
    const packed = await framing.packPayload(content);
    assert.deepEqual(await framing.unpackPayload(packed, MAX), content);
  }
});

test('a batch of similar rows is sent compressed', async () => {
  const content = Buffer.from(JSON.stringify(Array.from({ length: 500 }, (_, i) => ['todos', `id-${i}`, 'Mathematik Hausübung Seite 142', false])));
  const packed = await framing.packPayload(content);
  assert.ok(packed.length < content.length / 4, `${packed.length} bytes for ${content.length}`);
});

test('package sizes fall on fixed steps, so length says little about content', async () => {
  const sizes = new Set();
  for (let length = 0; length < 900; length += 37) sizes.add((await framing.packPayload(randomBytes(length))).length);
  assert.deepEqual([...sizes], [1024], 'every small package has the same size');
  assert.equal(framing.paddedSize(1025), 2048);
  assert.equal(framing.paddedSize(40_000), 65_536);
  assert.equal(framing.paddedSize(65_537), 131_072);
  assert.equal(framing.paddedSize(200_000), 262_144);
});

test('a package that would expand beyond the limit is refused', async () => {
  const bomb = await framing.packPayload(Buffer.alloc(4 * 1024 * 1024, 0x61));
  assert.ok(bomb.length < 64 * 1024, 'highly compressible content packs small');
  await assert.rejects(() => framing.unpackPayload(bomb, 1024 * 1024));
});

test('malformed packages are refused', async () => {
  await assert.rejects(() => framing.unpackPayload(Buffer.from([0, 0]), MAX), /too short/);
  const lying = Buffer.alloc(32);
  lying.writeUInt32BE(1000, 1);
  await assert.rejects(() => framing.unpackPayload(lying, MAX), /inconsistent/);
  const unknown = Buffer.alloc(32);
  unknown.writeUInt8(9, 0);
  await assert.rejects(() => framing.unpackPayload(unknown, MAX), /unknown/);
});
