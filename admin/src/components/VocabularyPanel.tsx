import { useCallback, useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { Download, Languages, Loader2, Search, Upload } from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from './Toast';
import type {
  AdminLearnCourse,
  AdminLearnCourseVocabularyResponse,
  AdminLearnVocabularyImportResponse,
  LearnVocabularyImportOutcome,
  LearnVocabularyVerificationStatus,
} from '../types';

const inputStyle: CSSProperties = {
  background: '#1c1c1e',
  border: '1px solid rgba(255,255,255,0.08)',
  color: 'rgba(235,235,245,0.88)',
};

const mutedText: CSSProperties = { color: 'rgba(235,235,245,0.45)' };

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' });
}

function verificationLabel(status: LearnVocabularyVerificationStatus): string {
  switch (status) {
    case 'VERIFIED': return 'Geprüft';
    case 'FLAGGED': return 'Markiert';
    default: return 'Ungeprüft';
  }
}

function verificationColor(status: LearnVocabularyVerificationStatus): string {
  switch (status) {
    case 'VERIFIED': return '#30d158';
    case 'FLAGGED': return '#ff9f0a';
    default: return 'rgba(235,235,245,0.45)';
  }
}

function importOutcomeLabel(outcome: LearnVocabularyImportOutcome): string {
  switch (outcome) {
    case 'added': return 'Hinzugefügt';
    case 'synonym_added': return 'Als neue Bedeutung hinzugefügt';
    case 'duplicate_exact': return 'Bereits vorhanden — übersprungen';
    case 'duplicate_near_translation': return 'Ähnliche Übersetzung bereits vorhanden — übersprungen';
    case 'duplicate_near_source': return 'Ähnliches Wort bereits vorhanden — übersprungen';
    case 'skipped_missing_translation': return 'Keine Übersetzung vorhanden — übersprungen';
    default: return outcome;
  }
}

