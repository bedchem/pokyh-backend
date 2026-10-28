import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Cpu, Database, Gauge, HardDrive, RefreshCw, ServerCrash, Timer } from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import { Empty, Figures, IconButton, Notice, PageHeader, Section, Segmented, Spinner, Status, Tag, useTableLabels, type Tone } from '../components/kit';
import { SplitBar } from '../components/charts';
import { ms, num } from '../components/format';
import type { EndpointStat, PerformanceReport, SystemHealth } from '../types';

// System health and API performance for the operators: is the server and its
// database well, and which endpoints are slow or failing. Figures are
// aggregated per endpoint — no person is behind any of them.

function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d} T ${h} Std.` : h > 0 ? `${h} Std. ${m} Min.` : `${m} Min.`;
}

// A rough verdict per endpoint, so the slow ones stand out.
function speed(e: EndpointStat): { tone: Tone; label: string } {
  const p95 = e.p95Ms ?? 9999;
  if (e.serverErrors > 0 && e.serverErrors / e.count > 0.02) return { tone: 'rose', label: 'Fehler' };
  if (p95 <= 100) return { tone: 'mint', label: 'schnell' };
  if (p95 <= 500) return { tone: 'amber', label: 'mittel' };
  return { tone: 'rose', label: 'langsam' };
}

export function SystemPage() {
  const { showToast } = useToast();
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [perf, setPerf] = useState<PerformanceReport | null>(null);
  const [hours, setHours] = useState<'1' | '24' | '168'>('24');
  const [loading, setLoading] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  useTableLabels(ref);

  const load = useCallback(async () => {
    try {
      const [h, p] = await Promise.all([adminApi.health(), adminApi.performance(Number(hours))]);
      setHealth(h);
      setPerf(p);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Systemdaten konnten nicht geladen werden', 'error');
    } finally {
      setLoading(false);
    }
  }, [hours, showToast]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useAutoRefresh(load, 30_000);

  const scopeParts = useMemo(() => {
    const color: Record<string, string> = { core: 'var(--sky)', admin: 'var(--amber)' };
    const label: Record<string, string> = { core: 'Pokyh', admin: 'Admin-Panel' };
    return (perf?.byScope ?? []).map((s) => ({ label: label[s.scope] ?? s.scope, value: s.count, color: color[s.scope] ?? 'var(--well-3)' }));
  }, [perf]);

  return (
    <div>
      <PageHeader title="System & Leistung" subtitle="Zustand von Server und Datenbank, Antwortzeiten aller Endpunkte. Zusammengefasst je Endpunkt, ohne Personenbezug.">
        <Segmented label="Zeitraum" value={hours} onChange={setHours} options={[{ value: '1', label: '1 Std.' }, { value: '24', label: '24 Std.' }, { value: '168', label: '7 Tage' }]} />
        <IconButton icon={RefreshCw} label="Aktualisieren" size={42} busy={loading} onClick={() => { setLoading(true); void load(); }} />
      </PageHeader>

      {!health ? (
        <div className="mt-10"><Spinner /></div>
      ) : (
        <>
          {!health.database.ok && <div className="mt-8"><Notice tone="rose" icon={Database}>Die Datenbank antwortet nicht.</Notice></div>}
          <Figures
            className="mt-8"
            items={[
              { label: 'Laufzeit', value: uptime(health.process.uptimeSeconds), icon: Cpu, note: <span className="text-[12.5px] text-ink-3">Node {health.process.node}</span> },
              { label: 'Datenbank', value: health.database.ok ? ms(health.database.latencyMs) : 'aus', icon: Database, note: <span className="text-[12.5px] text-ink-3">{health.database.connections ?? '–'} Verbindungen</span> },
              { label: 'Speicher', value: `${num(health.process.rssMb)} MB`, icon: HardDrive, note: <span className="text-[12.5px] text-ink-3">Heap {num(health.process.heapUsedMb)} MB</span> },
              { label: 'Letzte 5 Min.', value: health.lastFiveMinutes.requests, icon: Activity, note: <span className="text-[12.5px] text-ink-3">Ø {ms(health.lastFiveMinutes.avgMs)}</span> },
              { label: 'Serverfehler (5 Min.)', value: health.lastFiveMinutes.serverErrors, icon: ServerCrash },
            ]}
          />
        </>
      )}

      <div className="mt-[52px] grid gap-[52px] xl:grid-cols-[minmax(0,1fr)_320px]">
        <Section title="Endpunkte" meta={perf ? `${perf.endpoints.length} · alle Bereiche` : undefined}>
          {!perf ? <div className="mt-8"><Spinner /></div> : perf.endpoints.length === 0 ? (
            <Empty icon={Gauge}>Keine Anfragen in diesem Zeitraum.</Empty>
          ) : (
            <div ref={ref} className="tbl-scroll mt-6">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Endpunkt</th>
                    <th className="text-right">Aufrufe</th>
                    <th className="text-right">Ø</th>
                    <th className="hidden text-right md:table-cell">95 %</th>
                    <th className="hidden text-right lg:table-cell">Max</th>
                    <th className="hidden text-right sm:table-cell">Fehler</th>
                    <th>Bewertung</th>
                  </tr>
                </thead>
                <tbody>
                  {perf.endpoints.map((e) => {
                    const v = speed(e);
                    return (
                      <tr key={`${e.method} ${e.endpoint}`}>
                        <td>
                          <div className="flex min-w-0 items-center gap-2">
                            <Tag mono>{e.method}</Tag>
                            <span className="truncate font-mono text-[13px]" title={e.endpoint}>{e.endpoint}</span>
                          </div>
                        </td>
                        <td className="tabular text-right">{num(e.count)}</td>
                        <td className="tabular text-right">{ms(e.avgMs)}</td>
                        <td className="tabular hidden text-right md:table-cell">{e.p95Ms === null ? '> 2,5 s' : `≤ ${ms(e.p95Ms)}`}</td>
                        <td className="tabular hidden text-right lg:table-cell">{ms(e.maxMs)}</td>
                        <td className="tabular hidden text-right sm:table-cell">{num(e.errors)}</td>
                        <td><Status tone={v.tone}>{v.label}</Status></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        <div className="flex flex-col gap-[52px]">
          <Section title="Verkehr nach Bereich">
            <div className="mt-8"><SplitBar ariaLabel="Anfragen nach Bereich" parts={scopeParts} /></div>
          </Section>
          <Section title="Langsamste" meta="95 %-Wert">
            <ol className="mt-6 flex flex-col gap-3">
              {(perf?.slowest ?? []).map((e) => (
                <li key={`${e.method} ${e.endpoint}`} className="flex items-center justify-between gap-3 text-[13.5px]">
                  <span className="min-w-0 truncate font-mono text-[12.5px]" title={e.endpoint}>{e.method} {e.endpoint}</span>
                  <span className="tabular flex flex-shrink-0 items-center gap-1.5 text-ink-2"><Timer size={13} strokeWidth={1.8} />{e.p95Ms === null ? '> 2,5 s' : ms(e.p95Ms)}</span>
                </li>
              ))}
            </ol>
          </Section>
        </div>
      </div>
    </div>
  );
}
