import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

// Loads one dependency-free TypeScript source file as an ES module. Only
// modules that import nothing but Node built-ins and other such modules
// (relative imports, loaded the same way) can be loaded like this, which is
// exactly the property that keeps them unit-testable without a database.
const loaded = new Map();

async function moduleUrl(pathFromRepoRoot) {
  if (loaded.has(pathFromRepoRoot)) return loaded.get(pathFromRepoRoot);
  const source = await readFile(new URL(`../../${pathFromRepoRoot}`, import.meta.url), 'utf8');
  let compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const [, quote, specifier] of [...compiled.matchAll(/from\s+(['"])(\.\.?\/[^'"]+)\1/g)]) {
    const dependency = path.posix.join(path.posix.dirname(pathFromRepoRoot), `${specifier}.ts`);
    compiled = compiled.replaceAll(`${quote}${specifier}${quote}`, `${quote}${await moduleUrl(dependency)}${quote}`);
  }
  const url = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
  loaded.set(pathFromRepoRoot, url);
  return url;
}

export async function loadTs(pathFromRepoRoot) {
  return import(await moduleUrl(pathFromRepoRoot));
}
