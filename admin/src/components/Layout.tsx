import { ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { LogOut, Menu, Moon, Sun, X } from 'lucide-react';
import gsap from 'gsap';
import { useAuth } from '../hooks/useAuth';
import { prefersReducedMotion } from '../motion';
import { DOCK_TABS, NAV_GROUPS, activeNavPath } from '../nav';
import { toggleTheme, useTheme } from '../theme';
import { useLiveConnection } from '../live';
import { useTableLabels } from './kit';

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

// The new theme grows out of the icon, also when triggered by keyboard.
function toggleThemeFrom(button: HTMLElement) {
  const icon = (button.querySelector('.theme-icon') ?? button).getBoundingClientRect();
  toggleTheme({ x: icon.left + icon.width / 2, y: icon.top + icon.height / 2 });
}

function ThemeIcon({ theme }: { theme: 'light' | 'dark' }) {
  return (
    <span className="theme-icon">
      <Sun size={20} strokeWidth={1.6} data-shown={theme === 'dark'} />
      <Moon size={20} strokeWidth={1.6} data-shown={theme === 'light'} />
    </span>
  );
}

// The sidebar rows only stagger in once per page load, not on every remount.
let sidebarIntroPlayed = false;

interface SidebarProps {
  username: string;
  onLogout: () => void;
}

function Sidebar({ username, onLogout }: SidebarProps) {
  const { pathname } = useLocation();
  const active = activeNavPath(pathname);
  const theme = useTheme();
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
    // Only where the sidebar is actually shown; below lg the dock takes over.
    if (sidebarIntroPlayed || !list || list.offsetHeight === 0 || prefersReducedMotion()) return;
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
  }, []);

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
        <button
          type="button"
          className="side-link w-full text-left"
          aria-pressed={theme === 'dark'}
          onClick={(e) => toggleThemeFrom(e.currentTarget)}
        >
          <ThemeIcon theme={theme} />
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

// ─── Small screens: bottom bar and the "Mehr" sheet ─────────────────────────

interface DockProps {
  moreOpen: boolean;
  onMore: () => void;
  // Tapping the tab of the page already shown takes that page back to its top.
  onReselect: () => void;
  moreRef: React.RefObject<HTMLButtonElement | null>;
}

function Dock({ moreOpen, onMore, onReselect, moreRef }: DockProps) {
  const { pathname } = useLocation();
  const active = activeNavPath(pathname);
  const tabIndex = DOCK_TABS.findIndex((tab) => tab.to === active);
  // Pages without a tab of their own live under "Mehr", so that one lights up.
  const current = moreOpen || tabIndex < 0 ? DOCK_TABS.length : tabIndex;

  return (
    <nav className="dock lg:hidden" aria-label="Hauptnavigation">
      <div className="dock-row" style={{ ['--tabs' as string]: DOCK_TABS.length + 1 }}>
        <span className="dock-marker" style={{ transform: `translateX(${current * 100}%)` }} aria-hidden="true" />
        {DOCK_TABS.map(({ to, label, icon: Icon }, index) => (
          <Link
            key={to}
            to={to}
            className="dock-tab"
            data-on={current === index}
            aria-current={active === to ? 'page' : undefined}
            onClick={() => { if (active === to && !moreOpen) onReselect(); }}
          >
            <Icon size={22} strokeWidth={1.6} />
            <span className="dock-label">{label}</span>
          </Link>
        ))}
        <button
          ref={moreRef}
          type="button"
          className="dock-tab"
          data-on={current === DOCK_TABS.length}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          onClick={onMore}
        >
          <Menu size={22} strokeWidth={1.6} />
          <span className="dock-label">Mehr</span>
        </button>
      </div>
    </nav>
  );
}

interface MoreSheetProps {
  open: boolean;
  onClose: () => void;
  username: string;
  onLogout: () => void;
}

const DRAG_CLOSE_PX = 90;

