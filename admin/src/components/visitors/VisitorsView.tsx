import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { adminApi } from '../../api';
import { useTheme } from '../../theme';
import { Bars, RankBars } from '../charts';
import { Avatar, SearchField, Segmented, Spinner } from '../kit';
import { NEUTRAL, PLATFORM_COLOR, PLATFORM_LABEL, SOURCE_PEOPLE, de, percent, shortDate, sourceOfViews, viewWord, when } from '../analytics/format';
import type {
  AnalyticsRange,
  AnalyticsVisitorIp,
  AnalyticsVisitors,
  UsagePlatform,
  VisitClient,
  VisitSource,
  VisitorDevice,
  VisitorIp,
} from '../../types';
import { countryName, frameFor } from './countries';
import { WorldMap, type MapFrame, type MapValue } from './WorldMap';

// Where people come from, inside the inspector: the website's visitors
// ("Website-Besucher"), the apps' users ("App-Nutzer"), or both ("Herkunft").
// The map shows the countries; beside it one calm list — addresses or
// countries. An address opens in the same place, always with everything from
// it: how often, when, which pages and apps, which devices, and the accounts
// behind it (by name where they consent), each of which leads on to that
// person.

const DEVICE_LABEL: Record<VisitorDevice, string> = { ios: 'iPhone/iPad', android: 'Android', desktop: 'Computer', other: 'Sonstiges' };
const APP_LABEL: Record<VisitorDevice, string> = { ios: 'iPhone-App', android: 'Android-App', desktop: 'App', other: 'App' };
const PAGE_SIZE = 50;

function deviceLabel(client: VisitClient, device: VisitorDevice): string {
  return client === 'app' ? APP_LABEL[device] ?? 'App' : DEVICE_LABEL[device] ?? device;
}

function place(entry: { country: string; region: string | null; city: string | null }): string {
  const local = [entry.city, entry.region && entry.region !== entry.city ? entry.region : null].filter(Boolean).join(', ');
  return [local, countryName(entry.country)].filter(Boolean).join(' · ');
}

function CountryCode({ code }: { code: string }) {
  return <span className="cc" aria-hidden="true">{code || '??'}</span>;
}

// An address someone signed in from is "Konto", any other "Gast".
function Kind({ signed }: { signed: boolean }) {
  return <span className="vis-kind" data-kind={signed ? 'account' : 'guest'}>{signed ? 'Konto' : 'Gast'}</span>;
}

// Where an address was used, as the platform dots of the rest of the page.
function PlatformDots({ platforms, colors }: { platforms: UsagePlatform[]; colors: Record<UsagePlatform, string> }) {
  if (platforms.length === 0) return null;
  // Labelled with aria-label rather than an sr-only text: an absolutely
  // positioned element in every row would stretch the side panel's own scroll
  // area to the length of the list and give it a second scrollbar.
  const label = platforms.map((p) => PLATFORM_LABEL[p]).join(', ');
  return (
    <span role="img" aria-label={label} title={label} className="flex flex-shrink-0 items-center gap-1">
      {platforms.map((p) => <i key={p} className="h-[7px] w-[7px] rounded-full" style={{ background: colors[p] }} aria-hidden="true" />)}
    </span>
  );
}

// Who is behind an address, in a few words: "anna.m", "anna.m +2",
// "3 Konten", or nothing for a guest.
function accountsText(entry: Pick<VisitorIp, 'accountCount' | 'accounts'>): string | null {
  const named = entry.accounts.map((a) => a.username);
  const others = Math.max(0, entry.accountCount - named.length);
  if (named.length > 0) return others > 0 || named.length > 1 ? `${named[0]} +${others + named.length - 1}` : named[0]!;
  if (entry.accountCount > 1) return `${de(entry.accountCount)} Konten`;
  return null;
}

// "12 Website · 3 App" for an address used both ways; null otherwise.
function splitText(views: number, appViews: number): string | null {
  const webViews = views - appViews;
  if (webViews <= 0 || appViews <= 0) return null;
  return `${de(webViews)} Website · ${de(appViews)} App`;
}

// "1.234" with what it is made of beneath, such as "davon 456 mit Konto".
function Total({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="tabular">{de(value)}</dd>
      <dd className="vis-sub tabular">{sub}</dd>
    </div>
  );
}

