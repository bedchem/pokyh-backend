import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Loads one dependency-free TypeScript source file as an ES module. Only
// modules that import nothing but Node built-ins can be loaded this way, which
// is exactly the property that keeps them unit-testable without a database.
export async function loadTs(pathFromRepoRoot) {
  const source = await readFile(new URL(`../../${pathFromRepoRoot}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}
