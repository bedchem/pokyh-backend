import { readFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Loads one TypeScript source file as an ES module. Only modules that import
// nothing but Node built-ins, installed packages (sharp, marked …) and other
// such modules (relative imports, loaded the same way) can be loaded like
// this, which is exactly the property that keeps them unit-testable without
// a database.
const loaded = new Map();
const requireFromRepo = createRequire(new URL('../../package.json', import.meta.url));

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
  // An installed package, by where Node finds it from the repository.
  for (const [, quote, specifier] of [...compiled.matchAll(/from\s+(['"])([^./'"][^'"]*)\1/g)]) {
    if (isBuiltin(specifier)) continue;
    let file;
    try {
      file = pathToFileURL(requireFromRepo.resolve(specifier)).href;
    } catch {
      continue; // Not a package (a word in a comment): left as it is.
    }
    compiled = compiled.replaceAll(`${quote}${specifier}${quote}`, `${quote}${file}${quote}`);
  }
  const url = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
  loaded.set(pathFromRepoRoot, url);
  return url;
}

export async function loadTs(pathFromRepoRoot) {
  return import(await moduleUrl(pathFromRepoRoot));
}
