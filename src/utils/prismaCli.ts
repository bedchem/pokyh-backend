import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptions,
  type SpawnOptionsWithStdioTuple,
  type StdioNull,
  type StdioPipe,
} from 'child_process';
import type { Readable, Writable } from 'stream';

// Runs the Prisma CLI that is installed with the application, through the Node
// binary that runs the server: no shell and no npx lookup, so it behaves the
// same on every platform (on Windows `npx` is a .cmd script that cannot be
// started without a shell) and arguments are never re-parsed by a shell.
export function spawnPrismaCli(args: string[], options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe>): ChildProcessByStdio<Writable, Readable, Readable>;
export function spawnPrismaCli(args: string[], options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>): ChildProcessByStdio<null, Readable, Readable>;
export function spawnPrismaCli(args: string[], options: SpawnOptions): ChildProcess {
  const cli = require.resolve('prisma/build/index.js', { paths: [process.cwd(), __dirname] });
  return spawn(process.execPath, [cli, ...args], options);
}
