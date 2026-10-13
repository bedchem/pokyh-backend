import { ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { LogOut, Menu, Moon, Sun, X } from 'lucide-react';
import gsap from 'gsap';
import { useAuth } from '../hooks/useAuth';
import { usePulse, type Pulse } from '../hooks/usePulse';
import { prefersReducedMotion } from '../motion';
import { NAV_GROUPS, activeNavPath } from '../nav';
import { toggleTheme, useTheme } from '../theme';
import { useLiveConnection, useLiveStatus } from '../live';

export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="currentColor" aria-hidden="true">
      <rect x="2.2" y="4.6" width="13.4" height="6.8" rx="3.4" transform="rotate(-38 8.9 8)" />
      <circle cx="21" cy="7.2" r="3.4" />
      <circle cx="7" cy="20.8" r="3.4" />
      <rect x="12.4" y="16.6" width="13.4" height="6.8" rx="3.4" transform="rotate(-38 19.1 20)" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="flex items-center gap-2.5 text-ink">
      <Mark />
      <span className="text-[22px] font-semibold leading-none tracking-[-0.03em]">pokyh</span>
    </span>
  );
}

// The sidebar rows only stagger in once per page load, not on every remount.
let sidebarIntroPlayed = false;

interface SidebarProps {
  username: string;
  pulse: Pulse;
  onLogout: () => void;
  intro?: boolean;
}

function Sidebar({ username, pulse, onLogout, intro = false }: SidebarProps) {
  const { pathname } = useLocation();
  const active = activeNavPath(pathname);
  const theme = useTheme();
  const live = useLiveStatus();
  const listRef = useRef<HTMLDivElement>(null);
  // Where the marker sits, or null while there is no active row to sit beside.
  const [markerY, setMarkerY] = useState<number | null>(null);
  // A lighter marker that goes to the row under the cursor.
  const [ghostY, setGhostY] = useState<number | null>(null);

  // The marker's position is plain state and a CSS transition moves it: one
  // source of truth, so a resize and a navigation can never fight over it.
  const placeMarker = useCallback(() => {
    const list = listRef.current;
    const link = active && list ? list.querySelector<HTMLElement>(`[data-nav="${active}"]`) : null;
    // offsetHeight is 0 while this sidebar is display:none (other breakpoint).
    setMarkerY(link && link.offsetHeight > 0 ? link.offsetTop + (link.offsetHeight - 20) / 2 : null);
    return link;
  }, [active]);

  useLayoutEffect(() => {
    const link = placeMarker();
    const scroller = listRef.current?.parentElement;
    if (!link || !scroller || link.offsetHeight === 0) return;
    // Keep the active row inside the scrolling list.
    const top = link.offsetTop;
    const bottom = top + link.offsetHeight;
    if (top < scroller.scrollTop + 16) scroller.scrollTop = Math.max(0, top - 44);
    else if (bottom > scroller.scrollTop + scroller.clientHeight - 24) scroller.scrollTop = bottom - scroller.clientHeight + 44;
  }, [placeMarker]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(() => { placeMarker(); });
    observer.observe(list);
    return () => observer.disconnect();
  }, [placeMarker]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!intro || sidebarIntroPlayed || !list || prefersReducedMotion()) return;
    const ctx = gsap.context(() => {
      gsap.from('[data-nav], [data-nav-title]', {
        autoAlpha: 0,
        duration: 0.5,
        ease: 'power1.out',
        stagger: 0.02,
        clearProps: 'opacity,visibility',
        onComplete: () => { sidebarIntroPlayed = true; },
      });
    }, list);
    return () => ctx.revert();
  }, [intro]);

  const pulseLabel = pulse.state === 'up' ? 'Server bereit' : pulse.state === 'down' ? 'Server nicht bereit' : 'Server';

  return (
    <div className="flex h-full flex-col">
      <Link to="/dashboard" className="flex h-[104px] flex-shrink-0 items-center px-[30px]" aria-label="Pokyh Admin Panel">
        <Wordmark />
      </Link>

      <nav className="side-scroll min-h-0 flex-1 overflow-y-auto" aria-label="Hauptnavigation">
        <div ref={listRef} className="relative pb-4 pt-1" onMouseLeave={() => setGhostY(null)}>
          <span className="side-ghost" style={{ transform: `translateY(${ghostY ?? markerY ?? 0}px)`, opacity: ghostY === null || ghostY === markerY ? 0 : 1 }} />
          {markerY !== null && <span className="side-marker" style={{ transform: `translateY(${markerY}px)` }} />}
          {NAV_GROUPS.map((group, groupIndex) => (
            <div key={group.title} className={groupIndex === 0 ? '' : 'mt-3'}>
              <div
                data-nav-title
                className="flex h-[30px] items-center px-[30px] text-[11px] font-medium uppercase tracking-[0.12em] text-ink-4"
              >
                {group.title}
              </div>
              {group.items.map(({ to, label, icon: Icon }) => (
                <Link
                  key={to}
                  to={to}
                  data-nav={to}
                  aria-current={active === to ? 'page' : undefined}
                  className="side-link"
                  onMouseEnter={(e) => setGhostY(e.currentTarget.offsetTop + (e.currentTarget.offsetHeight - 20) / 2)}
                >
                  <Icon size={20} strokeWidth={1.6} />
                  <span className="truncate">{label}</span>
                </Link>
              ))}
            </div>
          ))}
        </div>
      </nav>

      <div className="flex-shrink-0 pb-5 pt-1">
        <div className="side-link" data-static title="Bereitschaft von Server und Datenbank">
          <span className="flex w-5 flex-shrink-0 justify-center">
            <span className="live-dot" data-state={pulse.state} />
          </span>
          <span className="flex-1 truncate">{pulseLabel}</span>
          <span className="tabular text-[12px] text-ink-3" title={live ? 'Änderungen erscheinen sofort' : undefined}>
            {live ? 'live' : pulse.ms !== null ? `${pulse.ms} ms` : ''}
          </span>
        </div>
        <button
          type="button"
          className="side-link w-full text-left"
          aria-pressed={theme === 'dark'}
          onClick={(e) => {
            // The new theme grows out of the icon, also when triggered by keyboard.
            const icon = e.currentTarget.firstElementChild!.getBoundingClientRect();
            toggleTheme({ x: icon.left + icon.width / 2, y: icon.top + icon.height / 2 });
          }}
        >
          <span className="theme-icon">
            <Sun size={20} strokeWidth={1.6} data-shown={theme === 'dark'} />
            <Moon size={20} strokeWidth={1.6} data-shown={theme === 'light'} />
          </span>
          <span className="flex-1">{theme === 'dark' ? 'Helles Design' : 'Dunkles Design'}</span>
        </button>
        <button type="button" onClick={onLogout} className="side-link w-full text-left">
          <LogOut size={20} strokeWidth={1.6} />
          <span className="flex-1">Abmelden</span>
          <span className="max-w-[84px] truncate text-[12px] text-ink-3">{username}</span>
        </button>
      </div>
    </div>
  );
}

