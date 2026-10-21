// What a WebUntis session's requests keep needing (a bearer token, the school
// year, the CSRF token, the tenant), looked up once per session and kept for
// a while. Requests that ask while it is still being looked up share that one
// lookup, so a page firing five requests at once mints one token, not five.
// Only this plumbing is kept: what the person sees is always read live.
// Pure (the clock can be passed in), tested on its own
// (tests/webuntisMemo.test.mjs); ./client.ts keeps it in this process's memory.

interface Kept {
  value: unknown;
  until: number;
}

interface Entry {
  kept: Map<string, Kept>;
  loading: Map<string, Promise<unknown>>;
  touched: number;
}

export interface SessionMemo {
  /** The value kept under `key` while it is fresh. */
  peek<T>(sessionId: string, key: string): T | undefined;
  /** Keeps `value` under `key` for `ttlMs`. */
  keep(sessionId: string, key: string, value: unknown, ttlMs: number): void;
  /**
   * The value kept under `key` or, without one, what `load` finds, kept for
   * `ttlMs(value)` (0 or less: not kept, e.g. a failed lookup). One load per
   * session and key at a time: callers asking meanwhile share it.
   */
  get<T>(sessionId: string, key: string, load: () => Promise<T>, ttlMs: (value: T) => number): Promise<T>;
  /** Drops one key of a session (also a load under way), or the whole session. */
  forget(sessionId: string, key?: string): void;
}

export function createSessionMemo(opts: { maxSessions: number; idleMs: number; now?: () => number }): SessionMemo {
  const now = opts.now ?? Date.now;
  const sessions = new Map<string, Entry>();

  function entry(sessionId: string): Entry {
    const t = now();
    if (sessions.size > opts.maxSessions) {
      for (const [id, e] of sessions) if (t - e.touched > opts.idleMs) sessions.delete(id);
    }
    let e = sessions.get(sessionId);
    if (!e) {
      e = { kept: new Map(), loading: new Map(), touched: t };
      sessions.set(sessionId, e);
    }
    e.touched = t;
    return e;
  }

  function fresh(e: Entry, key: string): Kept | undefined {
    const kept = e.kept.get(key);
    if (kept && kept.until > now()) return kept;
    if (kept) e.kept.delete(key);
    return undefined;
  }

  return {
    peek<T>(sessionId: string, key: string): T | undefined {
      return fresh(entry(sessionId), key)?.value as T | undefined;
    },

    keep(sessionId, key, value, ttlMs) {
      if (ttlMs > 0) entry(sessionId).kept.set(key, { value, until: now() + ttlMs });
    },

    get<T>(sessionId: string, key: string, load: () => Promise<T>, ttlMs: (value: T) => number): Promise<T> {
      const e = entry(sessionId);
      const kept = fresh(e, key);
      if (kept) return Promise.resolve(kept.value as T);
      const pending = e.loading.get(key);
      if (pending) return pending as Promise<T>;
      // A load that was forgotten meanwhile neither keeps its answer nor
      // clears the load that replaced it.
      const loading: Promise<T> = load()
        .then((value) => {
          const ttl = ttlMs(value);
          if (e.loading.get(key) === loading && ttl > 0) e.kept.set(key, { value, until: now() + ttl });
          return value;
        })
        .finally(() => {
          if (e.loading.get(key) === loading) e.loading.delete(key);
        });
      e.loading.set(key, loading);
      return loading;
    },

    forget(sessionId, key) {
      if (key === undefined) {
        sessions.delete(sessionId);
        return;
      }
      const e = sessions.get(sessionId);
      e?.kept.delete(key);
      e?.loading.delete(key);
    },
  };
}
