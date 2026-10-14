import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronRight,
  BookOpen,
  CalendarDays,
  ChartNoAxesColumn,
  Clock,
  Flame,
  Globe,
  Hourglass,
  Layers,
  Medal,
  MessagesSquare,
  Moon,
  RefreshCw,
  Repeat,
  Smartphone,
  Sparkles,
  Star,
  Sunrise,
  Timer,
  Trophy,
  Users,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react';
import { adminApi } from '../api';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import { useLive, useLiveStatus } from '../live';
import { useTheme, type Theme } from '../theme';
import { TrendChart, type TrendSeries } from '../components/TrendChart';
import { Bars, RankBars, Ring, SplitBar } from '../components/charts';
import { Avatar, Delta, Dialog, Empty, Figures, IconButton, Notice, PageHeader, SearchField, Section, Segmented, Spinner, TONES, Tag, useTableLabels, type Tone } from '../components/kit';
import type { AdminAnalytics, AnalyticsBreakdown, AnalyticsDish, AnalyticsPeople, AnalyticsPerson, AnalyticsRange, BreakdownKind, PeopleFilters, UsagePlatform } from '../types';

// ─── Vocabulary ─────────────────────────────────────────────────────────────

// iPhone and Android are the native apps only. Everything in a browser — on a
// phone or a computer, in a tab or installed to the home screen — is "Web".
const PLATFORM_ORDER: UsagePlatform[] = ['ios', 'android', 'web', 'other'];
const PLATFORM_LABEL: Record<UsagePlatform, string> = { ios: 'iPhone-App', android: 'Android-App', web: 'Web', other: 'Andere App' };

// One colour per platform, the same in every chart on the page. Checked for
// colour-vision deficiencies and contrast on both sheets; dark mode has its
// own, darker steps rather than the light ones.
const PLATFORM_COLOR: Record<Theme, Record<UsagePlatform, string>> = {
  light: { ios: '#4f96dc', android: '#3fae86', web: '#e0892f', other: '#9b7ad6' },
  dark:  { ios: '#4a8fd6', android: '#2f9a73', web: '#c9782a', other: '#9f80db' },
};
const NEUTRAL = '#4f96dc';

const WEEKDAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const WEEKDAYS_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

type Metric = 'users' | 'time' | 'sessions';
type TabKey = 'overview' | 'platforms' | 'usage' | 'features' | 'accounts';

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: 'overview',  label: 'Überblick' },
  { value: 'platforms', label: 'Plattformen' },
  { value: 'usage',     label: 'Nutzungszeiten' },
  { value: 'features',  label: 'Funktionen' },
  { value: 'accounts',  label: 'Konten' },
];
const TAB_KEY = 'pokyh_admin_analytics_tab';

function storedTab(): TabKey {
  try {
    const value = localStorage.getItem(TAB_KEY);
    return TABS.some((t) => t.value === value) ? value as TabKey : 'overview';
  } catch {
    return 'overview';
  }
}

// ─── Formatting ─────────────────────────────────────────────────────────────

const de = (value: number, digits = 0) => value.toLocaleString('de-AT', { maximumFractionDigits: digits });

