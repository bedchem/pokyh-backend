import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

// What another page (the search, the dashboard) handed over when navigating
// here — an account to open, a filter. Read once, then removed from the
// history entry, so a reload or "back" does not open it again.
export function useHanded<T extends object>(): Partial<T> {
  const location = useLocation();
  const navigate = useNavigate();
  const [handed] = useState<Partial<T>>(() => (location.state && typeof location.state === 'object' ? (location.state as Partial<T>) : {}));
  useEffect(() => {
    if (location.state) navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return handed;
}