// One fact about an address, with what it means beneath.
function Fact({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="tabular">{value}</dd>
      <dd className="vis-fact-sub">{sub}</dd>
    </div>
  );
}

// "heute", "gestern", "vor 12 Tagen".
function daysAgo(iso: string | null): string {
  if (!iso) return '–';
  const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(new Date(iso))) / 86_400_000);
  return days <= 0 ? 'heute' : days === 1 ? 'gestern' : `vor ${de(days)} Tagen`;
}

// Phones and narrow windows stack the list under the map.
function stacked(): boolean {
  return window.matchMedia('(max-width: 1023.98px)').matches;
}

interface VisitorsViewProps {
  range: AnalyticsRange;
  // Website, apps, or both.
  source: VisitSource;
  onSource: (source: VisitSource) => void;
  // The list narrowed to one country when opened (a click in the preview).
  country: string | null;
  // The address shown in detail; chosen here or arriving from a person.
  ip: string | null;
  onSelectIp: (ip: string | null) => void;
  onOpenPerson: (uid: string, username: string) => void;
  setMeta: (meta: ReactNode) => void;
}

export default function VisitorsView({ range, source, onSource, country: initialCountry, ip, onSelectIp, onOpenPerson, setMeta }: VisitorsViewProps) {
  const theme = useTheme();
  const colors = PLATFORM_COLOR[theme];
  const [data, setData] = useState<AnalyticsVisitors | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [country, setCountry] = useState<string | null>(initialCountry);
  const [tab, setTab] = useState<'ips' | 'countries'>('ips');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE_SIZE);
  const [frame, setFrame] = useState<MapFrame>('world');
  const sideRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    adminApi.analyticsVisitors(range, source)
      .then((next) => {
        if (!alive) return;
        setData(next);
        setTab(next.ips.length === 0 ? 'countries' : 'ips');
        setFrame(frameFor(next.countries));
        setMeta([next.period.label, `${de(next.totals.views)} ${viewWord(source, next.totals.views)}`, `${de(next.totals.visitors)} ${SOURCE_PEOPLE[source]}`].join(' · '));
      })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : 'Die Besucher konnten nicht geladen werden.'); });
    return () => { alive = false; };
  }, [range, source, setMeta]);

  const values = useMemo(() => new Map<string, MapValue>(
    (data?.countries ?? []).filter((c) => c.country !== '').map((c) => [c.country, { views: c.views, visitors: c.visitors }]),
  ), [data]);

  const ips = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Matches an address, a place, a name, "konto" / "gast", or "app" / "web".
    return (data?.ips ?? []).filter((entry) => (!country || entry.country === country) && (!q
      || entry.ip.includes(q)
      || place(entry).toLowerCase().includes(q)
      || entry.accounts.some((a) => a.username.toLowerCase().includes(q))
      || (entry.signedViews > 0 ? 'konto' : 'gast') === q
      || (q === 'app' && entry.appViews > 0)
      || ((q === 'web' || q === 'website') && entry.views > entry.appViews)
      || entry.platforms.some((p) => PLATFORM_LABEL[p].toLowerCase() === q)));
  }, [data, country, query]);

  const countries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.countries ?? []).filter((c) => !q || countryName(c.country).toLowerCase().includes(q) || c.country.toLowerCase() === q);
  }, [data, query]);

  useEffect(() => { setShown(PAGE_SIZE); }, [country, query, tab, source]);

  const entry = ip ? data?.ips.find((e) => e.ip === ip) ?? null : null;

  const chooseCountry = (code: string | null) => {
    onSelectIp(null);
    setCountry(code);
    if (code) setTab('ips');
  };

  const openIp = (next: string) => {
    onSelectIp(next);
    if (stacked()) requestAnimationFrame(() => sideRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  if (error) return <p className="py-16 text-center text-[14px] text-ink-3">{error}</p>;
  if (!data) return <div className="flex justify-center py-20"><Spinner size={20} /></div>;
  const { totals } = data;
  const listLength = tab === 'ips' ? ips.length : countries.length;
  // The figures of the switch: always both sides, whichever is shown.
  const allViews = data.sources.web + data.sources.app;
  const topCountry = data.countries.find((c) => c.country !== '') ?? null;

  return (
    <>
      <Segmented
        label="Besucher von"
        value={source}
        onChange={onSource}
        options={[
          { value: 'all', label: <>Alle <span className="tabular text-ink-4">{de(allViews)}</span></> },
          { value: 'web', label: <>Website <span className="tabular text-ink-4">{de(data.sources.web)}</span></> },
          { value: 'app', label: <>Apps <span className="tabular text-ink-4">{de(data.sources.app)}</span></> },
        ]}
      />

      <dl className="vis-totals mt-5">
        {/* The apps send only signed in, so there every figure is "mit Konto"
            and the line beneath says something else. */}
        <Total
          label={SOURCE_PEOPLE[source]}
          value={totals.visitors}
          sub={source === 'app' ? 'alle mit Konto' : `davon ${de(totals.signedVisitors)} mit Konto`}
        />
        <Total
          label={viewWord(source, 2)}
          value={totals.views}
          sub={source === 'app'
            ? `Ø ${de(totals.visitors > 0 ? totals.views / totals.visitors : 0, 1)} pro Nutzer und Tag`
            : `davon ${de(totals.signedViews)} mit Konto`}
        />
        <Total
          label="IP-Adressen"
          value={totals.ips}
          sub={source === 'app'
            ? `Ø ${de(data.ips.length > 0 ? data.ips.reduce((sum, e) => sum + e.views, 0) / data.ips.length : 0, 1)} Öffnungen je Adresse`
            : `davon ${de(totals.signedIps)} mit Konto`}
        />
        <Total
          label="Länder"
          value={totals.countries}
          sub={topCountry ? `${percent(topCountry.views, totals.views)} aus ${countryName(topCountry.country)}` : 'noch keins bekannt'}
        />
      </dl>

      <div className="vis-grid mt-6">
        <div className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-[14.5px] text-ink-3">Herkunft nach Land</h3>
            <Segmented label="Kartenausschnitt" value={frame} onChange={setFrame} options={[{ value: 'world', label: 'Welt' }, { value: 'europe', label: 'Europa' }]} />
          </div>
          <WorldMap
            values={values}
            frame={frame}
            selected={entry ? entry.country || null : country}
            onSelect={chooseCountry}
            theme={theme}
            idleText={values.size > 0 ? 'Land wählen für seine IP-Adressen' : 'Noch kein Land bekannt'}
            units={{ views: viewWord(source, 2), visitors: SOURCE_PEOPLE[source] }}
          />
        </div>

        <div ref={sideRef} className="vis-side">
          <div className="vis-side-inner">
            {ip ? (
              <IpDetail key={ip} ip={ip} entry={entry} range={range} colors={colors} onBack={() => onSelectIp(null)} onOpenPerson={onOpenPerson} />
            ) : (
              <>
                <Segmented
                  label="Liste"
                  value={tab}
                  onChange={setTab}
                  options={[
                    { value: 'ips', label: <>IP-Adressen <span className="tabular text-ink-4">{de(totals.ips)}</span></> },
                    { value: 'countries', label: <>Länder <span className="tabular text-ink-4">{de(totals.countries)}</span></> },
                  ]}
                />
                <SearchField
                  className="mt-3"
                  value={query}
                  onChange={setQuery}
                  placeholder={tab === 'ips' ? 'IP, Ort, Name oder App suchen' : 'Land suchen'}
                />
                {country && tab === 'ips' && (
                  <button type="button" className="vis-filter mt-3" onClick={() => setCountry(null)}>
                    <CountryCode code={country} />
                    {countryName(country)}
                    <X size={13} strokeWidth={2} aria-hidden="true" />
                    <span className="sr-only">Filter entfernen</span>
                  </button>
                )}

                <div className="vis-list scrollbar-thin mt-3">
                  {tab === 'ips' ? (
                    ips.length === 0 ? (
                      <p className="py-10 text-center text-[13.5px] leading-relaxed text-ink-3">
                        {data.ips.length === 0
                          ? source === 'app' && totals.views === 0
                            ? 'In diesem Zeitraum wurde keine App geöffnet.'
                            : `Für diesen Zeitraum gibt es keine IP-Adressen: sie werden nach ${data.ipRetentionDays} Tagen entfernt.`
                          : 'Keine IP-Adresse passt.'}
                      </p>
                    ) : (
                      <ul>
                        {ips.slice(0, shown).map((row) => {
                          const who = accountsText(row);
                          return (
                            <li key={row.ip}>
                              <button type="button" className="vis-row" onClick={() => openIp(row.ip)}>
                                <span className="min-w-0 flex-1">
                                  <span className="flex min-w-0 items-center gap-2">
                                    <span className="vis-ip min-w-0 truncate">{row.ip}</span>
                                    <Kind signed={row.signedViews > 0} />
                                    {source === 'all' && <PlatformDots platforms={row.platforms} colors={colors} />}
                                  </span>
                                  <span className="mt-1 flex min-w-0 items-center gap-2 text-[12.5px] text-ink-3">
                                    <CountryCode code={row.country} />
                                    <span className="truncate">
                                      {who && <span className="text-ink-2">{who} · </span>}
                                      {[row.city ?? countryName(row.country), when(row.lastAt)].join(' · ')}
                                    </span>
                                  </span>
                                </span>
                                <span className="flex-shrink-0 text-right">
                                  <span className="tabular block text-[15px] font-semibold">{de(row.views)}</span>
                                  <span className="block text-[11.5px] text-ink-3">{viewWord(sourceOfViews(row.views, row.appViews), row.views)}</span>
                                </span>
                                <ChevronRight size={15} strokeWidth={1.7} className="flex-shrink-0 text-ink-4" aria-hidden="true" />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )
                  ) : countries.length === 0 ? (
                    <p className="py-10 text-center text-[13.5px] text-ink-3">{data.countries.length === 0 ? 'Noch keine Besuche in diesem Zeitraum.' : 'Kein Land passt.'}</p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {countries.slice(0, shown).map((c) => {
                        const peak = Math.max(1, data.countries[0]?.views ?? 1);
                        return (
                          <li key={c.country || 'unknown'}>
                            <button type="button" className="vis-country" disabled={!c.country} onClick={() => chooseCountry(c.country)}>
                              <span className="flex items-baseline justify-between gap-3">
                                <span className="flex min-w-0 items-center gap-2">
                                  <CountryCode code={c.country} />
                                  <span className="truncate text-[14px]">{countryName(c.country)}</span>
                                </span>
                                <span className="tabular flex-shrink-0 text-[14px] font-medium">{de(c.views)}</span>
                              </span>
                              <span className="rank-track mt-2 block">
                                <span className="rank-fill" style={{ width: `${Math.max((c.views / peak) * 100, 2)}%`, background: NEUTRAL }} />
                              </span>
                              <span className="mt-1.5 block text-[12px] text-ink-3">
                                {de(c.visitors)} {SOURCE_PEOPLE[source]}{c.ips > 0 ? ` · ${de(c.ips)} IP-Adressen` : ''}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {listLength > shown && (
                    <div className="flex justify-center pb-1 pt-4">
                      <button type="button" className="btn btn-sm btn-quiet" onClick={() => setShown((n) => n + PAGE_SIZE)}>
                        Weitere {de(Math.min(PAGE_SIZE, listLength - shown))} anzeigen
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <p className="mt-6 max-w-[90ch] text-[12.5px] leading-relaxed text-ink-3">
        {source !== 'app' && 'Website: jeder Seitenaufruf zählt, mit oder ohne Konto. '}
        {source !== 'web' && 'Apps: jedes Öffnen zählt einmal pro IP-Adresse und Tag, nur angemeldet — ohne Konto senden die Apps nichts. '}
        {SOURCE_PEOPLE[source]} sind verschiedene Personen pro Tag: Angemeldete zählen pro Konto{source === 'all' ? ', auf der Website und in den Apps zusammen' : ''}
        {source === 'app' ? '' : ', Gäste pro Gerät'}; wer an zwei Tagen kommt, zählt zweimal. Namen nur von Konten mit Einwilligung zur Nutzungsstatistik.
        IP-Adressen, Orte und Namen werden nach {data.ipRetentionDays} Tagen entfernt, danach bleibt nur die anonyme Zahl pro Land.
        {data.ipWindow.clamped && ` IP-Adressen gibt es in diesem Zeitraum erst ab ${shortDate(data.ipWindow.fromKey)}.`}
        {data.since && data.since > data.period.fromKey && ` Gezählt seit ${shortDate(data.since)}.`}
        {totals.unknownViews > 0 && ` ${de(totals.unknownViews)} ${viewWord(source, totals.unknownViews)} ohne bekanntes Land.`}
      </p>
    </>
  );
}

// ─── One address ────────────────────────────────────────────────────────────

function IpDetail({ ip, entry, range, colors, onBack, onOpenPerson }: {
  ip: string;
  entry: VisitorIp | null;
  range: AnalyticsRange;
  colors: Record<UsagePlatform, string>;
  onBack: () => void;
  onOpenPerson: (uid: string, username: string) => void;
}) {
  const [detail, setDetail] = useState<AnalyticsVisitorIp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allRecent, setAllRecent] = useState(false);

  useEffect(() => {
    let alive = true;
    adminApi.analyticsVisitorIp(ip, range)
      .then((next) => { if (alive) setDetail(next); })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : 'Die IP-Adresse konnte nicht geladen werden.'); });
    return () => { alive = false; };
  }, [ip, range]);

  const head = detail ?? entry;
  const peakHour = detail ? detail.hours.reduce((best, n, h, all) => (n > (all[best] ?? 0) ? h : best), 0) : 0;
  const others = detail ? Math.max(0, detail.accountCount - detail.accounts.length) : 0;
  // An address only ever seen in the apps speaks of openings, any other of views.
  const unit: VisitSource = detail ? sourceOfViews(detail.views, detail.appViews) : 'web';
  // What the address did last: the page, or which app in which version.
  const last = detail?.recent[0];
  const lastText = !last ? '–'
    : last.client === 'app' ? [deviceLabel('app', last.device), last.appVersion && `v${last.appVersion}`].filter(Boolean).join(' ')
      : `${last.page} · ${deviceLabel('web', last.device)}`;
  const platforms = useMemo<UsagePlatform[]>(() => {
    if (!detail) return entry?.platforms ?? [];
    const seen = new Set(detail.devices.map((d) => (d.client === 'app' ? (d.device === 'ios' || d.device === 'android' ? d.device : 'other') : 'web')));
    return (['ios', 'android', 'web', 'other'] as UsagePlatform[]).filter((p) => seen.has(p));
  }, [detail, entry]);

  return (
    <div className="animate-fadeIn">
      <button type="button" className="vis-back" onClick={onBack}>
        <ChevronLeft size={15} strokeWidth={1.8} aria-hidden="true" />
        Alle IP-Adressen
      </button>

      <div className="mt-4">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="vis-ip break-all text-[19px]">{ip}</span>
          {head && <Kind signed={(detail ? detail.signedInViews : entry?.signedViews ?? 0) > 0} />}
          <PlatformDots platforms={platforms} colors={colors} />
        </div>
        {head && (
          <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[13px] text-ink-3">
            <CountryCode code={head.country} />
            <span className="min-w-0">{place(head)}</span>
          </div>
        )}
      </div>

      {error ? (
        <p className="py-10 text-center text-[13.5px] text-ink-3">{error}</p>
      ) : !detail ? (
        <div className="flex justify-center py-12"><Spinner size={18} /></div>
      ) : (
        <>
          <dl className="vis-facts mt-5">
            <Fact
              label={viewWord(unit, 2)}
              value={de(detail.views)}
              sub={splitText(detail.views, detail.appViews) ?? `Ø ${de(detail.days > 0 ? detail.views / detail.days : 0, 1)} pro aktivem Tag`}
            />
            <Fact label="Aktive Tage" value={de(detail.days)} sub={`von ${de(detail.daily.length)} Tagen`} />
            <Fact label="Zuerst" value={when(detail.firstAt)} sub={daysAgo(detail.firstAt)} />
            <Fact label="Zuletzt" value={when(detail.lastAt)} sub={lastText} />
            <Fact
              label="Meist um"
              value={`${String(peakHour).padStart(2, '0')}–${String((peakHour + 1) % 24).padStart(2, '0')} Uhr`}
              sub={`${de(detail.hours[peakHour] ?? 0)} ${viewWord(unit, detail.hours[peakHour] ?? 0)} in dieser Stunde`}
            />
            <Fact
              label="Mit Konto"
              value={`${de(detail.signedInViews)} ${viewWord(unit, detail.signedInViews)}`}
              sub={`${percent(detail.signedInViews, detail.views)} von allen`}
            />
          </dl>

          {detail.accountCount > 0 && (
            <>
              <h4 className="vis-h">
                {detail.accountCount === 1 ? 'Angemeldet als' : `${de(detail.accountCount)} Konten von dieser Adresse`}
              </h4>
              {detail.accounts.length > 0 && (
                <ul className="vis-accounts">
                  {detail.accounts.map((account) => (
                    <li key={account.stableUid}>
                      <button type="button" className="vis-person" onClick={() => onOpenPerson(account.stableUid, account.username)}>
                        <Avatar name={account.username} size={32} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[14px] font-medium">{account.username}</span>
                          <span className="block truncate text-[12px] text-ink-3">
                            {[
                              account.klasse || 'ohne Klasse',
                              `${de(account.views)} ${viewWord(sourceOfViews(account.views, account.appViews), account.views)}`,
                              account.appViews > 0 && account.appViews < account.views ? `${de(account.appViews)} in der App` : null,
                              when(account.lastAt),
                            ].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                        <ChevronRight size={15} strokeWidth={1.7} className="flex-shrink-0 text-ink-4" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {others > 0 && (
                <p className="mt-2.5 text-[12.5px] leading-relaxed text-ink-3">
                  {detail.accounts.length > 0 ? `Dazu ${de(others)}` : de(others)} {others === 1 ? 'Konto' : 'Konten'} ohne Einwilligung
                  zur Nutzungsstatistik — gezählt, aber ohne Namen.
                </p>
              )}
            </>
          )}

          <h4 className="vis-h">{viewWord(unit, 2)} pro Tag</h4>
          <Bars
            values={detail.daily.map((d) => d.views)}
            labels={detail.daily.map((d) => `${new Date(`${d.dayKey}T12:00:00`).getDate()}.`)}
            titles={detail.daily.map((d) => new Date(`${d.dayKey}T12:00:00`).toLocaleDateString('de-AT', { weekday: 'short', day: 'numeric', month: 'long' }))}
            unit={viewWord(unit, 2)}
            height={78}
            color={NEUTRAL}
            ariaLabel={`${viewWord(unit, 2)} von ${ip} pro Tag`}
          />

          {detail.pages.length > 0 && (
            <>
              <h4 className="vis-h">Seiten der Website</h4>
              <RankBars items={detail.pages.slice(0, 6).map((p) => ({ label: p.page, value: p.views }))} color={NEUTRAL} />
            </>
          )}

          <h4 className="vis-h">Geräte &amp; Apps</h4>
          <ul className="flex flex-wrap gap-2">
            {detail.devices.map((d) => (
              <li key={`${d.client}-${d.device}`} className="vis-chip">
                {d.client === 'app' && (
                  <i className="h-[7px] w-[7px] rounded-full" style={{ background: colors[d.device === 'ios' || d.device === 'android' ? d.device : 'other'] }} aria-hidden="true" />
                )}
                {deviceLabel(d.client, d.device)}
                <span className="tabular text-ink-3">{de(d.views)}</span>
              </li>
            ))}
          </ul>

          <h4 className="vis-h">Zuletzt</h4>
          <ul className="vis-recent">
            {(allRecent ? detail.recent : detail.recent.slice(0, 8)).map((r, i) => (
              <li key={`${r.at}-${i}`}>
                <span className="tabular w-[92px] flex-shrink-0 text-ink-3">{when(r.at)}</span>
                <span className="min-w-0 flex-1 truncate">
                  {r.client === 'app' ? <>App geöffnet{r.appVersion && <span className="text-ink-3"> · v{r.appVersion}</span>}</> : r.page}
                </span>
                <span className="flex-shrink-0 text-ink-3">{deviceLabel(r.client, r.device)} · {r.signedIn ? 'Konto' : 'Gast'}</span>
              </li>
            ))}
          </ul>
          {!allRecent && detail.recent.length > 8 && (
            <button type="button" className="btn btn-sm btn-quiet mt-3" onClick={() => setAllRecent(true)}>
              Alle {de(detail.recent.length)} zeigen
            </button>
          )}
          {detail.window.clamped && (
            <p className="mt-4 text-[12px] text-ink-3">Nur ab {shortDate(detail.window.fromKey)}: ältere Besuche haben keine IP-Adresse mehr.</p>
          )}
        </>
      )}
    </div>
  );
}
