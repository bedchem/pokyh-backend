import { useCallback, useEffect, useRef, useState } from 'react';
import { Bug, ExternalLink, MonitorSmartphone, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { adminApi } from '../api';
import { useAccess } from '../access';
import { useLive } from '../live';
import { useToast } from '../components/Toast';
import { Dialog, Empty, IconButton, Notice, PageHeader, SearchField, Section, Segmented, Spinner, Status, Tag, useTableLabels, type Tone } from '../components/kit';
import { dateTime, num, relative } from '../components/format';
import { FrontendActivityTab } from './LogsPage';
import type { ClientErrorGroup, ClientErrorOccurrence } from '../types';

// Frontend and app logs: what the website and the apps report about
// themselves — their errors, and what people did (page views, sign-ins).
// Kept apart from the server's own logs (Backend-Logs). Reports are untrusted
// input: the server scrubbed them on the way in, and they carry no address
// and no account.

type Tab = 'errors' | 'activity';

const SOURCE_LABEL: Record<string, string> = { web: 'Website', android: 'Android-App', ios: 'iOS-App', admin: 'Admin-Panel' };

export function FrontendLogsPage() {
  const { view } = useAccess();
  const [tab, setTab] = useState<Tab>('errors');
  return (
    <div>
      <PageHeader
        title="Frontend-Logs"
        subtitle={view?.kind === 'school'
          ? 'Fehlerberichte und Aktivität aus Website und Apps der Konten dieser Schule.'
          : 'Was Website, Apps und das Admin-Panel über sich melden: Fehler und Aktivität. Die Logs des Servers stehen unter Backend-Logs.'}
      >
        <Segmented label="Ansicht" value={tab} onChange={setTab} options={[{ value: 'errors', label: 'Fehlerberichte' }, { value: 'activity', label: 'Aktivität' }]} />
      </PageHeader>
      <div className="mt-8">
        {tab === 'errors' ? <ErrorReports /> : <FrontendActivityTab autoRefresh />}
      </div>
    </div>
  );
}

function ErrorReports() {
  const { view } = useAccess();
  const { showToast } = useToast();
  const [groups, setGroups] = useState<ClientErrorGroup[] | null>(null);
  const [retention, setRetention] = useState(30);
  const [days, setDays] = useState<'1' | '7' | '30'>('7');
  const [source, setSource] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState<ClientErrorGroup | null>(null);
  const [loading, setLoading] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  useTableLabels(ref);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.clientErrors({ days: Number(days), source: source || undefined, search: debounced || undefined });
      setGroups(res.groups);
      setRetention(res.retentionDays);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Fehlerberichte konnten nicht geladen werden', 'error');
    } finally {
      setLoading(false);
    }
  }, [days, source, debounced, showToast]);

  useEffect(() => { void load(); }, [load]);
  useLive(['client-errors'], () => { void load(); }, 5000);

  const sources = view?.kind === 'school' ? ['', 'web', 'android', 'ios'] : ['', 'web', 'android', 'ios', 'admin'];

  return (
    <Section
      title="Fehlerberichte"
      meta={`gruppiert · ${retention} Tage gespeichert`}
      action={(
        <>
          <SearchField value={search} onChange={setSearch} placeholder="Meldung oder Seite" className="w-full sm:w-[220px]" />
          <select className="field h-11 px-4 text-[14px]" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Quelle">
            {sources.map((s) => <option key={s} value={s}>{s ? SOURCE_LABEL[s] : 'Alle Quellen'}</option>)}
          </select>
          <Segmented label="Zeitraum" value={days} onChange={setDays} options={[{ value: '1', label: '24 h' }, { value: '7', label: '7 Tage' }, { value: '30', label: '30 Tage' }]} />
          <IconButton icon={RefreshCw} label="Aktualisieren" busy={loading} onClick={() => void load()} />
        </>
      )}
    >
      {!groups ? (
        <div className="mt-8"><Spinner /></div>
      ) : groups.length === 0 ? (
        <Empty icon={Bug}>Keine Fehler gemeldet. Website und Apps melden Fehler automatisch, sobald sie auftreten.</Empty>
      ) : (
        <div ref={ref} className="tbl-scroll mt-6">
          <table className="tbl">
            <thead>
              <tr>
                <th>Fehler</th>
                <th className="text-right">Anzahl</th>
                <th className="hidden md:table-cell">Zuletzt</th>
                <th className="hidden lg:table-cell">Wo</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.fingerprint} className="cursor-pointer" onClick={() => setOpen(g)}>
                  <td>
                    <button type="button" className="min-w-0 text-left" onClick={() => setOpen(g)}>
                      <div className="flex flex-wrap items-center gap-2">
                        <Tag tone={g.level === 'warning' ? 'amber' : 'rose'} mono>{g.name || 'Error'}</Tag>
                        {g.source && <Tag>{SOURCE_LABEL[g.source] ?? g.source}</Tag>}
                      </div>
                      <div className="mt-1.5 line-clamp-2 text-[14px] text-ink">{g.message}</div>
                    </button>
                  </td>
                  <td className="tabular text-right font-medium">{num(g.count)}</td>
                  <td className="hidden whitespace-nowrap text-ink-2 md:table-cell">{relative(g.lastAt)}</td>
                  <td className="hidden lg:table-cell">
                    <div className="truncate font-mono text-[12.5px] text-ink-2">{g.page || '–'}</div>
                    <div className="text-[12px] text-ink-3">{[g.browser, g.release].filter(Boolean).join(' · ')}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <Occurrences group={open} onClose={() => setOpen(null)} />}
    </Section>
  );
}