function MoreSheet({ open, onClose, username, onLogout }: MoreSheetProps) {
  const { pathname } = useLocation();
  const active = activeNavPath(pathname);
  const theme = useTheme();
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Pulling the sheet down by its handle follows the finger; far enough closes it.
  const drag = useRef<{ startY: number; id: number } | null>(null);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDragY(0);
    setDragging(false);
    bodyRef.current?.scrollTo(0, 0);
    // After the sheet became visible, otherwise the focus would scroll it.
    const timer = window.setTimeout(() => closeRef.current?.focus({ preventScroll: true }), 60);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    drag.current = { startY: e.clientY, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    setDragY(Math.max(0, e.clientY - drag.current.startY));
  };
  const onPointerEnd = (e: React.PointerEvent) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    const pulled = e.clientY - drag.current.startY;
    drag.current = null;
    setDragging(false);
    // The release animates from where the finger let go, either way.
    setDragY(0);
    if (pulled > DRAG_CLOSE_PX) onClose();
  };

  return (
    <>
      <div className="more-scrim lg:hidden" data-open={open} onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Alle Bereiche"
        className="more-sheet lg:hidden"
        data-open={open}
        data-dragging={dragging}
        style={dragY > 0 ? { transform: `translateY(${dragY}px)` } : undefined}
        inert={!open}
      >
        <div
          className="more-head"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <span className="more-grip" aria-hidden="true" />
          <div className="flex items-center justify-between gap-4 px-5 pb-3 pt-2">
            <Wordmark />
            <button ref={closeRef} type="button" className="orb h-10 w-10" onClick={onClose} aria-label="Schließen">
              <X size={18} strokeWidth={1.7} />
            </button>
          </div>
        </div>

        <div ref={bodyRef} className="more-body">
          {NAV_GROUPS.map((group) => (
            <section key={group.title} className="mt-4 first:mt-1">
              <h2 className="px-1 pb-2.5 text-[11px] font-medium uppercase tracking-[0.12em] text-ink-4">{group.title}</h2>
              <div className="more-grid">
                {group.items.map(({ to, label, icon: Icon }) => (
                  <Link
                    key={to}
                    to={to}
                    className="more-item"
                    aria-current={active === to ? 'page' : undefined}
                    onClick={onClose}
                  >
                    <Icon size={22} strokeWidth={1.6} />
                    <span>{label}</span>
                  </Link>
                ))}
              </div>
            </section>
          ))}

          <div className="mt-6 flex flex-col border-t border-line pt-3">
            <button type="button" className="more-row" aria-pressed={theme === 'dark'} onClick={(e) => toggleThemeFrom(e.currentTarget)}>
              <ThemeIcon theme={theme} />
              <span className="flex-1">{theme === 'dark' ? 'Helles Design' : 'Dunkles Design'}</span>
            </button>
            <button type="button" className="more-row" onClick={onLogout}>
              <LogOut size={20} strokeWidth={1.6} />
              <span className="flex-1">Abmelden</span>
              <span className="max-w-[45%] truncate text-[12.5px] text-ink-3">{username}</span>
            </button>
          </div>
        </div>
      </div>
    </>
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
  const [moreOpen, setMoreOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  useLiveConnection();
  useTableLabels(mainRef);

  function handleLogout() {
    logout();
    navigate('/login');
  }

  const closeMore = useCallback(() => {
    setMoreOpen((wasOpen) => {
      if (wasOpen) moreRef.current?.focus({ preventScroll: true });
      return false;
    });
  }, []);

  useEffect(() => {
    setMoreOpen(false);
    mainRef.current?.scrollTo(0, 0);
  }, [pathname]);

  // The sheet belongs to small screens; growing past them closes it.
  useEffect(() => {
    if (!moreOpen) return;
    const wide = window.matchMedia('(min-width: 1024px)');
    const onChange = () => { if (wide.matches) setMoreOpen(false); };
    wide.addEventListener('change', onChange);
    return () => wide.removeEventListener('change', onChange);
  }, [moreOpen]);

  return (
    <div className="shell">
      <div className="sheet">
        <aside className="hidden w-[248px] flex-shrink-0 border-r border-line lg:block">
          <Sidebar username={username} onLogout={handleLogout} />
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <main ref={mainRef} className="app-main scroll-touch scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            {bleed ? children : (
              <div key={pathname} className="page-in mx-auto max-w-[1340px] px-4 pb-14 pt-7 sm:px-8 sm:pt-8 lg:pt-[50px] xl:px-14">
                {children}
              </div>
            )}
          </main>
        </div>
      </div>

      <Dock
        moreOpen={moreOpen}
        moreRef={moreRef}
        onMore={() => setMoreOpen((open) => !open)}
        onReselect={() => mainRef.current?.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })}
      />
      <MoreSheet open={moreOpen} onClose={closeMore} username={username} onLogout={handleLogout} />
    </div>
  );
}
