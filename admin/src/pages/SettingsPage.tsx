import { useState, useRef } from 'react';
import { Download, Upload, AlertTriangle, CheckCircle2, Database, Shield, Info } from 'lucide-react';
import { adminApi } from '../api';
import { FormSection, Notice, PageHeader, Spinner } from '../components/kit';

export function SettingsPage() {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);

  const importInputRef = useRef<HTMLInputElement>(null);

  async function handleExport() {
    setExporting(true);
    setExportError(null);
    try {
      await adminApi.exportDatabase();
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export fehlgeschlagen');
    } finally {
      setExporting(false);
    }
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    const confirmed = window.confirm(
      '⚠️ ACHTUNG: Der Import überschreibt ALLE bestehenden Daten unwiderruflich.\n\nNur fortfahren wenn du dir sicher bist!'
    );
    if (!confirmed) return;

    setImporting(true);
    setImportError(null);
    setImportSuccess(false);

    try {
      const text = await file.text();
      const payload = JSON.parse(text) as unknown;
      await adminApi.importDatabase(payload);
      setImportSuccess(true);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import fehlgeschlagen');
    } finally {
      setImporting(false);
    }
  }

  return (
    <div>
      <PageHeader title="Einstellungen" subtitle="Export, Import und Sicherung der gesamten Datenbank." />

      <div className="mt-10">
        <FormSection
          icon={Database}
          title="Datenbank exportieren"
          hint="Ein vollständiges Abbild als JSON-Datei — als Backup oder als Vorlage für einen Import."
        >
          <p className="max-w-[60ch] text-[14.5px] leading-relaxed text-ink-2">
            Exportiert alle Daten als JSON-Datei: Nutzer, Klassen, Todos, Erinnerungen, Speiseplan, Bilder, Logs und mehr.
            Die Datei kann als vollständiges Backup genutzt oder für einen Import verwendet werden.
          </p>
          {exportError && <div className="mt-5 max-w-[60ch]"><Notice tone="rose" icon={AlertTriangle}>{exportError}</Notice></div>}
          <button type="button" onClick={() => void handleExport()} disabled={exporting} className="btn btn-primary mt-6">
            {exporting ? <Spinner /> : <Download size={16} strokeWidth={1.7} />}
            {exporting ? 'Exportiere…' : 'Datenbank exportieren (JSON)'}
          </button>
        </FormSection>

        <FormSection
          icon={Shield}
          title="Datenbank importieren"
          hint="Ersetzt den gesamten Datenbestand durch den Inhalt einer Export-Datei."
        >
          <div className="max-w-[60ch]">
            <Notice tone="amber" icon={AlertTriangle}>
              <strong className="font-semibold">Achtung:</strong> Der Import löscht alle bestehenden Daten und ersetzt sie vollständig durch den Inhalt der Import-Datei.
              Dieser Vorgang kann nicht rückgängig gemacht werden. Erstelle vorher ein Backup!
            </Notice>
          </div>
          <p className="mt-5 max-w-[60ch] text-[14.5px] leading-relaxed text-ink-2">
            Importiert eine JSON-Datei, die zuvor über den Export erstellt wurde. Alle Tabellen werden in einer einzigen Transaktion atomisch ersetzt.
          </p>

          {importError && <div className="mt-5 max-w-[60ch]"><Notice tone="rose" icon={AlertTriangle}>{importError}</Notice></div>}
          {importSuccess && (
            <div className="mt-5 max-w-[60ch]">
              <Notice tone="mint" icon={CheckCircle2}>Import erfolgreich! Die Datenbank wurde wiederhergestellt.</Notice>
            </div>
          )}

          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => void handleImportFile(e)}
          />
          <button type="button" onClick={() => importInputRef.current?.click()} disabled={importing} className="btn btn-danger mt-6">
            {importing ? <Spinner /> : <Upload size={16} strokeWidth={1.7} />}
            {importing ? 'Importiere…' : 'JSON-Datei importieren'}
          </button>
        </FormSection>

        <FormSection icon={Info} title="Hinweise" hint="Was beim Umgang mit Export-Dateien zu beachten ist.">
          <ul className="flex max-w-[60ch] flex-col gap-4 text-[14.5px] leading-relaxed text-ink-2">
            {[
              'Export-Dateien enthalten alle Daten inkl. gehashte Passwörter und Sitzungs-Tokens — sicher aufbewahren.',
              'Bilder (Fachbilder, Dish-Bilder) werden als Base64 in der JSON-Datei gespeichert — die Datei kann daher sehr groß werden.',
              'Nach einem Import wird der Dish-Cache automatisch geleert.',
              'Der Import schlägt fehl und lässt die Datenbank unverändert, falls die JSON-Datei ungültig ist.',
            ].map((text) => (
              <li key={text} className="flex items-start gap-3.5">
                <i className="mt-[9px] h-[7px] w-[7px] flex-shrink-0 rounded-full bg-sky" />
                {text}
              </li>
            ))}
          </ul>
        </FormSection>
      </div>
    </div>
  );
}
