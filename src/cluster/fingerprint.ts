import { createHash } from 'crypto';

// The fingerprint of a catalog's signature lines ("c|table|…", "u|table|…"):
// two nodes exchange rows only while theirs match. Pure, tested on its own
// (tests/clusterFingerprint).
export function fingerprintOf(lines: string[]): string {
  return createHash('sha256').update([...lines].sort().join('\n')).digest('hex').slice(0, 32);
}
