import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Bell, Building2, Globe2, History, MessageCircle, School, Search, ShieldCheck, User, UtensilsCrossed, X, type LucideIcon } from 'lucide-react';
import { adminApi } from '../api';
import { useAccess, type View } from '../access';
import { navFor, type NavEntry } from '../nav';
import { rankedSchoolPicks } from '../schoolPicks';
import { useSwitchView } from '../useSwitchView';
import { roleLabel } from '../roles';
import type { AccountRole, MeSchool, SearchKind, SearchResponse } from '../types';
import { Highlight } from './Highlight';
import { Spinner } from './kit';
import { relative } from './format';

// The panel's search: "/" anywhere, or the field at the top.
// Pages and schools are found as you type; accounts, classes, admins, dishes
// and comments come from the server — from every school the admin's rights
// reach, whichever view is open, each with its school. Picking one opens it,
// switching to the view that may show it. A filter narrows to one kind and
// shows more of it.

type Filter = 'all' | 'pages' | 'schools' | SearchKind;

interface Item {
  key: string;
  group: string;
  icon: LucideIcon;
  title: string;
  // Part of the title to mark as the match.
  match?: string;
  subtitle?: ReactNode;
  badge?: ReactNode;
  run: () => void;
}

interface Group {
  key: string;
  title: string;
  total?: number;
  items: Item[];
  // "Show all": the filter that lists every match of this kind.
  more?: Filter;
}

const FILTERS: Array<{ key: Filter; label: string; perm?: string }> = [
  { key: 'all', label: 'Alles' },
  { key: 'users', label: 'Benutzer', perm: 'users.view' },
  { key: 'classes', label: 'Klassen', perm: 'classes.view' },
  { key: 'admins', label: 'Admins', perm: 'admins.view' },
  { key: 'dishes', label: 'Gerichte', perm: 'mensa.view' },
  { key: 'comments', label: 'Kommentare', perm: 'comments.view' },
  { key: 'schools', label: 'Schulen' },
  { key: 'pages', label: 'Seiten' },
];

// Other words a page is found by.
const PAGE_WORDS: Record<string, string> = {
  '/dashboard': 'start übersicht home',
  '/analytics': 'statistik nutzung besucher',
  '/requests': 'anfragen requests api logs endpunkte fehler latenz',
  '/schools': 'schulen webuntis mensaplan',
  '/users': 'benutzer konten accounts schüler eltern',
  '/admins': 'rechte berechtigungen rollen',
  '/classes': 'klassen',
  '/sessions': 'sitzungen geräte login',
  '/dishes': 'mensa speiseplan essen gerichte menü',
  '/comments': 'kommentare bewertungen moderation',
  '/todos-reminders': 'aufgaben erinnerungen',
  '/popups': 'popups hinweise ankündigungen',
  '/logs/frontend': 'fehler fehlerberichte errors app web',
  '/logs/backend': 'server log dateien winston',
  '/audit': 'audit protokoll änderungen anmeldungen',
  '/system': 'leistung performance health monitoring',
  '/privacy': 'datenschutz dsgvo gdpr aufbewahrung',
  '/school-years': 'schuljahr archiv',
  '/api-keys': 'schlüssel keys',
  '/backups': 'sicherung export import',
  '/cluster': 'nodes server replikation',
  '/school': 'schule einstellungen',
  '/settings': 'konto passwort passkey 2fa',
};

