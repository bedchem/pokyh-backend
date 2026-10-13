import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { GraduationCap, Save, ShieldCheck, ShieldAlert, BookOpen, Upload, Bot } from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { PageHeader, Toggle as Switch } from '../components/kit';
import type { LearnConfigValues } from '../types';

// A settings block: what it is on the left, its controls on the right.
function Card({ children, title, icon }: { children: React.ReactNode; title: string; icon: React.ReactNode }) {
  return (
    <section className="form-section">
      <div className="flex items-center gap-3.5 self-start">
        <span className="orb h-11 w-11">{icon}</span>
        <h2 className="text-[17px] font-semibold leading-snug">{title}</h2>
      </div>
      <div className="min-w-0 max-w-[660px]">{children}</div>
    </section>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div className="flex items-center justify-between gap-6 py-2">
      <span className="text-[14.5px]">{label}</span>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-2">
      <span className="text-[13px] text-ink-2">{label}</span>
      {children}
    </label>
  );
}


export function LearnConfigPage() {
  const { showToast } = useToast();
  const [cfg, setCfg] = useState<LearnConfigValues | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [webUntisRef, setWebUntisRef] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.getLearnConfig();
      setCfg(res);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Laden fehlgeschlagen', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void load(); }, [load]);

  function set<K extends keyof LearnConfigValues>(key: K, value: LearnConfigValues[K]) {
    setCfg((prev) => prev ? { ...prev, [key]: value } : prev);
  }

  async function handleSave() {
    if (!cfg) return;
    setSaving(true);
    try {
      const payload: Partial<LearnConfigValues> & { webUntisAuthorizationReference?: string } = {
        legalGateEnabled: cfg.legalGateEnabled,
        privacyNoticeUrl: cfg.privacyNoticeUrl,
        privacyNoticeVersion: cfg.privacyNoticeVersion,
        dictionaryEnabled: cfg.dictionaryEnabled,
        dictionaryProvider: cfg.dictionaryProvider,
        dictionaryBaseUrl: cfg.dictionaryBaseUrl,
        dictionaryContactEmail: cfg.dictionaryContactEmail,
        dictionaryAllowedPairs: cfg.dictionaryAllowedPairs,
        dictionaryTimeoutMs: cfg.dictionaryTimeoutMs,
        dictionaryCacheTtlMs: cfg.dictionaryCacheTtlMs,
        dictionaryMaxCacheEntries: cfg.dictionaryMaxCacheEntries,
        dictionaryValidationEnabled: cfg.dictionaryValidationEnabled,
        dictionaryValidationProvider: cfg.dictionaryValidationProvider,
        dictionaryValidationBaseUrl: cfg.dictionaryValidationBaseUrl,
        dictionaryValidationTimeoutMs: cfg.dictionaryValidationTimeoutMs,
        dictionaryValidationCacheTtlMs: cfg.dictionaryValidationCacheTtlMs,
        dictionaryValidationMaxCacheEntries: cfg.dictionaryValidationMaxCacheEntries,
        reviewInitialIntervalDays: cfg.reviewInitialIntervalDays,
        reviewMaxIntervalDays: cfg.reviewMaxIntervalDays,
        reviewMinimumEase: cfg.reviewMinimumEase,
        reviewMaximumEase: cfg.reviewMaximumEase,
        reviewCorrectEaseStep: cfg.reviewCorrectEaseStep,
        reviewIncorrectEasePenalty: cfg.reviewIncorrectEasePenalty,
        reviewWrongDelayMinutes: cfg.reviewWrongDelayMinutes,
        analyticsRetentionDays: cfg.analyticsRetentionDays,
        importMaxCourses: cfg.importMaxCourses,
        importMaxSectionsPerCourse: cfg.importMaxSectionsPerCourse,
        importMaxVocabularyPerCourse: cfg.importMaxVocabularyPerCourse,
      };
      if (webUntisRef.trim()) payload.webUntisAuthorizationReference = webUntisRef.trim();
      await adminApi.updateLearnConfig(payload);
      setWebUntisRef('');
      showToast('Learn-Konfiguration gespeichert', 'success');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Speichern fehlgeschlagen', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (loading || !cfg) {
    return (
      <div className="flex flex-col gap-4">
        {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-40 rounded-[22px] shimmer" />)}
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Learn" subtitle="Konfiguration für Pokyh Learn — wirkt sofort, kein Neustart nötig.">
        <Link to="/learn/teams" className="btn btn-quiet"><GraduationCap size={16} strokeWidth={1.7} /> Teams &amp; Zugriffe</Link>
        <Link to="/learn/ai" className="btn btn-quiet"><Bot size={16} strokeWidth={1.7} /> Pokyh AI</Link>
        <button type="button" onClick={() => void handleSave()} disabled={saving} className="btn btn-primary">
          <Save size={16} strokeWidth={1.7} /> {saving ? 'Speichere…' : 'Speichern'}
        </button>
      </PageHeader>

      <div className="mt-10">
        <Card title="Rechtliche Freigabe (Legal Gate)" icon={cfg.legalGateReady ? <ShieldCheck size={17} /> : <ShieldAlert size={17} />}>
          <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-[12px] text-[12px]" style={{
            background: cfg.legalGateReady ? 'rgba(40,170,125,0.1)' : 'rgba(236,140,40,0.1)',
            color: cfg.legalGateReady ? 'var(--mint-deep)' : 'var(--amber-deep)',
            border: `1px solid ${cfg.legalGateReady ? 'rgba(40,170,125,0.2)' : 'rgba(236,140,40,0.2)'}`,
          }}>
            {cfg.legalGateReady ? 'Bereit — WebUntis-Anmeldung für Learn ist freigegeben.' : 'Nicht bereit — Learn-Anmeldung bleibt gesperrt, bis alle Felder gesetzt sind.'}
          </div>
          <Toggle checked={cfg.legalGateEnabled} onChange={(v) => set('legalGateEnabled', v)} label="Rechtliche Freigabe erforderlich" />
          <div className="grid gap-3 mt-3">
            <Field label="Datenschutzhinweis-URL">
              <input value={cfg.privacyNoticeUrl} onChange={(e) => set('privacyNoticeUrl', e.target.value)}
                placeholder="https://pokyh.com/legal?view=learn" className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label="Datenschutzhinweis-Version">
              <input value={cfg.privacyNoticeVersion} onChange={(e) => set('privacyNoticeVersion', e.target.value)}
                placeholder="2026-09-12" className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label={`WebUntis-Genehmigungsreferenz ${cfg.hasWebUntisAuthorizationReference ? '(gesetzt — wird nicht angezeigt)' : '(nicht gesetzt)'}`}>
              <input value={webUntisRef} onChange={(e) => setWebUntisRef(e.target.value)}
                placeholder={cfg.hasWebUntisAuthorizationReference ? 'Neuen Wert eingeben, um zu ersetzen…' : 'Referenz eingeben…'}
                className="field h-11 px-4 text-[14px]" />
            </Field>
          </div>
        </Card>

        <Card title="Wörterbuch-Anbieter" icon={<BookOpen size={17} />}>
          <Toggle checked={cfg.dictionaryEnabled} onChange={(v) => set('dictionaryEnabled', v)} label="Wörterbuch-Vorschläge aktiviert" />
          <div className="grid grid-cols-2 gap-3 mt-3">
            <Field label="Anbieter">
              <input value={cfg.dictionaryProvider} onChange={(e) => set('dictionaryProvider', e.target.value)}
                className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label="Kontakt-E-Mail">
              <input value={cfg.dictionaryContactEmail} onChange={(e) => set('dictionaryContactEmail', e.target.value)}
                className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label="Basis-URL">
              <input value={cfg.dictionaryBaseUrl} onChange={(e) => set('dictionaryBaseUrl', e.target.value)}
                className="field h-11 px-4 text-[14px] col-span-2" />
            </Field>
            <Field label="Erlaubte Sprachpaare (kommagetrennt)">
              <input value={cfg.dictionaryAllowedPairs} onChange={(e) => set('dictionaryAllowedPairs', e.target.value)}
                placeholder="it:de,en:de,de:it,de:en" className="field h-11 px-4 text-[14px] col-span-2" />
            </Field>
            <Field label="Timeout (ms)">
              <input type="number" value={cfg.dictionaryTimeoutMs} onChange={(e) => set('dictionaryTimeoutMs', Number(e.target.value))}
                className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label="Cache-TTL (ms)">
              <input type="number" value={cfg.dictionaryCacheTtlMs} onChange={(e) => set('dictionaryCacheTtlMs', Number(e.target.value))}
                className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label="Max. Cache-Einträge">
              <input type="number" value={cfg.dictionaryMaxCacheEntries} onChange={(e) => set('dictionaryMaxCacheEntries', Number(e.target.value))}
                className="field h-11 px-4 text-[14px]" />
            </Field>
          </div>
        </Card>

        <Card title="Englische Wortprüfung" icon={<ShieldCheck size={17} />}>
          <Toggle checked={cfg.dictionaryValidationEnabled} onChange={(v) => set('dictionaryValidationEnabled', v)} label="Free Dictionary für englische Wörter aktivieren" />
          <p className="text-[12px] mt-2 leading-relaxed" style={{ color: 'rgb(var(--ink-rgb) / 0.62)' }}>
            dictionaryapi.dev prüft dokumentiert englische Stichwörter und kann Definitionen/Beispiele liefern. Deutsch und Italienisch bleiben nutzbar, werden bei fehlender passenden Quelle aber klar als redaktionelle Prüfung behandelt. Bei einem Ausfall bleiben Inhalte speicherbar.
          </p>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <Field label="Anbieter">
              <input value={cfg.dictionaryValidationProvider} readOnly className="field h-11 px-4 text-[14px] opacity-70" />
            </Field>
            <Field label="Timeout (ms)">
              <input type="number" value={cfg.dictionaryValidationTimeoutMs} onChange={(e) => set('dictionaryValidationTimeoutMs', Number(e.target.value))}
                className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label="Basis-URL">
              <input value={cfg.dictionaryValidationBaseUrl} onChange={(e) => set('dictionaryValidationBaseUrl', e.target.value)}
                className="field h-11 px-4 text-[14px] col-span-2" />
            </Field>
            <Field label="Cache-TTL (ms)">
              <input type="number" value={cfg.dictionaryValidationCacheTtlMs} onChange={(e) => set('dictionaryValidationCacheTtlMs', Number(e.target.value))}
                className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label="Max. Cache-Einträge">
              <input type="number" value={cfg.dictionaryValidationMaxCacheEntries} onChange={(e) => set('dictionaryValidationMaxCacheEntries', Number(e.target.value))}
                className="field h-11 px-4 text-[14px]" />
            </Field>
          </div>
        </Card>

        <Card title="Adaptives Lernen & Lernanalysen" icon={<GraduationCap size={17} />}>
          <p className="text-[12px] leading-relaxed" style={{ color: 'rgb(var(--ink-rgb) / 0.62)' }}>
            Der Server berechnet Wiederholungen pro Lernendem aus den gespeicherten Ergebnissen. Er speichert dafür nur aggregierte Tageszahlen je Kurs, keine Antworttexte in der Analyse. Die Werte gelten sofort für neue Quizversuche.
          </p>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <Field label="Erste Wiederholung (Tage)">
              <input type="number" min="1" max="30" value={cfg.reviewInitialIntervalDays} onChange={(e) => set('reviewInitialIntervalDays', Number(e.target.value))}
                className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label="Max. Intervall (Tage)">
              <input type="number" min="1" max="3650" value={cfg.reviewMaxIntervalDays} onChange={(e) => set('reviewMaxIntervalDays', Number(e.target.value))}
                className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label="Min. Leichtigkeitsfaktor">
              <input type="number" min="1" max="5" step="0.05" value={cfg.reviewMinimumEase} onChange={(e) => set('reviewMinimumEase', Number(e.target.value))}
                className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label="Max. Leichtigkeitsfaktor">
              <input type="number" min="1" max="5" step="0.05" value={cfg.reviewMaximumEase} onChange={(e) => set('reviewMaximumEase', Number(e.target.value))}
                className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label="Bonus bei richtig">
              <input type="number" min="0" max="1" step="0.01" value={cfg.reviewCorrectEaseStep} onChange={(e) => set('reviewCorrectEaseStep', Number(e.target.value))}
                className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label="Abzug bei falsch">
              <input type="number" min="0" max="1" step="0.01" value={cfg.reviewIncorrectEasePenalty} onChange={(e) => set('reviewIncorrectEasePenalty', Number(e.target.value))}
                className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label="Wiederholung nach Fehler (Min.)">
              <input type="number" min="0" max="1440" value={cfg.reviewWrongDelayMinutes} onChange={(e) => set('reviewWrongDelayMinutes', Number(e.target.value))}
                className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label="Analyse-Aufbewahrung (Tage)">
              <input type="number" min="30" max="3650" value={cfg.analyticsRetentionDays} onChange={(e) => set('analyticsRetentionDays', Number(e.target.value))}
                className="field h-11 px-4 text-[14px]" />
            </Field>
          </div>
        </Card>

        <Card title="Import-Limits" icon={<Upload size={17} />}>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Max. Kurse">
              <input type="number" value={cfg.importMaxCourses} onChange={(e) => set('importMaxCourses', Number(e.target.value))}
                className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label="Max. Abschnitte/Kurs">
              <input type="number" value={cfg.importMaxSectionsPerCourse} onChange={(e) => set('importMaxSectionsPerCourse', Number(e.target.value))}
                className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label="Max. Vokabeln/Kurs">
              <input type="number" value={cfg.importMaxVocabularyPerCourse} onChange={(e) => set('importMaxVocabularyPerCourse', Number(e.target.value))}
                className="field h-11 px-4 text-[14px]" />
            </Field>
          </div>
        </Card>

        <Card title="Hinweise" icon={<GraduationCap size={17} />}>
          <ul className="text-[13px] flex flex-col gap-2" style={{ color: 'rgb(var(--ink-rgb) / 0.62)' }}>
            <li className="flex items-start gap-2"><span style={{ color: 'var(--sky-deep)', flexShrink: 0 }}>•</span>Änderungen wirken sofort für alle Learn-Anfragen — kein Neustart nötig.</li>
            <li className="flex items-start gap-2"><span style={{ color: 'var(--sky-deep)', flexShrink: 0 }}>•</span>Erlaubte Ursprünge (LEARN_ALLOWED_ORIGINS) bleiben bewusst serverseitig konfiguriert und sind hier nicht editierbar.</li>
            <li className="flex items-start gap-2"><span style={{ color: 'var(--sky-deep)', flexShrink: 0 }}>•</span>Die WebUntis-Genehmigungsreferenz wird nach dem Speichern nicht mehr im Klartext angezeigt.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
