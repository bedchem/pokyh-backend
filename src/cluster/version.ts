import { readFileSync } from 'fs';
import path from 'path';

// What this server runs: the commit its build came from and when it was
// built (dist/build-info.json, written by scripts/build-info.js). Read once.

export interface BuildInfo {
  commit: string;
  builtAt: string;
}

let cached: BuildInfo | null = null;

export function buildInfo(): BuildInfo {
  if (!cached) {
    try {
      const parsed = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'build-info.json'), 'utf8')) as Partial<BuildInfo>;
      cached = {
        commit: typeof parsed.commit === 'string' && /^[0-9a-f]{40}$/.test(parsed.commit) ? parsed.commit : '',
        builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt.slice(0, 40) : '',
      };
    } catch {
      cached = { commit: '', builtAt: '' };
    }
  }
  return cached;
}
