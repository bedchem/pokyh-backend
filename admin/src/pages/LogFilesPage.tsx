import { useState, useEffect, useCallback } from 'react';
import { adminApi } from '../api';
import type { FileLogFile, FileLogEntry } from '../types';
import { FileText, Download, RefreshCw, ChevronLeft, ChevronRight, AlertCircle, Info, AlertTriangle } from 'lucide-react';

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

function LevelBadge({ level }: { level?: string }) {
  const l = (level ?? 'info').toLowerCase();
  if (l === 'error') {
    return (
      <span className="flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ background: 'rgba(255,69,58,0.15)', color: '#ff453a' }}>
        <AlertCircle size={10} /> error
      </span>
    );
  }
  if (l === 'warn') {
    return (
      <span className="flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ background: 'rgba(255,159,10,0.15)', color: '#ff9f0a' }}>
        <AlertTriangle size={10} /> warn
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ background: 'rgba(10,132,255,0.12)', color: '#0a84ff' }}>
      <Info size={10} /> info
    </span>
  );
}

export function LogFilesPage() {
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
      .then((f) => { setFiles(f); if (f.length > 0 && !selectedDate) setSelectedDate(f[0]!.date); })
      .finally(() => setFilesLoading(false));
  }, []);

  const loadEntries = useCallback((date: string, p: number) => {
    setLoading(true);
    adminApi.fileLogEntries(date, p, LIMIT)
      .then((r) => { setEntries(r.entries); setTotal(r.total); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (selectedDate) { setPage(1); loadEntries(selectedDate, 1); }
  }, [selectedDate, loadEntries]);

  useEffect(() => {
    if (selectedDate && page > 1) loadEntries(selectedDate, page);
  }, [page, selectedDate, loadEntries]);

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-[28px] font-bold text-white tracking-[-0.03em]">Logdateien</h1>
          <p className="text-sm mt-0.5" style={{ color: 'rgba(235,235,245,0.45)' }}>
            Tägliche App-Logs auf dem Server
          </p>
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-4" style={{ minHeight: '70vh' }}>
        {/* File list */}
        <div
          className="w-full md:w-[220px] md:flex-shrink-0 rounded-[16px] overflow-hidden"
          style={{ background: '#1c1c1e', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          <div className="px-4 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ color: 'rgba(235,235,245,0.35)' }}>
              Verfügbare Tage
            </span>
          </div>
          <div className="overflow-y-auto flex md:flex-col flex-row flex-wrap" style={{ maxHeight: 'calc(70vh - 48px)' }}>
            {filesLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="shimmer mx-3 my-2 rounded-[8px]" style={{ height: '52px' }} />
              ))
            ) : files.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm" style={{ color: 'rgba(235,235,245,0.35)' }}>
                Keine Dateien
              </div>
            ) : (
              files.map((f) => (
                <button
                  key={f.date}
                  onClick={() => setSelectedDate(f.date)}
                  className="w-full text-left px-4 py-3 transition-colors"
                  style={{
                    background: selectedDate === f.date ? 'rgba(10,132,255,0.12)' : 'transparent',
                    borderLeft: selectedDate === f.date ? '2px solid #0a84ff' : '2px solid transparent',
                  }}
                  onMouseEnter={(e) => { if (selectedDate !== f.date) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)'; }}
                  onMouseLeave={(e) => { if (selectedDate !== f.date) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                >
                  <div className="flex items-center gap-2">
                    <FileText size={13} style={{ color: selectedDate === f.date ? '#0a84ff' : 'rgba(235,235,245,0.4)', flexShrink: 0 }} />
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium truncate" style={{ color: selectedDate === f.date ? '#0a84ff' : 'rgba(235,235,245,0.85)' }}>
                        {f.date}
                      </div>
                      <div className="text-[11px] mt-0.5" style={{ color: 'rgba(235,235,245,0.3)' }}>
                        {formatBytes(f.size)}
                      </div>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Entries */}
        <div className="flex-1 min-w-0 rounded-[16px] overflow-hidden" style={{ background: '#1c1c1e', border: '1px solid rgba(255,255,255,0.07)' }}>
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <div>
              {selectedDate ? (
                <span className="text-[14px] font-semibold text-white">{formatDate(selectedDate)}</span>
              ) : (
                <span className="text-[14px]" style={{ color: 'rgba(235,235,245,0.4)' }}>Kein Tag ausgewählt</span>
              )}
              {total > 0 && (
                <span className="ml-2 text-[12px]" style={{ color: 'rgba(235,235,245,0.3)' }}>
                  {total} Einträge
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {selectedDate && !loading && (
                <a
                  href={`/api/admin/file-logs/${selectedDate}/raw`}
                  download={`app-${selectedDate}.log`}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[12px] font-medium transition-colors"
                  style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(235,235,245,0.7)' }}
                  onClick={(e) => {
                    e.preventDefault();
                    const content = entries.map((en) => JSON.stringify(en)).join('\n');
                    const blob = new Blob([content], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `app-${selectedDate}.log`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  <Download size={12} /> Download
                </a>
              )}
              {selectedDate && (
                <button
                  onClick={() => loadEntries(selectedDate, page)}
                  disabled={loading}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[12px] font-medium transition-colors"
                  style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(235,235,245,0.7)' }}
                >
                  <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Aktualisieren
                </button>
              )}
            </div>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            {!selectedDate ? (
              <div className="flex items-center justify-center py-20">
                <p style={{ color: 'rgba(235,235,245,0.3)' }}>Wähle einen Tag aus der Liste</p>
              </div>
            ) : loading ? (
              <div className="px-5 py-4">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="shimmer rounded-[8px] mb-2" style={{ height: '40px' }} />
                ))}
              </div>
            ) : entries.length === 0 ? (
              <div className="flex items-center justify-center py-20">
                <p style={{ color: 'rgba(235,235,245,0.3)' }}>Keine Einträge für diesen Tag</p>
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    {['Uhrzeit', 'Level', 'Meldung', 'Details'].map((h) => (
                      <th
                        key={h}
                        className="text-left px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.05em]"
                        style={{ color: 'rgba(235,235,245,0.3)', whiteSpace: 'nowrap' }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry, idx) => {
                    const time = entry.timestamp
                      ? new Date(entry.timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                      : '—';
                    const { timestamp: _ts, level: _lv, message: _msg, ...rest } = entry;
                    const hasExtra = Object.keys(rest).length > 0;

                    return (
                      <tr
                        key={idx}
                        style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)'; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; }}
                      >
                        <td className="px-5 py-3 text-[12px] font-mono whitespace-nowrap" style={{ color: 'rgba(235,235,245,0.4)' }}>
                          {time}
                        </td>
                        <td className="px-5 py-3 whitespace-nowrap">
                          <LevelBadge level={entry.level} />
                        </td>
                        <td className="px-5 py-3 text-[13px] text-white" style={{ maxWidth: '400px', overflowWrap: 'break-word' }}>
                          {String(entry.message ?? entry['raw'] ?? '')}
                        </td>
                        <td className="px-5 py-3">
                          {hasExtra && (
                            <code
                              className="text-[11px] font-mono"
                              style={{ color: 'rgba(235,235,245,0.4)', display: 'block', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                              title={JSON.stringify(rest, null, 2)}
                            >
                              {JSON.stringify(rest)}
                            </code>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-5 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <span className="text-[12px]" style={{ color: 'rgba(235,235,245,0.35)' }}>
                Seite {page} von {totalPages}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="p-1.5 rounded-[8px] transition-colors disabled:opacity-30"
                  style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(235,235,245,0.6)' }}
                >
                  <ChevronLeft size={14} />
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="p-1.5 rounded-[8px] transition-colors disabled:opacity-30"
                  style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(235,235,245,0.6)' }}
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
