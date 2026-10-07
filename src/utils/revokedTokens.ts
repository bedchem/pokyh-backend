import { prisma } from '../db';
import { config } from '../config';
import { logger } from './logger';
import { tokenLifetimeMs } from './duration';

// Per-user revocation timestamps.
// When a user's session is revoked, we store the revocation epoch (seconds).
// Auth middleware rejects any JWT whose `iat` is older than this timestamp.
//
// The lookup itself stays in memory (it runs on every authenticated request),
// but each revocation is also written to the `token_revocations` table: that
// is what survives a restart and what reaches the other nodes of a cluster.
// Entries stop mattering once every token issued before them has expired.

// A revocation must outlive the longest-lived access token it has to block.
// The lifetime is operator-configurable, so it is derived from the same
// setting the tokens are signed with; an unparseable value falls back to a
// deliberately long window rather than a short one.
const FALLBACK_LIFE_MS = 24 * 60 * 60 * 1000;
const JWT_MAX_LIFE_MS = tokenLifetimeMs(config.jwtExpiresIn, FALLBACK_LIFE_MS);

interface Entry {
  revokedAtSec: number; // seconds (matches JWT iat/exp)
  expiresAt: number;    // Date.now() ms — when this entry stops mattering
}

const map = new Map<string, Entry>();

// Records a revocation in memory only. Used for revocations that already
// exist durably: ones loaded at startup and ones received from another node.
export function noteTokenRevocation(stableUid: string, revokedAt: Date): void {
  const revokedAtMs = revokedAt.getTime();
  if (!stableUid || !Number.isFinite(revokedAtMs)) return;
  const expiresAt = revokedAtMs + JWT_MAX_LIFE_MS;
  if (expiresAt <= Date.now()) return;
  const revokedAtSec = Math.floor(revokedAtMs / 1000);
  const current = map.get(stableUid);
  if (current && current.revokedAtSec >= revokedAtSec) return;
  map.set(stableUid, { revokedAtSec, expiresAt });
}

export function revokeUserTokens(stableUid: string): void {
  const revokedAt = new Date();
  noteTokenRevocation(stableUid, revokedAt);
  // Persisting is best-effort and never blocks the admin action: the
  // in-memory entry above already protects this process immediately.
  prisma.tokenRevocation
    .upsert({ where: { stableUid }, create: { stableUid, revokedAt }, update: { revokedAt } })
    .catch((err) => {
      logger.warn('Token revocation could not be persisted', {
        action: 'token_revocation_persist_failed',
        message: err instanceof Error ? err.message.split('\n')[0] : String(err),
      });
    });
}

// Restores still-relevant revocations after a restart.
export async function loadTokenRevocations(): Promise<number> {
  const cutoff = new Date(Date.now() - JWT_MAX_LIFE_MS);
  const rows = await prisma.tokenRevocation.findMany({ where: { revokedAt: { gt: cutoff } } });
  for (const row of rows) noteTokenRevocation(row.stableUid, row.revokedAt);
  return rows.length;
}

export function isTokenRevoked(stableUid: string, issuedAtSec: number): boolean {
  const entry = map.get(stableUid);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    map.delete(stableUid);
    return false;
  }
  return issuedAtSec < entry.revokedAtSec;
}
