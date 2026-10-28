import { ReactNode, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Flame,
  Hourglass,
  Layers,
  Map as MapIcon,
  Medal,
  MessagesSquare,
  Moon,
  RefreshCw,
  Repeat,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  Sparkles,
  Star,
  Sunrise,
  Timer,
  Trophy,
  Users,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react';
import { adminApi, setAnalyticsEnd } from '../api';
import { todayDayKey } from '../components/format';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import { useLive, useLiveStatus } from '../live';
import { useTheme } from '../theme';
import { TrendChart, type TrendSeries } from '../components/TrendChart';
import { Bars, RankBars, Ring, SplitBar, type Rank } from '../components/charts';
import { Count, Delta, Empty, Figures, IconButton, Notice, PageHeader, Section, Segmented, Spinner, TONES, Tag, useTableLabels, type Tone } from '../components/kit';
import { Inspector, type DishSort, type InspectorView, type SortKey } from '../components/analytics/Inspector';
import {
  NEUTRAL,
  PLATFORM_COLOR,
  PLATFORM_LABEL,
  PLATFORM_ORDER,
  WEEKDAYS,
  WEEKDAYS_SHORT,
  dayDate,
  de,
  duration,
  hourSpan,
  hours,
  longDay,
  percent,
} from '../components/analytics/format';
import { countryName } from '../components/visitors/countries';
import type { AdminAnalytics, AnalyticsRange, BreakdownKind, PeopleFilters, UsagePlatform } from '../types';

// The map preview loads its map code and world data on its own.
const VisitorMapPreview = lazy(() => import('../components/visitors/VisitorMapPreview'));

// The page reads top to bottom as one story:
//
//   1. Four figures that matter most — active users, website visitors, time
//      per day, sessions. The chosen one is the chart beneath it.
//   2. Where the website's visitors come from, and what stands out.
//   3. The details, one area at a time.
//
// Every number leads further into the same inspector window: from a day to the
// people active on it, from a person to the addresses it used, from an address
// to the map and the accounts behind it.

type Metric = 'users' | 'visitors' | 'time' | 'sessions';
type TabKey = 'platforms' | 'usage' | 'features' | 'accounts';

// `short` is the label in the tab grid on a phone.
const TABS: Array<{ value: TabKey; label: string; short: string }> = [
  { value: 'platforms', label: 'Plattformen',    short: 'Plattformen' },
  { value: 'usage',     label: 'Nutzungszeiten', short: 'Zeiten' },
  { value: 'features',  label: 'Funktionen',     short: 'Funktionen' },
  { value: 'accounts',  label: 'Konten',         short: 'Konten' },
];
const TAB_KEY = 'pokyh_admin_analytics_tab';
const METRIC_KEY = 'pokyh_admin_analytics_metric';

// The periods on offer; a calendar year is picked from its own list.
type RangeChoice = '7' | '30' | '90' | '365' | 'all';
const RANGES: Array<{ value: RangeChoice; label: string }> = [
  { value: '7', label: '7 Tage' },
  { value: '30', label: '30 Tage' },
  { value: '90', label: '90 Tage' },
  { value: '365', label: '12 Monate' },
  { value: 'all', label: 'Alltime' },
];
const RANGE_KEY = 'pokyh_admin_analytics_range';

function stored<T extends string>(key: string, allowed: (value: string) => boolean, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    if (value && allowed(value)) return value as T;
  } catch { /* the default then */ }
  return fallback;
}

function remember(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ }
}

// Phones get an arrangement of their own; the stylesheet stacks below this
// width as well.
const PHONE_QUERY = '(max-width: 639.98px)';

function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(PHONE_QUERY);
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return phone;
}

// ─── Chart buckets ──────────────────────────────────────────────────────────

// Up to three months are drawn day by day; longer periods per week, more than
// a year per month — a year of single days is only noise.
type Day = AdminAnalytics['daily'][number];
interface Bucket { label: string; title: string; days: Day[] }

function shortDay(dayKey: string, days: number): string {
  const d = dayDate(dayKey);
  return days > 31 ? `${d.getDate()}.${d.getMonth() + 1}.` : String(d.getDate()).padStart(2, '0');
}

function bucketsOf(daily: Day[]): { unit: 'day' | 'week' | 'month'; buckets: Bucket[] } {
  if (daily.length <= 92) {
    return { unit: 'day', buckets: daily.map((d) => ({ label: shortDay(d.dayKey, daily.length), title: longDay(d.dayKey), days: [d] })) };
  }
  const unit = daily.length <= 400 ? 'week' : 'month';
  const buckets: Bucket[] = [];
  let currentKey = '';
  for (const d of daily) {
    const date = dayDate(d.dayKey);
    const monday = new Date(date);
    monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    const key = unit === 'week' ? monday.toDateString() : d.dayKey.slice(0, 7);
    if (key !== currentKey) {
      currentKey = key;
      buckets.push(unit === 'week'
        ? { label: `${date.getDate()}.${date.getMonth() + 1}.`, title: `Woche ab ${longDay(d.dayKey)}`, days: [] }
        : {
          label: date.toLocaleDateString('de-AT', { month: 'short', year: '2-digit' }),
          title: date.toLocaleDateString('de-AT', { month: 'long', year: 'numeric' }),
          days: [],
        });
    }
    buckets[buckets.length - 1]!.days.push(d);
  }
  return { unit, buckets };
}

// A bucket's daily figure: the average over its days with use.
function perUsedDay(days: Day[], pick: (d: Day) => number, used: (d: Day) => boolean = (d) => d.sessions > 0 || d.people > 0): number {
  const counted = days.filter(used);
  return counted.length > 0 ? Math.round((counted.reduce((s, d) => s + pick(d), 0) / counted.length) * 10) / 10 : 0;
}

function tickEveryFor(points: number): number {
  return points <= 8 ? 1 : points <= 31 ? 3 : Math.ceil(points / 10);
}

// ─── Small pieces ───────────────────────────────────────────────────────────

