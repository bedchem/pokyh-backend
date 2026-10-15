import { ReactNode, Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, ChevronRight, ExternalLink } from 'lucide-react';
import { adminApi } from '../../api';
import { Bars, RankBars } from '../charts';
import { Avatar, Dialog, SearchField, Spinner, useTableLabels } from '../kit';
import { countryName } from '../visitors/countries';
import type {
  AnalyticsBreakdown,
  AnalyticsDish,
  AnalyticsPeople,
  AnalyticsPerson,
  AnalyticsPersonDetail,
  AnalyticsRange,
  BreakdownKind,
  PeopleFilters,
  UsagePlatform,
} from '../../types';
import { NEUTRAL, PLATFORM_LABEL, capitalised, dayDate, de, duration, hours, lastSeen, longDay, percent, periodText, shortDate, when } from './format';

// Everything behind a figure opens here, in one window that remembers the way
// it came: a list of people leads to a person, a person to the addresses it
// used, an address to the map and the accounts behind it — and back. The
// window keeps its place on screen; only its content and width change.

// The map and its world data load only when the visitors are first opened.
const VisitorsView = lazy(() => import('../visitors/VisitorsView'));

export type SortKey = 'username' | 'seconds' | 'visits' | 'activeDays' | 'lastSeenAt';
export type DishSort = 'name' | 'starCount' | 'ratings' | 'avgStars' | 'comments';

export type InspectorView =
  | { kind: 'people'; title: string; filters: PeopleFilters; sort: SortKey; range?: AnalyticsRange; search?: string }
  | { kind: 'dishes'; title: string; sort: DishSort; stars?: number }
  | { kind: 'breakdown'; title: string; breakdown: BreakdownKind; labelHeader: string; valueHeader: string }
  | { kind: 'visitors'; country?: string | null; ip?: string | null }
  | { kind: 'person'; uid: string; username: string };

export interface InspectorNav {
  range: AnalyticsRange;
  colors: Record<UsagePlatform, string>;
  push: (view: InspectorView) => void;
  // Changes the current step in place (an address chosen on the map).
  replace: (view: InspectorView) => void;
  // The line under the title, once a view knows its numbers.
  setMeta: (meta: ReactNode) => void;
}

function titleOf(view: InspectorView): string {
  if (view.kind === 'visitors') return 'Website-Besucher';
  if (view.kind === 'person') return view.username;
  return view.title;
}

// How a step is named in the trail above the title.
function crumbOf(view: InspectorView): string {
  if (view.kind === 'visitors') return view.ip ?? (view.country ? `Besucher aus ${countryName(view.country)}` : 'Website-Besucher');
  return titleOf(view);
}

const WIDTH: Record<InspectorView['kind'], number> = { visitors: 1180, people: 820, person: 900, dishes: 760, breakdown: 640 };

export function Inspector({ stack, onChange, range, colors }: {
  stack: InspectorView[];
  onChange: (next: InspectorView[]) => void;
  range: AnalyticsRange;
  colors: Record<UsagePlatform, string>;
}) {
  const top = stack[stack.length - 1]!;
  const depth = stack.length;
  const [meta, setMeta] = useState<ReactNode>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // A new step starts without the previous one's numbers, at its top.
  const stepKey = `${depth}-${top.kind}${top.kind === 'person' ? `-${top.uid}` : ''}`;
  useEffect(() => {
    setMeta(null);
    contentRef.current?.closest('.fixed')?.scrollTo({ top: 0 });
  }, [stepKey]);

  const nav: InspectorNav = {
    range,
    colors,
    push: (view) => onChange([...stack, view]),
    replace: (view) => onChange([...stack.slice(0, -1), view]),
    setMeta,
  };

  return (
    <Dialog
      title={titleOf(top)}
      subtitle={meta ?? capitalised(periodText(range))}
      onClose={() => onChange([])}
      onBack={depth > 1 ? () => onChange(stack.slice(0, -1)) : undefined}
      trail={stack.slice(0, -1).map((view, i) => ({ label: crumbOf(view), onClick: () => onChange(stack.slice(0, i + 1)) }))}
      width={WIDTH[top.kind]}
      lead={top.kind === 'person' ? <Avatar name={top.username} size={46} /> : undefined}
      sheet
    >
      <div ref={contentRef} key={stepKey} className="animate-fadeIn">
        {top.kind === 'people' && <PeopleView view={top} nav={nav} />}
        {top.kind === 'dishes' && <DishesView view={top} nav={nav} />}
        {top.kind === 'breakdown' && <BreakdownView view={top} nav={nav} />}
        {top.kind === 'person' && <PersonView view={top} nav={nav} />}
        {top.kind === 'visitors' && (
          <Suspense fallback={<div className="flex justify-center py-20"><Spinner size={20} /></div>}>
            <VisitorsView
              range={range}
              country={top.country ?? null}
              ip={top.ip ?? null}
              onSelectIp={(ip) => nav.replace({ ...top, ip })}
              onOpenPerson={(uid, username) => nav.push({ kind: 'person', uid, username })}
              setMeta={setMeta}
            />
          </Suspense>
        )}
      </div>
    </Dialog>
  );
}

