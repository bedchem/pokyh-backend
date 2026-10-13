import { useEffect, useState, useCallback } from 'react';
import { CalendarClock, DatabaseBackup, Download, HardDrive, History, PlayCircle, RotateCcw, Save, Trash2 } from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { Delta, Empty, FieldLabel, Figures, FormSection, IconButton, PageHeader, Section, Spinner, Toggle } from '../components/kit';
import { Bars } from '../components/charts';
import type { BackupFile, BackupsResponse } from '../types';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
  const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
  const lastRun = data?.config.lastRunAt ? new Date(data.config.lastRunAt) : null;
  const lastOk = data?.config.lastRunStatus === 'ok';
  // Oldest first, so the bars read left to right like a timeline.
  const timeline = [...files].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()).slice(-14);

  return (
    <div>
      <PageHeader title="Backups" subtitle="Vollständige Datenbanksicherungen (mysqldump, komprimiert) — geplant und manuell.">
        <button type="button" onClick={() => void runNow()} disabled={running} className="btn btn-primary">
          {running ? <Spinner /> : <PlayCircle size={16} strokeWidth={1.7} />}
          {running ? 'Erstelle Backup…' : 'Jetzt sichern'}
        </button>
      </PageHeader>

      <Figures
        className="mt-10"
        items={[
          { label: 'Backups', value: files.length, icon: DatabaseBackup },
          { label: 'Speicher', value: data ? formatSize(totalBytes) : '–', icon: HardDrive },
          {
            label: 'Letzter Lauf',
            value: lastRun ? lastRun.toLocaleDateString('de-AT', { day: 'numeric', month: 'short' }) : 'noch nie',
            icon: History,
            note: data?.config.lastRunStatus
              ? <Delta tone={lastOk ? 'mint' : 'rose'}>{lastOk ? 'erfolgreich' : 'fehlgeschlagen'}</Delta>
              : undefined,
          },
          {
            label: 'Zeitplan',
            value: data ? (data.config.enabled ? `${String(data.config.scheduleHour).padStart(2, '0')}:00 UTC` : 'aus') : '–',
            icon: CalendarClock,
            note: data?.config.enabled ? <Delta>{data.config.retentionDays} Tage</Delta> : undefined,
          },
        ]}
      />

      {timeline.length > 1 && (
        <Section className="mt-[46px]" title="Größe der Sicherungen" meta={`Letzte ${timeline.length}`}>
          <div className="mt-8 max-w-[860px]">
            <Bars
              values={timeline.map((f) => f.sizeBytes)}
              labels={timeline.map((f) => new Date(f.createdAt).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' }))}
              titles={timeline.map((f) => new Date(f.createdAt).toLocaleString('de-AT', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }))}
              unit=""
              format={formatSize}
              tickEvery={timeline.length > 8 ? 2 : 1}
              ariaLabel="Größe der letzten Sicherungen"
            />
          </div>
        </Section>
      )}

      <div className="mt-[46px]">
        <FormSection
          icon={CalendarClock}
          title="Zeitplan"
          hint="Wann die automatische Sicherung läuft und wie lange Dateien aufbewahrt werden."
        >
          <div className="flex max-w-[620px] flex-col gap-6">
            <div className="flex items-center justify-between gap-6">
              <div>
                <div className="text-[14.5px]">Automatische Sicherung</div>
                <div className="mt-0.5 text-[13px] text-ink-3">Täglich zur gewählten Stunde.</div>
              </div>
              <Toggle checked={enabled} onChange={setEnabled} label="Automatische Sicherung" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <FieldLabel label="Uhrzeit (UTC)">
                <input type="number" min={0} max={23} value={scheduleHour} onChange={(e) => setScheduleHour(Number(e.target.value))}
                  className="field h-12 w-full px-4 text-[14.5px]" />
              </FieldLabel>
              <FieldLabel label="Aufbewahrung (Tage)">
                <input type="number" min={1} max={365} value={retentionDays} onChange={(e) => setRetentionDays(Number(e.target.value))}
                  className="field h-12 w-full px-4 text-[14.5px]" />
              </FieldLabel>
            </div>
            <div>
              <button type="button" onClick={() => void saveConfig()} disabled={saving} className="btn btn-quiet">
                {saving ? <Spinner /> : <Save size={16} strokeWidth={1.7} />}
                {saving ? 'Speichert…' : 'Zeitplan speichern'}
              </button>
            </div>
          </div>
        </FormSection>
      </div>

      <Section className="mt-4 border-t border-line pt-[38px]" title="Vorhandene Backups" meta={`${files.length} Dateien`}>
        {loading && files.length === 0 ? (
          <div className="mt-7 flex flex-col gap-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4"><div className="shimmer h-12 w-12 rounded-full" /><div className="shimmer h-4 flex-1 rounded-full" /></div>
            ))}
          </div>
        ) : files.length === 0 ? (
          <Empty icon={DatabaseBackup}>Noch keine Backups vorhanden.</Empty>
        ) : (
          <ul className="stack mt-3">
            {files.map((file) => (
              <li key={file.filename} className="spot flex items-center gap-4 py-4">
                <span className="orb h-12 w-12"><DatabaseBackup size={19} strokeWidth={1.6} /></span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[13.5px]">{file.filename}</div>
                  <div className="mt-1 text-[13px] text-ink-3">{new Date(file.createdAt).toLocaleString('de-DE')}</div>
                </div>
                <span className="tabular hidden whitespace-nowrap text-[14.5px] font-medium sm:block">{formatSize(file.sizeBytes)}</span>
                <div className="flex flex-shrink-0 gap-1.5">
                  <IconButton icon={Download} label={`${file.filename} herunterladen`} busy={busyFile === file.filename} onClick={() => void download(file)} />
                  <IconButton icon={RotateCcw} tone="amber" label={`${file.filename} wiederherstellen`} disabled={busyFile === file.filename} onClick={() => void restore(file)} />
                  <IconButton icon={Trash2} tone="rose" label={`${file.filename} löschen`} disabled={busyFile === file.filename} onClick={() => void remove(file)} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