interface Fact {
  icon: LucideIcon;
  tone: Tone;
  value: string;
  label: string;
  // Opens what is behind the fact.
  open?: () => void;
}

function FactGrid({ facts, columns = 3 }: { facts: Fact[]; columns?: 1 | 2 | 3 }) {
  if (facts.length === 0) return <p className="mt-6 text-[14px] text-ink-3">Noch keine Daten in diesem Zeitraum.</p>;
  const grid = columns === 1 ? '' : columns === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-2 2xl:grid-cols-3';
  return (
    <ul className={`mt-7 grid gap-x-10 gap-y-7 ${grid}`}>
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
  return <p className="mt-5 max-w-[78ch] text-[13px] leading-relaxed text-ink-3">{children}</p>;
}

function Pair({ children }: { children: ReactNode }) {
  return <div className="grid gap-x-16 gap-y-14 xl:grid-cols-2">{children}</div>;
}

// A figure of the top band. A tile does one thing only: it chooses what the
// chart shows. The way into the people behind it is the button under the
// chart, so a tap on a tile never opens anything by surprise.
interface MetricTile {
  key: Metric;
  label: string;
  value: number | string;
  detail: string;
}

function MetricBand({ tiles, value, onChange }: { tiles: MetricTile[]; value: Metric; onChange: (next: Metric) => void }) {
  return (
    <div className="kpi-band" role="group" aria-label="Kennzahl für das Diagramm">
      {tiles.map((tile) => (
        <button key={tile.key} type="button" className="kpi" data-on={tile.key === value} aria-pressed={tile.key === value} onClick={() => onChange(tile.key)}>
          <span className="kpi-label">{tile.label}</span>
          <span className="kpi-value tabular">{typeof tile.value === 'number' ? <Count value={tile.value} /> : tile.value}</span>
          <span className="kpi-detail">{tile.detail}</span>
        </button>
      ))}
    </div>
  );
}

// The page's areas on a phone: one full-width switch whose raised thumb
// travels to the chosen tab — every tab in reach, none scrolled out of sight.
function LineTabs({ value, onChange }: { value: TabKey; onChange: (next: TabKey) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [marker, setMarker] = useState<{ left: number; width: number } | null>(null);
  // Each tab is as wide as its word; the marker is measured under the chosen one.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const active = root.querySelector<HTMLElement>('[aria-pressed="true"]');
      setMarker(active ? { left: active.offsetLeft, width: active.offsetWidth } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [value]);
  return (
    <div ref={rootRef} className="line-tabs" role="group" aria-label="Bereich">
      {TABS.map((tab) => (
        <button key={tab.value} type="button" aria-pressed={tab.value === value} onClick={() => onChange(tab.value)}>
          {tab.short}
        </button>
      ))}
      {marker && <span className="line-tabs-marker" aria-hidden="true" style={{ transform: `translateX(${marker.left}px)`, width: marker.width }} />}
    </div>
  );
}

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Laden">
      <div className="shimmer h-9 w-56 rounded-full" />
      <div className="shimmer mt-4 h-4 w-96 max-w-full rounded-full" />
      <div className="mt-10 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="shimmer h-[104px] rounded-[20px]" />)}
      </div>
      <div className="shimmer mt-8 h-[236px] rounded-[22px]" />
    </div>
  );
}

