import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// The usage statistics are never deleted: a visit only loses its account and
// stays as an anonymous count, and the per-class totals hold no account at
// all. A change that deletes them — in a clean-up job, a consent handler or a
// start-up step — would empty the Analytics page on the next deploy, so it
// fails here first.

const root = fileURLToPath(new URL('..', import.meta.url));
const FORBIDDEN = [
  /\busageSession\.delete(Many)?\s*\(/,
  /\busageClassDay\.delete(Many)?\s*\(/,
  /DELETE\s+FROM\s+`?usage_(sessions|class_days)`?/i,
  /TRUNCATE\s+(TABLE\s+)?`?usage_(sessions|class_days)`?/i,
  /DROP\s+TABLE\s+(IF\s+EXISTS\s+)?`?usage_(sessions|class_days)`?/i,
];

function sourceFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(ts|js|mjs|cjs)$/.test(name)) files.push(path);
  }
  return files;
}

test('no code deletes usage visits or class totals', () => {
  const hits = [];
  for (const file of [...sourceFiles(join(root, 'src')), ...sourceFiles(join(root, 'scripts'))]) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN) {
      if (pattern.test(text)) hits.push(`${relative(root, file)}: ${pattern}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('the schema is applied without accepting data loss', () => {
  const index = readFileSync(join(root, 'src', 'index.ts'), 'utf8');
  assert.ok(!/--accept-data-loss['"`]/.test(index.replace(/\/\/.*$/gm, '')), 'db push must not pass --accept-data-loss');
});
