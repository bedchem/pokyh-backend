import { useEffect, useRef } from 'react';

// "/" opens the search — the panel's only keyboard shortcut. It works while
// no field has the focus and no dialog is open, so typing "/" into a field
// stays typing.

function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

// A dialog that is open right now (closed sheets stay in the page, inert).
function dialogOpen(): boolean {
  return !!document.querySelector('[aria-modal="true"]:not([inert])');
}

export function useSlashToSearch(openSearch: () => void): void {
  const open = useRef(openSearch);
  open.current = openSearch;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.defaultPrevented || e.isComposing || e.repeat) return;
      // AltGr (Ctrl+Alt on Windows) types "/" on some layouts; other
      // modifiers mean another key combination.
      const altGr = e.getModifierState?.('AltGraph') ?? false;
      if ((e.metaKey || e.ctrlKey || e.altKey) && !altGr) return;
      if (typingIn(e.target) || dialogOpen()) return;
      e.preventDefault();
      open.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
