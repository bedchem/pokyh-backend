import { useEffect, useRef, useState } from 'react';

// Whole minutes down to one minute, then seconds.
export function formatRemaining(ms: number): string {
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)} min`;
  return `${Math.max(0, Math.ceil(ms / 1000))} s`;
}

/** The difference to the server clock, from a response's serverTime. */
export function clockOffset(serverTime: string | undefined): number {
  const server = serverTime ? Date.parse(serverTime) : NaN;
  return Number.isFinite(server) ? server - Date.now() : 0;
}

/**
 * How long a WebUntis account made admin still has for its first login,
 * ticking every second. `offset` corrects for the server clock.
 */
export function AdminCountdown({ expiresAt, offset = 0, onExpired }: { expiresAt: string; offset?: number; onExpired?: () => void }) {
  const end = Date.parse(expiresAt);
  const [now, setNow] = useState(() => Date.now() + offset);
  const expiredRef = useRef(onExpired);
  expiredRef.current = onExpired;

  useEffect(() => {
    setNow(Date.now() + offset);
    const id = setInterval(() => setNow(Date.now() + offset), 1000);
    return () => clearInterval(id);
  }, [offset]);

  const left = end - now;
  const expired = left <= 0;
  useEffect(() => {
    if (expired) expiredRef.current?.();
  }, [expired]);

  return (
    <span
      className="tabular whitespace-nowrap text-[12.5px]"
      style={{ color: left < 60_000 ? 'var(--rose-deep)' : 'var(--amber-deep)' }}
      title="Ohne ersten Login mit dem Einmal-Passwort verfällt der Admin-Zugang"
    >
      {expired ? 'verfällt…' : `noch ${formatRemaining(left)}`}
    </span>
  );
}
