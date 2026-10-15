import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { adminApi } from '../../api';
import { useTheme } from '../../theme';
import { Bars, RankBars } from '../charts';
import { Avatar, SearchField, Segmented, Spinner } from '../kit';
import { NEUTRAL, de, shortDate, when } from '../analytics/format';
import type { AnalyticsRange, AnalyticsVisitorIp, AnalyticsVisitors, VisitorDevice, VisitorIp } from '../../types';
import { countryName, frameFor } from './countries';
import { WorldMap, type MapFrame, type MapValue } from './WorldMap';

// "Website-Besucher" inside the inspector: everyone who opened the website,
// signed in or not. The map shows where they come from; beside it one calm
// list — addresses or countries. An address opens in the same place: how
// often, when, which pages and devices, and the accounts behind it (by name
// where they consent), each of which leads on to that person.

const DEVICE_LABEL: Record<VisitorDevice, string> = { ios: 'iPhone/iPad', android: 'Android', desktop: 'Computer', other: 'Sonstiges' };
const PAGE_SIZE = 50;

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

// Who is behind an address, in a few words: "anna.m", "anna.m +2",
// "3 Konten", or nothing for a guest.
function accountsText(entry: Pick<VisitorIp, 'accountCount' | 'accounts'>): string | null {
  const named = entry.accounts.map((a) => a.username);
  const others = Math.max(0, entry.accountCount - named.length);
  if (named.length > 0) return others > 0 || named.length > 1 ? `${named[0]} +${others + named.length - 1}` : named[0]!;
  if (entry.accountCount > 1) return `${de(entry.accountCount)} Konten`;
  return null;
}

// "1.234" with "davon 456 mit Konto" beneath.
function Total({ label, value, signed }: { label: string; value: number; signed?: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="tabular">{de(value)}</dd>
      {signed !== undefined && <dd className="vis-sub tabular">davon {de(signed)} mit Konto</dd>}
    </div>
  );
}

// Phones and narrow windows stack the list under the map.
function stacked(): boolean {
  return window.matchMedia('(max-width: 1023.98px)').matches;
}

interface VisitorsViewProps {
  range: AnalyticsRange;
  // The list narrowed to one country when opened (a click in the preview).
  country: string | null;
  // The address shown in detail; chosen here or arriving from a person.
  ip: string | null;
  onSelectIp: (ip: string | null) => void;
  onOpenPerson: (uid: string, username: string) => void;
  setMeta: (meta: ReactNode) => void;
}