// Local day keys (YYYY-MM-DD) moved by whole days.
function shiftDay(dayKey: string, days: number): string {
  const d = new Date(`${dayKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}


// ─── Page ───────────────────────────────────────────────────────────────────

export function AnalyticsPage() {
  const theme = useTheme();
  const colors = PLATFORM_COLOR[theme];
  const phone = usePhone();
  const [range, setRangeState] = useState<AnalyticsRange>(() => stored(RANGE_KEY, (v) => /^(7|30|90|365|all|\d{4})$/.test(v), '30'));
  const [tab, setTabState] = useState<TabKey>(() => stored(TAB_KEY, (v) => TABS.some((t) => t.value === v), 'platforms'));
  const [metric, setMetricState] = useState<Metric>(() => stored(METRIC_KEY, (v) => ['users', 'visitors', 'time', 'sessions'].includes(v), 'users'));
  const [data, setData] = useState<AdminAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // The inspector's way so far; empty while it is closed.
  const [inspector, setInspector] = useState<InspectorView[]>([]);
  const [allHighlights, setAllHighlights] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);
  useTableLabels(tableRef);
  // While the admin stream is connected every change reaches the page at once.
  const streaming = useLiveStatus();

  // Paging back through history: the last day of a rolling period (null: today).
  const [end, setEnd] = useState<string | null>(null);
  const setRange = (next: AnalyticsRange) => { setEnd(null); setRangeState(next); remember(RANGE_KEY, next); };
  const setTab = (next: TabKey) => { setTabState(next); remember(TAB_KEY, next); };
  const setMetric = (next: Metric) => { setMetricState(next); remember(METRIC_KEY, next); };

  // Every figure opens the inspector at the right place.
  const open = (view: InspectorView) => setInspector([view]);
  const show = (title: string, filters: PeopleFilters, sort: SortKey = 'seconds', extra: { range?: AnalyticsRange; search?: string } = {}) =>
    open({ kind: 'people', title, filters, sort, ...extra });
  const showDishes = (title: string, sort: DishSort, stars?: number) => open({ kind: 'dishes', title, sort, stars });
  const showBreakdown = (title: string, breakdown: BreakdownKind, labelHeader: string, valueHeader: string) =>
    open({ kind: 'breakdown', title, breakdown, labelHeader, valueHeader });
  const showPlatform = (platform: UsagePlatform, search?: string) =>
    show(`${PLATFORM_LABEL[platform]}: wer nutzt sie?`, { platform }, 'lastSeenAt', { search });
  // The website's visitors behind "Website-Besucher"; website and apps
  // together behind "Herkunft".
  const showVisitors = (country: string | null = null) => open({ kind: 'visitors', source: 'web', country });
  const showOrigin = (country: string | null = null) => open({ kind: 'visitors', source: 'all', country });

  const load = useCallback(async (fresh = false) => {
    try {
      setAnalyticsEnd(end);
      const next = await adminApi.analytics(range, fresh);
      setData(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analytics konnten nicht geladen werden');
    } finally {
      setLoading(false);
    }
  }, [range, end]);
  // Other pages never inherit the shifted period.
  useEffect(() => () => setAnalyticsEnd(null), []);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const timed = useCallback(() => { void load(); }, [load]);
  // Live: every visit, ping, sign-up, comment or rating announced on the admin
  // stream refetches the figures; the timer is the fallback when the stream is
  // down and keeps "online now" current while nothing else happens.
  useLive(['analytics', 'users', 'sessions', 'todos', 'reminders', 'comments', 'ratings', 'activity'], timed, 3000);
  const { refreshing } = useAutoRefresh(timed, 30_000);
  const [manual, setManual] = useState(false);
  const refreshNow = async () => {
    setManual(true);
    try { await load(true); } finally { setManual(false); }
  };

  const buckets = useMemo(() => (data ? bucketsOf(data.daily) : null), [data]);

  const trend = useMemo(() => {
    if (!data || !buckets) return null;
    const { unit } = buckets;
    const list = buckets.buckets;
    let series: TrendSeries[];
    if (metric === 'users') {
      series = PLATFORM_ORDER
        .filter((p) => data.daily.some((d) => d.byPlatform[p] > 0))
        .map((p) => ({ key: p, label: PLATFORM_LABEL[p], color: colors[p], values: list.map((b) => perUsedDay(b.days, (d) => d.byPlatform[p])) }));
    } else if (metric === 'visitors') {
      // Per day like the users: a week or month shows its average day.
      series = [{ key: 'visitors', label: 'Website-Besucher', color: NEUTRAL, area: true, values: list.map((b) => perUsedDay(b.days, (d) => d.webVisitors, (d) => d.webViews > 0)) }];
    } else if (metric === 'time') {
      series = [{
        key: 'time',
        label: 'Ø Minuten pro Nutzer',
        color: NEUTRAL,
        area: true,
        values: list.map((b) => {
          const users = b.days.reduce((s, d) => s + d.users, 0);
          const seconds = b.days.reduce((s, d) => s + d.userSeconds, 0);
          return users > 0 ? Math.round((seconds / users / 60) * 10) / 10 : 0;
        }),
      }];
    } else {
      series = [{ key: 'sessions', label: 'Sitzungen', color: NEUTRAL, area: true, values: list.map((b) => b.days.reduce((s, d) => s + d.sessions, 0)) }];
    }
    return { unit, labels: list.map((b) => b.label), titles: list.map((b) => b.title), tickEvery: tickEveryFor(list.length), series };
  }, [data, buckets, metric, colors]);

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

  const { platforms, time, engagement, accounts, features, mensa, live, web, origin } = data;
  const hasVisits = time.sessions > 0;
  const rangeLabel = data.period.label;
  // Periods longer than the server logs reach: people per day, on average.
  const perDay = platforms.mode === 'dailyAverage';
  const years = data.availableYears.length > 0 ? data.availableYears : [new Date().getFullYear()];
  const isYear = /^\d{4}$/.test(range);
  const unitWord = trend?.unit === 'week' ? 'Woche' : trend?.unit === 'month' ? 'Monat' : 'Tag';
  const todayKey = new Date().toLocaleDateString('sv-SE', { timeZone: data.timezone });
  const loadedAt = new Date(data.generatedAt).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const platformSum = PLATFORM_ORDER.reduce((s, p) => s + platforms.byPlatform[p], 0);
  const shownPlatforms = PLATFORM_ORDER.filter((p) => p !== 'other' || platforms.byPlatform.other > 0 || time.byPlatform.other.sessions > 0);
  const hasTrend = data.daily.some((d) => d.people > 0 || d.sessions > 0 || d.webViews > 0);
  // Website visitors are different people per day; the tile shows the
  // average day, like the chart beneath it, not their sum over the period.
  const webDays = data.daily.filter((d) => d.webViews > 0).length;
  const perWebDay = (n: number) => (webDays > 0 ? n / webDays : 0);

  // ── Derived records ───────────────────────────────────────────────────────
  const busiestDay = data.daily.reduce<Day | null>((best, d) => (d.people > (best?.people ?? 0) ? d : best), null);
  const peakHour = data.hours.reduce<AdminAnalytics['hours'][number] | null>((best, h) => (h.sessions > (best?.sessions ?? 0) ? h : best), null);
  const favouriteDay = data.weekdays.reduce<AdminAnalytics['weekdays'][number] | null>((best, w) => (w.avgUsers > (best?.avgUsers ?? 0) ? w : best), null);
  const hourList = (from: number, to: number) => Array.from({ length: 24 }, (_, h) => h).filter((h) => (from <= to ? h >= from && h < to : h >= from || h < to));
  const sumHours = (from: number, to: number) => hourList(from, to).reduce((s, h) => s + (data.hours[h]?.sessions ?? 0), 0);
  const weekendSeconds = data.weekdays.filter((w) => w.weekday >= 5).reduce((s, w) => s + w.seconds, 0);
  const topPlatform = PLATFORM_ORDER.reduce<UsagePlatform | null>((best, p) => (platforms.byPlatform[p] > (best ? platforms.byPlatform[best] : 0) ? p : best), null);
  const lengthPeak = time.lengthBands.reduce((best, b, i, all) => (b.sessions > (all[best]?.sessions ?? 0) ? i : best), 0);

  const highlights: Fact[] = [];
  if (hasVisits) highlights.push({ icon: Hourglass, tone: 'sky', value: hours(time.totalSeconds), label: 'insgesamt auf Pokyh verbracht', open: () => show('Zeit in Pokyh', {}, 'seconds') });
  if (busiestDay && busiestDay.people > 0) highlights.push({ icon: Trophy, tone: 'amber', value: `${de(busiestDay.people)} Nutzer`, label: `Rekordtag: ${longDay(busiestDay.dayKey)}`, open: () => show(`Aktiv am ${longDay(busiestDay.dayKey)}`, { day: busiestDay.dayKey }) });
  if (peakHour && peakHour.sessions > 0) highlights.push({ icon: Flame, tone: 'rose', value: hourSpan(peakHour.hour), label: `Stoßzeit — ${percent(peakHour.sessions, time.sessions)} aller Sitzungen starten hier`, open: () => show(`Sitzungen ${hourSpan(peakHour.hour)}`, { hours: [peakHour.hour] }, 'visits') });
  if (topPlatform && platformSum > 0) highlights.push({ icon: Medal, tone: 'violet', value: `${PLATFORM_LABEL[topPlatform]} vorn`, label: `${percent(platforms.byPlatform[topPlatform], platformSum)} der Plattform-Nutzungen`, open: () => showPlatform(topPlatform) });
  if (favouriteDay && favouriteDay.avgUsers > 0) highlights.push({ icon: CalendarDays, tone: 'mint', value: WEEKDAYS[favouriteDay.weekday]!, label: `Lieblingstag mit Ø ${de(favouriteDay.avgUsers, 1)} aktiven Nutzern`, open: () => show(`Aktiv an ${WEEKDAYS[favouriteDay.weekday]}en`, { weekdays: [favouriteDay.weekday] }, 'visits') });
  if (engagement.loyalUsers > 0) highlights.push({ icon: Repeat, tone: 'mint', value: `${de(engagement.loyalUsers)} Stammnutzer`, label: 'an mindestens jedem zweiten Tag aktiv', open: () => show('Stammnutzer', { segment: 'loyal' }, 'activeDays') });
  if (time.longestSessionSeconds > 0) highlights.push({ icon: Timer, tone: 'sky', value: duration(time.longestSessionSeconds), label: 'längste einzelne Sitzung' });
  if (!perDay && platforms.multiPlatform > 0) highlights.push({ icon: Layers, tone: 'violet', value: `${de(platforms.multiPlatform)} Nutzer`, label: `nutzen mehrere Plattformen (${percent(platforms.multiPlatform, platforms.total)})`, open: () => show('Auf mehreren Plattformen', { segment: 'multi' }) });
  if (mensa.topRated) highlights.push({ icon: UtensilsCrossed, tone: 'amber', value: mensa.topRated.name, label: `Mensa-Liebling: Ø ${de(mensa.topRated.avg, 1)} ★`, open: () => showDishes('Gerichte nach Bewertung', 'avgStars') });
  // Two columns of three beside the map; a phone shows four and the rest on request.
  const highlightLimit = phone && !allHighlights ? 4 : 6;

  const habits: Fact[] = hasVisits ? [
    { icon: Moon, tone: 'violet', value: percent(sumHours(22, 5), time.sessions), label: 'Nachteulen — Sitzungen zwischen 22 und 5 Uhr', open: () => show('Nachteulen (22–5 Uhr)', { hours: hourList(22, 5) }, 'visits') },
    { icon: Sunrise, tone: 'amber', value: percent(sumHours(5, 7), time.sessions), label: 'Frühaufsteher — Sitzungen zwischen 5 und 7 Uhr', open: () => show('Frühaufsteher (5–7 Uhr)', { hours: hourList(5, 7) }, 'visits') },
    { icon: BookOpen, tone: 'mint', value: percent(sumHours(8, 13), time.sessions), label: 'der Sitzungen in der Schulzeit (8–13 Uhr)', open: () => show('In der Schulzeit (8–13 Uhr)', { hours: hourList(8, 13) }, 'visits') },
    { icon: CalendarDays, tone: 'ink', value: percent(weekendSeconds, time.totalSeconds), label: 'der Nutzungszeit liegt am Wochenende', open: () => show('Am Wochenende', { weekdays: [5, 6] }) },
    { icon: Sparkles, tone: 'sky', value: de(time.screensPerSession, 1), label: 'Bildschirme werden pro Sitzung geöffnet' },
    { icon: Repeat, tone: 'mint', value: de(time.sessionsPerUserDay, 1), label: 'Sitzungen pro Nutzer und aktivem Tag', open: () => show('Sitzungen', {}, 'visits') },
  ] : [];

  // ── The top band ──────────────────────────────────────────────────────────
  const tiles: MetricTile[] = [
    {
      key: 'users',
      label: 'Aktive Nutzer',
      value: perDay ? de(platforms.total, 1) : platforms.total,
      detail: perDay ? `Ø pro Tag · ${de(engagement.dau)} heute` : `${de(engagement.dau)} heute · ${de(engagement.wau)} in 7 Tagen`,
    },
    {
      key: 'visitors',
      label: 'Website-Besucher',
      value: de(perWebDay(web.visitors), 1),
      detail: `Ø pro Tag · davon ${de(perWebDay(web.signedVisitors), 1)} mit Konto`,
    },
    {
      key: 'time',
      label: 'Zeit pro Tag',
      value: hasVisits ? duration(time.avgDailySecondsPerUser) : '–',
      detail: hasVisits ? 'je aktivem Nutzer' : 'noch nicht gemessen',
    },
    {
      key: 'sessions',
      label: 'Sitzungen',
      value: time.sessions,
      detail: hasVisits ? `Ø ${duration(time.avgSessionSeconds)} · Median ${duration(time.medianSessionSeconds)}` : 'noch nicht gemessen',
    },
  ];

  // Under the chart: the way to who is behind the chosen figure.
  const drill: Record<Metric, { label: string; icon: LucideIcon; open: () => void } | null> = {
    users: { label: perDay ? 'Heute aktiv' : 'Aktive Konten', icon: Users, open: () => (perDay ? show('Heute aktiv', { day: todayKey }, 'lastSeenAt') : show('Aktiv im Zeitraum', {}, 'seconds')) },
    visitors: { label: 'Karte & IP-Adressen', icon: MapIcon, open: () => showVisitors() },
    time: hasVisits ? { label: 'Wer wie lange', icon: Hourglass, open: () => show('Zeit in Pokyh', {}, 'seconds') } : null,
    sessions: hasVisits ? { label: 'Alle Sitzungen', icon: Timer, open: () => show('Sitzungen', {}, 'visits') } : null,
  };
  const action = drill[metric];

  const explain: Record<Metric, string> = {
    users: perDay
      ? `Ø verschiedene Personen pro Tag, die eine App oder die Website genutzt haben, je ${unitWord}. Wer mehrere Plattformen nutzt, zählt bei jeder.`
      : `Verschiedene Konten pro ${unitWord}, nach Plattform. Wer mehrere nutzt, zählt bei jeder.${trend?.unit === 'day' ? ' Klick auf einen Tag zeigt, wer aktiv war.' : ''}`,
    visitors: `${trend?.unit === 'day' ? 'Verschiedene' : 'Ø verschiedene'} Besucher der Website pro Tag, mit und ohne Konto — auch Startseite, Anmeldung und Mensa. Bots zählen nicht; die Apps stehen unter Aktive Nutzer, ihre IP-Adressen unter Herkunft. Klick zeigt Karte und IP-Adressen.`,
    time: 'Ø Zeit pro aktiver Person und Tag, gemessen in den Apps und auf der Website, solange Pokyh im Vordergrund ist.',
    sessions: `Wie oft Pokyh pro ${unitWord} geöffnet wurde, in den Apps und auf der Website.${trend?.unit === 'day' ? ' Klick auf einen Tag zeigt, wer da war.' : ''}`,
  };

  // Paging a rolling period (7/30/90/365 days) back or forward in time.
  const rolling = /^\d+$/.test(range) && range.length <= 3;
  const span = rolling ? Number(range) : 0;
  const earliest = `${Math.min(...(data.availableYears.length > 0 ? data.availableYears : [Number(data.period.toKey.slice(0, 4))]))}-01-01`;
  const canBack = rolling && data.period.fromKey > earliest;
  const canForward = rolling && end !== null;
  const page = (direction: -1 | 1) => {
    if (!rolling || (direction === -1 ? !canBack : !canForward)) return;
    const next = shiftDay(data.period.toKey, direction * span);
    setLoading(true);
    setEnd(direction === 1 && next >= todayDayKey() ? null : next);
  };

  const onSelectPoint = metric === 'visitors'
    ? () => showVisitors()
    : trend?.unit === 'day'
      ? (i: number) => {
        const dayKey = data.daily[i]?.dayKey;
        if (dayKey) show(`Aktiv am ${longDay(dayKey)}`, { day: dayKey }, metric === 'sessions' ? 'visits' : 'seconds');
      }
      : undefined;

  const knownCountries = origin.byCountry.filter((c) => c.country !== '');

  return (
    <div>
      <PageHeader
        title="Analytics"
        subtitle={phone
          ? 'Wie Pokyh genutzt wird. Antippen führt tiefer.'
          : 'Wie Pokyh genutzt wird — iPhone-App, Android-App und Website. Jede Zahl führt weiter: zu Tagen, Menschen, Orten und Adressen.'}
      >
        {!phone && (
          <>
            <Segmented label="Zeitraum" value={range as RangeChoice} onChange={setRange} options={RANGES} />
            <select
              value={isYear ? range : ''}
              onChange={(e) => { if (e.target.value) setRange(e.target.value as AnalyticsRange); }}
              aria-label="Jahr"
              className="field h-11 px-4 text-[14px]"
            >
              <option value="" disabled>Jahr</option>
              {years.map((year) => <option key={year} value={String(year)}>{year}</option>)}
            </select>
            <IconButton icon={RefreshCw} label="Aktualisieren" size={42} busy={manual || refreshing || loading} onClick={() => void refreshNow()} />
          </>
        )}
      </PageHeader>

      {phone && (
        // One menu for every period, beside the refresh button.
        <div className="mt-5 flex items-center gap-2.5">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Zeitraum</span>
            <select
              value={range}
              onChange={(e) => setRange(e.target.value as AnalyticsRange)}
              className="field h-11 w-full appearance-none pl-4 pr-10 text-[14px]"
            >
              {RANGES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              <optgroup label="Kalenderjahr">
                {years.map((year) => <option key={year} value={String(year)}>Jahr {year}</option>)}
              </optgroup>
            </select>
            <ChevronDown size={16} strokeWidth={1.7} className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-ink-3" />
          </label>
          <IconButton icon={RefreshCw} label="Aktualisieren" size={44} busy={manual || refreshing || loading} onClick={() => void refreshNow()} />
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-[14px]">
        <Tag tone={live.online > 0 ? 'mint' : 'ink'}>{live.online > 0 ? 'Live' : 'Ruhig'}</Tag>
        <span><span className="tabular font-semibold">{de(live.online)}</span> gerade online</span>
        {!phone && PLATFORM_ORDER.filter((p) => live.byPlatform[p] > 0).map((p) => (
          <span key={p} className="flex items-center gap-2 text-ink-3">
            <i className="h-[7px] w-[7px] rounded-full" style={{ background: colors[p] }} />
            <span className="tabular">{de(live.byPlatform[p])}</span> {PLATFORM_LABEL[p]}
          </span>
        ))}
        <span className="text-ink-3" title={`Zuletzt geladen um ${loadedAt}`}>· {streaming ? 'Live-Stand' : `Stand ${loadedAt.slice(0, 5)}`}</span>
      </div>

      <div style={{ opacity: loading ? 0.55 : 1, transition: 'opacity 0.25s ease' }}>
        {/* 1 — the four figures that matter most, and the chosen one over time */}
        <div className="hero mt-7">
          <MetricBand tiles={tiles} value={metric} onChange={setMetric} />

          <div className="hero-chart">
            <div className="flex min-h-[34px] flex-wrap items-center justify-between gap-x-6 gap-y-3">
              {metric === 'users' ? (
                <ul className="flex flex-wrap gap-x-2 gap-y-1">
                  {PLATFORM_ORDER.filter((p) => platforms.byPlatform[p] > 0 || data.daily.some((d) => d.byPlatform[p] > 0)).map((p) => (
                    <li key={p}>
                      <button type="button" className="legend-btn" onClick={() => showPlatform(p)}>
                        <i style={{ background: colors[p] }} />
                        {PLATFORM_LABEL[p]}
                        <span className="tabular text-ink">{de(platforms.byPlatform[p], perDay ? 1 : 0)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-[13.5px] text-ink-3">
                  {metric === 'visitors' ? `${de(web.views)} Aufrufe · ${de(web.ips)} IP-Adressen` : metric === 'time' ? 'Ø Minuten pro aktivem Nutzer und Tag' : `Sitzungen je ${unitWord}`}
                </span>
              )}
              <div className="hero-action flex items-center gap-3">
                {rolling ? (
                  <div className="period-pager" role="group" aria-label="Zeitraum blättern">
                    <button type="button" className="orb h-9 w-9" onClick={() => page(-1)} disabled={!canBack} aria-label="Früherer Zeitraum">
                      <ChevronLeft size={16} strokeWidth={1.8} />
                    </button>
                    <span className="min-w-0 truncate text-[13.5px] text-ink-2">{rangeLabel}</span>
                    <button type="button" className="orb h-9 w-9" onClick={() => page(1)} disabled={!canForward} aria-label="Späterer Zeitraum">
                      <ChevronRight size={16} strokeWidth={1.8} />
                    </button>
                    {end && <button type="button" className="btn btn-sm btn-quiet" onClick={() => { setLoading(true); setEnd(null); }}>Heute</button>}
                  </div>
                ) : !phone && <span className="text-[13.5px] text-ink-3">{rangeLabel}</span>}
                {action && (
                  <button type="button" className="btn btn-sm btn-quiet" onClick={action.open}>
                    <action.icon size={14} strokeWidth={1.8} /> {action.label} <ChevronRight size={14} strokeWidth={1.8} />
                  </button>
                )}
              </div>
            </div>

            <div className="mt-5">
              {trend && hasTrend ? (
                <TrendChart
                  labels={trend.labels}
                  titles={trend.titles}
                  series={trend.series}
                  tickEvery={trend.tickEvery}
                  drawKey={`${metric}-${data.period.key}`}
                  onSelect={onSelectPoint}
                  onPage={rolling ? page : undefined}
                  canPageBack={canBack}
                  canPageForward={canForward}
                  ariaLabel={`${tiles.find((t) => t.key === metric)?.label ?? ''} je ${unitWord}, ${rangeLabel}`}
                />
              ) : (
                <p className="py-16 text-center text-[14px] text-ink-3">In diesem Zeitraum gibt es noch keine Daten.</p>
              )}
            </div>
            <Explain>{explain[metric]}</Explain>
          </div>
        </div>

        {!hasVisits && (
          <div className="mt-8">
            <Notice tone="sky" icon={Sparkles}>
              Nutzungszeiten, Sitzungen und Stoßzeiten erscheinen, sobald die aktualisierten Apps (iPhone, Android, Web)
              genutzt werden. Die Plattform-Zahlen kommen bis dahin aus den Server-Logs.
            </Notice>
          </div>
        )}

        {/* 2 — where the website and the apps are used from, and what stands out */}
        <div className="mt-14">
          <Pair>
            <Section
              title="Herkunft"
              meta={`Website & Apps · ${de(origin.countries)} ${origin.countries === 1 ? 'Land' : 'Länder'} · ${de(origin.ips)} IP-Adressen`}
              action={<button type="button" className="btn btn-sm btn-quiet" onClick={() => showOrigin()}>Karte & IP-Adressen <ChevronRight size={14} strokeWidth={1.8} /></button>}
            >
              <div className="mt-6">
                <Suspense fallback={<div className="map-frame flex items-center justify-center"><Spinner size={18} /></div>}>
                  <VisitorMapPreview byCountry={knownCountries} onOpen={showOrigin} />
                </Suspense>
              </div>
              {knownCountries.length > 0 && (
                <ul className="origin-list mt-5">
                  {knownCountries.slice(0, 3).map((c) => (
                    <li key={c.country}>
                      <button type="button" onClick={() => showOrigin(c.country)}>
                        <span className="flex items-center gap-2.5">
                          <span className="cc" aria-hidden="true">{c.country}</span>
                          <span className="min-w-0 flex-1 truncate">{countryName(c.country)}</span>
                          <span className="tabular text-ink-3">{de(c.views)} · {percent(c.views, origin.views)}</span>
                        </span>
                        <span className="rank-track mt-2 block">
                          <span className="rank-fill" style={{ width: `${Math.max((c.views / Math.max(1, knownCountries[0]!.views)) * 100, 2)}%`, background: NEUTRAL }} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Highlights" meta={rangeLabel}>
              <FactGrid facts={highlights.slice(0, highlightLimit)} columns={phone ? 1 : 2} />
              {phone && highlights.length > 4 && (
                <button type="button" className="btn btn-sm btn-quiet mt-6 w-full" aria-expanded={allHighlights} onClick={() => setAllHighlights((v) => !v)}>
                  {allHighlights ? 'Weniger zeigen' : `Alle ${highlights.length} Highlights`}
                </button>
              )}
            </Section>
          </Pair>
        </div>

        {/* 3 — the details, one area at a time */}
        <div className={phone ? 'mt-14' : 'mt-16 border-t border-line pt-10'}>
          {phone ? <LineTabs value={tab} onChange={setTab} /> : <Segmented label="Bereich" value={tab} onChange={setTab} options={TABS} />}
        </div>

        <div key={tab} className={`animate-fadeInUp ${phone ? 'mt-8' : 'mt-10'}`}>
          {tab === 'platforms' && (
            <div className="flex flex-col gap-[56px]">
              <Pair>
                <Section title="Verteilung" meta={perDay ? `Ø ${de(platforms.total, 1)} Personen pro Tag` : `${de(platforms.total)} aktive Konten`}>
                  <div className="mt-8">
                    <SplitBar
                      ariaLabel="Aktive Konten nach Plattform"
                      legend={!phone}
                      parts={shownPlatforms.map((p) => ({ label: PLATFORM_LABEL[p], value: platforms.byPlatform[p], color: colors[p] }))}
                    />
                  </div>
                  {phone ? (
                    // On a phone one calm row per platform instead of a table
                    // broken into cards.
                    <ul className="plat-list mt-8">
                      {shownPlatforms.map((p) => {
                        const t = time.byPlatform[p];
                        return (
                          <li key={p}>
                            <button type="button" onClick={() => showPlatform(p)}>
                              <span className="flex items-center gap-[10px]">
                                <i className="h-[7px] w-[7px] flex-shrink-0 rounded-full" style={{ background: colors[p] }} />
                                <span className="min-w-0 flex-1 truncate font-medium">{PLATFORM_LABEL[p]}</span>
                                <span className="tabular font-semibold">{de(platforms.byPlatform[p], perDay ? 1 : 0)}</span>
                                <span className="tabular w-[42px] text-right text-[12.5px] text-ink-3">{percent(platforms.byPlatform[p], platformSum)}</span>
                                <ChevronRight size={15} strokeWidth={1.7} className="flex-shrink-0 text-ink-4" />
                              </span>
                              <span className="mt-1 block pl-[17px] text-[12.5px] text-ink-3">
                                {[`${de(t.sessions)} Sitzungen`, t.sessions > 0 ? `Ø ${duration(t.seconds / t.sessions)}` : null, t.seconds > 0 ? `${hours(t.seconds)} gesamt` : null].filter(Boolean).join(' · ')}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                  <div ref={tableRef} className="tbl-scroll mt-9">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>Plattform</th>
                          <th style={{ textAlign: 'right' }}>{perDay ? 'Ø pro Tag' : 'Nutzer'}</th>
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
                              <td className="tabular text-right">{de(platforms.byPlatform[p], perDay ? 1 : 0)}</td>
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
                  )}
                  <Explain>{perDay ? 'Über so lange Zeiträume werden Besuche nicht zu Konten verknüpft. Klick zeigt die benannten Konten.' : 'Klick auf eine Plattform zeigt, wer sie nutzt.'}</Explain>
                </Section>

                <Section title="Web im Detail" meta={perDay ? `Ø ${de(platforms.byPlatform.web, 1)} pro Tag` : `${de(platforms.byPlatform.web)} Nutzer`}>
                  <div className="mt-8">
                    <RankBars
                      color={colors.web}
                      unit={perDay ? ' pro Tag' : ' Nutzer'}
                      items={[
                        { label: 'Am Computer', value: platforms.web.desktop },
                        { label: 'Am Handy oder Tablet', value: platforms.web.mobile },
                        { label: 'Als Web-App installiert (PWA)', value: platforms.web.pwa },
                        { label: 'Im Browser-Tab', value: platforms.web.browser },
                      ]}
                    />
                  </div>
                  <Explain>Alles im Browser zählt als Web, auch am Handy. Wer die Website ohne Konto besucht, steht unter Website-Besucher.</Explain>
                </Section>
              </Pair>

              {(data.appVersions.length > 0 || (data.appOlderUsers?.ios ?? 0) + (data.appOlderUsers?.android ?? 0) > 0) && (
                <Pair>
                  {(['ios', 'android'] as const).map((p) => {
                    const versions = data.appVersions.filter((v) => v.platform === p);
                    // While the logs reach back: people per version, their
                    // sessions beside them, and those still on a version that
                    // reports nothing. Otherwise sessions only.
                    const withUsers = data.appOlderUsers != null;
                    const older = data.appOlderUsers?.[p] ?? 0;
                    const items: Rank[] = withUsers
                      ? [
                        ...versions.map((v) => ({ label: v.version, value: v.users ?? 0, note: `${de(v.sessions)} ${v.sessions === 1 ? 'Sitzung' : 'Sitzungen'}` })),
                        ...(older > 0 ? [{ label: 'Ältere', value: older, note: 'keine Sitzungsdaten' }] : []),
                      ]
                      : versions.map((v) => ({ label: v.version, value: v.sessions }));
                    return (
                      <Section key={p} title={`${PLATFORM_LABEL[p]}-Versionen`} meta={withUsers ? 'Nutzer und Sitzungen je Version' : 'Sitzungen je Version'}>
                        <div className="mt-8">
                          <RankBars
                            color={colors[p]}
                            items={items}
                            unit={withUsers ? ' Nutzer' : ''}
                            empty="Noch keine Version gemeldet."
                          />
                        </div>
                        {older > 0 && <Explain>Ältere: hat die App im Zeitraum genutzt, aber mit einer Version, die noch keine Nutzung meldet — dort gibt es keine Sitzungen.</Explain>}
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
                            { label: 'Neu und aktiv', value: de(engagement.newUsers), hint: 'Konto im Zeitraum erstellt und im Zeitraum genutzt', open: () => show('Neu im Zeitraum', { segment: 'new' }, 'lastSeenAt') },
                            { label: 'Wiederkehrend', value: de(engagement.returningUsers), open: () => show('Wiederkehrend', { segment: 'returning' }) },
                            { label: 'Stammnutzer', value: de(engagement.loyalUsers), hint: 'an mindestens jedem zweiten Tag aktiv', open: () => show('Stammnutzer', { segment: 'loyal' }, 'activeDays') },
                            { label: 'Ø aktive Tage', value: de(engagement.activeDaysPerUser, 1), open: () => show('Aktive Tage', {}, 'activeDays') },
                          ]}
                        />
                      </div>
                    </div>
                    <Explain>Der Ring zählt immer die letzten 30 Tage, unabhängig vom Zeitraum: Anteil der {de(engagement.mau)} Monatsnutzer, die an einem durchschnittlichen Tag Pokyh öffnen.</Explain>
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
            </div>
          )}

          {tab === 'accounts' && (
            <div className="flex flex-col gap-[56px]">
              <Figures
                className="figures-compact"
                items={[
                  {
                    label: 'Konten',
                    value: accounts.total,
                    icon: Users,
                    note: <Delta>registriert</Delta>,
                    hint: `Alle Konten, aufgeteilt nach ihrer Wahl im Cookie-Banner: ${de(accounts.usageConsents)} mit Einwilligung + ${de(accounts.usageRefusals)} „Nur notwendige“ + ${de(accounts.usageUndecided)} noch ohne Wahl.`,
                  },
                  {
                    label: 'Mit Einwilligung',
                    value: accounts.usageConsents,
                    icon: ShieldCheck,
                    note: <Delta>{percent(accounts.usageConsents, accounts.total)} der Konten</Delta>,
                    onClick: () => show('Konten mit Einwilligung', { segment: 'consented' }, 'lastSeenAt'),
                    hint: 'Haben „Alle akzeptieren“ gewählt oder die persönliche Statistik im Profil eingeschaltet. Nur sie erscheinen mit Namen — in Listen, als Person und an ihren IP-Adressen.',
                  },
                  {
                    label: 'Nur notwendige',
                    value: accounts.usageRefusals,
                    icon: ShieldX,
                    note: <Delta>ohne Namen gezählt</Delta>,
                    hint: 'Haben im Banner „Nur notwendige“ gewählt: gezählt, aber nie mit Namen gezeigt.',
                  },
                  {
                    label: 'Noch keine Wahl',
                    value: accounts.usageUndecided,
                    icon: ShieldQuestion,
                    note: <Delta>ohne Namen gezählt</Delta>,
                    hint: 'Haben im Cookie-Banner noch nichts gewählt; bis dahin wie „Nur notwendige“.',
                  },
                ]}
              />
              <Pair>
                <Section title="Konten" meta={`${de(accounts.newInRange)} neu registriert`}>
                  <div className="mt-8">
                    <Ledger
                      items={[
                        { label: 'Konten gesamt', value: de(accounts.total) },
                        ...(perDay ? [] : [
                          { label: 'Aktiv im Zeitraum', value: percent(platforms.total, accounts.total), open: () => show('Aktiv im Zeitraum', {}, 'seconds') },
                          { label: 'Ohne Aktivität', value: de(Math.max(0, accounts.total - platforms.total)), open: () => show('Ohne Aktivität im Zeitraum', { segment: 'inactive' }, 'username') },
                        ]),
                        { label: 'Schüler:innen', value: de(accounts.students) },
                        { label: 'Eltern', value: de(accounts.parents) },
                        ...(accounts.noRole > 0 ? [{ label: 'Ohne Rolle', value: de(accounts.noRole) }] : []),
                        { label: 'Mit WebUntis', value: de(accounts.untis) },
                        { label: 'Push aktiv', value: percent(accounts.withPush, accounts.total) },
                        { label: 'Admins', value: de(accounts.admins) },
                      ]}
                    />
                  </div>
                  <h3 className="mb-5 mt-10 text-[14.5px] text-ink-3">Neue Konten pro {unitWord}</h3>
                  <Bars
                    values={(buckets?.buckets ?? []).map((b) => b.days.reduce((s, d) => s + d.signups, 0))}
                    labels={(buckets?.buckets ?? []).map((b) => b.label)}
                    titles={(buckets?.buckets ?? []).map((b) => b.title)}
                    unit="neue Konten"
                    tickEvery={tickEveryFor(buckets?.buckets.length ?? 0)}
                    height={96}
                    color={NEUTRAL}
                    ariaLabel={`Neue Konten je ${unitWord}, ${rangeLabel}`}
                    onSelect={buckets?.unit === 'day' ? (i) => {
                      const dayKey = data.daily[i]?.dayKey;
                      if (dayKey) show(`Neu am ${longDay(dayKey)}`, { created: dayKey }, 'username');
                    } : undefined}
                  />
                </Section>
                <Section title="Aktivste Klassen" meta="nach Zeit in Pokyh">
                  <div className="mt-8">
                    <RankBars
                      unit=" Std."
                      items={data.classes.map((c) => ({
                        label: c.name,
                        value: Math.round(c.seconds / 360) / 10,
                        note: `Ø ${de(c.avgPeople, 1)} Personen pro Tag · Ø ${duration(c.seconds / Math.max(c.people, 1))} pro Person und Tag`,
                      }))}
                      onSelect={(item) => show(`Klasse ${item.label}`, { klasse: item.label }, 'seconds')}
                      empty="Noch keine Klasse mit genug Nutzung im Zeitraum."
                    />
                  </div>
                  <Explain>Anonym gezählt; eine Klasse erscheint ab 5 Personen-Tagen. Klick zeigt die Konten mit Einwilligung.</Explain>
                </Section>
              </Pair>
            </div>
          )}
        </div>
      </div>

      {inspector.length > 0 && <Inspector stack={inspector} onChange={setInspector} range={range} colors={colors} />}
    </div>
  );
}

// "Was erstellt wird" rows → the view that breaks them down.
type Openers = {
  showBreakdown: (title: string, breakdown: BreakdownKind, labelHeader: string, valueHeader: string) => void;
  showDishes: (title: string, sort: DishSort, stars?: number) => void;
};
const FEATURE_POPUPS: Record<string, (open: Openers) => void> = {
  'Todos': ({ showBreakdown }) => showBreakdown('Todos nach Klasse', 'todos', 'Klasse', 'Todos'),
  'Erinnerungen': ({ showBreakdown }) => showBreakdown('Erinnerungen nach Klasse', 'reminders', 'Klasse', 'Erinnerungen'),
  'Kommentare zu Erinnerungen': ({ showBreakdown }) => showBreakdown('Kommentare nach Klasse', 'reminderComments', 'Klasse', 'Kommentare'),
  'Mensa-Bewertungen': ({ showDishes }) => showDishes('Bewertete Gerichte', 'ratings'),
  'Mensa-Kommentare': ({ showDishes }) => showDishes('Kommentierte Gerichte', 'comments'),
  'Downloads': ({ showBreakdown }) => showBreakdown('Downloads nach Datei', 'downloads', 'Datei', 'Downloads'),
};

