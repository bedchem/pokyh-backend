import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/utils/accountClass.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { mayJoinClass, normalizeAccountClass } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

test('parent accounts always receive an empty class identity', () => {
  assert.deepEqual(normalizeAccountClass('parent', 4711, ' 4A '), {
    klasseId: 0,
    klasseName: '',
  });
  assert.equal(mayJoinClass('parent'), false);
});

test('student class data remains available and is normalized', () => {
  assert.deepEqual(normalizeAccountClass('student', 4711, ' 4A '), {
    klasseId: 4711,
    klasseName: '4A',
  });
  assert.equal(mayJoinClass('student'), true);
});

test('invalid student class ids stay unassigned instead of creating class zero', () => {
  assert.deepEqual(normalizeAccountClass('student', 0, 'unknown'), {
    klasseId: 0,
    klasseName: 'unknown',
  });
});
