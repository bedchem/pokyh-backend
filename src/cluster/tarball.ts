import { lstatSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { gzipSync } from 'zlib';

// A gzip-compressed POSIX (ustar) archive of selected files, for the bundle a
// node hands to a server it installs (provision.ts). Pure, tested on its own
// (tests/clusterInstall). Entries are sorted and carry fixed owners and
// times, so the same files always give the same archive; only regular files
// are included (no links, devices or absolute paths), and every name stays
// below the given prefix.

const BLOCK = 512;
// 2026-01-01T00:00:00Z — a fixed, plausible modification time.
const FIXED_MTIME = 1_767_225_600;

// Relative paths (with '/') of every regular file at or below the entries.
// Throws when an entry does not exist.
export function collectFiles(root: string, entries: string[]): string[] {
  const files = new Set<string>();
  const walk = (relative: string) => {
    const absolute = path.join(root, relative);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const child of readdirSync(absolute)) {
        if (child === '.DS_Store') continue;
        walk(path.posix.join(relative, child));
      }
      return;
    }
    if (stat.isFile()) files.add(relative.split(path.sep).join('/'));
  };
  for (const entry of entries) walk(entry);
  return [...files].sort();
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function splitName(name: string): { name: string; prefix: string } {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  for (let cut = name.lastIndexOf('/'); cut > 0; cut = name.lastIndexOf('/', cut - 1)) {
    const prefix = name.slice(0, cut);
    const rest = name.slice(cut + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return { name: rest, prefix };
  }
  throw new Error(`path is too long for the archive: ${name}`);
}

function header(name: string, size: number, mode: number): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  const split = splitName(name);
  block.write(split.name, 0, 100, 'utf8');
  block.write(octal(mode, 8), 100, 8, 'ascii');
  block.write(octal(0, 8), 108, 8, 'ascii');
  block.write(octal(0, 8), 116, 8, 'ascii');
  block.write(octal(size, 12), 124, 12, 'ascii');
  block.write(octal(FIXED_MTIME, 12), 136, 12, 'ascii');
  block.fill(' ', 148, 156);
  block.write('0', 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  block.write('root', 265, 32, 'ascii');
  block.write('root', 297, 32, 'ascii');
  block.write(split.prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

export function createTarGz(root: string, files: string[], prefix: string): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    if (file.startsWith('/') || file.split('/').includes('..')) throw new Error(`refusing unsafe path ${file}`);
    const absolute = path.join(root, file);
    const content = readFileSync(absolute);
    const executable = (lstatSync(absolute).mode & 0o111) !== 0;
    parts.push(header(`${prefix}/${file}`, content.length, executable ? 0o755 : 0o644), content);
    const padding = (BLOCK - (content.length % BLOCK)) % BLOCK;
    if (padding > 0) parts.push(Buffer.alloc(padding, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}
