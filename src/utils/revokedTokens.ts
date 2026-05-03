// In-memory per-user revocation timestamps.
// When a user's session is revoked, we store the revocation epoch (seconds).
// Auth middleware rejects any JWT whose `iat` is older than this timestamp.
// Entries self-expire after JWT_MAX_LIFE so the map never grows unbounded.

const JWT_MAX_LIFE_MS = 8 * 60 * 60 * 1000; // 8 h — matches jwtExpiresIn

interface Entry {
  revokedAtSec: number; // seconds (matches JWT iat/exp)
  expiresAt: number;    // Date.now() ms — when to clean this entry up
}

const map = new Map<string, Entry>();

export function revokeUserTokens(stableUid: string): void {
  map.set(stableUid, {
    revokedAtSec: Math.floor(Date.now() / 1000),
    expiresAt: Date.now() + JWT_MAX_LIFE_MS,
  });
}

export function isTokenRevoked(stableUid: string, issuedAtSec: number): boolean {
  const entry = map.get(stableUid);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    map.delete(stableUid);
    return false;
  }
  return issuedAtSec <= entry.revokedAtSec;
}
