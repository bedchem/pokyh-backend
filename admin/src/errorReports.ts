import { adminApi } from './api';

// Errors of the panel itself land in the server's error reports (Frontend-
// Logs, source "Admin-Panel"), scrubbed there like any other report. Each
// distinct error is sent once per page load, and at most a few a minute, so
// a render loop cannot flood them.

const MAX_PER_MINUTE = 5;
const seen = new Set<string>();
let windowStart = 0;
let sent = 0;

export function reportPanelError(error: unknown): void {
  const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Unbekannter Fehler');
  const key = `${err.name}:${err.message}`.slice(0, 300);
  if (seen.has(key)) return;
  const now = Date.now();
  if (now - windowStart > 60_000) { windowStart = now; sent = 0; }
  if (sent >= MAX_PER_MINUTE) return;
  seen.add(key);
  sent += 1;
  adminApi.reportPanelError({
    message: err.message.slice(0, 1000) || err.name,
    name: err.name.slice(0, 120),
    ...(err.stack ? { stack: err.stack.slice(0, 8000) } : {}),
    page: window.location.pathname,
    release: import.meta.env.MODE,
  });
}

export function startErrorReports(): void {
  window.addEventListener('error', (event) => {
    // Failed resource loads (an <img>) carry no error and are not the panel's.
    if (event.error || event.message) reportPanelError(event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => reportPanelError(event.reason));
}
