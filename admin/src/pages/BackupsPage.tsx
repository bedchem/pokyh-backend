import { useEffect, useState, useCallback } from 'react';
import { DatabaseBackup, Download, PlayCircle, RotateCcw, Save, Trash2 } from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import type { BackupFile, BackupsResponse } from '../types';

function Card({ children, title, icon }: { children: React.ReactNode; title: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-[16px] p-5" style={{ background: '#0d0d0d', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="flex items-center gap-2.5 mb-4">
        <span style={{ color: '#0a84ff' }}>{icon}</span>
        <h2 className="text-[15px] font-semibold text-white tracking-[-0.01em]">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const inputStyle: React.CSSProperties = { background: '#1c1c1e', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(235,235,245,0.85)' };
const dimText = { color: 'rgba(235,235,245,0.45)' };

export function BackupsPage() {
  const { showToast } = useToast();
  const [data, setData] = useState<BackupsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [scheduleHour, setScheduleHour] = useState(3);
  const [retentionDays, setRetentionDays] = useState(7);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [busyFile, setBusyFile] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.getBackups();
      setData(res);
      setEnabled(res.config.enabled);
      setScheduleHour(res.config.scheduleHour);
      setRetentionDays(res.config.retentionDays);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Laden fehlgeschlagen', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void load(); }, [load]);

  async function saveConfig() {
    setSaving(true);
    try {
      await adminApi.updateBackupConfig({ enabled, scheduleHour, retentionDays });
      showToast('Backup-Einstellungen gespeichert', 'success');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Speichern fehlgeschlagen', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    setRunning(true);
    try {
      const result = await adminApi.runBackupNow();
      showToast(`Backup erstellt (${formatSize(result.sizeBytes)})`, 'success');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Backup fehlgeschlagen', 'error');
    } finally {
      setRunning(false);
    }
  }

  async function download(file: BackupFile) {
    setBusyFile(file.filename);
    try {
      await adminApi.downloadBackup(file.filename);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Download fehlgeschlagen', 'error');
    } finally {
      setBusyFile(null);
    }
  }

  async function remove(file: BackupFile) {
    if (!window.confirm(`Backup "${file.filename}" wirklich löschen? Dies kann nicht rückgängig gemacht werden.`)) return;
    setBusyFile(file.filename);
    try {
      await adminApi.deleteBackup(file.filename);
      showToast('Backup gelöscht', 'success');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Löschen fehlgeschlagen', 'error');
    } finally {
      setBusyFile(null);
    }
  }

  async function restore(file: BackupFile) {
    const typed = window.prompt(
      `⚠️ Dies überschreibt die GESAMTE aktuelle Datenbank mit dem Inhalt von "${file.filename}". Dieser Vorgang kann nicht rückgängig gemacht werden.\n\nTippe den Dateinamen exakt ein, um zu bestätigen:`,
    );
    if (typed !== file.filename) {
      if (typed !== null) showToast('Bestätigung stimmt nicht überein — Wiederherstellung abgebrochen', 'error');
      return;
    }
    setBusyFile(file.filename);
    try {
      await adminApi.restoreBackup(file.filename, typed);
      showToast('Datenbank wiederhergestellt', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Wiederherstellung fehlgeschlagen', 'error');
    } finally {
      setBusyFile(null);
    }
  }

  const files = data?.files ?? [];

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[22px] font-bold text-white tracking-[-0.02em]">Backups</h1>
          <p className="text-[13px] mt-1" style={dimText}>
            Vollständige Datenbanksicherungen (mysqldump, komprimiert) — geplant und manuell.
          </p>
        </div>
        <button onClick={() => void runNow()} disabled={running}
          className="flex items-center gap-2 px-4 py-2.5 rounded-[10px] text-[13px] font-medium transition-all disabled:opacity-50"
          style={{ background: 'rgba(10,132,255,0.15)', color: '#0a84ff', border: '1px solid rgba(10,132,255,0.25)' }}>
          <PlayCircle size={14} /> {running ? 'Erstelle Backup…' : 'Jetzt sichern'}
        </button>
      </div>

      <div className="grid gap-4 max-w-[820px]">
        <Card title="Zeitplan" icon={<DatabaseBackup size={17} />}>
          {data && (
            <p className="text-[12px] mb-4" style={dimText}>
              Letzter Lauf: {data.config.lastRunAt ? new Date(data.config.lastRunAt).toLocaleString('de-DE') : 'noch nie'}
              {data.config.lastRunStatus && ` · Status: ${data.config.lastRunStatus === 'ok' ? 'erfolgreich' : 'fehlgeschlagen'}`}
            </p>
          )}
          <div className="grid grid-cols-3 gap-3 items-end">
            <label className="flex items-center gap-2 text-[13px]" style={{ color: 'rgba(235,235,245,0.7)' }}>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Aktiviert
            </label>
            <div>
              <label className="text-[12px] block mb-1" style={dimText}>Uhrzeit (UTC)</label>
              <input type="number" min={0} max={23} value={scheduleHour} onChange={(e) => setScheduleHour(Number(e.target.value))}
                className="apple-input px-3 py-2 text-[13px] w-full" style={inputStyle} />
            </div>
            <div>
              <label className="text-[12px] block mb-1" style={dimText}>Aufbewahrung (Tage)</label>
              <input type="number" min={1} max={365} value={retentionDays} onChange={(e) => setRetentionDays(Number(e.target.value))}
                className="apple-input px-3 py-2 text-[13px] w-full" style={inputStyle} />
            </div>
          </div>
          <button onClick={() => void saveConfig()} disabled={saving}
            className="mt-4 flex items-center gap-2 px-4 py-2.5 rounded-[10px] text-[13px] font-medium transition-all disabled:opacity-50"
            style={{ background: 'rgba(10,132,255,0.15)', color: '#0a84ff', border: '1px solid rgba(10,132,255,0.25)' }}>
            <Save size={14} /> {saving ? 'Speichert…' : 'Zeitplan speichern'}
          </button>
        </Card>

        <Card title={`Vorhandene Backups (${files.length})`} icon={<DatabaseBackup size={17} />}>
          {loading ? (
            <div className="flex flex-col gap-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-12 rounded-[10px] shimmer" />)}</div>
          ) : files.length === 0 ? (
            <p className="text-[13px] text-center py-6" style={dimText}>Noch keine Backups vorhanden.</p>
          ) : (
            <div className="flex flex-col divide-y" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
              {files.map((file) => (
                <div key={file.filename} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-mono text-white truncate">{file.filename}</div>
                    <div className="text-[12px] mt-0.5" style={dimText}>{new Date(file.createdAt).toLocaleString('de-DE')} · {formatSize(file.sizeBytes)}</div>
                  </div>
                  <div className="flex-shrink-0 flex items-center gap-1.5">
                    <button onClick={() => void download(file)} disabled={busyFile === file.filename} aria-label={`${file.filename} herunterladen`}
                      className="p-2 rounded-[8px] transition-colors disabled:opacity-40" style={{ color: 'rgba(235,235,245,0.6)' }}>
                      <Download size={15} />
                    </button>
                    <button onClick={() => void restore(file)} disabled={busyFile === file.filename} aria-label={`${file.filename} wiederherstellen`}
                      className="p-2 rounded-[8px] transition-colors disabled:opacity-40" style={{ color: '#ff9f0a' }}>
                      <RotateCcw size={15} />
                    </button>
                    <button onClick={() => void remove(file)} disabled={busyFile === file.filename} aria-label={`${file.filename} löschen`}
                      className="p-2 rounded-[8px] transition-colors disabled:opacity-40" style={{ color: '#ff453a' }}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
