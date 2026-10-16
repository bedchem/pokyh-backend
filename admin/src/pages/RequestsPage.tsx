import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, ChevronLeft, ChevronRight, Gauge, RefreshCw, ServerCrash, Timer } from 'lucide-react';
import { adminApi } from '../api';
import { useAccess } from '../access';
import { useLive } from '../live';
import { useToast } from '../components/Toast';
import { TrendChart } from '../components/TrendChart';
import { SplitBar } from '../components/charts';
import { Empty, Figures, IconButton, PageHeader, Pager, SearchField, Section, Segmented, Status, Tag, useTableLabels, type Tone } from '../components/kit';
import { currentHour, longDayKey, ms, num, shiftDayKey, startOfDay, timeOnly } from '../components/format';
import type { RequestLog, RequestScopeChoice, RequestsSummary } from '../types';

// API requests — traffic, not activity: one local day at a time, hour by
// hour, with the busiest endpoints and every request of that day. The admin
// panel's own requests are a scope of their own (operators only) and never
// mixed into the apps' figures.

const SCOPES: Array<{ value: RequestScopeChoice; label: string; global?: boolean }> = [
  { value: 'app', label: 'Apps' },
  { value: 'core', label: 'Pokyh' },
  { value: 'learn', label: 'Learn' },
  { value: 'admin', label: 'Admin-Panel', global: true },
  { value: 'all', label: 'Alle', global: true },
];

function statusTone(status: number): Tone {
  if (status >= 500) return 'rose';
  if (status >= 400) return 'amber';
  if (status >= 300) return 'sky';
  return 'mint';
}

function methodTone(method: string): Tone {
  if (method === 'GET') return 'sky';
  if (method === 'POST') return 'mint';
  if (method === 'DELETE') return 'rose';
  return 'amber';
}

// The day's bounds in the installation's time zone, for the request list.
function dayBounds(dayKey: string): { from: string; to: string } {
  const start = startOfDay(dayKey);
  const end = startOfDay(shiftDayKey(dayKey, 1));
  return { from: start.toISOString(), to: new Date(end.getTime() - 1).toISOString() };
}

