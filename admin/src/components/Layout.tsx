import { ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Check, ChevronDown, ChevronRight, Globe2, History, LogOut, Menu, Moon, School, Search, Sun, X } from 'lucide-react';
import gsap from 'gsap';
import { useAuth } from '../hooks/useAuth';
import { prefersReducedMotion } from '../motion';
import { activeNavPath, dockFor, entryFor, navFor, type NavEntry, type NavGroup } from '../nav';
import { toggleTheme, useTheme } from '../theme';
import { useLiveConnection } from '../live';
import { useAccess, viewLabel, type View } from '../access';
import { rankedSchoolPicks } from '../schoolPicks';
import { useSwitchView } from '../useSwitchView';
import type { MeSchool } from '../types';
import { useTableLabels } from './kit';
import { Highlight } from './Highlight';
import { CommandPalette, SearchTrigger } from './CommandPalette';
import { useSlashToSearch } from '../useSlashToSearch';
import { moveIndicator, nudgeIndicator, placeIndicator, type IndicatorParts, type Span } from './dockMotion';

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

// ─── The view switcher: all schools, or one ──────────────────────────────────
// Top left, under the logo: which data the panel shows. Global and a school
// look different (icon, tone, label) so the two are never mistaken.

function ViewIcon({ view, size = 18 }: { view: View | null; size?: number }) {
  return view?.kind === 'school'
    ? <School size={size} strokeWidth={1.7} />
    : <Globe2 size={size} strokeWidth={1.7} />;
}

// How well a school matches a search: name start, word start, anywhere.
function schoolMatch(school: MeSchool, q: string): number {
  const fields = [school.name, school.shortName, school.slug].map((f) => f.toLowerCase());
  if (fields.some((f) => f.startsWith(q))) return 0;
  if (fields.some((f) => f.split(/[\s._-]+/).some((w) => w.startsWith(q)))) return 1;
  if (fields.some((f) => f.includes(q))) return 2;
  return -1;
}

type ViewChoice = { key: string; view: View; school: MeSchool | null; section: 'global' | 'frequent' | 'all' };

// How many schools the switcher offers as "Häufig" before the full list;
// with no more schools than that, the list itself is ordered by use.
const FREQUENT = 4;
// From this many schools on, the list gets a search field.
const SEARCH_FROM = 2;