const MIN_SERVER = 2;
const DEBOUNCE_MS = 160;

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me, view, can, canGlobal } = useAccess();
  const { switchView } = useSwitchView();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const listId = useId();

  // Whether the admin holds a permission in any school (or globally).
  const anywhere = useCallback((perm: string) => !!me && (me.owner || me.global.includes(perm) || me.schools.some((s) => s.permissions.includes(perm))), [me]);
  const filters = useMemo(() => FILTERS.filter((f) => !f.perm || anywhere(f.perm)), [anywhere]);

  // Focus before the next paint: what is typed right after "/" or ⌘K lands
  // in the field, not on the page.
  useLayoutEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    setQuery('');
    setFilter('all');
    setData(null);
    setError(null);
    inputRef.current?.focus({ preventScroll: true });
    return () => { returnFocus.current?.focus?.({ preventScroll: true }); };
  }, [open]);

  // Server results, debounced; an older answer never overwrites a newer one.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    const kinds: SearchKind[] | null = filter === 'all' ? null : filter === 'pages' || filter === 'schools' ? [] : [filter];
    if (q.length < MIN_SERVER || (kinds && kinds.length === 0)) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      adminApi.search(q, kinds, ctrl.signal)
        .then((res) => { setData(res); setError(null); })
        .catch((err) => { if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : 'Suche fehlgeschlagen'); })
        .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    }, DEBOUNCE_MS);
    return () => { ctrl.abort(); window.clearTimeout(timer); };
  }, [open, query, filter]);

  // Opens something of a school in a view that may show it: the current one
  // when it can, else that school's own view, else the global view.
  const openIn = useCallback((schoolIds: string[], perm: string, path: string, state?: unknown) => {
    if (!me) return;
    onClose();
    const inCurrent = view?.kind === 'global' ? canGlobal(perm) : view?.kind === 'school' && schoolIds.includes(view.school.id) && can(perm);
    if (inCurrent) { navigate(path, { state }); return; }
    const school = schoolIds.map((id) => me.schools.find((s) => s.id === id)).find((s): s is MeSchool => !!s && (me.owner || s.permissions.includes(perm)));
    if (school) { switchView({ kind: 'school', school }, { path, state }); return; }
    if (canGlobal(perm)) switchView({ kind: 'global' }, { path, state });
  }, [me, view, can, canGlobal, navigate, onClose, switchView]);

  const groups = useMemo<Group[]>(() => {
    if (!me) return [];
    const q = query.trim().toLowerCase();
    const out: Group[] = [];
    const show = (f: Filter) => filter === 'all' || filter === f;

    // Pages: this view's, plus the global view's when the admin has it.
    if (show('pages')) {
      const kind = view?.kind ?? 'global';
      const here = navFor(kind, can).flatMap((g) => g.items);
      const globalOnly = kind === 'school' && me.globalView ? navFor('global', canGlobal).flatMap((g) => g.items).filter((e) => !here.some((h) => h.to === e.to)) : [];
      const pages: Array<NavEntry & { global?: boolean }> = [...here, ...globalOnly.map((e) => ({ ...e, global: true }))];
      const hits = q
        ? pages.filter((p) => p.label.toLowerCase().includes(q) || (PAGE_WORDS[p.to] ?? '').includes(q))
        : filter === 'pages' ? pages : [];
      if (hits.length > 0) {
        out.push({
          key: 'pages',
          title: 'Seiten',
          items: hits.slice(0, filter === 'pages' ? 50 : 5).map((p) => ({
            key: `page:${p.to}`,
            group: 'pages',
            icon: p.icon,
            title: p.label,
            match: q,
            subtitle: p.global ? 'in der globalen Ansicht' : undefined,
            run: () => {
              onClose();
              if (p.global) switchView({ kind: 'global' }, { path: p.to });
              else navigate(p.to);
            },
          })),
        });
      }
    }

    // Schools: the ones picked often first while nothing is typed.
    if (show('schools')) {
      const schoolItem = (s: MeSchool, recent = false): Item => ({
        key: `school:${s.id}`,
        group: 'schools',
        icon: recent ? History : School,
        title: s.name,
        match: q,
        subtitle: [s.shortName || s.slug, !s.menuId && 'kein Mensaplan', !s.active && 'deaktiviert'].filter(Boolean).join(' · '),
        badge: view?.kind === 'school' && view.school.id === s.id ? <span className="cmdk-badge">aktuell</span> : undefined,
        run: () => { onClose(); switchView({ kind: 'school', school: s }); },
      });
      const globalItem: Item = {
        key: 'school:global',
        group: 'schools',
        icon: Globe2,
        title: 'Alle Schulen',
        subtitle: 'Globale Ansicht',
        badge: view?.kind === 'global' ? <span className="cmdk-badge">aktuell</span> : undefined,
        run: () => { onClose(); switchView({ kind: 'global' } as View); },
      };
      let items: Item[] = [];
      if (q) {
        items = me.schools
          .filter((s) => [s.name, s.shortName, s.slug].some((f) => f.toLowerCase().includes(q)))
          .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name, 'de'))
          .slice(0, filter === 'schools' ? 100 : 5)
          .map((s) => schoolItem(s));
        if (me.globalView && ('alle schulen global'.includes(q))) items.unshift(globalItem);
      } else if (me.schools.length + (me.globalView ? 1 : 0) > 1) {
        const picks = rankedSchoolPicks(me.username, me.schools.map((s) => s.id), filter === 'schools' ? me.schools.length : 4);
        const rest = filter === 'schools' ? me.schools.filter((s) => !picks.includes(s.id)).sort((a, b) => a.name.localeCompare(b.name, 'de')) : [];
        items = [
          ...(me.globalView ? [globalItem] : []),
          ...picks.map((id) => schoolItem(me.schools.find((s) => s.id === id)!, true)),
          ...rest.map((s) => schoolItem(s)),
        ];
      }
      if (items.length > 0) out.push({ key: 'schools', title: q ? 'Schulen' : 'Ansicht wechseln', items });
    }

    const r = data?.results;
    if (r?.users && r.users.items.length > 0) {
      out.push({
        key: 'users',
        title: 'Benutzer',
        total: r.users.total,
        more: filter === 'all' && r.users.total > r.users.items.length ? 'users' : undefined,
        items: r.users.items.map((u) => ({
          key: `user:${u.id}`,
          group: 'users',
          icon: User,
          title: u.username,
          match: q,
          subtitle: [u.role !== 'none' ? roleLabel(u.role as AccountRole) : null, u.className, u.local ? 'lokales Konto' : null, u.schoolName].filter(Boolean).join(' · '),
          badge: u.admin ? <span className="cmdk-badge" data-tone="violet">Admin</span> : undefined,
          run: () => openIn([u.schoolId], 'users.view', '/users', { open: u.id, search: u.username }),
        })),
      });
    }
    if (r?.classes && r.classes.items.length > 0) {
      out.push({
        key: 'classes',
        title: 'Klassen',
        total: r.classes.total,
        more: filter === 'all' && r.classes.total > r.classes.items.length ? 'classes' : undefined,
        items: r.classes.items.map((c) => ({
          key: `class:${c.id}`,
          group: 'classes',
          icon: Building2,
          title: c.name,
          match: q,
          subtitle: [`${c.members} ${c.members === 1 ? 'Mitglied' : 'Mitglieder'}`, c.code.toLowerCase() === q ? `Code ${c.code}` : null, c.schoolName].filter(Boolean).join(' · '),
          run: () => openIn([c.schoolId], 'classes.view', '/classes', { open: c.id, search: c.name }),
        })),
      });
    }
    if (r?.admins && r.admins.items.length > 0) {
      out.push({
        key: 'admins',
        title: 'Admins',
        total: r.admins.total,
        more: filter === 'all' && r.admins.total > r.admins.items.length ? 'admins' : undefined,
        items: r.admins.items.map((a) => ({
          key: `admin:${a.username}`,
          group: 'admins',
          icon: ShieldCheck,
          title: a.username,
          match: q,
          subtitle: a.owner ? 'Server-Owner' : a.global ? 'Global-Admin' : a.schools.length > 0 ? `Rechte in ${a.schools.join(', ')}` : a.schoolName ?? undefined,
          run: () => openIn([a.schoolId, ...me.schools.filter((s) => a.schools.includes(s.name)).map((s) => s.id)], 'admins.view', '/admins', { open: a.username }),
        })),
      });
    }
    if (r?.dishes && r.dishes.items.length > 0) {
      out.push({
        key: 'dishes',
        title: 'Gerichte',
        total: r.dishes.total,
        more: filter === 'all' && r.dishes.total > r.dishes.items.length ? 'dishes' : undefined,
        items: r.dishes.items.map((d) => ({
          key: `dish:${d.id}`,
          group: 'dishes',
          icon: UtensilsCrossed,
          title: d.name,
          match: q,
          subtitle: [d.menuName, d.plan === 'summer' ? 'Sommerplan' : 'Winterplan', d.schoolIds.length === 0 ? 'keiner Schule zugewiesen' : null].filter(Boolean).join(' · '),
          run: () => openIn(d.schoolIds, 'mensa.view', '/dishes', { menuId: d.menuId, search: d.name, plan: d.plan }),
        })),
      });
    }
    if (r?.comments && r.comments.items.length > 0) {
      out.push({
        key: 'comments',
        title: 'Kommentare',
        total: r.comments.total,
        more: filter === 'all' && r.comments.total > r.comments.items.length ? 'comments' : undefined,
        items: r.comments.items.map((c) => ({
          key: `comment:${c.type}:${c.id}`,
          group: 'comments',
          icon: c.type === 'dish' ? MessageCircle : Bell,
          title: c.body,
          match: q,
          subtitle: [c.username, c.context, relative(c.createdAt), c.schoolName].filter(Boolean).join(' · '),
          run: () => openIn([c.schoolId], 'comments.view', '/comments', c.type === 'dish'
            ? { tab: 'dishes', dishKey: c.dishKey, menuId: c.menuId, search: c.context ?? '' }
            : { tab: 'reminders', search: c.context ?? '' }),
        })),
      });
    }
    return out;
  }, [me, view, can, canGlobal, query, filter, data, navigate, onClose, switchView, openIn]);

  // One flat list for the keyboard; "show all" rows take a place too.
  const flat = useMemo(() => {
    const rows: Array<{ item?: Item; more?: Filter; total?: number; title?: string }> = [];
    for (const g of groups) {
      for (const item of g.items) rows.push({ item });
      if (g.more) rows.push({ more: g.more, total: g.total, title: g.title });
    }
    return rows;
  }, [groups]);

  useEffect(() => { setActive(0); }, [query, filter, data]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function runRow(index: number) {
    const row = flat[index];
    if (!row) return;
    if (row.item) row.item.run();
    else if (row.more) { setFilter(row.more); inputRef.current?.focus(); }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (flat.length) setActive((i) => (i + 1) % flat.length); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (flat.length) setActive((i) => (i - 1 + flat.length) % flat.length); return; }
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); runRow(active); return; }
    // Focus stays inside the dialog.
    if (e.key === 'Tab') {
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>('input, button:not([tabindex="-1"])');
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  if (!open) return null;

  const q = query.trim();
  const serverPending = q.length >= MIN_SERVER && loading;
  const nothing = !loading && !error && flat.length === 0;
  let index = -1;

  return (
    <div className="cmdk-root" onKeyDown={onKeyDown}>
      <div className="cmdk-scrim" aria-hidden="true" onClick={onClose} />
      <div ref={dialogRef} className="cmdk" role="dialog" aria-modal="true" aria-label="Suche">
        <div className="cmdk-head">
          <Search size={19} strokeWidth={1.8} className="flex-shrink-0 text-ink-3" aria-hidden="true" />
          <input
            ref={inputRef}
            className="cmdk-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Benutzer, Klassen, Schulen, Seiten suchen …"
            aria-label="Suchen"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={flat[active] ? `${listId}-${active}` : undefined}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="search"
            maxLength={64}
          />
          {serverPending && <Spinner />}
          {query && !serverPending && (
            <button type="button" className="cmdk-clear" aria-label="Suche leeren" onClick={() => { setQuery(''); inputRef.current?.focus(); }}>
              <X size={15} strokeWidth={2} />
            </button>
          )}
          <button type="button" className="cmdk-cancel" onClick={onClose}>Abbrechen</button>
        </div>

        <div className="cmdk-filters" role="radiogroup" aria-label="Was suchen">
          {filters.map((f) => (
            <button
              key={f.key}
              type="button"
              role="radio"
              aria-checked={filter === f.key}
              className="cmdk-chip"
              onClick={() => { setFilter(f.key); inputRef.current?.focus({ preventScroll: true }); }}
            >
              {f.label}
              {f.key !== 'all' && f.key !== 'pages' && f.key !== 'schools' && data?.results[f.key as SearchKind] && filter === 'all' && (
                <span className="cmdk-chip-count">{data.results[f.key as SearchKind]!.total}</span>
              )}
            </button>
          ))}
        </div>

        <div ref={listRef} id={listId} className="cmdk-body" role="listbox" aria-label="Ergebnisse">
          {groups.map((g) => (
            <div key={g.key} role="group" aria-label={g.title} className="cmdk-group">
              <div className="cmdk-group-title">
                <span>{g.title}</span>
                {g.total !== undefined && <span className="tabular">{g.total > g.items.length ? `${g.items.length} von ${g.total}` : g.total}</span>}
              </div>
              {g.items.map((item) => {
                index += 1;
                const i = index;
                const Icon = item.icon;
                return (
                  <button
                    key={item.key}
                    id={`${listId}-${i}`}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    data-index={i}
                    tabIndex={-1}
                    className="cmdk-row"
                    onMouseMove={() => setActive(i)}
                    onClick={() => runRow(i)}
                  >
                    <span className="cmdk-icon"><Icon size={17} strokeWidth={1.7} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px] font-medium">{item.match ? <Highlight text={item.title} query={item.match} /> : item.title}</span>
                      {item.subtitle && <span className="block truncate text-[12.5px] text-ink-3">{item.subtitle}</span>}
                    </span>
                    {item.badge}
                  </button>
                );
              })}
              {g.more && (() => {
                index += 1;
                const i = index;
                return (
                  <button
                    id={`${listId}-${i}`}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    data-index={i}
                    tabIndex={-1}
                    className="cmdk-row cmdk-more"
                    onMouseMove={() => setActive(i)}
                    onClick={() => runRow(i)}
                  >
                    <span className="cmdk-icon"><ArrowRight size={16} strokeWidth={1.8} /></span>
                    <span className="flex-1 text-[13.5px]">Alle {g.total} {g.title} anzeigen</span>
                  </button>
                );
              })()}
            </div>
          ))}

          {error && <p className="cmdk-empty text-rose-deep">{error}</p>}
          {nothing && (
            <p className="cmdk-empty">
              {q.length === 0
                ? 'Tippe, um Benutzer, Klassen, Admins, Gerichte, Kommentare, Schulen und Seiten zu finden — über alle deine Schulen.'
                : q.length < MIN_SERVER && filter !== 'pages' && filter !== 'schools'
                  ? 'Noch ein Zeichen …'
                  : `Nichts gefunden für „${q}“.`}
            </p>
          )}
        </div>

      </div>
    </div>
  );
}

// The field at the top of the page (wide screens) that opens the search.
export function SearchTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="search-trigger" onClick={onOpen} aria-keyshortcuts="/">
      <Search size={16} strokeWidth={1.8} aria-hidden="true" />
      <span className="flex-1 truncate text-left">Suchen …</span>
      <kbd>/</kbd>
    </button>
  );
}
