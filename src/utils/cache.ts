import { config } from '../config';

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Tiny in-memory TTL cache. Single-process only (no Redis) — perfect for hot,
 * read-heavy, rarely-changing data like the public dish catalog. `get` returns
 * undefined once an entry is older than its TTL; `stale` ignores the TTL so a
 * caller can fall back to old data when the upstream fetch fails.
 */
export class TtlCache<V> {
  private store = new Map<string, Entry<V>>();

  /**
   * `maxEntries` bounds the memory a cache keyed by something unbounded (a
   * session, an account) can take: past it, the entries written longest ago
   * go first.
   */
  constructor(private readonly ttlMs: number = config.cacheTtlMs, private readonly maxEntries = 5_000) {}

  get(key: string): V | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    // Expired → report a miss but KEEP the value so `stale()` can still serve it
    // as a fallback when a fresh fetch fails (stale-while-revalidate).
    if (Date.now() > e.expiresAt) return undefined;
    return e.value;
  }

  stale(key: string): V | undefined {
    return this.store.get(key)?.value;
  }

  set(key: string, value: V): void {
    // Re-inserted, so the Map's order stays the order of the last write.
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  get size(): number {
    return this.store.size;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

// Shared cache for the public dish catalog (GET /dishes), one entry per menu
// and week. Invalidated by admin dish writes so the menu is always fresh
// after an edit/import.
export const dishesCache = new TtlCache<unknown>();

export function invalidateDishesCache(): void {
  dishesCache.clear();
}

// A new week is a new entry, so past weeks are rotated on its first request.
export function dishesCacheKey(menuId: string, weekMondayIso: string): string {
  return `dishes:${menuId}:${weekMondayIso}`;
}