export function RequestsPage() {
  const { view, canGlobal } = useAccess();
  const { showToast } = useToast();
  const operator = view?.kind === 'global' && canGlobal('system.monitoring.view');
  const scopes = SCOPES.filter((s) => !s.global || operator);
  const [scope, setScope] = useState<RequestScopeChoice>('app');
  const [day, setDay] = useState<string | null>(null);
  const [summary, setSummary] = useState<RequestsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await adminApi.requestsSummary(day ?? undefined, scope);
      setSummary(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Anfragen konnten nicht geladen werden');
    } finally {
      setLoading(false);
    }
  }, [day, scope]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  // Today's figures follow new requests; a past day does not change.
  useLive(['requests'], () => { if (!day || day === summary?.today) void load(); }, 5000);

  const shown = summary?.day ?? null;
  const canBack = !!summary && summary.day > summary.firstDay;
  const canForward = !!summary && summary.day < summary.today;
  const go = (direction: -1 | 1) => {
    if (!summary || (direction === -1 ? !canBack : !canForward)) return;
    const next = shiftDayKey(summary.day, direction);
    setDay(next >= summary.today ? null : next);
  };

  const chart = useMemo(() => {
    if (!summary) return null;
    return {
      labels: summary.hours.map((h) => String(h.hour).padStart(2, '0')),
      titles: summary.hours.map((h) => `${String(h.hour).padStart(2, '0')}:00–${String((h.hour + 1) % 24).padStart(2, '0')}:00`),
      series: [
        { key: 'count', label: 'Anfragen', color: '#4f96dc', area: true, values: summary.hours.map((h) => h.count) },
        { key: 'errors', label: 'Fehler', color: '#f2a55c', values: summary.hours.map((h) => h.clientErrors + h.serverErrors) },
      ],
    };
  }, [summary]);

  const statusParts = useMemo(() => {
    const by = (lo: number, hi: number) => (summary?.statuses ?? []).filter((s) => s.status >= lo && s.status < hi).reduce((sum, s) => sum + s.count, 0);
    return [
      { label: '2xx', value: by(200, 300), color: 'var(--mint)' },
      { label: '3xx', value: by(300, 400), color: 'var(--sky)' },
      { label: '4xx', value: by(400, 500), color: 'var(--amber)' },
      { label: '5xx', value: by(500, 600), color: 'var(--rose)' },
    ];
  }, [summary]);

  const totals = summary?.totals;
  const errorRate = totals && totals.count > 0 ? ((totals.clientErrors + totals.serverErrors) / totals.count) * 100 : 0;
  const peak = Math.max(1, ...(summary?.endpoints ?? []).map((e) => e.count));

  return (
    <div>
      <PageHeader
        title="Anfragen"
        subtitle={view?.kind === 'school'
          ? 'API-Anfragen der Konten dieser Schule, Tag für Tag. Ohne Adressen und Geräte-Kennungen.'
          : 'API-Anfragen der Apps, Tag für Tag. Die eigenen Anfragen des Admin-Panels zählen hier nicht mit, außer du wählst sie.'}
      >
        {scopes.length > 1 && <Segmented label="Bereich" value={scope} onChange={(next) => { setScope(next); setLoading(true); }} options={scopes} />}
        <IconButton icon={RefreshCw} label="Aktualisieren" size={42} busy={loading} onClick={() => { setLoading(true); void load(); }} />
      </PageHeader>

      {/* The day: buttons, keys (on the chart) and a drag past its edge. */}
      <div className="day-nav mt-7" role="group" aria-label="Tag wählen">
        <button type="button" className="orb h-10 w-10" onClick={() => go(-1)} disabled={!canBack} aria-label="Vorheriger Tag">
          <ChevronLeft size={18} strokeWidth={1.8} />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <div className="truncate text-[16px] font-semibold">{shown ? longDayKey(shown) : '…'}</div>
          <div className="text-[12.5px] text-ink-3">{shown && summary && shown === summary.today ? 'Heute' : `Gespeichert werden ${summary?.retentionDays ?? 30} Tage`}</div>
        </div>
        <button type="button" className="orb h-10 w-10" onClick={() => go(1)} disabled={!canForward} aria-label="Nächster Tag">
          <ChevronRight size={18} strokeWidth={1.8} />
        </button>
        {day && <button type="button" className="btn btn-sm btn-quiet" onClick={() => setDay(null)}>Heute</button>}
      </div>

      {error && <p className="mt-6 text-[14px]" style={{ color: 'var(--rose-deep)' }}>{error}</p>}

      <div style={{ opacity: loading ? 0.55 : 1, transition: 'opacity 0.25s ease' }}>
        <Figures
          className="mt-6"
          items={[
            { label: 'Anfragen', value: totals?.count ?? 0, icon: Activity },
            { label: 'Fehlerquote', value: `${num(errorRate, 1)} %`, icon: AlertTriangle, note: <span className="text-[12.5px] text-ink-3">{num(totals?.clientErrors ?? 0)} × 4xx</span> },
            { label: 'Serverfehler', value: totals?.serverErrors ?? 0, icon: ServerCrash },
            { label: 'Antwortzeit Ø', value: ms(totals?.avgMs), icon: Timer, note: <span className="text-[12.5px] text-ink-3">Median ≤ {ms(totals?.p50Ms)}</span> },
            { label: '95 % schneller als', value: totals?.p95Ms === null ? '> 2,5 s' : ms(totals?.p95Ms), icon: Gauge },
          ]}
        />

        <Section className="mt-[46px]" title="Je Stunde" meta={shown ? longDayKey(shown) : undefined}>
          <div className="mt-6">
            {chart && totals && totals.count > 0 ? (
              <TrendChart
                labels={chart.labels}
                titles={chart.titles}
                series={chart.series}
                tickEvery={3}
                restIndex={shown === summary?.today ? currentHour() : 23}
                drawKey={`${scope}-${shown}`}
                ariaLabel={`Anfragen und Fehler je Stunde am ${shown ? longDayKey(shown) : ''}`}
                onPage={go}
                canPageBack={canBack}
                canPageForward={canForward}
              />
            ) : (
              <Empty icon={Activity}>{loading ? 'Lädt …' : 'An diesem Tag gab es keine Anfragen in diesem Bereich.'}</Empty>
            )}
          </div>
        </Section>

        <div className="mt-[52px] grid gap-[52px] xl:grid-cols-[minmax(0,1fr)_320px]">
          <Section title="Endpunkte" meta="nach Aufrufen">
            {(summary?.endpoints.length ?? 0) === 0 ? (
              <Empty icon={Activity}>Keine Endpunkte an diesem Tag.</Empty>
            ) : (
              <EndpointTable endpoints={summary!.endpoints} peak={peak} />
            )}
          </Section>
          <Section title="Status">
            <div className="mt-8">
              <SplitBar ariaLabel="Anfragen nach Statusklasse" parts={statusParts} />
            </div>
            <ul className="mt-6 flex flex-col gap-2 text-[13.5px]">
              {(summary?.statuses ?? []).slice(0, 8).map((s) => (
                <li key={s.status} className="flex items-center justify-between gap-3">
                  <Status tone={statusTone(s.status)}>{s.status}</Status>
                  <span className="tabular text-ink-2">{num(s.count)}</span>
                </li>
              ))}
            </ul>
          </Section>
        </div>

        {shown && <RequestList day={shown} scope={scope} onError={(m) => showToast(m, 'error')} />}
      </div>
    </div>
  );
}