interface LayoutProps {
  children: ReactNode;
  // A bleed page lays out the full height itself instead of sitting in the padded column.
  bleed?: boolean;
}

export function Layout({ children, bleed = false }: LayoutProps) {
  const { logout, username } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const pulse = usePulse();
  useLiveConnection();

  function handleLogout() {
    logout();
    navigate('/login');
  }

  useEffect(() => {
    setMenuOpen(false);
    mainRef.current?.scrollTo(0, 0);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <div className="shell">
      <div className="sheet">
        <aside className="hidden w-[248px] flex-shrink-0 border-r border-line lg:block">
          <Sidebar username={username} pulse={pulse} onLogout={handleLogout} intro />
        </aside>

        {/* Drawer below lg */}
        <div
          className="fixed inset-0 z-40 lg:hidden"
          style={{
            background: 'var(--scrim)',
            opacity: menuOpen ? 1 : 0,
            pointerEvents: menuOpen ? 'auto' : 'none',
            transition: 'opacity 0.35s ease',
          }}
          onClick={() => setMenuOpen(false)}
          aria-hidden="true"
        />
        <aside
          className="fixed inset-y-0 left-0 z-50 w-[272px] bg-sheet lg:hidden"
          style={{
            transform: menuOpen ? 'translateX(0)' : 'translateX(-104%)',
            transition: 'transform 0.55s var(--glide)',
            visibility: menuOpen ? 'visible' : 'hidden',
            transitionProperty: 'transform, visibility',
          }}
          aria-hidden={!menuOpen}
        >
          <button
            type="button"
            className="orb absolute right-4 top-[30px] h-10 w-10"
            onClick={() => setMenuOpen(false)}
            aria-label="Menü schließen"
          >
            <X size={18} strokeWidth={1.7} />
          </button>
          <Sidebar username={username} pulse={pulse} onLogout={handleLogout} />
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-[64px] flex-shrink-0 items-center justify-between border-b border-line px-4 lg:hidden">
            <button type="button" className="orb h-10 w-10" onClick={() => setMenuOpen(true)} aria-label="Menü öffnen">
              <Menu size={18} strokeWidth={1.7} />
            </button>
            <Wordmark />
            <button type="button" className="orb h-10 w-10" onClick={handleLogout} aria-label="Abmelden" title="Abmelden">
              <LogOut size={17} strokeWidth={1.7} />
            </button>
          </header>

          <main ref={mainRef} className="scroll-touch scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            {bleed ? children : (
              <div key={pathname} className="page-in mx-auto max-w-[1340px] px-5 pb-14 pt-8 sm:px-8 lg:pt-[50px] xl:px-14">
                {children}
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