export function ViewSwitcher({ compact = false }: { compact?: boolean }) {
  const { me, view } = useAccess();
  const { switchView } = useSwitchView();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const schools = useMemo(() => me?.schools ?? [], [me]);
  const choices = (me?.globalView ? 1 : 0) + schools.length;
  const searchable = schools.length >= SEARCH_FROM;

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    setQuery('');
    const onDown = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', onDown);
    // A keyboard on a phone would cover the list: focus the field only where
    // there is a real keyboard anyway.
    if (window.matchMedia('(pointer: fine)').matches) (searchRef.current ?? listRef.current)?.focus({ preventScroll: true });
    else listRef.current?.focus({ preventScroll: true });
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  const options = useMemo<ViewChoice[]>(() => {
    const out: ViewChoice[] = [];
    if (me?.globalView) out.push({ key: 'global', view: { kind: 'global' }, school: null, section: 'global' });
    const q = query.trim().toLowerCase();
    if (q) {
      const picks = me ? rankedSchoolPicks(me.username, schools.map((s) => s.id), schools.length) : [];
      const pickRank = (id: string) => { const i = picks.indexOf(id); return i < 0 ? picks.length : i; };
      schools
        .map((school) => ({ school, score: schoolMatch(school, q) }))
        .filter((m) => m.score >= 0)
        .sort((a, b) => a.score - b.score || pickRank(a.school.id) - pickRank(b.school.id) || a.school.name.localeCompare(b.school.name, 'de'))
        .forEach(({ school }) => out.push({ key: `s:${school.id}`, view: { kind: 'school', school }, school, section: 'all' }));
      return out;
    }
    const picks = me ? rankedSchoolPicks(me.username, schools.map((s) => s.id), schools.length) : [];
    if (schools.length > FREQUENT) {
      for (const id of picks.slice(0, FREQUENT)) {
        const school = schools.find((s) => s.id === id)!;
        out.push({ key: `f:${id}`, view: { kind: 'school', school }, school, section: 'frequent' });
      }
      [...schools].sort((a, b) => a.name.localeCompare(b.name, 'de'))
        .forEach((school) => out.push({ key: `s:${school.id}`, view: { kind: 'school', school }, school, section: 'all' }));
    } else {
      // Few schools: one list, the ones used most on top.
      const rank = (id: string) => { const i = picks.indexOf(id); return i < 0 ? picks.length : i; };
      [...schools].sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name, 'de'))
        .forEach((school) => out.push({ key: `s:${school.id}`, view: { kind: 'school', school }, school, section: 'all' }));
    }
    return out;
  }, [me, schools, query]);

  // The current view is where the keyboard starts.
  useEffect(() => {
    if (!open) return;
    if (query.trim()) { setActive(options.length > 1 && options[0]?.section === 'global' ? 1 : 0); return; }
    const current = options.findIndex((o) => (view?.kind === 'global' ? o.section === 'global' : o.school?.id === (view?.kind === 'school' ? view.school.id : '') && o.section === 'all'));
    setActive(Math.max(0, current));
  }, [open, query, options, view]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function choose(next: View) {
    close(false);
    switchView(next);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
    if (options.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % options.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + options.length) % options.length); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); const o = options[active]; if (o) choose(o.view); }
  }

  const isGlobal = view?.kind !== 'school';
  const listId = compact ? 'view-list-compact' : 'view-list';
  const frequentCount = options.filter((o) => o.section === 'frequent').length;
  const allCount = options.filter((o) => o.section === 'all').length;

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={buttonRef}
        type="button"
        className="view-switch"
        data-kind={isGlobal ? 'global' : 'school'}
        data-compact={compact}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => choices > 1 && setOpen((o) => !o)}
        disabled={choices <= 1}
        title={choices <= 1 ? undefined : 'Ansicht wechseln'}
      >
        <span className="view-switch-icon"><ViewIcon view={view} size={compact ? 16 : 18} /></span>
        <span className="min-w-0 flex-1 text-left">
          {!compact && <span className="block text-[11px] font-medium uppercase tracking-[0.1em] opacity-70">{isGlobal ? 'Globale Ansicht' : 'Schule'}</span>}
          <span className="block truncate text-[14px] font-medium leading-snug">{viewLabel(view)}</span>
        </span>
        {choices > 1 && <ChevronDown size={16} strokeWidth={1.8} className="view-switch-chevron flex-shrink-0" data-open={open} />}
      </button>

      {open && (
        <>
          {compact && <div className="view-scrim" aria-hidden="true" onClick={() => close(false)} />}
          <div className="view-pop" data-sheet={compact} onKeyDown={onKeyDown}>
            {compact && (
              <div className="view-sheet-head">
                <span className="text-[15px] font-semibold">Ansicht wählen</span>
                <button type="button" className="orb h-9 w-9" aria-label="Schließen" onClick={() => close(true)}><X size={17} strokeWidth={1.8} /></button>
              </div>
            )}
            {searchable && (
              <label className="view-search">
                <Search size={15} strokeWidth={1.8} aria-hidden="true" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`${schools.length} Schulen durchsuchen`}
                  aria-label="Schule suchen"
                  role="combobox"
                  aria-expanded="true"
                  aria-controls={listId}
                  aria-activedescendant={options[active] ? `${listId}-${active}` : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  enterKeyHint="go"
                />
                {query && <button type="button" tabIndex={-1} className="view-search-clear" aria-label="Suche leeren" onClick={() => { setQuery(''); searchRef.current?.focus(); }}><X size={14} strokeWidth={2} /></button>}
              </label>
            )}
            <div ref={listRef} id={listId} className="view-list" role="listbox" aria-label="Ansicht wählen" tabIndex={-1}>
              {options.map((o, index) => {
                const selected = o.section !== 'frequent' && (o.view.kind === 'global' ? isGlobal : view?.kind === 'school' && view.school.id === o.school?.id);
                const header =
                  o.section === 'frequent' && options[index - 1]?.section !== 'frequent' ? 'Häufig' :
                  o.section === 'all' && options[index - 1]?.section !== 'all' && (frequentCount > 0 || query.trim()) ? (query.trim() ? `${allCount} Treffer` : `Alle Schulen · ${schools.length}`) : null;
                return (
                  <div key={o.key}>
                    {header && <div className="view-section">{header}</div>}
                    <button
                      type="button"
                      id={`${listId}-${index}`}
                      data-index={index}
                      role="option"
                      aria-selected={selected}
                      data-active={index === active}
                      className="view-option"
                      data-kind={o.view.kind}
                      tabIndex={-1}
                      onMouseMove={() => setActive(index)}
                      onClick={() => choose(o.view)}
                    >
                      <span className="view-switch-icon">{o.view.kind === 'global' ? <Globe2 size={16} strokeWidth={1.7} /> : o.section === 'frequent' ? <History size={16} strokeWidth={1.7} /> : <School size={16} strokeWidth={1.7} />}</span>
                      <span className="min-w-0 flex-1">
                        {o.school ? (
                          <>
                            <span className="block truncate text-[14px] font-medium"><Highlight text={o.school.name} query={query} /></span>
                            <span className="block truncate text-[12px] text-ink-3">
                              {o.school.shortName || o.school.slug}
                              {!o.school.menuId && ' · kein Mensaplan'}
                              {!o.school.active && ' · deaktiviert'}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="block text-[14px] font-medium">Alle Schulen</span>
                            <span className="block text-[12px] text-ink-3">Globale Verwaltung und Zahlen</span>
                          </>
                        )}
                      </span>
                      {selected && <Check size={16} strokeWidth={2} />}
                    </button>
                    {o.section === 'global' && options[index + 1] && <div className="view-divider" aria-hidden="true" />}
                  </div>
                );
              })}
              {query.trim() && allCount === 0 && <p className="px-3 py-3 text-[13.5px] text-ink-3">Keine Schule gefunden.</p>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// The view and the section, above every page: "Alle Schulen › Nutzer".
function ContextBar() {
  const { view } = useAccess();
  const { pathname } = useLocation();
  const section = entryFor(pathname);
  return (
    <div className="context-bar" data-kind={view?.kind ?? 'global'}>
      <ViewIcon view={view} size={14} />
      <span className="truncate">{viewLabel(view)}</span>
      {section && (
        <>
          <ChevronRight size={13} strokeWidth={1.8} className="flex-shrink-0 opacity-60" aria-hidden="true" />
          <span className="truncate text-ink-2">{section.label}</span>
        </>
      )}
    </div>
  );
}

// The sidebar rows only stagger in once per page load, not on every remount.
let sidebarIntroPlayed = false;

interface SidebarProps {
  groups: NavGroup[];
  username: string;
  onLogout: () => void;
}

function Sidebar({ groups, username, onLogout }: SidebarProps) {
  const { pathname } = useLocation();
  const items = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const active = activeNavPath(pathname, items);
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
  }, [placeMarker, groups]);

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
      <div className="flex-shrink-0 px-[22px] pb-4 pt-7">
        <Link to="/dashboard" className="flex h-9 items-center px-2" aria-label="Pokyh Admin Panel">
          <Wordmark />
        </Link>
        <div className="mt-4">
          <ViewSwitcher />
        </div>
      </div>

      <nav className="side-scroll min-h-0 flex-1 overflow-y-auto" aria-label="Hauptnavigation">
        <div ref={listRef} className="relative pb-4 pt-1" onMouseLeave={() => setGhostY(null)}>
          <span className="side-ghost" style={{ transform: `translateY(${ghostY ?? markerY ?? 0}px)`, opacity: ghostY === null || ghostY === markerY ? 0 : 1 }} />
          {markerY !== null && <span className="side-marker" style={{ transform: `translateY(${markerY}px)` }} />}
          {groups.map((group, groupIndex) => (
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

// ─── Quick access: the tab bar along the bottom edge ─────────────────────────
// Touch screens below the sidebar width: the most used sections one tap away,
// and "Mehr" with everything else. A tapped tab lights up at once and the
// page follows a frame later, so the pill is already moving (on the
// compositor, see dockMotion.ts) while the new page renders.

interface DockProps {
  entries: NavEntry[];
  allItems: NavEntry[];
  moreOpen: boolean;
  onMore: () => void;
  // Tapping the tab of the page already shown takes that page back to its top.
  onReselect: () => void;
  moreRef: React.RefObject<HTMLButtonElement | null>;
  // The page's scroll container: scrolling down tucks the bar away.
  scrollRef: React.RefObject<HTMLElement | null>;
}

// The bar plays its entrance once per page load, not on every remount.
let dockIntroPlayed = false;

// A tab: its dimmed icon (the lit one lives in the pill) and its label, once
// dimmed and once lit; the two labels cross-fade, so a tab never changes size.
function TabFace({ label, glyph }: { label: string; glyph: ReactNode }) {
  return (
    <span className="qdock-face">
      <span className="qdock-well">{glyph}</span>
      <span className="qdock-label">
        <span data-layer="off">{label}</span>
        <span data-layer="on" aria-hidden="true">{label}</span>
      </span>
    </span>
  );
}

const moreGlyph = (strokeWidth: number) => (
  <>
    <Menu size={20} strokeWidth={strokeWidth} className="qdock-more-menu" />
    <X size={20} strokeWidth={strokeWidth} className="qdock-more-close" />
  </>
);

function Dock({ entries, allItems, moreOpen, onMore, onReselect, moreRef, scrollRef }: DockProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const active = activeNavPath(pathname, allItems);
  // The tab tapped last, until the route has caught up with it.
  const [pending, setPending] = useState<string | null>(null);
  const shown = pending ?? active;
  const tabIndex = entries.findIndex((tab) => tab.to === shown);
  // The highlighted slot: a tab, "Mehr" (its sheet open, or a page not in
  // the bar), or none.
  const moreIndex = entries.length;
  const current = moreOpen || (tabIndex < 0 && shown !== null) ? moreIndex : tabIndex;

  const dockRef = useRef<HTMLElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const indRef = useRef<HTMLSpanElement>(null);
  const shownIndex = useRef<number | null>(null);
  const placed = useRef(false);
  const hidden = useRef(false);
  const navTimer = useRef<{ frame: number; timer: number } | null>(null);
  const [intro] = useState(() => !dockIntroPlayed && !prefersReducedMotion());

  const slot = (index: number) => rowRef.current?.querySelector<HTMLElement>(`[data-slot="${index}"]`) ?? null;
  const litSlot = (index: number) => indRef.current?.querySelector<HTMLElement>(`[data-lit="${index}"]`) ?? null;
  const rowWidth = () => rowRef.current?.getBoundingClientRect().width ?? 0;

  const indicator = (): IndicatorParts | null => {
    const root = indRef.current;
    const clipL = root?.firstElementChild as HTMLElement | null;
    const clipR = clipL?.firstElementChild as HTMLElement | null;
    const layer = clipR?.firstElementChild as HTMLElement | null;
    return root && clipL && clipR && layer ? { root, clipL, clipR, layer } : null;
  };

  // Where the pill sits behind a tab's icon, in the row's coordinates. From
  // the tab's own box (exact, unlike the rounded offsets): the face is scaled
  // while pressed or coming in, so its own box cannot be used.
  const spanOf = (index: number): { span: Span; top: number } | null => {
    const row = rowRef.current;
    const tab = index >= 0 ? slot(index) : null;
    const face = tab?.querySelector<HTMLElement>('.qdock-face');
    const well = face?.querySelector<HTMLElement>('.qdock-well');
    if (!row || !tab || !face || !well || well.offsetWidth === 0) return null;
    const box = tab.getBoundingClientRect();
    const origin = row.getBoundingClientRect();
    const left = box.left - origin.left + (box.width - well.offsetWidth) / 2;
    const top = box.top - origin.top + (box.height - face.offsetHeight) / 2;
    return { span: { left, right: left + well.offsetWidth }, top };
  };

  // The lit label fades in as the pill gets there and out as it leaves; the
  // icon in the pill pops in with it.
  const switchLabel = (index: number | null, on: boolean, at: number) => {
    const tab = index !== null ? slot(index) : null;
    if (!tab || index === null) return;
    const delay = Math.max(0, at - 0.05) * 1000;
    tab.querySelectorAll<HTMLElement>('.qdock-label > [data-layer]').forEach((layer) => {
      const to = (layer.dataset.layer === 'on') === on ? 1 : 0;
      // The style already shows the new state; the fade starts from what is
      // on screen: mid-fade where one runs, else the old state.
      const running = layer.getAnimations();
      const from = running.length > 0 ? Number(getComputedStyle(layer).opacity) : 1 - to;
      running.forEach((a) => a.cancel());
      if (from === to) return;
      layer.animate([{ opacity: from }, { opacity: to }], { duration: 180, delay, easing: 'ease-out', fill: 'backwards' });
    });
    const lit = litSlot(index)?.firstElementChild as HTMLElement | null;
    if (!lit) return;
    lit.getAnimations().forEach((a) => a.cancel());
    if (on) lit.animate([{ transform: 'scale(0.78)' }, { transform: 'scale(1)' }], { duration: 480, delay, easing: 'cubic-bezier(0.34, 1.7, 0.5, 1)', fill: 'backwards' });
  };

  useLayoutEffect(() => {
    const parts = indicator();
    if (!parts) return;
    const target = current >= 0 ? spanOf(current) : null;
    const previous = shownIndex.current;
    shownIndex.current = target ? current : null;
    if (target) parts.root.style.top = `${target.top}px`;
    if (!placed.current || prefersReducedMotion()) {
      placed.current = true;
      placeIndicator(parts, target?.span ?? null, rowWidth());
      return;
    }
    if (previous === current) return;
    const move = moveIndicator(parts, target?.span ?? null, rowWidth());
    switchLabel(previous, false, move.leave);
    switchLabel(target ? current : null, true, move.arrive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, entries.length]);

  // Rotating the phone moves the tabs: the pill goes along at once.
  useEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') return;
    let width = rowWidth();
    const observer = new ResizeObserver(() => {
      if (rowWidth() === width) return;
      width = rowWidth();
      const parts = indicator();
      const target = shownIndex.current !== null ? spanOf(shownIndex.current) : null;
      if (!parts || !target) return;
      parts.root.style.top = `${target.top}px`;
      placeIndicator(parts, target.span, width);
    });
    observer.observe(row);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!intro) return;
    dockIntroPlayed = true;
    const timer = window.setTimeout(() => dockRef.current?.removeAttribute('data-intro'), 1200);
    return () => window.clearTimeout(timer);
  }, [intro]);

  // The route caught up with the tapped tab (or went elsewhere meanwhile).
  useEffect(() => {
    if (!navTimer.current) setPending(null);
  }, [pathname]);

  const cancelNavigation = () => {
    if (!navTimer.current) return;
    cancelAnimationFrame(navTimer.current.frame);
    window.clearTimeout(navTimer.current.timer);
    navTimer.current = null;
  };
  useEffect(() => cancelNavigation, []);

  const setHidden = useCallback((on: boolean) => {
    if (hidden.current === on || !dockRef.current) return;
    hidden.current = on;
    dockRef.current.dataset.hidden = String(on);
  }, []);

  // Scrolling down tucks the bar away; up, the top or the very end of the
  // page brings it back. Always there while "Mehr" is open.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let lastY = scroller.scrollTop;
    const onScroll = () => {
      const y = scroller.scrollTop;
      const atEnd = y + scroller.clientHeight >= scroller.scrollHeight - 24;
      if (y < 60 || atEnd) setHidden(false);
      else if (y > lastY + 8) setHidden(true);
      else if (y < lastY - 8) setHidden(false);
      if (Math.abs(y - lastY) > 8) lastY = y;
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [scrollRef, setHidden]);

  // A new page, or the sheet opening, starts with the bar in view.
  useEffect(() => { if (moreOpen) setHidden(false); }, [moreOpen, setHidden]);
  useEffect(() => { setHidden(false); }, [pathname, setHidden]);

  // The page follows after the frame that starts the pill's motion: by then
  // the browser plays the motion by itself, and rendering the new page cannot
  // hold it up.
  const go = (to: string) => {
    cancelNavigation();
    const handle = { frame: 0, timer: 0 };
    handle.frame = requestAnimationFrame(() => {
      handle.timer = window.setTimeout(() => {
        navTimer.current = null;
        navigate(to);
      }, 0);
    });
    navTimer.current = handle;
  };

  const onTab = (e: React.MouseEvent<HTMLAnchorElement>, to: string) => {
    // A new tab or window stays the browser's.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (!moreOpen && to === shown) {
      if (pending) return;
      onReselect();
      const parts = indicator();
      const at = spanOf(current);
      if (parts && at && !prefersReducedMotion()) nudgeIndicator(parts, at.span);
      return;
    }
    if (moreOpen) onMore();
    if (to === active) {
      // Back to the page already shown: just the sheet closes.
      cancelNavigation();
      setPending(null);
      return;
    }
    setPending(to);
    go(to);
  };

  // A finger on a tab presses it in, its icon in the pill along with it;
  // letting go springs both back (CSS).
  const press = (on: boolean) => (e: React.PointerEvent<HTMLElement>) => {
    if (on && e.button !== 0) return;
    const targets = [e.currentTarget, litSlot(Number(e.currentTarget.dataset.slot))];
    for (const el of targets) {
      if (!el) continue;
      if (on) el.dataset.pressed = 'true';
      else delete el.dataset.pressed;
    }
  };
  const pressHandlers = { onPointerDown: press(true), onPointerUp: press(false), onPointerLeave: press(false), onPointerCancel: press(false) };

  return (
    <nav ref={dockRef} className="qdock" aria-label="Schnellzugriff" data-raised={moreOpen} data-intro={intro || undefined}>
      <div ref={rowRef} className="qdock-row">
        {entries.map(({ to, label, icon: Icon }, index) => (
          <Link
            key={to}
            to={to}
            data-slot={index}
            className="qdock-tab"
            data-on={current === index}
            aria-current={active === to ? 'page' : undefined}
            style={{ '--i': index } as React.CSSProperties}
            {...pressHandlers}
            onClick={(e) => onTab(e, to)}
          >
            <TabFace label={label} glyph={<Icon size={20} strokeWidth={1.7} />} />
          </Link>
        ))}
        <button
          ref={moreRef}
          type="button"
          data-slot={moreIndex}
          className="qdock-tab"
          data-on={current === moreIndex}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          style={{ '--i': moreIndex } as React.CSSProperties}
          {...pressHandlers}
          onClick={onMore}
        >
          <TabFace label="Mehr" glyph={moreGlyph(1.7)} />
        </button>
        {/* The pill: a window onto the lit icons, see dockMotion.ts. */}
        <span ref={indRef} className="qdock-ind" aria-hidden="true" style={{ '--i': Math.max(0, current) } as React.CSSProperties}>
          <span className="qdock-ind-clip" data-edge="left">
            <span className="qdock-ind-clip" data-edge="right">
              <span className="qdock-ind-layer">
                {entries.map(({ to, icon: Icon }, index) => (
                  <span key={to} className="qdock-ind-slot" data-lit={index}><span><Icon size={20} strokeWidth={2} /></span></span>
                ))}
                <span className="qdock-ind-slot" data-lit={moreIndex} data-open={moreOpen}><span>{moreGlyph(2)}</span></span>
              </span>
            </span>
          </span>
        </span>
      </div>
    </nav>
  );
}

interface MoreSheetProps {
  open: boolean;
  onClose: () => void;
  groups: NavGroup[];
  username: string;
  onLogout: () => void;
}

const DRAG_CLOSE_PX = 90;

function MoreSheet({ open, onClose, groups, username, onLogout }: MoreSheetProps) {
  const { pathname } = useLocation();
  const active = activeNavPath(pathname, groups.flatMap((g) => g.items));
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
        aria-modal={open || undefined}
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
          {groups.map((group) => (
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
  const { view, can, viewKey } = useAccess();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  useLiveConnection();
  useTableLabels(mainRef);

  const kind = view?.kind ?? 'global';
  const groups = useMemo(() => navFor(kind, can), [kind, can]);
  const dock = useMemo(() => dockFor(kind, can), [kind, can]);
  const allItems = useMemo(() => groups.flatMap((g) => g.items), [groups]);

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
  }, [pathname, viewKey]);

  useSlashToSearch(() => setSearchOpen(true));

  const closeSearch = useCallback(() => setSearchOpen(false), []);

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
          <Sidebar groups={groups} username={username} onLogout={handleLogout} />
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Small screens: the logo and the view switcher on top. */}
          <header className="mobile-top lg:hidden">
            <Link to="/dashboard" aria-label="Pokyh Admin Panel" className="flex-shrink-0 text-ink"><Mark size={24} /></Link>
            <div className="min-w-0 flex-1"><ViewSwitcher compact /></div>
            <button type="button" className="orb h-10 w-10 flex-shrink-0" aria-label="Suchen" aria-keyshortcuts="/" onClick={() => setSearchOpen(true)}>
              <Search size={18} strokeWidth={1.8} />
            </button>
            {/* Without a touch screen there is no bar at the bottom: the menu is here. */}
            <button type="button" className="orb only-fine h-10 w-10 flex-shrink-0" aria-label="Menü" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>
              <Menu size={18} strokeWidth={1.8} />
            </button>
          </header>
          {/* Wide screens: where you are, and the search. */}
          <div className="desk-top hidden lg:flex">
            <ContextBar />
            <SearchTrigger onOpen={() => setSearchOpen(true)} />
          </div>
          <main ref={mainRef} className="app-main scroll-touch scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            {bleed ? (
              <div key={`${viewKey}:${pathname}`} className="contents">{children}</div>
            ) : (
              <div key={`${viewKey}:${pathname}`} className="page-in mx-auto max-w-[1340px] px-4 pb-14 pt-5 sm:px-8 sm:pt-6 lg:pt-6 xl:px-14">
                <div className="lg:hidden"><ContextBar /></div>
                {children}
              </div>
            )}
          </main>
        </div>
      </div>

      {dock.length > 0 && (
        <Dock
          entries={dock}
          allItems={allItems}
          moreOpen={moreOpen}
          moreRef={moreRef}
          scrollRef={mainRef}
          onMore={() => setMoreOpen((open) => !open)}
          onReselect={() => mainRef.current?.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })}
        />
      )}
      <MoreSheet open={moreOpen} onClose={closeMore} groups={groups} username={username} onLogout={handleLogout} />
      <CommandPalette open={searchOpen} onClose={closeSearch} />
    </div>
  );
}