function Occurrences({ group, onClose }: { group: ClientErrorGroup; onClose: () => void }) {
  const { canGlobal, view } = useAccess();
  const [items, setItems] = useState<ClientErrorOccurrence[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seesBackend = view?.kind === 'global' && canGlobal('system.logs.view');

  useEffect(() => {
    adminApi.clientErrorOccurrences(group.fingerprint)
      .then((res) => setItems(res.occurrences))
      .catch((err) => setError(err instanceof Error ? err.message : 'Nicht verfügbar'));
  }, [group.fingerprint]);

  const tone = (level: string): Tone => (level === 'warning' ? 'amber' : 'rose');
  return (
    <Dialog title={group.name || 'Fehler'} subtitle={`${num(group.count)}× gemeldet`} onClose={onClose} width={720}>
      <p className="text-[14.5px] text-ink">{group.message}</p>
      {error && <div className="mt-4"><Notice tone="rose">{error}</Notice></div>}
      {!items && !error && <div className="mt-6"><Spinner /></div>}
      <ol className="mt-6 flex flex-col gap-5">
        {items?.map((o) => (
          <li key={o.id} className="rounded-[18px] bg-well px-5 py-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-2">
              <Status tone={tone(o.level)}>{dateTime(o.at)}</Status>
              <span>{SOURCE_LABEL[o.source] ?? o.source}</span>
              {o.page && <span className="font-mono">{o.page}</span>}
              {o.browser && <span>{o.browser}</span>}
              {o.release && <span>Version {o.release}</span>}
              {o.schoolName && <span>{o.schoolName}</span>}
            </div>
            {o.stack && <pre className="mt-3 max-h-[220px] overflow-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-ink-2">{o.stack}</pre>}
            {o.requestId && (
              <div className="mt-2 flex items-center gap-2 text-[12.5px] text-ink-3">
                Anfrage <span className="font-mono">{o.requestId}</span>
                {seesBackend && <Link to={`/logs/backend?requestId=${encodeURIComponent(o.requestId)}`} className="inline-flex items-center gap-1 underline-offset-4 hover:underline" onClick={onClose}>im Server-Log <ExternalLink size={12} strokeWidth={1.8} /></Link>}
              </div>
            )}
          </li>
        ))}
      </ol>
      <p className="mt-6 flex items-center gap-2 text-[12.5px] text-ink-3"><MonitorSmartphone size={13} strokeWidth={1.8} /> Gespeichert ohne IP-Adresse und ohne Konto; Tokens, E-Mail-Adressen und Query-Strings entfernt der Server beim Empfang.</p>
    </Dialog>
  );
}
