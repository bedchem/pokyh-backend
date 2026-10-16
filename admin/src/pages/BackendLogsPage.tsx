import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FileText, RefreshCw, ServerCog } from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { Empty, IconButton, PageHeader, Pager, SearchField, Section, Segmented, Spinner, Status, Tag, type Tone } from '../components/kit';
import { dateTime, num } from '../components/format';
import type { SystemLogEntry } from '../types';

// Backend / system logs: what the server writes about itself — errors,
// warnings, start-up and background jobs, failed integrations. Read from the
// server's own log files (secrets are redacted when written). For the
// system's operators only; the apps' reports are under Frontend-Logs.

const LEVEL_TONE: Record<string, Tone> = { error: 'rose', warn: 'amber', info: 'sky', debug: 'ink' };

export function BackendLogsPage() {
  const { showToast } = useToast();
  const [params, setParams] = useSearchParams();
  const [level, setLevel] = useState<'error' | 'warn' | 'info'>('warn');
  const [days, setDays] = useState<'1' | '3' | '7'>('3');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const requestId = params.get('requestId') ?? '';
  const [page, setPage] = useState(1);
  const [entries, setEntries] = useState<SystemLogEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [truncated, setTruncated] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const limit = 100;

  useEffect(() => {
    const t = window.setTimeout(() => { setDebounced(search.trim()); setPage(1); }, 350);
    return () => window.clearTimeout(t);
  }, [search]);
  useEffect(() => { setPage(1); }, [level, days, requestId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.systemLogs({ level: requestId ? 'debug' : level, days: Number(days), search: debounced || undefined, requestId: requestId || undefined, page, limit });
      setEntries(res.entries);
      setTotal(res.total);
      setCounts(res.counts);
      setTruncated(res.truncated);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Logs konnten nicht geladen werden', 'error');
    } finally {
      setLoading(false);
    }
  }, [level, days, debounced, requestId, page, showToast]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <PageHeader title="Backend-Logs" subtitle="Was der Server über sich schreibt: Fehler, Warnungen, Hintergrundjobs und Integrationen. Geheimnisse werden beim Schreiben entfernt.">
        <Link to="/logs/backend/files" className="btn btn-quiet"><FileText size={16} strokeWidth={1.7} /> Logdateien</Link>
        <IconButton icon={RefreshCw} label="Aktualisieren" size={42} busy={loading} onClick={() => void load()} />
      </PageHeader>

      <Section
        className="mt-10"
        title="Server-Log"
        meta={`${num(total)} Einträge${truncated ? ' (gekürzt)' : ''}`}
        action={(
          <>
            <SearchField value={search} onChange={setSearch} placeholder="Text, Pfad, Aktion …" className="w-full sm:w-[240px]" />
            <Segmented label="Stufe" value={level} onChange={setLevel} options={[{ value: 'error', label: 'Fehler' }, { value: 'warn', label: '+ Warnungen' }, { value: 'info', label: '+ Info' }]} />
            <Segmented label="Tage" value={days} onChange={setDays} options={[{ value: '1', label: 'Heute' }, { value: '3', label: '3 Tage' }, { value: '7', label: '7 Tage' }]} />
          </>
        )}
      >
        {requestId && (
          <div className="mt-5 flex flex-wrap items-center gap-3 text-[13.5px]">
            <Tag mono>Anfrage {requestId}</Tag>
            <button type="button" className="underline-offset-4 hover:underline" onClick={() => setParams({})}>Filter entfernen</button>
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-4 text-[13px] text-ink-3">
          {['error', 'warn', 'info'].filter((l) => counts[l]).map((l) => <Status key={l} tone={LEVEL_TONE[l] ?? 'ink'}>{num(counts[l] ?? 0)} {l}</Status>)}
        </div>
        {!entries ? (
          <div className="mt-8"><Spinner /></div>
        ) : entries.length === 0 ? (
          <Empty icon={ServerCog}>Keine Einträge für diese Filter. Ruhig ist gut.</Empty>
        ) : (
          <ol className="mt-5 flex flex-col">
            {entries.map((e, i) => (
              <li key={`${e.timestamp}-${i}`} className="border-t border-line first:border-t-0">
                <button type="button" className="flex w-full items-start gap-4 py-3 text-left" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
                  <span className="w-[150px] flex-shrink-0 font-mono text-[12px] text-ink-3">{e.timestamp ? dateTime(e.timestamp) : '–'}</span>
                  <span className="w-[64px] flex-shrink-0"><Status tone={LEVEL_TONE[e.level ?? ''] ?? 'ink'}>{e.level}</Status></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] text-ink">{e.message}</span>
                    <span className="mt-0.5 block truncate font-mono text-[12px] text-ink-3">
                      {[e.method && e.path ? `${e.method} ${e.path}` : null, e.status, e.action, e.requestId].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </button>
                {open === i && (
                  <pre className="mb-4 max-h-[320px] overflow-auto whitespace-pre-wrap break-all rounded-[16px] bg-well p-4 font-mono text-[12px] leading-relaxed text-ink-2">
                    {JSON.stringify(e.meta, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ol>
        )}
        <Pager page={page} pages={Math.ceil(total / limit)} onChange={setPage} />
      </Section>
    </div>
  );
}