// ─── Shared pieces ──────────────────────────────────────────────────────────
// Lists alike: a search, a table sorted by a click on its header.

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

// The common frame: search, the list, states for loading and errors.
function ListBody({ error, loading, empty, search, onSearch, placeholder, footer, children }: {
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
      {/* On a phone the sheet itself scrolls; a second scroller inside it
          would trap the thumb. */}
      <div className="scrollbar-thin -mx-3 mt-4 px-3 sm:max-h-[60vh] sm:overflow-y-auto sm:overflow-x-hidden">
        {error ? (
          <p className="py-10 text-center text-[14px] text-ink-3">{error}</p>
        ) : loading ? (
          <div className="flex justify-center py-12"><Spinner size={20} /></div>
        ) : empty ? (
          <p className="py-10 text-center text-[14px] text-ink-3">{search ? 'Kein Treffer.' : 'Nichts in diesem Zeitraum.'}</p>
        ) : children}
      </div>
      {footer && <p className="mt-4 text-[12.5px] leading-relaxed text-ink-3">{footer}</p>}
    </>
  );
}

// Loads a view's data once per input and keeps it while it is shown.
function useViewData<T>(load: () => Promise<T>, key: string) {
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
      .catch((err) => { if (alive) setError(err instanceof Error ? err.message : 'Die Daten konnten nicht geladen werden.'); });
    return () => { alive = false; };
  }, [key]);
  return { data, error };
}

// ─── People ─────────────────────────────────────────────────────────────────

