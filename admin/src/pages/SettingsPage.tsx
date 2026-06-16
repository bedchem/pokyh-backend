import { useState, useRef } from 'react';
import { Download, Upload, AlertTriangle, CheckCircle2, Database, Shield } from 'lucide-react';
import { adminApi } from '../api';

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

export function SettingsPage() {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);

  const importInputRef = useRef<HTMLInputElement>(null);

  const dimText = { color: 'rgba(235,235,245,0.45)' };

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
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-[22px] font-bold text-white tracking-[-0.02em]">Einstellungen</h1>
        <p className="text-[13px] mt-1" style={dimText}>Export, Import und Sicherung der gesamten Datenbank</p>
      </div>

      <div className="grid gap-4 max-w-[680px]">

        {/* Export */}
        <Card title="Datenbank exportieren" icon={<Database size={17} />}>
          <p className="text-[13px] mb-4" style={dimText}>
            Exportiert alle Daten als JSON-Datei: Nutzer, Klassen, Todos, Erinnerungen, Speiseplan, Bilder, Logs und mehr.
            Die Datei kann als vollständiges Backup genutzt oder für einen Import verwendet werden.
          </p>
          {exportError && (
            <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-[10px] text-[13px]" style={{ background: 'rgba(255,69,58,0.1)', color: '#ff453a', border: '1px solid rgba(255,69,58,0.2)' }}>
              <AlertTriangle size={14} /> {exportError}
            </div>
          )}
          <button
            onClick={handleExport}
            disabled={exporting}
            className="flex items-center gap-2 px-4 py-2.5 rounded-[10px] text-[13px] font-medium transition-all disabled:opacity-50"
            style={{ background: 'rgba(10,132,255,0.15)', color: '#0a84ff', border: '1px solid rgba(10,132,255,0.25)' }}
          >
            <Download size={14} />
            {exporting ? 'Exportiere…' : 'Datenbank exportieren (JSON)'}
          </button>
        </Card>

        {/* Import */}
        <Card title="Datenbank importieren" icon={<Shield size={17} />}>
          <div className="flex items-start gap-2.5 mb-4 px-3 py-2.5 rounded-[10px]" style={{ background: 'rgba(255,159,10,0.08)', border: '1px solid rgba(255,159,10,0.2)' }}>
            <AlertTriangle size={14} style={{ color: '#ff9f0a', marginTop: '1px', flexShrink: 0 }} />
            <p className="text-[12px]" style={{ color: '#ff9f0a' }}>
              <strong>Achtung:</strong> Der Import löscht alle bestehenden Daten und ersetzt sie vollständig durch den Inhalt der Import-Datei.
              Dieser Vorgang kann nicht rückgängig gemacht werden. Erstelle vorher ein Backup!
            </p>
          </div>
          <p className="text-[13px] mb-4" style={dimText}>
            Importiert eine JSON-Datei, die zuvor über den Export erstellt wurde. Alle Tabellen werden in einer einzigen Transaktion atomisch ersetzt.
          </p>

          {importError && (
            <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-[10px] text-[13px]" style={{ background: 'rgba(255,69,58,0.1)', color: '#ff453a', border: '1px solid rgba(255,69,58,0.2)' }}>
              <AlertTriangle size={14} /> {importError}
            </div>
          )}
          {importSuccess && (
            <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-[10px] text-[13px]" style={{ background: 'rgba(48,209,88,0.1)', color: '#30d158', border: '1px solid rgba(48,209,88,0.2)' }}>
              <CheckCircle2 size={14} /> Import erfolgreich! Die Datenbank wurde wiederhergestellt.
            </div>
          )}

          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={handleImportFile}
          />
          <button
            onClick={() => importInputRef.current?.click()}
            disabled={importing}
            className="flex items-center gap-2 px-4 py-2.5 rounded-[10px] text-[13px] font-medium transition-all disabled:opacity-50"
            style={{ background: 'rgba(255,159,10,0.12)', color: '#ff9f0a', border: '1px solid rgba(255,159,10,0.22)' }}
          >
            <Upload size={14} />
            {importing ? 'Importiere…' : 'JSON-Datei importieren'}
          </button>
        </Card>

        {/* Info */}
        <Card title="Hinweise" icon={<Shield size={17} />}>
          <ul className="text-[13px] flex flex-col gap-2" style={dimText}>
            <li className="flex items-start gap-2"><span style={{ color: '#0a84ff', flexShrink: 0 }}>•</span>Export-Dateien enthalten alle Daten inkl. gehashte Passwörter und Sitzungs-Tokens — sicher aufbewahren.</li>
            <li className="flex items-start gap-2"><span style={{ color: '#0a84ff', flexShrink: 0 }}>•</span>Bilder (Fachbilder, Dish-Bilder) werden als Base64 in der JSON-Datei gespeichert — die Datei kann daher sehr groß werden.</li>
            <li className="flex items-start gap-2"><span style={{ color: '#0a84ff', flexShrink: 0 }}>•</span>Nach einem Import wird der Dish-Cache automatisch geleert.</li>
            <li className="flex items-start gap-2"><span style={{ color: '#0a84ff', flexShrink: 0 }}>•</span>Der Import schlägt fehl und lässt die Datenbank unverändert, falls die JSON-Datei ungültig ist.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
