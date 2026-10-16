import { useEffect, useRef, useSyncExternalStore } from 'react';
import { adminApi } from './api';

// One stream from the backend (GET /api/admin/live) that says which area of
// the panel just changed — a new account, a comment, an edited class … — so
// pages can refetch that instead of waiting for a timer. The stream carries no
// data; everything is still read through the normal, authorised endpoints.
//
// It is read with fetch() rather than EventSource so the token travels in the
// Authorization header and never in a URL.

type Listener = (areas: string[]) => void;

const listeners = new Set<Listener>();
const statusListeners = new Set<() => void>();
let connected = false;
let consumers = 0;
// Bumped on every start/stop; a read loop from an earlier generation gives up.
let generation = 0;
let controller: AbortController | null = null;
let retryTimer: number | undefined;
let retryMs = 1000;
let hadConnection = false;

function setConnected(next: boolean) {
  if (connected === next) return;
  connected = next;
  statusListeners.forEach((notify) => notify());
}

function emit(areas: string[]) {
  listeners.forEach((listener) => listener(areas));
}

function handleBlock(block: string) {
  let event = 'message';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (event !== 'change') return;
  try {
    const parsed = JSON.parse(data) as { areas?: unknown };
    const areas = Array.isArray(parsed.areas) ? parsed.areas.filter((a): a is string => typeof a === 'string') : [];
    emit(areas.length > 0 ? areas : ['all']);
  } catch {
    // a malformed block is ignored; the next one will be fine
  }
}

async function run(mine: number): Promise<void> {
  const token = adminApi.getToken();
  if (!token) return;
  let retry = true;
  controller = new AbortController();
  try {
    const res = await fetch('/api/admin/live', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      retry = false;
    } else if (res.ok && res.body && (res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      retryMs = 1000;
      setConnected(true);
      // After a gap anything may have changed; the first connection follows a fresh page load.
      if (hadConnection) emit(['all']);
      hadConnection = true;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let cut = buffer.indexOf('\n\n');
        while (cut >= 0) {
          handleBlock(buffer.slice(0, cut));
          buffer = buffer.slice(cut + 2);
          cut = buffer.indexOf('\n\n');
        }
      }
    }
  } catch {
    // aborted, offline or the server went away: fall through to the retry
  }
  if (mine !== generation) return;
  setConnected(false);
  if (retry && consumers > 0) {
    retryTimer = window.setTimeout(() => { void run(mine); }, retryMs);
    retryMs = Math.min(retryMs * 2, 15000);
  }
}

function start() {
  generation++;
  window.clearTimeout(retryTimer);
  controller?.abort();
  retryMs = 1000;
  void run(generation);
}

function stop() {
  generation++;
  window.clearTimeout(retryTimer);
  controller?.abort();
  controller = null;
  hadConnection = false;
  setConnected(false);
}

// Keeps the stream open for as long as the calling component is mounted.
export function useLiveConnection(): void {
  useEffect(() => {
    consumers++;
    if (consumers === 1) start();
    return () => {
      consumers--;
      if (consumers === 0) stop();
    };
  }, []);
}

function subscribeStatus(notify: () => void) {
  statusListeners.add(notify);
  return () => { statusListeners.delete(notify); };
}

export function useLiveStatus(): boolean {
  return useSyncExternalStore(subscribeStatus, () => connected);
}

// Calls `onChange` (at most every few seconds) when one of `areas` changes;
// returns the unsubscribe function. For code outside a component's hooks.
export function subscribeLive(areas: readonly string[], onChange: () => void, minGapMs = 2000): () => void {
  const wanted = new Set(areas);
  let timer: number | undefined;
  const listener: Listener = (changed) => {
    if (!changed.includes('all') && !changed.some((area) => wanted.has(area))) return;
    if (timer !== undefined) return;
    timer = window.setTimeout(() => { timer = undefined; onChange(); }, minGapMs);
  };
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    window.clearTimeout(timer);
  };
}

// Calls onChange when one of the given areas changes on the server. Bursts are
// folded into one call, calls keep a minimum distance, and a hidden tab waits
// until it is looked at again.
export function useLive(areas: readonly string[], onChange: () => void, minGapMs = 1500): void {
  const latest = useRef(onChange);
  latest.current = onChange;
  const key = areas.join(',');

  useEffect(() => {
    const wanted = new Set(key.split(','));
    let timer: number | undefined;
    let stale = false;
    let last = 0;

    const fire = () => {
      timer = undefined;
      if (document.hidden) { stale = true; return; }
      last = Date.now();
      latest.current();
    };
    const listener: Listener = (changed) => {
      if (!changed.includes('all') && !changed.some((area) => wanted.has(area))) return;
      if (timer !== undefined) return;
      timer = window.setTimeout(fire, Math.max(300, minGapMs - (Date.now() - last)));
    };
    const onVisible = () => {
      if (!document.hidden && stale) { stale = false; fire(); }
    };

    listeners.add(listener);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      listeners.delete(listener);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearTimeout(timer);
    };
  }, [key, minGapMs]);
}
