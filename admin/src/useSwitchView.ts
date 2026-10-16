import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAccess, type View } from './access';
import { allowed, entryFor } from './nav';

// Switches the panel's view (all schools, or one) and stays on the current
// section when the other view offers it; otherwise goes to the dashboard.
// `to` opens a given page in the new view instead.
export function useSwitchView() {
  const { me, setView } = useAccess();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // Whether the given view grants a permission (before switching to it).
  const canIn = useCallback((next: View, permission: string) => !!me && (me.owner || (next.kind === 'global' ? me.global.includes(permission) : next.school.permissions.includes(permission))), [me]);

  const switchView = useCallback((next: View, to?: { path: string; state?: unknown }) => {
    setView(next);
    if (to) {
      navigate(to.path, { state: to.state });
      return;
    }
    const entry = entryFor(pathname);
    if (entry && !allowed(entry, next.kind, (p) => canIn(next, p))) navigate('/dashboard');
  }, [setView, navigate, pathname, canIn]);

  return { switchView, canIn };
}