export default function VisitorsView({ range, country: initialCountry, ip, onSelectIp, onOpenPerson, setMeta }: VisitorsViewProps) {
  const theme = useTheme();
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
    adminApi.analyticsVisitors(range)
      .then((next) => {
        if (!alive) return;
        setData(next);
        if (next.ips.length === 0) setTab('countries');
        setFrame(frameFor(next.countries));
        setMeta([next.period.label, `${de(next.totals.views)} Aufrufe`, `${de(next.totals.visitors)} Besucher`].join(' · '));
      })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : 'Die Besucher konnten nicht geladen werden.'); });
    return () => { alive = false; };
  }, [range, setMeta]);

  const values = useMemo(() => new Map<string, MapValue>(
    (data?.countries ?? []).filter((c) => c.country !== '').map((c) => [c.country, { views: c.views, visitors: c.visitors }]),
  ), [data]);

  const ips = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Matches an address, a place, a name, or "konto" / "gast".
    return (data?.ips ?? []).filter((entry) => (!country || entry.country === country) && (!q
      || entry.ip.includes(q)
      || place(entry).toLowerCase().includes(q)
      || entry.accounts.some((a) => a.username.toLowerCase().includes(q))
      || (entry.signedViews > 0 ? 'konto' : 'gast') === q));
  }, [data, country, query]);

  const countries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.countries ?? []).filter((c) => !q || countryName(c.country).toLowerCase().includes(q) || c.country.toLowerCase() === q);
  }, [data, query]);

  useEffect(() => { setShown(PAGE_SIZE); }, [country, query, tab]);

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

  return (
    <>
      <dl className="vis-totals">
        <Total label="Besucher" value={totals.visitors} signed={totals.signedVisitors} />
        <Total label="Aufrufe" value={totals.views} signed={totals.signedViews} />
        <Total label="IP-Adressen" value={totals.ips} signed={totals.signedIps} />
        <Total label="Länder" value={totals.countries} />
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
          />
        </div>

        <div ref={sideRef} className="vis-side">
          <div className="vis-side-inner">
            {ip ? (
              <IpDetail key={ip} ip={ip} entry={entry} range={range} onBack={() => onSelectIp(null)} onOpenPerson={onOpenPerson} />
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
                  placeholder={tab === 'ips' ? 'IP, Ort oder Name suchen' : 'Land suchen'}
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
                          ? `Für diesen Zeitraum gibt es keine IP-Adressen: sie werden nach ${data.ipRetentionDays} Tagen entfernt.`
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
                                  <span className="block text-[11.5px] text-ink-3">Aufrufe</span>
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
                                {de(c.visitors)} Besucher{c.ips > 0 ? ` · ${de(c.ips)} IP-Adressen` : ''}
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
        Gezählt wird jeder Seitenaufruf der Website, mit oder ohne Konto. Besucher sind verschiedene Personen pro Tag:
        Angemeldete zählen pro Konto, Gäste pro Gerät; wer an zwei Tagen kommt, zählt zweimal. Namen nur von Konten mit Einwilligung zur Nutzungsstatistik.
        IP-Adressen, Orte und Namen werden nach {data.ipRetentionDays} Tagen entfernt, danach bleibt nur die anonyme Zahl pro Land.
        {data.ipWindow.clamped && ` IP-Adressen gibt es in diesem Zeitraum erst ab ${shortDate(data.ipWindow.fromKey)}.`}
        {data.since && data.since > data.period.fromKey && ` Website-Besucher werden seit ${shortDate(data.since)} gezählt.`}
        {totals.unknownViews > 0 && ` ${de(totals.unknownViews)} Aufrufe ohne bekanntes Land.`}
      </p>
    </>
  );
}

// ─── One address ────────────────────────────────────────────────────────────

function IpDetail({ ip, entry, range, onBack, onOpenPerson }: {
  ip: string;
  entry: VisitorIp | null;
  range: AnalyticsRange;
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
            <div><dt>Aufrufe</dt><dd className="tabular">{de(detail.views)}</dd></div>
            <div><dt>Aktive Tage</dt><dd className="tabular">{de(detail.days)}</dd></div>
            <div><dt>Zuerst</dt><dd>{when(detail.firstAt)}</dd></div>
            <div><dt>Zuletzt</dt><dd>{when(detail.lastAt)}</dd></div>
            <div><dt>Meist um</dt><dd className="tabular">{String(peakHour).padStart(2, '0')}–{String((peakHour + 1) % 24).padStart(2, '0')} Uhr</dd></div>
            <div><dt>Mit Konto</dt><dd className="tabular">{de(detail.signedInViews)} {detail.signedInViews === 1 ? 'Aufruf' : 'Aufrufe'}</dd></div>
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
                            {[account.klasse || 'ohne Klasse', `${de(account.views)} ${account.views === 1 ? 'Aufruf' : 'Aufrufe'}`, when(account.lastAt)].join(' · ')}
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

          <h4 className="vis-h">Aufrufe pro Tag</h4>
          <Bars
            values={detail.daily.map((d) => d.views)}
            labels={detail.daily.map((d) => `${new Date(`${d.dayKey}T12:00:00`).getDate()}.`)}
            titles={detail.daily.map((d) => new Date(`${d.dayKey}T12:00:00`).toLocaleDateString('de-AT', { weekday: 'short', day: 'numeric', month: 'long' }))}
            unit="Aufrufe"
            height={78}
            color={NEUTRAL}
            ariaLabel={`Aufrufe von ${ip} pro Tag`}
          />

          <h4 className="vis-h">Seiten</h4>
          <RankBars items={detail.pages.slice(0, 6).map((p) => ({ label: p.page, value: p.views }))} color={NEUTRAL} />

          <h4 className="vis-h">Geräte</h4>
          <ul className="flex flex-wrap gap-2">
            {detail.devices.map((d) => (
              <li key={d.device} className="vis-chip">
                {DEVICE_LABEL[d.device] ?? d.device}
                <span className="tabular text-ink-3">{de(d.views)}</span>
              </li>
            ))}
          </ul>

          <h4 className="vis-h">Letzte Aufrufe</h4>
          <ul className="vis-recent">
            {(allRecent ? detail.recent : detail.recent.slice(0, 8)).map((r, i) => (
              <li key={`${r.at}-${i}`}>
                <span className="tabular w-[92px] flex-shrink-0 text-ink-3">{when(r.at)}</span>
                <span className="min-w-0 flex-1 truncate">{r.page}</span>
                <span className="flex-shrink-0 text-ink-3">{DEVICE_LABEL[r.device] ?? r.device} · {r.signedIn ? 'Konto' : 'Gast'}</span>
              </li>
            ))}
          </ul>
          {!allRecent && detail.recent.length > 8 && (
            <button type="button" className="btn btn-sm btn-quiet mt-3" onClick={() => setAllRecent(true)}>
              Alle {de(detail.recent.length)} zeigen
            </button>
          )}
          {detail.window.clamped && (
            <p className="mt-4 text-[12px] text-ink-3">Nur ab {shortDate(detail.window.fromKey)}: ältere Aufrufe haben keine IP-Adresse mehr.</p>
          )}
        </>
      )}
    </div>
  );
}
