import { useState, useEffect, useCallback } from 'react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import type { FileLogFile, FileLogEntry } from '../types';
import { CalendarDays, Download, FileText, HardDrive, ListOrdered, RefreshCw } from 'lucide-react';
import { Empty, Figures, IconButton, PageHeader, Pager, Section, Status, type Tone } from '../components/kit';
import { Bars, SplitBar } from '../components/charts';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('de-DE', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

function dayLabel(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

type Level = 'info' | 'warn' | 'error';

function levelOf(entry: FileLogEntry): Level {
  const l = (entry.level ?? 'info').toLowerCase();
  return l === 'error' ? 'error' : l === 'warn' ? 'warn' : 'info';
}

const LEVEL_TONE: Record<Level, Tone> = { info: 'sky', warn: 'amber', error: 'rose' };

export function LogFilesPage() {
  const { showToast } = useToast();
  const [files, setFiles] = useState<FileLogFile[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [filesLoading, setFilesLoading] = useState(true);
  const LIMIT = 100;

  useEffect(() => {
    setFilesLoading(true);
    adminApi.fileLogList()
      .then((f) => { setFiles(f); setSelectedDate((current) => current ?? f[0]?.date ?? null); })
      .catch((err) => showToast(err instanceof Error ? err.message : 'Logdateien konnten nicht geladen werden', 'error'))
      .finally(() => setFilesLoading(false));
  }, [showToast]);

  const loadEntries = useCallback((date: string, p: number) => {
    setLoading(true);
    adminApi.fileLogEntries(date, p, LIMIT)
      .then((r) => { setEntries(r.entries); setTotal(r.total); })
      .catch((err) => showToast(err instanceof Error ? err.message : 'Einträge konnten nicht geladen werden', 'error'))
      .finally(() => setLoading(false));
  }, [showToast]);

  useEffect(() => {
    if (selectedDate) { setPage(1); loadEntries(selectedDate, 1); }
  }, [selectedDate, loadEntries]);

  useEffect(() => {
    if (selectedDate && page > 1) loadEntries(selectedDate, page);
  }, [page, selectedDate, loadEntries]);

  function downloadPage() {
    if (!selectedDate) return;
    const content = entries.map((en) => JSON.stringify(en)).join('\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `app-${selectedDate}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const totalPages = Math.ceil(total / LIMIT);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const levels = { info: 0, warn: 0, error: 0 };
  for (const entry of entries) levels[levelOf(entry)] += 1;
  // Oldest first, so the bars read left to right like a timeline.
  const timeline = [...files].sort((a, b) => a.date.localeCompare(b.date)).slice(-14);

  return (
    <div>
      <PageHeader title="Logdateien" subtitle="Tägliche App-Logs auf dem Server." />

      <Figures
        className="mt-10"
        items={[
          { label: 'Tage', value: files.length, icon: CalendarDays },
          { label: 'Speicher', value: filesLoading ? '–' : formatBytes(totalBytes), icon: HardDrive },
          { label: 'Einträge am Tag', value: selectedDate ? total : '–', icon: ListOrdered },
        ]}
      />

      {timeline.length > 1 && (
        <Section className="mt-[46px]" title="Umfang pro Tag" meta={`Letzte ${timeline.length} Tage`}>
          <div className="mt-8 max-w-[860px]">
            <Bars
              values={timeline.map((f) => f.size)}
              labels={timeline.map((f) => f.date.slice(8, 10))}
              titles={timeline.map((f) => formatDate(f.date))}
              unit=""
              format={formatBytes}
              tickEvery={timeline.length > 8 ? 2 : 1}
              ariaLabel="Größe der Logdateien pro Tag"
            />
          </div>
        </Section>
      )}

      <Section className="mt-[50px]" title="Tag wählen">
        {filesLoading ? (
          <div className="mt-6 flex gap-3">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="shimmer h-[58px] w-[132px] rounded-[18px]" />)}</div>
        ) : files.length === 0 ? (
          <Empty icon={FileText}>Keine Logdateien vorhanden.</Empty>
        ) : (
          <div className="day-strip mt-6" role="group" aria-label="Verfügbare Tage">
            {files.map((f) => (
              <button
                key={f.date}
                type="button"
                className="day-chip"
                aria-pressed={selectedDate === f.date}
                onClick={() => setSelectedDate(f.date)}
              >
                <span className="text-[14px] font-medium">{dayLabel(f.date)}</span>
                <span className="tabular text-[12px]">{formatBytes(f.size)}</span>
              </button>
            ))}
          </div>
        )}
      </Section>

      {selectedDate && (
        <Section
          className="mt-[46px]"
          title={formatDate(selectedDate)}
          meta={`${total.toLocaleString('de-AT')} Einträge`}
          action={(
            <>
              <IconButton icon={RefreshCw} label="Aktualisieren" busy={loading} onClick={() => loadEntries(selectedDate, page)} />
              <button type="button" className="btn btn-sm btn-line" onClick={downloadPage} disabled={entries.length === 0}>
                <Download size={14} strokeWidth={1.8} /> Diese Seite speichern
              </button>
            </>
          )}
        >
          {entries.length > 0 && (
            <div className="mt-8 max-w-[720px]">
              <SplitBar
                ariaLabel="Einträge dieser Seite nach Stufe"
                parts={[
                  { label: 'Info',    value: levels.info,  color: '#4f96dc' },
                  { label: 'Warnung', value: levels.warn,  color: 'var(--amber)' },
                  { label: 'Fehler',  value: levels.error, color: 'var(--rose)' },
                ]}
              />
            </div>
          )}

          {loading && entries.length === 0 ? (
            <div className="mt-8 flex flex-col gap-4">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="shimmer h-4 rounded-full" style={{ width: `${92 - i * 5}%` }} />)}</div>
          ) : entries.length === 0 ? (
            <Empty icon={FileText}>Keine Einträge an diesem Tag.</Empty>
          ) : (
            <div className="tbl-scroll mt-9">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Uhrzeit</th>
                    <th>Stufe</th>
                    <th>Meldung</th>
                    <th className="hidden lg:table-cell">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry, i) => {
                    const time = entry.timestamp
                      ? new Date(entry.timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                      : '—';
                    const { timestamp: _ts, level: _lv, message: _msg, ...rest } = entry;
                    const hasExtra = Object.keys(rest).length > 0;
                    const level = levelOf(entry);
                    return (
                      <tr key={i}>
                        <td className="tabular whitespace-nowrap font-mono text-[12.5px] text-ink-3">{time}</td>
                        <td><Status tone={LEVEL_TONE[level]}>{level}</Status></td>
                        <td>
                          <span className="block max-w-[640px] break-words text-[13.5px]" style={{ color: level === 'error' ? 'var(--rose-deep)' : undefined }}>
                            {String(entry.message ?? entry['raw'] ?? '')}
                          </span>
                        </td>
                        <td className="hidden lg:table-cell">
                          {hasExtra && (
                            <span className="block max-w-[320px] truncate font-mono text-[11.5px] text-ink-3" title={JSON.stringify(rest, null, 2)}>
                              {JSON.stringify(rest)}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <Pager page={page} pages={totalPages} onChange={setPage} />
        </Section>
      )}
    </div>
  );
}
