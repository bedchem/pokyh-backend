import { useSyncExternalStore } from 'react';
import { prefersReducedMotion } from './motion';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'pokyh_admin_theme';
const CHANGE_EVENT = 'pokyh-theme';
// The colour of the sheet that fills the window, for the browser's own chrome.
const CANVAS: Record<Theme, string> = { light: '#ffffff', dark: '#161616' };

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// An explicit choice lives on <html data-theme>; without one the system decides.
export function currentTheme(): Theme {
  const chosen = document.documentElement.dataset.theme;
  return chosen === 'light' || chosen === 'dark' ? chosen : systemTheme();
}

function syncBrowserChrome(theme: Theme) {
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', CANVAS[theme]);
}

function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // storage unavailable: the choice lasts for this page load only
  }
  syncBrowserChrome(theme);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { ready: Promise<void> };
};

// Switches theme. Where the browser supports view transitions the new theme
// grows out of the point that was clicked; elsewhere it simply switches.
export function toggleTheme(origin?: { x: number; y: number }) {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  const doc = document as ViewTransitionDocument;
  if (!doc.startViewTransition || prefersReducedMotion()) {
    apply(next);
    return;
  }

  const x = origin?.x ?? window.innerWidth / 2;
  const y = origin?.y ?? window.innerHeight / 2;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));

  const transition = doc.startViewTransition(() => apply(next));
  void transition.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 700, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' },
    );
  }).catch(() => {
    // the transition was skipped; the theme itself has already been applied
  });
}

function subscribe(onChange: () => void) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', onChange);
  media.addEventListener('change', onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onChange);
    media.removeEventListener('change', onChange);
  };
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme);
}

// Another tab changed the theme: follow it, and keep the browser chrome in step.
export function startThemeSync(): void {
  syncBrowserChrome(currentTheme());
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    if (e.newValue === 'light' || e.newValue === 'dark') document.documentElement.dataset.theme = e.newValue;
    else delete document.documentElement.dataset.theme;
    syncBrowserChrome(currentTheme());
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => syncBrowserChrome(currentTheme()));
}