// Accounts are only named with their consent to the usage statistics; the
// rest of a figure is said in one line under the list.
function peopleFooter(result: AnalyticsPeople): string | undefined {
  const parts: string[] = [];
  if (result.window?.clamped) parts.push(`Namen gibt es nur ab ${shortDate(result.window.fromKey)}, ältere Besuche sind anonym.`);
  if (result.total > result.people.length) parts.push(`Gezeigt werden ${de(result.people.length)} von ${de(result.total)} Konten.`);
  if (result.hidden > 0) parts.push(`${de(result.hidden)} weitere ${result.hidden === 1 ? 'Konto' : 'Konten'} ohne Einwilligung zur Nutzungsstatistik ${result.hidden === 1 ? 'wird' : 'werden'} nicht einzeln gezeigt.`);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

const PEOPLE_COLUMNS: Column<SortKey>[] = [
  { key: 'username', label: 'Konto' },
  { key: 'seconds', label: 'Zeit', numeric: true },
  { key: 'visits', label: 'Besuche', numeric: true },
  { key: 'activeDays', label: 'Tage', numeric: true },
  { key: 'lastSeenAt', label: 'Zuletzt', numeric: true },
];

function comparePeople(a: AnalyticsPerson, b: AnalyticsPerson, key: SortKey): number {
  if (key === 'username') return a.username.localeCompare(b.username, 'de');
  if (key === 'lastSeenAt') return (a.lastSeenAt ?? '').localeCompare(b.lastSeenAt ?? '');
  return a[key] - b[key];
}

function PeopleView({ view, nav }: { view: Extract<InspectorView, { kind: 'people' }>; nav: InspectorNav }) {
  const range = view.range ?? nav.range;
  const [query, setQuery] = useState(view.search ?? '');
  const [sort, setSort] = useState<Sort<SortKey>>({ key: view.sort, desc: view.sort !== 'username' });
  const tableRef = useRef<HTMLDivElement>(null);
  useTableLabels(tableRef);
  const { data: result, error } = useViewData<AnalyticsPeople>(
    () => adminApi.analyticsPeople(range, view.filters),
    `${range}|${JSON.stringify(view.filters)}`,
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const people = (result?.people ?? []).filter((p) => !q || [p.username, p.klasse, p.detail].some((v) => v.toLowerCase().includes(q)));
    return [...people].sort((a, b) => {
      const order = comparePeople(a, b, sort.key);
      return (sort.desc ? -order : order) || a.username.localeCompare(b.username, 'de');
    });
  }, [result, query, sort]);
  const totalSeconds = shown.reduce((sum, p) => sum + p.seconds, 0);

  const { setMeta } = nav;
  useEffect(() => {
    if (!result) return;
    const shownPeriod = result.window?.clamped ? `seit ${shortDate(result.window.fromKey)}` : periodText(range);
    setMeta([`${de(result.total)} ${result.total === 1 ? 'Konto' : 'Konten'}`, shownPeriod, totalSeconds > 0 ? `zusammen ${hours(totalSeconds)}` : null].filter(Boolean).join(' · '));
  }, [result, range, totalSeconds, setMeta]);

  return (
    <ListBody
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
          <SortHeader columns={PEOPLE_COLUMNS} sort={sort} onSort={(column) => setSort((current) => nextSort(current, column.key, Boolean(column.numeric)))} />
          <tbody>
            {shown.map((p) => {
              const open = () => nav.push({ kind: 'person', uid: p.stableUid, username: p.username });
              return (
                <tr
                  key={p.stableUid}
                  data-clickable
                  tabIndex={0}
                  aria-label={`${p.username} öffnen`}
                  onClick={open}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
                >
                  <td data-primary>
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar name={p.username} size={34} />
                      <div className="min-w-0">
                        <div className="truncate font-medium">{p.username}</div>
                        <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-ink-3">
                          {p.platforms.map((platform) => (
                            <i key={platform} className="h-[7px] w-[7px] flex-shrink-0 rounded-full" style={{ background: nav.colors[platform] }} title={PLATFORM_LABEL[platform]} />
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
              );
            })}
          </tbody>
        </table>
      </div>
    </ListBody>
  );
}

// ─── One person ─────────────────────────────────────────────────────────────

function PersonView({ view, nav }: { view: Extract<InspectorView, { kind: 'person' }>; nav: InspectorNav }) {
  const { data, error } = useViewData<AnalyticsPersonDetail>(() => adminApi.analyticsPerson(view.uid, nav.range), `${view.uid}|${nav.range}`);
  const { setMeta } = nav;
  useEffect(() => {
    if (data) setMeta([data.klasse || 'ohne Klasse', `Konto seit ${shortDate(data.createdAt.slice(0, 10))}`].join(' · '));
  }, [data, setMeta]);

  if (error) {
    return <p className="py-16 text-center text-[14px] text-ink-3">{/404|consent/i.test(error) ? 'Dieses Konto wird ohne Einwilligung zur Nutzungsstatistik nicht einzeln gezeigt.' : error}</p>;
  }
  if (!data) return <div className="flex justify-center py-20"><Spinner size={20} /></div>;

  const { usage, web } = data;
  return (
    <div>
      {/* Where the person uses Pokyh, and the way to the account itself. */}
      <div className="flex flex-wrap items-center gap-2">
        {usage.platforms.map((platform) => (
          <span key={platform} className="vis-chip">
            <i className="h-[7px] w-[7px] flex-shrink-0 rounded-full" style={{ background: nav.colors[platform] }} />
            {PLATFORM_LABEL[platform]}
          </span>
        ))}
        {usage.platforms.length === 0 && <span className="text-[13px] text-ink-3">Keine gemessene Nutzung im Zeitraum</span>}
        <Link to="/users" state={{ search: data.username }} className="insp-link ml-auto">
          Im Nutzerbereich öffnen <ExternalLink size={13} strokeWidth={1.8} aria-hidden="true" />
        </Link>
      </div>

      <dl className="insp-facts mt-5">
        <div><dt>Zeit in Pokyh</dt><dd className="tabular">{usage.seconds > 0 ? duration(usage.seconds) : '–'}</dd></div>
        <div><dt>Besuche</dt><dd className="tabular">{de(usage.visits)}</dd></div>
        <div><dt>Aktive Tage</dt><dd className="tabular">{de(usage.activeDays)}</dd></div>
        <div><dt>Zuletzt aktiv</dt><dd>{usage.lastSeenAt ? lastSeen(usage.lastSeenAt) : '–'}</dd></div>
      </dl>

      {usage.daily.some((d) => d.seconds > 0) && (
        <>
          <h4 className="vis-h">Zeit pro Tag</h4>
          <Bars
            values={usage.daily.map((d) => Math.round(d.seconds / 60))}
            labels={usage.daily.map((d) => `${dayDate(d.dayKey).getDate()}.`)}
            titles={usage.daily.map((d) => longDay(d.dayKey))}
            unit="Min."
            height={84}
            color={NEUTRAL}
            ariaLabel={`Minuten in Pokyh pro Tag, ${data.username}`}
          />
        </>
      )}

      <div className="insp-pair mt-2">
        <section className="min-w-0">
          <h4 className="vis-h">Website · IP-Adressen</h4>
          {web.ips.length === 0 ? (
            <p className="text-[13.5px] text-ink-3">Keine Website-Besuche mit IP-Adresse im Zeitraum.</p>
          ) : (
            <ul className="vis-list-plain">
              {web.ips.map((entry) => (
                <li key={entry.ip}>
                  <button type="button" className="vis-row" onClick={() => nav.push({ kind: 'visitors', ip: entry.ip })}>
                    <span className="min-w-0 flex-1">
                      <span className="vis-ip block truncate">{entry.ip}</span>
                      <span className="mt-1 flex min-w-0 items-center gap-2 text-[12.5px] text-ink-3">
                        <span className="cc" aria-hidden="true">{entry.country || '??'}</span>
                        <span className="truncate">{[entry.city ?? countryName(entry.country), when(entry.lastAt)].join(' · ')}</span>
                      </span>
                    </span>
                    <span className="flex-shrink-0 text-right">
                      <span className="tabular block text-[15px] font-semibold">{de(entry.views)}</span>
                      <span className="block text-[11.5px] text-ink-3">Aufrufe</span>
                    </span>
                    <ChevronRight size={15} strokeWidth={1.7} className="flex-shrink-0 text-ink-4" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="min-w-0">
          <h4 className="vis-h">Aufgerufene Seiten</h4>
          <RankBars items={web.pages.map((p) => ({ label: p.page, value: p.views }))} empty="Keine Seitenaufrufe im Zeitraum." />
        </section>
      </div>

      <p className="mt-6 text-[12.5px] leading-relaxed text-ink-3">
        Sichtbar, weil dieses Konto der Nutzungsstatistik zugestimmt hat.
        {usage.window.clamped && ` Nutzung mit Namen ab ${shortDate(usage.window.fromKey)}.`}
        {` IP-Adressen ${web.window.clamped ? `ab ${shortDate(web.window.fromKey)}` : 'im Zeitraum'}; sie werden nach 30 Tagen entfernt.`}
      </p>
    </div>
  );
}

// ─── Dishes ─────────────────────────────────────────────────────────────────

function dishValue(dish: AnalyticsDish, key: DishSort, stars?: number): number | string {
  if (key === 'name') return dish.name;
  if (key === 'starCount') return stars ? dish.stars[stars - 1] ?? 0 : 0;
  if (key === 'avgStars') return dish.avgStars ?? -1;
  return dish[key];
}

function DishesView({ view, nav }: { view: Extract<InspectorView, { kind: 'dishes' }>; nav: InspectorNav }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort<DishSort>>({ key: view.sort, desc: view.sort !== 'name' });
  const tableRef = useRef<HTMLDivElement>(null);
  useTableLabels(tableRef);
  const { data, error } = useViewData(() => adminApi.analyticsDishes(), 'dishes');
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

  const { setMeta } = nav;
  useEffect(() => {
    if (data) setMeta(`${de(shown.length)} ${shown.length === 1 ? 'Gericht' : 'Gerichte'} · alle Bewertungen`);
  }, [data, shown.length, setMeta]);

  return (
    <ListBody error={error} loading={!data} empty={shown.length === 0} search={query} onSearch={setQuery} placeholder="Gericht suchen">
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
    </ListBody>
  );
}

// ─── What a figure is made of ───────────────────────────────────────────────

function BreakdownView({ view, nav }: { view: Extract<InspectorView, { kind: 'breakdown' }>; nav: InspectorNav }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort<'label' | 'value'>>({ key: 'value', desc: true });
  const tableRef = useRef<HTMLDivElement>(null);
  useTableLabels(tableRef);
  const { range } = nav;
  const { data, error } = useViewData<AnalyticsBreakdown>(() => adminApi.analyticsBreakdown(view.breakdown, range), `${view.breakdown}|${range}`);
  const peak = Math.max(1, ...(data?.items ?? []).map((item) => item.value));

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = (data?.items ?? []).filter((item) => !q || item.label.toLowerCase().includes(q));
    return [...items].sort((a, b) => {
      const order = sort.key === 'label' ? a.label.localeCompare(b.label, 'de') : a.value - b.value;
      return (sort.desc ? -order : order) || a.label.localeCompare(b.label, 'de');
    });
  }, [data, query, sort]);

  const { setMeta } = nav;
  useEffect(() => {
    if (data) setMeta(`${de(data.total)} ${view.valueHeader} · ${periodText(range)}`);
  }, [data, range, view.valueHeader, setMeta]);

  const columns: Column<'label' | 'value'>[] = [
    { key: 'label', label: view.labelHeader },
    { key: 'value', label: view.valueHeader, numeric: true },
  ];

  return (
    <ListBody error={error} loading={!data} empty={shown.length === 0} search={query} onSearch={setQuery} placeholder={`${view.labelHeader} suchen`}>
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
    </ListBody>
  );
}