function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} Sek.`;
  if (s < 600) return `${de(s / 60, 1)} Min.`;
  if (s < 3600) return `${Math.round(s / 60)} Min.`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m > 0 ? `${h} Std. ${m} Min.` : `${h} Std.`;
}

function hours(seconds: number): string {
  const h = seconds / 3600;
  return `${de(h, h < 10 ? 1 : 0)} Std.`;
}

function percent(part: number, whole: number): string {
  if (whole <= 0) return '–';
  const value = part / whole;
  return `${de(value * 100, value < 0.1 ? 1 : 0)} %`;
}

function dayDate(dayKey: string): Date {
  return new Date(`${dayKey}T12:00:00`);
}

function longDay(dayKey: string): string {
  return dayDate(dayKey).toLocaleDateString('de-AT', { weekday: 'short', day: 'numeric', month: 'long' });
}

function shortDay(dayKey: string, days: number): string {
  const d = dayDate(dayKey);
  return days > 31 ? `${d.getDate()}.${d.getMonth() + 1}.` : String(d.getDate()).padStart(2, '0');
}

function lastSeen(iso: string): string {
  const then = new Date(iso);
  const minutes = Math.floor((Date.now() - then.getTime()) / 60000);
  if (minutes < 3) return 'gerade eben';
  if (minutes < 60) return `vor ${minutes} Min.`;
  if (then.toDateString() === new Date().toDateString()) return `heute, ${then.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })}`;
  const days = Math.floor(minutes / 1440);
  if (days <= 1) return 'gestern';
  if (days < 30) return `vor ${days} Tagen`;
  return then.toLocaleDateString('de-AT', { day: 'numeric', month: 'short' });
}

function hourSpan(hour: number): string {
  return `${String(hour).padStart(2, '0')}–${String((hour + 1) % 24).padStart(2, '0')} Uhr`;
}

// ─── Small pieces ───────────────────────────────────────────────────────────

interface Fact {
  icon: LucideIcon;
  tone: Tone;
  value: string;
  label: string;
  // Opens the list of who is behind the fact.
  open?: () => void;
}

// Short statements with one number each, three to a row on wide screens.
function FactGrid({ facts, columns = 3 }: { facts: Fact[]; columns?: 2 | 3 }) {
  if (facts.length === 0) return <p className="mt-6 text-[14px] text-ink-3">Noch keine Daten in diesem Zeitraum.</p>;
  return (
    <ul className={`mt-7 grid gap-x-10 gap-y-7 sm:grid-cols-2 ${columns === 3 ? '2xl:grid-cols-3' : ''}`}>
      {facts.map((fact, i) => {
        const body = (
          <>
            <span className="orb h-11 w-11 flex-shrink-0" style={{ background: TONES[fact.tone].wash, color: TONES[fact.tone].deep }}>
              <fact.icon size={18} strokeWidth={1.6} />
            </span>
            <span className="block min-w-0">
              <span className="fact-value block truncate text-[17px] font-semibold leading-snug" title={fact.value}>{fact.value}</span>
              <span className="mt-0.5 block text-[13.5px] leading-snug text-ink-3">{fact.label}</span>
            </span>
          </>
        );
        return (
          <li key={fact.label} className="animate-fadeInUp min-w-0" style={{ animationDelay: `${i * 35}ms` }}>
            {fact.open
              ? <button type="button" className="fact-link flex w-full min-w-0 items-start gap-4 text-left" onClick={fact.open}>{body}</button>
              : <div className="flex min-w-0 items-start gap-4">{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}

function Legend({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <ul className="flex flex-wrap gap-x-6 gap-y-2" aria-hidden="true">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-[10px] text-[13.5px] text-ink-3">
          <i className="h-[7px] w-[7px] flex-shrink-0 rounded-full" style={{ background: item.color }} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

interface LedgerItem {
  label: string;
  value: string;
  hint?: string;
  open?: () => void;
}

function Ledger({ items, columns = 3 }: { items: LedgerItem[]; columns?: 2 | 3 }) {
  return (
    <dl className={`grid grid-cols-2 gap-x-8 gap-y-6 ${columns === 3 ? 'sm:grid-cols-3' : ''}`}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="truncate text-[13.5px] text-ink-3" title={item.hint ?? item.label}>{item.label}</dt>
          <dd className="tabular mt-0.5 text-[19px] font-semibold">
            {item.open
              ? <button type="button" className="ledger-link" onClick={item.open}><span className="ledger-value">{item.value}</span></button>
              : item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// One line under a section that says what its numbers mean.
function Explain({ children }: { children: ReactNode }) {
  return <p className="mt-5 max-w-[70ch] text-[13px] leading-relaxed text-ink-3">{children}</p>;
}

function Pair({ children }: { children: ReactNode }) {
  return <div className="grid gap-x-16 gap-y-14 xl:grid-cols-2">{children}</div>;
}

// ─── Popups: what is behind a figure ────────────────────────────────────────
// Three kinds, all alike: a search, a table sorted by a click on its header.

interface Sort<K extends string> {
  key: K;
  desc: boolean;
}

interface Column<K extends string> {
  key: K;
  label: string;
  // Numbers sit on the right and sort largest first.
  numeric?: boolean;
}

function nextSort<K extends string>(current: Sort<K>, key: K, numeric: boolean): Sort<K> {
  return current.key === key ? { key, desc: !current.desc } : { key, desc: numeric };
}

function SortHeader<K extends string>({ columns, sort, onSort }: { columns: Column<K>[]; sort: Sort<K>; onSort: (column: Column<K>) => void }) {
  return (
    <thead>
      <tr>
        {columns.map((column) => {
          const on = sort.key === column.key;
          return (
            <th
              key={column.key}
              aria-sort={on ? (sort.desc ? 'descending' : 'ascending') : 'none'}
              style={column.numeric ? { textAlign: 'right' } : undefined}
            >
              <button type="button" className="sort-btn" data-on={on} onClick={() => onSort(column)}>
                {column.label}
                {on && (sort.desc ? <ArrowDown size={12} strokeWidth={2} /> : <ArrowUp size={12} strokeWidth={2} />)}
              </button>
            </th>
          );
        })}
      </tr>
    </thead>
  );
}

// The common frame: search, a scrolling table, states for loading and errors.
function PopupBody({ error, loading, empty, search, onSearch, placeholder, footer, children }: {
  error: string | null;
  loading: boolean;
  empty: boolean;
  search: string;
  onSearch: (next: string) => void;
  placeholder: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <SearchField value={search} onChange={onSearch} placeholder={placeholder} />
      <div className="scrollbar-thin -mx-2 mt-4 max-h-[60vh] overflow-y-auto px-2">
        {error ? (
          <p className="py-10 text-center text-[14px] text-ink-3">{error}</p>
        ) : loading ? (
          <div className="flex justify-center py-12"><Spinner size={20} /></div>
        ) : empty ? (
          <p className="py-10 text-center text-[14px] text-ink-3">{search ? 'Kein Treffer.' : 'Nichts in diesem Zeitraum.'}</p>
        ) : children}
      </div>
      {footer && <p className="mt-4 text-[12.5px] text-ink-3">{footer}</p>}
    </>
  );
}

// Loads a popup's data once per input and keeps it while it is open.
function usePopupData<T>(load: () => Promise<T>, key: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    latest.current()
      .then((next) => { if (alive) setData(next); })
      .catch((err) => { if (alive) setError(err instanceof Error ? err.message : 'Die Liste konnte nicht geladen werden.'); });
    return () => { alive = false; };
  }, [key]);
  return { data, error };
}

// ── Who ─────────────────────────────────────────────────────────────────────

// Accounts are only named with their consent to the usage statistics; the
// rest of a figure is said in one line under the list.
function peopleFooter(result: AnalyticsPeople): string | undefined {
  const parts: string[] = [];
  if (result.total > result.people.length) parts.push(`Gezeigt werden ${de(result.people.length)} von ${de(result.total)} Konten.`);
  if (result.hidden > 0) parts.push(`${de(result.hidden)} weitere ${result.hidden === 1 ? 'Konto' : 'Konten'} ohne Einwilligung zur Nutzungsstatistik ${result.hidden === 1 ? 'wird' : 'werden'} nicht einzeln gezeigt.`);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

type SortKey = 'username' | 'seconds' | 'visits' | 'activeDays' | 'lastSeenAt';

const COLUMNS: Column<SortKey>[] = [
  { key: 'username', label: 'Konto' },
  { key: 'seconds', label: 'Zeit', numeric: true },
  { key: 'visits', label: 'Besuche', numeric: true },
  { key: 'activeDays', label: 'Tage', numeric: true },
  { key: 'lastSeenAt', label: 'Zuletzt', numeric: true },
];

interface PeopleView {
  title: string;
  filters: PeopleFilters;
  sort: SortKey;
  // A range of its own (e.g. "last 7 days" whatever the page shows).
  days?: AnalyticsRange;
  search?: string;
}

function compare(a: AnalyticsPerson, b: AnalyticsPerson, key: SortKey): number {
  if (key === 'username') return a.username.localeCompare(b.username, 'de');
  if (key === 'lastSeenAt') return (a.lastSeenAt ?? '').localeCompare(b.lastSeenAt ?? '');
  return a[key] - b[key];
}

function PeopleDialog({ view, days, colors, onClose }: { view: PeopleView; days: AnalyticsRange; colors: Record<UsagePlatform, string>; onClose: () => void }) {
  const range = view.days ?? days;
  const [query, setQuery] = useState(view.search ?? '');
  const [sort, setSort] = useState<Sort<SortKey>>({ key: view.sort, desc: view.sort !== 'username' });
  const tableRef = useRef<HTMLDivElement>(null);
  useTableLabels(tableRef);
  const { data: result, error } = usePopupData<AnalyticsPeople>(
    () => adminApi.analyticsPeople(range, view.filters),
    `${range}|${JSON.stringify(view.filters)}`,
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const people = (result?.people ?? []).filter((p) => !q || [p.username, p.klasse, p.detail].some((v) => v.toLowerCase().includes(q)));
    return [...people].sort((a, b) => {
      const order = compare(a, b, sort.key);
      return (sort.desc ? -order : order) || a.username.localeCompare(b.username, 'de');
    });
  }, [result, query, sort]);
  const totalSeconds = shown.reduce((sum, p) => sum + p.seconds, 0);

  const subtitle = result
    ? [`${de(result.total)} ${result.total === 1 ? 'Konto' : 'Konten'}`, `letzte ${range} Tage`, totalSeconds > 0 ? `zusammen ${hours(totalSeconds)}` : null].filter(Boolean).join(' · ')
    : `Letzte ${range} Tage`;

  return (
    <Dialog title={view.title} subtitle={subtitle} onClose={onClose} width={820}>
      <PopupBody
        error={error}
        loading={!result}
        empty={shown.length === 0}
        search={query}
        onSearch={setQuery}
        placeholder="Name, Klasse oder Version suchen"
        footer={result ? peopleFooter(result) : undefined}
      >
        <div ref={tableRef} className="tbl-scroll">
          <table className="tbl">
            <SortHeader columns={COLUMNS} sort={sort} onSort={(column) => setSort((current) => nextSort(current, column.key, Boolean(column.numeric)))} />
            <tbody>
              {shown.map((p) => (
                <tr key={p.stableUid}>
                  <td data-primary>
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar name={p.username} size={34} />
                      <div className="min-w-0">
                        <Link to="/users" state={{ search: p.username }} className="block truncate font-medium hover:underline">{p.username}</Link>
                        <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-ink-3">
                          {p.platforms.map((platform) => (
                            <i key={platform} className="h-[7px] w-[7px] flex-shrink-0 rounded-full" style={{ background: colors[platform] }} title={PLATFORM_LABEL[platform]} />
                          ))}
                          <span className="truncate">
                            {[
                              p.role === 'parent' ? 'Elternteil' : p.klasse || 'ohne Klasse',
                              p.detail,
                              p.lastSeenAt ? null : `Konto seit ${new Date(p.createdAt).toLocaleDateString('de-AT', { day: 'numeric', month: 'short', year: 'numeric' })}`,
                            ].filter(Boolean).join(' · ')}
                          </span>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="tabular whitespace-nowrap text-right">{p.seconds > 0 ? duration(p.seconds) : '–'}</td>
                  <td className="tabular text-right text-ink-2">{p.visits > 0 ? de(p.visits) : p.lastSeenAt ? 'Log' : '–'}</td>
                  <td className="tabular text-right text-ink-2">{p.activeDays > 0 ? de(p.activeDays) : '–'}</td>
                  <td className="whitespace-nowrap text-right text-ink-2">{p.lastSeenAt ? lastSeen(p.lastSeenAt) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PopupBody>
    </Dialog>
  );
}

// ── Which dishes ────────────────────────────────────────────────────────────

type DishSort = 'name' | 'starCount' | 'ratings' | 'avgStars' | 'comments';

interface DishesView {
  title: string;
  sort: DishSort;
  // Only dishes rated with this many stars, with their count of them.
  stars?: number;
}

function dishValue(dish: AnalyticsDish, key: DishSort, stars?: number): number | string {
  if (key === 'name') return dish.name;
  if (key === 'starCount') return stars ? dish.stars[stars - 1] ?? 0 : 0;
  if (key === 'avgStars') return dish.avgStars ?? -1;
  return dish[key];
}

function DishesDialog({ view, onClose }: { view: DishesView; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort<DishSort>>({ key: view.sort, desc: view.sort !== 'name' });
  const tableRef = useRef<HTMLDivElement>(null);
  useTableLabels(tableRef);
  const { data, error } = usePopupData(() => adminApi.analyticsDishes(), 'dishes');
  const { stars } = view;

  const columns: Column<DishSort>[] = [
    { key: 'name', label: 'Gericht' },
    ...(stars ? [{ key: 'starCount' as const, label: `${stars} ★`, numeric: true }] : []),
    { key: 'ratings', label: 'Bewertungen', numeric: true },
    { key: 'avgStars', label: 'Ø', numeric: true },
    { key: 'comments', label: 'Kommentare', numeric: true },
  ];

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const dishes = (data?.dishes ?? [])
      .filter((d) => !stars || (d.stars[stars - 1] ?? 0) > 0)
      .filter((d) => !q || d.name.toLowerCase().includes(q));
    return [...dishes].sort((a, b) => {
      const x = dishValue(a, sort.key, stars);
      const y = dishValue(b, sort.key, stars);
      const order = typeof x === 'string' ? x.localeCompare(String(y), 'de') : x - (y as number);
      return (sort.desc ? -order : order) || a.name.localeCompare(b.name, 'de');
    });
  }, [data, query, sort, stars]);

  return (
    <Dialog
      title={view.title}
      subtitle={data ? `${de(shown.length)} ${shown.length === 1 ? 'Gericht' : 'Gerichte'} · alle Bewertungen` : 'Alle Bewertungen'}
      onClose={onClose}
      width={760}
    >
      <PopupBody error={error} loading={!data} empty={shown.length === 0} search={query} onSearch={setQuery} placeholder="Gericht suchen">
        <div ref={tableRef} className="tbl-scroll">
          <table className="tbl">
            <SortHeader columns={columns} sort={sort} onSort={(column) => setSort((current) => nextSort(current, column.key, Boolean(column.numeric)))} />
            <tbody>
              {shown.map((d) => (
                <tr key={d.key}>
                  <td data-primary>
                    <div className="min-w-0">
                      <div className="truncate font-medium">{d.name}</div>
                      <div className="truncate text-[12.5px] text-ink-3">
                        zuletzt {dayDate(d.lastServed).toLocaleDateString('de-AT', { day: 'numeric', month: 'short', year: 'numeric' })} · {de(d.served)}× auf dem Plan
                      </div>
                    </div>
                  </td>
                  {stars && (
                    <td className="tabular whitespace-nowrap text-right">
                      {de(d.stars[stars - 1] ?? 0)}
                      <span className="ml-1.5 text-[12.5px] text-ink-3">{percent(d.stars[stars - 1] ?? 0, d.ratings)}</span>
                    </td>
                  )}
                  <td className="tabular text-right text-ink-2">{de(d.ratings)}</td>
                  <td className="tabular whitespace-nowrap text-right text-ink-2">{d.avgStars === null ? '–' : `${de(d.avgStars, 1)} ★`}</td>
                  <td className="tabular text-right text-ink-2">{de(d.comments)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PopupBody>
    </Dialog>
  );
}

// ── What a figure is made of ────────────────────────────────────────────────

interface BreakdownView {
  title: string;
  kind: BreakdownKind;
  // Header of the first column ("Klasse") and of the count ("Todos").
  labelHeader: string;
  valueHeader: string;
}

function BreakdownDialog({ view, days, onClose }: { view: BreakdownView; days: AnalyticsRange; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort<'label' | 'value'>>({ key: 'value', desc: true });
  const tableRef = useRef<HTMLDivElement>(null);
  useTableLabels(tableRef);
  const { data, error } = usePopupData<AnalyticsBreakdown>(() => adminApi.analyticsBreakdown(view.kind, days), `${view.kind}|${days}`);
  const peak = Math.max(1, ...(data?.items ?? []).map((item) => item.value));

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = (data?.items ?? []).filter((item) => !q || item.label.toLowerCase().includes(q));
    return [...items].sort((a, b) => {
      const order = sort.key === 'label' ? a.label.localeCompare(b.label, 'de') : a.value - b.value;
      return (sort.desc ? -order : order) || a.label.localeCompare(b.label, 'de');
    });
  }, [data, query, sort]);

  const columns: Column<'label' | 'value'>[] = [
    { key: 'label', label: view.labelHeader },
    { key: 'value', label: view.valueHeader, numeric: true },
  ];

  return (
    <Dialog
      title={view.title}
      subtitle={data ? `${de(data.total)} ${view.valueHeader} · letzte ${days} Tage` : `Letzte ${days} Tage`}
      onClose={onClose}
      width={640}
    >
      <PopupBody error={error} loading={!data} empty={shown.length === 0} search={query} onSearch={setQuery} placeholder={`${view.labelHeader} suchen`}>
        <div ref={tableRef} className="tbl-scroll">
          <table className="tbl">
            <SortHeader columns={columns} sort={sort} onSort={(column) => setSort((current) => nextSort(current, column.key, Boolean(column.numeric)))} />
            <tbody>
              {shown.map((item) => (
                <tr key={item.label}>
                  <td data-primary>
                    <div className="min-w-0">
                      <div className="truncate font-medium" title={item.label}>{item.label}</div>
                      {item.note && <div className="truncate text-[12.5px] text-ink-3">{item.note}</div>}
                      <div className="rank-track mt-2 max-w-[320px]">
                        <span className="rank-fill" style={{ width: `${Math.max((item.value / peak) * 100, 2)}%`, background: NEUTRAL }} />
                      </div>
                    </div>
                  </td>
                  <td className="tabular text-right">{de(item.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PopupBody>
    </Dialog>
  );
}

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Laden">
      <div className="shimmer h-9 w-56 rounded-full" />
      <div className="shimmer mt-4 h-4 w-96 max-w-full rounded-full" />
      <div className="mt-10 h-px bg-line" />
      <div className="flex gap-10 py-8">
        {[0, 1, 2, 3].map((i) => <div key={i} className="shimmer h-12 flex-1 rounded-full" />)}
      </div>
      <div className="h-px bg-line" />
      <div className="shimmer mt-10 h-11 w-[520px] max-w-full rounded-full" />
      <div className="shimmer mt-10 h-[236px] rounded-[22px]" />
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function AnalyticsPage() {
  const theme = useTheme();
  const colors = PLATFORM_COLOR[theme];
  const [days, setDays] = useState<AnalyticsRange>(30);
  const [tab, setTabState] = useState<TabKey>(storedTab);
  const [data, setData] = useState<AdminAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [metric, setMetric] = useState<Metric>('users');
  const [popup, setPopup] = useState<
    | { type: 'people'; view: PeopleView }
    | { type: 'dishes'; view: DishesView }
    | { type: 'breakdown'; view: BreakdownView }
    | null
  >(null);
  const tableRef = useRef<HTMLDivElement>(null);
  useTableLabels(tableRef);
  // While the admin stream is connected every change reaches the page at once.
  const streaming = useLiveStatus();

  const setTab = (next: TabKey) => {
    setTabState(next);
    try { localStorage.setItem(TAB_KEY, next); } catch { /* remembered for this visit only */ }
  };

  // Opens what is behind a figure: who, which dishes, or what it is made of.
  const show = (title: string, filters: PeopleFilters, sort: SortKey = 'seconds', extra: Pick<PeopleView, 'days' | 'search'> = {}) =>
    setPopup({ type: 'people', view: { title, filters, sort, ...extra } });
  const showDishes = (title: string, sort: DishSort, stars?: number) => setPopup({ type: 'dishes', view: { title, sort, stars } });
  const showBreakdown = (title: string, kind: BreakdownKind, labelHeader: string, valueHeader: string) =>
    setPopup({ type: 'breakdown', view: { title, kind, labelHeader, valueHeader } });
  const showPlatform = (platform: UsagePlatform, search?: string) =>
    show(`${PLATFORM_LABEL[platform]}: wer nutzt sie?`, { platform }, 'lastSeenAt', { search });

  const load = useCallback(async (fresh = false) => {
    try {
      const next = await adminApi.analytics(days, fresh);
      setData(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analytics konnten nicht geladen werden');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const timed = useCallback(() => { void load(); }, [load]);
  // Live: every visit, ping, sign-up, comment or rating announced on the admin
  // stream refetches the figures; the timer is the fallback when the stream is
  // down and keeps "online now" current while nothing else happens.
  useLive(['analytics', 'users', 'sessions', 'todos', 'reminders', 'comments', 'ratings', 'activity', 'learn'], timed, 3000);
  const { refreshing } = useAutoRefresh(timed, 30_000);
  const [manual, setManual] = useState(false);
  const refreshNow = async () => {
    setManual(true);
    try { await load(true); } finally { setManual(false); }
  };

  const trend = useMemo(() => {
    if (!data) return null;
    const labels = data.daily.map((d) => shortDay(d.dayKey, data.days));
    const titles = data.daily.map((d) => longDay(d.dayKey));
    const tickEvery = data.days <= 7 ? 1 : data.days <= 30 ? 3 : 10;
    let series: TrendSeries[];
    if (metric === 'users') {
      series = PLATFORM_ORDER
        .filter((p) => data.daily.some((d) => d.byPlatform[p] > 0))
        .map((p) => ({ key: p, label: PLATFORM_LABEL[p], color: colors[p], values: data.daily.map((d) => d.byPlatform[p]) }));
    } else if (metric === 'time') {
      series = [{
        key: 'time',
        label: 'Ø Minuten pro Nutzer',
        color: NEUTRAL,
        area: true,
        values: data.daily.map((d) => (d.users > 0 ? Math.round((d.userSeconds / d.users / 60) * 10) / 10 : 0)),
      }];
    } else {
      series = [{ key: 'sessions', label: 'Sitzungen', color: NEUTRAL, area: true, values: data.daily.map((d) => d.sessions) }];
    }
    return { labels, titles, tickEvery, series };
  }, [data, metric, colors]);

  if (loading && !data) return <Skeleton />;

  if (!data) {
    return (
      <div>
        <PageHeader title="Analytics" />
        <Empty icon={AlertTriangle}>{error ?? 'Analytics konnten nicht geladen werden.'}</Empty>
        <div className="flex justify-center">
          <button type="button" className="btn btn-primary" onClick={() => { setLoading(true); void load(true); }}>Erneut versuchen</button>
        </div>
      </div>
    );
  }

  const { platforms, time, engagement, accounts, features, mensa, live } = data;
  const hasVisits = time.sessions > 0;
  const rangeLabel = `letzte ${data.days} Tage`;
  const todayKey = data.axis[data.axis.length - 1]!;
  const loadedAt = new Date(data.generatedAt).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const platformSum = PLATFORM_ORDER.reduce((s, p) => s + platforms.byPlatform[p], 0);
  const shownPlatforms = PLATFORM_ORDER.filter((p) => p !== 'other' || platforms.byPlatform.other > 0 || time.byPlatform.other.sessions > 0);

  // ── Derived records ───────────────────────────────────────────────────────
  const busiestDay = data.daily.reduce<AdminAnalytics['daily'][number] | null>((best, d) => (d.users > (best?.users ?? 0) ? d : best), null);
  const peakHour = data.hours.reduce<AdminAnalytics['hours'][number] | null>((best, h) => (h.sessions > (best?.sessions ?? 0) ? h : best), null);
  const favouriteDay = data.weekdays.reduce<AdminAnalytics['weekdays'][number] | null>((best, w) => (w.avgUsers > (best?.avgUsers ?? 0) ? w : best), null);
  const hourList = (from: number, to: number) => Array.from({ length: 24 }, (_, h) => h).filter((h) => (from <= to ? h >= from && h < to : h >= from || h < to));
  const sumHours = (from: number, to: number) => hourList(from, to).reduce((s, h) => s + (data.hours[h]?.sessions ?? 0), 0);
  const weekendSeconds = data.weekdays.filter((w) => w.weekday >= 5).reduce((s, w) => s + w.seconds, 0);
  const topPlatform = PLATFORM_ORDER.reduce<UsagePlatform | null>((best, p) => (platforms.byPlatform[p] > (best ? platforms.byPlatform[best] : 0) ? p : best), null);
  const lengthPeak = time.lengthBands.reduce((best, b, i, all) => (b.sessions > (all[best]?.sessions ?? 0) ? i : best), 0);

  const highlights: Fact[] = [];
  if (hasVisits) highlights.push({ icon: Hourglass, tone: 'sky', value: hours(time.totalSeconds), label: 'insgesamt auf Pokyh verbracht', open: () => show('Zeit in Pokyh', {}, 'seconds') });
  if (busiestDay && busiestDay.users > 0) highlights.push({ icon: Trophy, tone: 'amber', value: `${de(busiestDay.users)} Nutzer`, label: `Rekordtag: ${longDay(busiestDay.dayKey)}`, open: () => show(`Aktiv am ${longDay(busiestDay.dayKey)}`, { day: busiestDay.dayKey }) });
  if (peakHour && peakHour.sessions > 0) highlights.push({ icon: Flame, tone: 'rose', value: hourSpan(peakHour.hour), label: `Stoßzeit — ${percent(peakHour.sessions, time.sessions)} aller Sitzungen starten hier`, open: () => show(`Sitzungen ${hourSpan(peakHour.hour)}`, { hours: [peakHour.hour] }, 'visits') });
  if (topPlatform && platformSum > 0) highlights.push({ icon: Medal, tone: 'violet', value: `${PLATFORM_LABEL[topPlatform]} vorn`, label: `${percent(platforms.byPlatform[topPlatform], platformSum)} der Plattform-Nutzungen`, open: () => showPlatform(topPlatform) });
  if (favouriteDay && favouriteDay.avgUsers > 0) highlights.push({ icon: CalendarDays, tone: 'mint', value: WEEKDAYS[favouriteDay.weekday]!, label: `Lieblingstag mit Ø ${de(favouriteDay.avgUsers, 1)} aktiven Nutzern`, open: () => show(`Aktiv an ${WEEKDAYS[favouriteDay.weekday]}en`, { weekdays: [favouriteDay.weekday] }, 'visits') });
  if (engagement.loyalUsers > 0) highlights.push({ icon: Repeat, tone: 'mint', value: `${de(engagement.loyalUsers)} Stammnutzer`, label: 'an mindestens jedem zweiten Tag aktiv', open: () => show('Stammnutzer', { segment: 'loyal' }, 'activeDays') });
  if (time.longestSessionSeconds > 0) highlights.push({ icon: Timer, tone: 'sky', value: duration(time.longestSessionSeconds), label: 'längste einzelne Sitzung' });
  if (platforms.multiPlatform > 0) highlights.push({ icon: Layers, tone: 'violet', value: `${de(platforms.multiPlatform)} Nutzer`, label: `nutzen mehrere Plattformen (${percent(platforms.multiPlatform, platforms.total)})`, open: () => show('Auf mehreren Plattformen', { segment: 'multi' }) });
  if (mensa.topRated) highlights.push({ icon: UtensilsCrossed, tone: 'amber', value: mensa.topRated.name, label: `Mensa-Liebling: Ø ${de(mensa.topRated.avg, 1)} ★`, open: () => showDishes('Gerichte nach Bewertung', 'avgStars') });

  const learnByCourse = () => showBreakdown('Pokyh Learn nach Kurs', 'learn', 'Kurs', 'Antworten');

  const habits: Fact[] = hasVisits ? [
    { icon: Moon, tone: 'violet', value: percent(sumHours(22, 5), time.sessions), label: 'Nachteulen — Sitzungen zwischen 22 und 5 Uhr', open: () => show('Nachteulen (22–5 Uhr)', { hours: hourList(22, 5) }, 'visits') },
    { icon: Sunrise, tone: 'amber', value: percent(sumHours(5, 7), time.sessions), label: 'Frühaufsteher — Sitzungen zwischen 5 und 7 Uhr', open: () => show('Frühaufsteher (5–7 Uhr)', { hours: hourList(5, 7) }, 'visits') },
    { icon: BookOpen, tone: 'mint', value: percent(sumHours(8, 13), time.sessions), label: 'der Sitzungen in der Schulzeit (8–13 Uhr)', open: () => show('In der Schulzeit (8–13 Uhr)', { hours: hourList(8, 13) }, 'visits') },
    { icon: CalendarDays, tone: 'ink', value: percent(weekendSeconds, time.totalSeconds), label: 'der Nutzungszeit liegt am Wochenende', open: () => show('Am Wochenende', { weekdays: [5, 6] }) },
    { icon: Sparkles, tone: 'sky', value: de(time.screensPerSession, 1), label: 'Bildschirme werden pro Sitzung geöffnet' },
    { icon: Repeat, tone: 'mint', value: de(time.sessionsPerUserDay, 1), label: 'Sitzungen pro Nutzer und aktivem Tag', open: () => show('Sitzungen', {}, 'visits') },
  ] : [];

  return (
    <div>
      <PageHeader
        title="Analytics"
        subtitle="Wie Pokyh genutzt wird — iPhone-App, Android-App und Web im Vergleich. Ein Klick auf eine Zahl zeigt, wer dahintersteht."
      >
        <Segmented
          label="Zeitraum"
          value={String(days) as '7' | '30' | '90'}
          onChange={(next) => setDays(Number(next) as AnalyticsRange)}
          options={[{ value: '7', label: '7 Tage' }, { value: '30', label: '30 Tage' }, { value: '90', label: '90 Tage' }]}
        />
        <IconButton icon={RefreshCw} label="Aktualisieren" size={42} busy={manual || refreshing || loading} onClick={() => void refreshNow()} />
      </PageHeader>

      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-[14px]">
        <Tag tone={live.online > 0 ? 'mint' : 'ink'}>{live.online > 0 ? 'Live' : 'Ruhig'}</Tag>
        <span><span className="tabular font-semibold">{de(live.online)}</span> gerade online</span>
        {PLATFORM_ORDER.filter((p) => live.byPlatform[p] > 0).map((p) => (
          <span key={p} className="flex items-center gap-2 text-ink-3">
            <i className="h-[7px] w-[7px] rounded-full" style={{ background: colors[p] }} />
            <span className="tabular">{de(live.byPlatform[p])}</span> {PLATFORM_LABEL[p]}
          </span>
        ))}
        <span className="text-ink-3" title={`Zuletzt geladen um ${loadedAt}`}>
          · {streaming ? 'Live-Stand' : `Stand ${loadedAt.slice(0, 5)}`}
        </span>
        <span className="text-ink-3" title="Nutzungszeiten und Personenlisten gibt es nur von Konten, die der Nutzungsstatistik zugestimmt haben.">
          · {de(accounts.usageConsents)} {accounts.usageConsents === 1 ? 'Konto' : 'Konten'} mit Einwilligung
        </span>
      </div>

      <div style={{ opacity: loading ? 0.55 : 1, transition: 'opacity 0.25s ease' }}>
        <Figures
          className="mt-7"
          items={[
            {
              label: 'iPhone-App',
              value: platforms.byPlatform.ios,
              icon: Smartphone,
              note: <Delta>{percent(platforms.byPlatform.ios, platforms.total)} der Nutzer</Delta>,
              onClick: () => showPlatform('ios'),
            },
            {
              label: 'Android-App',
              value: platforms.byPlatform.android,
              icon: Smartphone,
              note: <Delta>{percent(platforms.byPlatform.android, platforms.total)} der Nutzer</Delta>,
              onClick: () => showPlatform('android'),
            },
            {
              label: 'Web',
              value: platforms.byPlatform.web,
              icon: Globe,
              note: <Delta>{percent(platforms.byPlatform.web, platforms.total)} der Nutzer</Delta>,
              onClick: () => showPlatform('web'),
            },
            {
              label: 'Ø Zeit pro Tag',
              value: hasVisits ? duration(time.avgDailySecondsPerUser) : '–',
              icon: Clock,
              note: <Delta>je aktivem Nutzer</Delta>,
              onClick: hasVisits ? () => show('Zeit in Pokyh', {}, 'seconds') : undefined,
            },
          ]}
        />
        <Figures
          className="-mt-px"
          items={[
            { label: 'Aktiv heute', value: engagement.dau, icon: Users, note: <Delta>Nutzer</Delta>, onClick: () => show('Heute aktiv', { day: todayKey }, 'lastSeenAt') },
            { label: 'Letzte 7 Tage', value: engagement.wau, icon: CalendarDays, note: <Delta>Nutzer</Delta>, onClick: () => show('Aktiv in den letzten 7 Tagen', {}, 'seconds', { days: 7 }) },
            { label: 'Letzte 30 Tage', value: engagement.mau, icon: ChartNoAxesColumn, note: <Delta>Nutzer</Delta>, onClick: () => show('Aktiv in den letzten 30 Tagen', {}, 'seconds', { days: 30 }) },
            {
              label: 'Ø Sitzung',
              value: hasVisits ? duration(time.avgSessionSeconds) : '–',
              icon: Timer,
              note: hasVisits ? <Delta>Median {duration(time.medianSessionSeconds)}</Delta> : undefined,
              onClick: hasVisits ? () => show('Sitzungen', {}, 'visits') : undefined,
            },
          ]}
        />

        {!hasVisits && (
          <div className="mt-8">
            <Notice tone="sky" icon={Sparkles}>
              Nutzungszeiten, Sitzungen und Stoßzeiten erscheinen, sobald die aktualisierten Apps (iPhone, Android, Web)
              genutzt werden. Die Plattform-Zahlen oben kommen bis dahin aus den Server-Logs.
            </Notice>
          </div>
        )}

        <div className="mt-10">
          <Segmented label="Bereich" value={tab} onChange={setTab} options={TABS} />
        </div>

        <div key={tab} className="animate-fadeInUp mt-10">
          {tab === 'overview' && (
            <div className="flex flex-col gap-[56px]">
              {hasVisits && trend && (
                <Section
                  title={metric === 'users' ? 'Aktive Nutzer' : metric === 'time' ? 'Zeit pro Nutzer' : 'Sitzungen'}
                  meta={rangeLabel}
                  action={(
                    <Segmented
                      label="Kennzahl"
                      value={metric}
                      onChange={setMetric}
                      options={[{ value: 'users', label: 'Nutzer' }, { value: 'time', label: 'Zeit' }, { value: 'sessions', label: 'Sitzungen' }]}
                    />
                  )}
                >
                  {metric === 'users' && (
                    <div className="mt-6">
                      <Legend items={trend.series.map((s) => ({ label: s.label, color: s.color }))} />
                    </div>
                  )}
                  <div className="mt-6">
                    <TrendChart
                      labels={trend.labels}
                      titles={trend.titles}
                      series={trend.series}
                      tickEvery={trend.tickEvery}
                      drawKey={`${metric}-${data.days}`}
                      onSelect={(i) => {
                        const dayKey = data.daily[i]?.dayKey;
                        if (dayKey) show(`Aktiv am ${longDay(dayKey)}`, { day: dayKey }, metric === 'sessions' ? 'visits' : 'seconds');
                      }}
                      ariaLabel={metric === 'users'
                        ? `Aktive Nutzer je Tag und Plattform, letzte ${data.days} Tage`
                        : metric === 'time'
                          ? `Durchschnittliche Minuten pro aktivem Nutzer je Tag, letzte ${data.days} Tage`
                          : `Sitzungen je Tag, letzte ${data.days} Tage`}
                    />
                  </div>
                  <Explain>
                    {metric === 'users' && 'Verschiedene Konten pro Tag. Klick auf einen Tag zeigt, wer aktiv war.'}
                    {metric === 'time' && 'Ø Zeit pro aktivem Konto und Tag.'}
                    {metric === 'sessions' && 'Wie oft Pokyh pro Tag geöffnet wurde.'}
                  </Explain>
                </Section>
              )}

              <Section title="Highlights" meta={rangeLabel}>
                <FactGrid facts={highlights} />
              </Section>
            </div>
          )}

          {tab === 'platforms' && (
            <div className="flex flex-col gap-[56px]">
              <Pair>
                <Section title="Verteilung" meta={`${de(platforms.total)} aktive Konten`}>
                  <div className="mt-8">
                    <SplitBar
                      ariaLabel="Aktive Konten nach Plattform"
                      parts={shownPlatforms.map((p) => ({ label: PLATFORM_LABEL[p], value: platforms.byPlatform[p], color: colors[p] }))}
                    />
                  </div>
                  <div ref={tableRef} className="tbl-scroll mt-9">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>Plattform</th>
                          <th style={{ textAlign: 'right' }}>Nutzer</th>
                          <th style={{ textAlign: 'right' }}>Sitzungen</th>
                          <th style={{ textAlign: 'right' }}>Ø Sitzung</th>
                          <th style={{ textAlign: 'right' }}>Zeit gesamt</th>
                          <th><span className="sr-only">Nutzer anzeigen</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {shownPlatforms.map((p) => {
                          const t = time.byPlatform[p];
                          return (
                            <tr
                              key={p}
                              data-clickable
                              tabIndex={0}
                              aria-label={`${PLATFORM_LABEL[p]}: wer nutzt sie?`}
                              onClick={() => showPlatform(p)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  showPlatform(p);
                                }
                              }}
                            >
                              <td data-primary>
                                <span className="flex items-center gap-[10px] font-medium">
                                  <i className="h-[7px] w-[7px] flex-shrink-0 rounded-full" style={{ background: colors[p] }} />
                                  {PLATFORM_LABEL[p]}
                                </span>
                              </td>
                              <td className="tabular text-right">{de(platforms.byPlatform[p])}</td>
                              <td className="tabular text-right text-ink-2">{de(t.sessions)}</td>
                              <td className="tabular text-right text-ink-2">{t.sessions > 0 ? duration(t.seconds / t.sessions) : '–'}</td>
                              <td className="tabular text-right text-ink-2">{t.seconds > 0 ? hours(t.seconds) : '–'}</td>
                              <td className="text-ink-3"><ChevronRight size={16} strokeWidth={1.7} /></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <Explain>Klick auf eine Plattform zeigt, wer sie nutzt.</Explain>
                </Section>

                <Section title="Web im Detail" meta={`${de(platforms.byPlatform.web)} Nutzer`}>
                  <div className="mt-8">
                    <RankBars
                      color={colors.web}
                      unit=" Nutzer"
                      onSelect={(item) => showPlatform('web', WEB_SEARCH[item.label])}
                      items={[
                        { label: 'Am Computer', value: platforms.web.desktop },
                        { label: 'Am Handy oder Tablet', value: platforms.web.mobile },
                        { label: 'Als Web-App installiert (PWA)', value: platforms.web.pwa },
                        { label: 'Im Browser-Tab', value: platforms.web.browser },
                      ]}
                    />
                  </div>
                  <Explain>Alles im Browser zählt als Web, auch am Handy.</Explain>
                </Section>
              </Pair>

              {data.appVersions.length > 0 && (
                <Pair>
                  {(['ios', 'android'] as const).map((p) => {
                    const versions = data.appVersions.filter((v) => v.platform === p);
                    return (
                      <Section key={p} title={`${PLATFORM_LABEL[p]}-Versionen`} meta="Nutzer je Version">
                        <div className="mt-8">
                          <RankBars
                            color={colors[p]}
                            items={versions.map((v) => ({ label: v.version, value: v.users }))}
                            onSelect={(item) => showPlatform(p, item.label)}
                            empty="Noch keine Version gemeldet."
                          />
                        </div>
                      </Section>
                    );
                  })}
                </Pair>
              )}
            </div>
          )}

          {tab === 'usage' && (
            hasVisits ? (
              <div className="flex flex-col gap-[56px]">
                <Pair>
                  <Section title="Tageszeit" meta="Beginn der Sitzungen">
                    <div className="mt-8">
                      <Bars
                        values={data.hours.map((h) => h.sessions)}
                        labels={data.hours.map((h) => String(h.hour).padStart(2, '0'))}
                        titles={data.hours.map((h) => hourSpan(h.hour))}
                        unit="Sitzungen"
                        tickEvery={3}
                        color={NEUTRAL}
                        ariaLabel="Sitzungen nach Startstunde"
                        onSelect={(hour) => show(`Sitzungen ${hourSpan(hour)}`, { hours: [hour] }, 'visits')}
                      />
                    </div>
                    {peakHour && <Explain>Am meisten los ist {hourSpan(peakHour.hour)}.</Explain>}
                  </Section>
                  <Section title="Wochentage" meta="Ø aktive Nutzer">
                    <div className="mt-8">
                      <Bars
                        values={data.weekdays.map((w) => w.avgUsers)}
                        labels={WEEKDAYS_SHORT}
                        titles={WEEKDAYS}
                        unit="Nutzer"
                        color={NEUTRAL}
                        format={(v) => de(v, 1)}
                        ariaLabel="Durchschnittlich aktive Nutzer je Wochentag"
                        onSelect={(weekday) => show(`Aktiv an ${WEEKDAYS[weekday]}en`, { weekdays: [weekday] }, 'visits')}
                      />
                    </div>
                    {favouriteDay && <Explain>Stärkster Tag: {WEEKDAYS[favouriteDay.weekday]}.</Explain>}
                  </Section>
                </Pair>

                <Pair>
                  <Section title="Sitzungslänge" meta={`Median ${duration(time.medianSessionSeconds)}`}>
                    <div className="mt-8">
                      <Bars
                        values={time.lengthBands.map((b) => b.sessions)}
                        labels={time.lengthBands.map((b) => b.label)}
                        unit="Sitzungen"
                        color={NEUTRAL}
                        ariaLabel="Sitzungen nach Länge"
                        onSelect={(band) => show(`Sitzungen von ${time.lengthBands[band]?.label ?? ''}`, { band }, 'visits')}
                      />
                    </div>
                    <Explain>Am häufigsten: {time.lengthBands[lengthPeak]?.label}</Explain>
                  </Section>
                  <Section title="Treue" meta={rangeLabel}>
                    <div className="mt-8 flex flex-wrap items-center gap-x-10 gap-y-8">
                      <Ring share={engagement.stickiness ?? 0} ariaLabel="Anteil der Monatsnutzer, die an einem durchschnittlichen Tag aktiv sind">
                        <span className="tabular text-[24px] font-semibold leading-none">
                          {engagement.stickiness === null ? '–' : `${de(engagement.stickiness * 100)} %`}
                        </span>
                        <span className="mt-1.5 text-[12px] text-ink-3">täglich da</span>
                      </Ring>
                      <div className="min-w-0 flex-1">
                        <Ledger
                          columns={2}
                          items={[
                            { label: 'Neu', value: de(engagement.newUsers), hint: 'Konto im Zeitraum erstellt', open: () => show('Neu im Zeitraum', { segment: 'new' }, 'lastSeenAt') },
                            { label: 'Wiederkehrend', value: de(engagement.returningUsers), open: () => show('Wiederkehrend', { segment: 'returning' }) },
                            { label: 'Stammnutzer', value: de(engagement.loyalUsers), hint: 'an mindestens jedem zweiten Tag aktiv', open: () => show('Stammnutzer', { segment: 'loyal' }, 'activeDays') },
                            { label: 'Ø aktive Tage', value: de(engagement.activeDaysPerUser, 1), open: () => show('Aktive Tage', {}, 'activeDays') },
                          ]}
                        />
                      </div>
                    </div>
                    <Explain>Anteil der Monatsnutzer, die an einem Tag Pokyh öffnen.</Explain>
                  </Section>
                </Pair>

                <Section title="Gewohnheiten" meta={rangeLabel}>
                  <FactGrid facts={habits} />
                </Section>
              </div>
            ) : (
              <Empty icon={Clock}>Nutzungszeiten erscheinen, sobald die aktualisierten Apps genutzt werden.</Empty>
            )
          )}

          {tab === 'features' && (
            <div className="flex flex-col gap-[56px]">
              <Pair>
                <Section title="Was erstellt wird" meta={rangeLabel}>
                  <div className="mt-8">
                    <RankBars
                      onSelect={(item) => FEATURE_POPUPS[item.label]?.({ showBreakdown, showDishes })}
                      items={[
                        { label: 'Todos', value: features.todos, note: features.todos > 0 ? `${percent(features.todosDone, features.todos)} erledigt` : undefined },
                        { label: 'Erinnerungen', value: features.reminders },
                        { label: 'Kommentare zu Erinnerungen', value: features.reminderComments },
                        { label: 'Mensa-Bewertungen', value: features.dishRatings },
                        { label: 'Mensa-Kommentare', value: features.dishComments },
                        { label: 'Learn-Antworten', value: features.learnAnswers },
                        { label: 'Downloads', value: features.downloads },
                      ].filter((item) => item.value > 0)}
                      empty="In diesem Zeitraum wurde noch nichts erstellt."
                    />
                  </div>
                </Section>

                <Section title="Mensa" meta="alle Bewertungen">
                  <div className="mt-8">
                    <Bars
                      values={mensa.starBands}
                      labels={['1 ★', '2 ★', '3 ★', '4 ★', '5 ★']}
                      titles={['1 Stern', '2 Sterne', '3 Sterne', '4 Sterne', '5 Sterne']}
                      unit="Bewertungen"
                      color={NEUTRAL}
                      height={110}
                      ariaLabel="Mensa-Bewertungen nach Sternen"
                      onSelect={(i) => showDishes(`Gerichte mit ${i + 1} ${i === 0 ? 'Stern' : 'Sternen'}`, 'starCount', i + 1)}
                    />
                  </div>
                  <FactGrid
                    columns={2}
                    facts={[
                      ...(features.avgStars !== null ? [{ icon: Star, tone: 'amber' as Tone, value: `Ø ${de(features.avgStars, 2)} ★`, label: 'durchschnittliche Bewertung', open: () => showDishes('Gerichte nach Bewertung', 'avgStars') }] : []),
                      ...(mensa.topRated ? [{ icon: Medal, tone: 'amber' as Tone, value: mensa.topRated.name, label: `Liebling: Ø ${de(mensa.topRated.avg, 1)} ★ (${de(mensa.topRated.ratings)}×)`, open: () => showDishes('Gerichte nach Bewertung', 'avgStars') }] : []),
                      ...(mensa.mostRated ? [{ icon: UtensilsCrossed, tone: 'sky' as Tone, value: mensa.mostRated.name, label: `meistbewertet (${de(mensa.mostRated.ratings)}×)`, open: () => showDishes('Meistbewertete Gerichte', 'ratings') }] : []),
                      ...(mensa.mostCommented ? [{ icon: MessagesSquare, tone: 'rose' as Tone, value: mensa.mostCommented.name, label: `meistdiskutiert (${de(mensa.mostCommented.comments)} Kommentare)`, open: () => showDishes('Meistdiskutierte Gerichte', 'comments') }] : []),
                    ]}
                  />
                </Section>
              </Pair>

              <Pair>
                <Section title="Web-Seiten" meta={`${de(features.pageViews)} Aufrufe`}>
                  <div className="mt-8">
                    <RankBars
                      items={data.pages.map((p) => ({ label: p.page, value: p.views }))}
                      onSelect={(item) => show(`Seite ${item.label}`, { page: item.label }, 'seconds')}
                      empty="Noch keine Seitenaufrufe."
                    />
                  </div>
                  <Explain>Klick auf eine Seite zeigt, wer sie aufgerufen hat.</Explain>
                </Section>
                <Section title="Pokyh Learn" meta={rangeLabel}>
                  <div className="mt-8">
                    {features.learnAnswers > 0 ? (
                      <Ledger
                        columns={2}
                        items={[
                          { label: 'Lernende', value: de(features.learnLearners), open: learnByCourse },
                          { label: 'Antworten', value: de(features.learnAnswers), open: learnByCourse },
                          { label: 'Davon richtig', value: percent(features.learnCorrect, features.learnAnswers), open: learnByCourse },
                          { label: 'Lernzeit', value: `${de(features.learnMinutes)} Min.`, open: learnByCourse },
                        ]}
                      />
                    ) : (
                      <p className="text-[14px] text-ink-3">In diesem Zeitraum wurde in Pokyh Learn noch nicht gelernt.</p>
                    )}
                  </div>
                </Section>
              </Pair>
            </div>
          )}

          {tab === 'accounts' && (
            <Pair>
              <Section title="Konten" meta={`${de(accounts.newInRange)} neu`}>
                <div className="mt-8">
                  <Ledger
                    items={[
                      { label: 'Konten gesamt', value: de(accounts.total) },
                      { label: 'Aktiv im Zeitraum', value: percent(platforms.total, accounts.total), open: () => show('Aktiv im Zeitraum', {}, 'seconds') },
                      { label: 'Ohne Aktivität', value: de(Math.max(0, accounts.total - platforms.total)), open: () => show('Ohne Aktivität im Zeitraum', { segment: 'inactive' }, 'username') },
                      { label: 'Schüler:innen', value: de(accounts.students) },
                      { label: 'Eltern', value: de(accounts.parents) },
                      { label: 'Mit WebUntis', value: de(accounts.untis) },
                      { label: 'Push aktiv', value: percent(accounts.withPush, accounts.total) },
                      { label: 'Learn-Profile', value: de(accounts.withLearn) },
                      { label: 'Admins', value: de(accounts.admins) },
                    ]}
                  />
                </div>
                <h3 className="mb-5 mt-10 text-[14.5px] text-ink-3">Neue Konten pro Tag</h3>
                <Bars
                  values={data.daily.map((d) => d.signups)}
                  labels={data.daily.map((d) => shortDay(d.dayKey, data.days))}
                  titles={data.daily.map((d) => longDay(d.dayKey))}
                  unit="neue Konten"
                  tickEvery={data.days <= 7 ? 1 : data.days <= 30 ? 3 : 10}
                  height={96}
                  color={NEUTRAL}
                  ariaLabel={`Neue Konten je Tag, letzte ${data.days} Tage`}
                  onSelect={(i) => {
                    const dayKey = data.daily[i]?.dayKey;
                    if (dayKey) show(`Neu am ${longDay(dayKey)}`, { created: dayKey }, 'username');
                  }}
                />
              </Section>
              <Section title="Aktivste Klassen" meta="nach Zeit in Pokyh">
                <div className="mt-8">
                  <RankBars
                    unit=" Std."
                    items={data.classes.map((c) => ({
                      label: c.name,
                      value: Math.round(c.seconds / 360) / 10,
                      note: `${de(c.users)} Nutzer · Ø ${duration(c.seconds / Math.max(c.users, 1))}`,
                    }))}
                    onSelect={(item) => show(`Klasse ${item.label}`, { klasse: item.label }, 'seconds')}
                    empty="Noch keine Nutzungszeiten von Klassen."
                  />
                </div>
              </Section>
            </Pair>
          )}
        </div>
      </div>

      {popup?.type === 'people' && <PeopleDialog view={popup.view} days={days} colors={colors} onClose={() => setPopup(null)} />}
      {popup?.type === 'dishes' && <DishesDialog view={popup.view} onClose={() => setPopup(null)} />}
      {popup?.type === 'breakdown' && <BreakdownDialog view={popup.view} days={days} onClose={() => setPopup(null)} />}
    </div>
  );
}

// "Was erstellt wird" rows → the popup that breaks them down.
type Openers = {
  showBreakdown: (title: string, kind: BreakdownKind, labelHeader: string, valueHeader: string) => void;
  showDishes: (title: string, sort: DishSort, stars?: number) => void;
};
const FEATURE_POPUPS: Record<string, (open: Openers) => void> = {
  'Todos': ({ showBreakdown }) => showBreakdown('Todos nach Klasse', 'todos', 'Klasse', 'Todos'),
  'Erinnerungen': ({ showBreakdown }) => showBreakdown('Erinnerungen nach Klasse', 'reminders', 'Klasse', 'Erinnerungen'),
  'Kommentare zu Erinnerungen': ({ showBreakdown }) => showBreakdown('Kommentare nach Klasse', 'reminderComments', 'Klasse', 'Kommentare'),
  'Mensa-Bewertungen': ({ showDishes }) => showDishes('Bewertete Gerichte', 'ratings'),
  'Mensa-Kommentare': ({ showDishes }) => showDishes('Kommentierte Gerichte', 'comments'),
  'Learn-Antworten': ({ showBreakdown }) => showBreakdown('Pokyh Learn nach Kurs', 'learn', 'Kurs', 'Antworten'),
  'Downloads': ({ showBreakdown }) => showBreakdown('Downloads nach Datei', 'downloads', 'Datei', 'Downloads'),
};

// "Web im Detail" rows → the search that narrows the web list to them.
const WEB_SEARCH: Record<string, string> = {
  'Am Computer': 'Computer',
  'Am Handy oder Tablet': 'Handy',
  'Als Web-App installiert (PWA)': 'Web-App',
  'Im Browser-Tab': 'Browser',
};
