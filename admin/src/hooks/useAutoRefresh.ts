import { useEffect, useRef, useCallback, useState } from 'react';

export function useAutoRefresh(fn: () => void, intervalMs = 15000) {
  const [refreshing, setRefreshing] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try { await Promise.resolve(fn()); } finally { setRefreshing(false); }
  }, [fn]);

  useEffect(() => {
    timer.current = setInterval(fn, intervalMs);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [fn, intervalMs]);

  return { refresh, refreshing };
}