function EndpointTable({ endpoints, peak }: { endpoints: RequestsSummary['endpoints']; peak: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useTableLabels(ref);
  return (
    <div ref={ref} className="tbl-scroll mt-6">
      <table className="tbl">
        <thead>
          <tr>
            <th>Endpunkt</th>
            <th className="text-right">Aufrufe</th>
            <th className="hidden text-right sm:table-cell">Fehler</th>
            <th className="text-right">Ø</th>
            <th className="hidden text-right md:table-cell">Median</th>
            <th className="hidden text-right md:table-cell">95 %</th>
          </tr>
        </thead>
        <tbody>
          {endpoints.map((e) => (
            <tr key={`${e.method} ${e.endpoint}`}>
              <td>
                <div className="flex min-w-0 items-center gap-2.5">
                  <Tag tone={methodTone(e.method)} mono>{e.method}</Tag>
                  <span className="truncate font-mono text-[13px]" title={e.endpoint}>{e.endpoint}</span>
                </div>
                <div className="rank-track mt-2 max-w-[320px]"><div className="rank-fill" style={{ width: `${(e.count / peak) * 100}%`, background: '#4f96dc' }} /></div>
              </td>
              <td className="tabular text-right">{num(e.count)}</td>
              <td className="tabular hidden text-right sm:table-cell" style={{ color: e.serverErrors > 0 ? 'var(--rose-deep)' : e.errors > 0 ? 'var(--amber-deep)' : undefined }}>{num(e.errors)}</td>
              <td className="tabular text-right">{ms(e.avgMs)}</td>
              <td className="tabular hidden text-right md:table-cell">{e.p50Ms === null ? '> 2,5 s' : `≤ ${ms(e.p50Ms)}`}</td>
              <td className="tabular hidden text-right md:table-cell">{e.p95Ms === null ? '> 2,5 s' : `≤ ${ms(e.p95Ms)}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Every request of the day, newest first, with the panel's filters.
function RequestList({ day, scope, onError }: { day: string; scope: RequestScopeChoice; onError: (message: string) => void }) {
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<'' | '200' | '400' | '500'>('');
  const [path, setPath] = useState('');
  const [debounced, setDebounced] = useState('');
  const [loading, setLoading] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  useTableLabels(ref);
  const limit = 25;

  useEffect(() => {
    const t = window.setTimeout(() => { setDebounced(path.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(t);
  }, [path]);
  useEffect(() => { setPage(1); }, [day, scope, status]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const { from, to } = dayBounds(day);
    adminApi.logs({
      page, limit, from, to,
      ...(status ? { status: Number(status) } : {}),
      ...(debounced ? { path: debounced } : {}),
      ...(scope === 'core' || scope === 'learn' || scope === 'admin' ? { scope } : {}),
    })
      .then((res) => { if (!cancelled) { setLogs(res.logs); setTotal(res.total); } })
      .catch((err) => { if (!cancelled) onError(err instanceof Error ? err.message : 'Anfragen konnten nicht geladen werden'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [day, scope, status, debounced, page, onError]);

  return (
    <Section
      className="mt-[52px]"
      title="Einzelne Anfragen"
      meta={`${num(total)} an diesem Tag`}
      action={(
        <>
          <SearchField value={path} onChange={setPath} placeholder="Pfad enthält …" className="w-full sm:w-[220px]" />
          <Segmented label="Status" value={status} onChange={setStatus} options={[{ value: '', label: 'Alle' }, { value: '200', label: '2xx' }, { value: '400', label: '4xx' }, { value: '500', label: '5xx' }]} />
        </>
      )}
    >
      {logs.length === 0 && !loading ? (
        <Empty icon={Activity}>Keine Anfragen mit diesen Filtern.</Empty>
      ) : (
        <div ref={ref} className="tbl-scroll mt-6" style={{ opacity: loading ? 0.55 : 1 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Zeit</th>
                <th>Anfrage</th>
                <th>Status</th>
                <th className="text-right">Dauer</th>
                <th className="hidden md:table-cell">Konto</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id}>
                  <td className="tabular whitespace-nowrap text-ink-2">{timeOnly(log.createdAt)}</td>
                  <td>
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Tag tone={methodTone(log.method)} mono>{log.method}</Tag>
                      <span className="truncate font-mono text-[13px]" title={log.path}>{log.path}</span>
                    </div>
                    {log.requestId && <div className="mt-1 font-mono text-[11px] text-ink-4">{log.requestId}</div>}
                  </td>
                  <td><Status tone={statusTone(log.status)}>{log.status}</Status></td>
                  <td className="tabular text-right">{ms(log.duration)}</td>
                  <td className="hidden text-ink-2 md:table-cell">{log.username ?? <span className="text-ink-4">Gast</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={page} pages={Math.ceil(total / limit)} onChange={setPage} />
    </Section>
  );
}
