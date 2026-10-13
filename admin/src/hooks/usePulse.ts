import { useEffect, useState } from 'react';

export interface Pulse {
  // 'idle' until the first answer, and whenever /readyz is not routed to the
  // backend at all (a proxy that only exposes /admin and /api): in that case
  // the panel must not claim the server is down.
  state: 'idle' | 'up' | 'down';
  ms: number | null;
}

// Polls the unauthenticated readiness probe, which the request logger skips.
export function usePulse(intervalMs = 20000): Pulse {
  const [pulse, setPulse] = useState<Pulse>({ state: 'idle', ms: null });

  useEffect(() => {
    let alive = true;

    async function probe() {
      if (document.hidden) return;
      const started = performance.now();
      try {
        const res = await fetch('/readyz', { cache: 'no-store' });
        const ms = Math.round(performance.now() - started);
        if (!alive) return;
        const isJson = (res.headers.get('content-type') ?? '').includes('json');
        if (!isJson) setPulse({ state: 'idle', ms: null });
        else setPulse(res.ok ? { state: 'up', ms } : { state: 'down', ms: null });
      } catch {
        if (alive) setPulse({ state: 'down', ms: null });
      }
    }

    void probe();
    const timer = setInterval(() => void probe(), intervalMs);
    const onVisible = () => { if (!document.hidden) void probe(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);

  return pulse;
}