// A "Vokabelliste" is one Learn course's vocabulary entries. Shared between
// the flat Kurse page (any course) and the Teams page (a team's own courses,
// grouped so it stays legible once many teams exist) — same behaviour either
// way, so it can never drift between the two entry points.
export function VocabularyPanel({
  course,
  onCourseChanged,
}: {
  course: AdminLearnCourse;
  onCourseChanged: (course: AdminLearnCourse) => void;
}) {
  const { showToast } = useToast();
  const [details, setDetails] = useState<AdminLearnCourseVocabularyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<AdminLearnVocabularyImportResponse | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadVocabulary = useCallback(async (page: number, query: string) => {
    setLoading(true);
    try {
      const result = await adminApi.getLearnCourseVocabulary(course.id, { page, limit: 50, q: query.trim() || undefined });
      setDetails(result);
      onCourseChanged(result.course);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Vokabeln konnten nicht geladen werden', 'error');
    } finally {
      setLoading(false);
    }
  }, [course.id, onCourseChanged, showToast]);

  // Debounced search-as-you-type; fires immediately on mount since q starts empty.
  useEffect(() => {
    const handle = setTimeout(() => { void loadVocabulary(1, q); }, q ? 250 : 0);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadVocabulary is stable per course.id; only q should retrigger this
  }, [q]);

  async function handleExport() {
    setExporting(true);
    try {
      await adminApi.exportLearnCourseVocabulary(course.id, course.slug);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Export fehlgeschlagen', 'error');
    } finally {
      setExporting(false);
    }
  }

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    try {
      const text = await file.text();
      const payload = JSON.parse(text) as unknown;
      const result = await adminApi.importLearnCourseVocabulary(course.id, payload);
      setImportResult(result);
      if (result.course) onCourseChanged(result.course);
      await loadVocabulary(1, q);
      const skipped = result.summary.duplicateExact + result.summary.duplicateNearTranslation
        + result.summary.duplicateNearSource + result.summary.skippedMissingTranslation;
      showToast(`Import: ${result.summary.added} neu, ${result.summary.synonymAdded} als Synonym, ${skipped} übersprungen`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Import fehlgeschlagen — ist die Datei ein gültiges JSON?', 'error');
    } finally {
      setImporting(false);
    }
  }

  const reviewableResults = importResult?.results.filter((row) => row.outcome !== 'added' || row.possibleTypoOf) ?? [];

  return (
    <div className="mt-4 pt-4" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="flex items-center gap-2 mb-2">
        <Languages size={15} style={{ color: '#0a84ff' }} />
        <h3 className="text-[13px] font-semibold text-white">Vokabeln{details ? ` (${details.vocabulary.total})` : ''}</h3>
      </div>

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <div className="relative flex-1 min-w-[160px]">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={mutedText} />
          <label htmlFor={`vocab-search-${course.id}`} className="sr-only">Vokabeln durchsuchen</label>
          <input
            id={`vocab-search-${course.id}`}
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Wort suchen…"
            className="apple-input w-full pl-8 pr-3 py-2 text-[13px]"
            style={inputStyle}
          />
        </div>
        <button type="button" onClick={() => void handleExport()} disabled={exporting || course.counts.vocabulary === 0} className="apple-btn-ghost flex items-center gap-1.5 px-3 py-2 text-[12px] disabled:opacity-50">
          {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Exportieren
        </button>
        <input ref={fileInputRef} type="file" accept=".json,application/json" className="hidden" onChange={(event) => void handleImportFile(event)} />
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={importing} className="apple-btn-ghost flex items-center gap-1.5 px-3 py-2 text-[12px] disabled:opacity-50">
          {importing ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Importieren
        </button>
      </div>

      {importResult && (
        <div className="mb-3 rounded-[10px] p-3" style={{ background: 'rgba(10,132,255,0.055)', border: '1px solid rgba(10,132,255,0.16)' }}>
          <div className="text-[12px] font-semibold text-white mb-1">Letztes Importergebnis</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]" style={{ color: 'rgba(235,235,245,0.75)' }}>
            <span>{importResult.summary.added} neu</span>
            <span>{importResult.summary.synonymAdded} als Synonym ergänzt</span>
            <span>{importResult.summary.duplicateExact} exakte Duplikate</span>
            <span>{importResult.summary.duplicateNearTranslation} ähnliche Übersetzung</span>
            <span>{importResult.summary.duplicateNearSource} ähnliches Wort</span>
            <span>{importResult.summary.skippedMissingTranslation} ohne Übersetzung</span>
          </div>
          {reviewableResults.length > 0 && (
            <details className="mt-2">
              <summary className="text-[11px] cursor-pointer" style={{ color: '#0a84ff' }}>{reviewableResults.length} Einträge zur Durchsicht</summary>
              <div className="mt-2 flex flex-col gap-1 max-h-[220px] overflow-y-auto">
                {reviewableResults.map((row, index) => (
                  <div key={index} className="text-[11px]" style={mutedText}>
                    <strong style={{ color: 'rgba(235,235,245,0.8)' }}>{row.sourceText}</strong> → {row.targetText}: {importOutcomeLabel(row.outcome)}
                    {row.matchedExisting && ` (bereits bekannt: „${row.matchedExisting.sourceText} → ${row.matchedExisting.targetText}“)`}
                    {row.possibleTypoOf && ` (evtl. Tippfehler zu „${row.possibleTypoOf}“?)`}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, index) => <div key={index} className="h-12 rounded-[10px] shimmer" />)}
        </div>
      ) : !details || details.vocabulary.items.length === 0 ? (
        <p className="text-[13px] py-3 text-center rounded-[10px]" style={{ background: 'rgba(255,255,255,0.03)', ...mutedText }}>Keine Vokabeln in dieser Liste.</p>
      ) : (
        <>
          <div className="flex flex-col rounded-[10px] overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
            {details.vocabulary.items.map((entry, index) => (
              <div key={entry.id} className="flex items-start gap-3 p-3 flex-wrap" style={{ borderTop: index === 0 ? undefined : '1px solid rgba(255,255,255,0.055)' }}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap text-[13px]">
                    <span className="font-medium text-white">{entry.sourceText}</span>
                    <span style={mutedText}>→</span>
                    <span className="text-white">{entry.targetText || '—'}</span>
                    {entry.article && <span className="text-[11px] px-1.5 py-0.5 rounded-[5px]" style={{ background: 'rgba(255,255,255,0.06)', ...mutedText }}>{entry.article}</span>}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px]" style={mutedText}>
                    {entry.partOfSpeech && <span>{entry.partOfSpeech}</span>}
                    {entry.tags.length > 0 && <span>{entry.tags.join(', ')}</span>}
                    <span>{entry.creator.username}</span>
                    <span>{formatDate(entry.updatedAt)}</span>
                  </div>
                </div>
                <span
                  className="text-[11px] px-2 py-0.5 rounded-[6px] font-medium flex-shrink-0"
                  style={{ background: `${verificationColor(entry.verificationStatus)}1f`, color: verificationColor(entry.verificationStatus), border: `1px solid ${verificationColor(entry.verificationStatus)}3c` }}
                >
                  {verificationLabel(entry.verificationStatus)}
                </span>
              </div>
            ))}
          </div>
          {details.vocabulary.total > details.vocabulary.limit && (
            <div className="mt-3 flex items-center justify-between gap-3 text-[12px]" style={mutedText}>
              <span>Seite {details.vocabulary.page} von {Math.max(1, Math.ceil(details.vocabulary.total / details.vocabulary.limit))}</span>
              <div className="flex gap-2">
                <button type="button" onClick={() => void loadVocabulary(details.vocabulary.page - 1, q)} disabled={loading || details.vocabulary.page <= 1} className="apple-btn-ghost px-2.5 py-1.5 disabled:opacity-50">Zurück</button>
                <button type="button" onClick={() => void loadVocabulary(details.vocabulary.page + 1, q)} disabled={loading || details.vocabulary.page * details.vocabulary.limit >= details.vocabulary.total} className="apple-btn-ghost px-2.5 py-1.5 disabled:opacity-50">Weiter</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
