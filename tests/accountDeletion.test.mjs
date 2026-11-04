import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Every table holding an account has to be thought about when an account deletes
// itself: tied to the user row by a foreign key, or named in the deletion.
const schema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const deletion = await readFile(new URL('../src/services/accountDeletion.ts', import.meta.url), 'utf8');

const models = [...schema.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm)].map(([, name, body]) => ({ name, body }));
const delegate = (name) => name[0].toLowerCase() + name.slice(1);

// Not about a person: the row only says that tokens of an id are dead, and runs out.
const NOT_PERSONAL = new Set(['TokenRevocation']);

test('every table with an account in it goes with the account', () => {
  const holding = models.filter(({ name, body }) =>
    !NOT_PERSONAL.has(name) && /^\s+stableUid\s/m.test(body) && name !== 'User' && name !== 'Admin');
  assert.ok(holding.length > 10, 'the schema was read');
  const missing = holding
    .filter(({ body }) => !/@relation\(fields: \[stableUid\], references: \[stableUid\], onDelete: (Cascade|SetNull)\)/.test(body))
    .map(({ name }) => name)
    .filter((name) => !deletion.includes(`prisma.${delegate(name)}.`));
  assert.deepEqual(missing, []);
});

test('tables naming their author lose the name', () => {
  const holding = models.filter(({ body }) => /^\s+createdByName\s/m.test(body));
  assert.ok(holding.length >= 4, 'the schema was read');
  const missing = holding.map(({ name }) => name).filter((name) => !deletion.includes(`prisma.${delegate(name)}.updateMany`));
  assert.deepEqual(missing, []);
});
