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

  constructor(private readonly ttlMs: number = config.cacheTtlMs) {}

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
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

// Shared cache for the public dish catalog (GET /dishes). Invalidated by admin
// dish writes so the menu is always fresh after an edit/import.
export const dishesCache = new TtlCache<unknown>();
export const DISHES_CACHE_KEY = 'dishes:all';
