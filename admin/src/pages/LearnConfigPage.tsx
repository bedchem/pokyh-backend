import { useEffect, useState, useCallback } from 'react';
import { GraduationCap, Save, ShieldCheck, ShieldAlert, BookOpen, Upload } from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import type { LearnConfigValues } from '../types';

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

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center justify-between gap-3 py-1.5 cursor-pointer">
      <span className="text-[13px]" style={{ color: 'rgba(235,235,245,0.7)' }}>{label}</span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className="relative w-10 h-6 rounded-full transition-colors flex-shrink-0"
        style={{ background: checked ? '#0a84ff' : 'rgba(255,255,255,0.12)' }}
      >
        <span
          className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform"
          style={{ transform: checked ? 'translateX(16px)' : 'translateX(0)' }}
        />
      </button>
    </label>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[12px]" style={{ color: 'rgba(235,235,245,0.45)' }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = { background: '#1c1c1e', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(235,235,245,0.85)' };

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
      <div className="flex flex-col gap-4 max-w-[720px]">
        {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-40 rounded-[16px] shimmer" />)}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[22px] font-bold text-white tracking-[-0.02em]">Learn</h1>
          <p className="text-[13px] mt-1" style={{ color: 'rgba(235,235,245,0.45)' }}>
            Konfiguration für Pokyh Learn — wirkt sofort, kein Neustart nötig.
          </p>
        </div>
        <button
          onClick={() => void handleSave()}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2.5 rounded-[10px] text-[13px] font-medium transition-all disabled:opacity-50"
          style={{ background: 'rgba(10,132,255,0.15)', color: '#0a84ff', border: '1px solid rgba(10,132,255,0.25)' }}
        >
          <Save size={14} /> {saving ? 'Speichere…' : 'Speichern'}
        </button>
      </div>

      <div className="grid gap-4 max-w-[720px]">
        <Card title="Rechtliche Freigabe (Legal Gate)" icon={cfg.legalGateReady ? <ShieldCheck size={17} /> : <ShieldAlert size={17} />}>
          <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-[10px] text-[12px]" style={{
            background: cfg.legalGateReady ? 'rgba(48,209,88,0.1)' : 'rgba(255,159,10,0.1)',
            color: cfg.legalGateReady ? '#30d158' : '#ff9f0a',
            border: `1px solid ${cfg.legalGateReady ? 'rgba(48,209,88,0.2)' : 'rgba(255,159,10,0.2)'}`,
          }}>
            {cfg.legalGateReady ? 'Bereit — WebUntis-Anmeldung für Learn ist freigegeben.' : 'Nicht bereit — Learn-Anmeldung bleibt gesperrt, bis alle Felder gesetzt sind.'}
          </div>
          <Toggle checked={cfg.legalGateEnabled} onChange={(v) => set('legalGateEnabled', v)} label="Rechtliche Freigabe erforderlich" />
          <div className="grid gap-3 mt-3">
            <Field label="Datenschutzhinweis-URL">
              <input value={cfg.privacyNoticeUrl} onChange={(e) => set('privacyNoticeUrl', e.target.value)}
                placeholder="https://pokyh.com/legal?view=learn" className="apple-input px-3 py-2 text-[13px]" style={inputStyle} />
            </Field>
            <Field label="Datenschutzhinweis-Version">
              <input value={cfg.privacyNoticeVersion} onChange={(e) => set('privacyNoticeVersion', e.target.value)}
                placeholder="2026-09-12" className="apple-input px-3 py-2 text-[13px]" style={inputStyle} />
            </Field>
            <Field label={`WebUntis-Genehmigungsreferenz ${cfg.hasWebUntisAuthorizationReference ? '(gesetzt — wird nicht angezeigt)' : '(nicht gesetzt)'}`}>
              <input value={webUntisRef} onChange={(e) => setWebUntisRef(e.target.value)}
                placeholder={cfg.hasWebUntisAuthorizationReference ? 'Neuen Wert eingeben, um zu ersetzen…' : 'Referenz eingeben…'}
                className="apple-input px-3 py-2 text-[13px]" style={inputStyle} />
            </Field>
          </div>
        </Card>

        <Card title="Wörterbuch-Anbieter" icon={<BookOpen size={17} />}>
          <Toggle checked={cfg.dictionaryEnabled} onChange={(v) => set('dictionaryEnabled', v)} label="Wörterbuch-Vorschläge aktiviert" />
          <div className="grid grid-cols-2 gap-3 mt-3">
            <Field label="Anbieter">
              <input value={cfg.dictionaryProvider} onChange={(e) => set('dictionaryProvider', e.target.value)}
                className="apple-input px-3 py-2 text-[13px]" style={inputStyle} />
            </Field>
            <Field label="Kontakt-E-Mail">
              <input value={cfg.dictionaryContactEmail} onChange={(e) => set('dictionaryContactEmail', e.target.value)}
                className="apple-input px-3 py-2 text-[13px]" style={inputStyle} />
            </Field>
            <Field label="Basis-URL">
              <input value={cfg.dictionaryBaseUrl} onChange={(e) => set('dictionaryBaseUrl', e.target.value)}
                className="apple-input px-3 py-2 text-[13px] col-span-2" style={inputStyle} />
            </Field>
            <Field label="Erlaubte Sprachpaare (kommagetrennt)">
              <input value={cfg.dictionaryAllowedPairs} onChange={(e) => set('dictionaryAllowedPairs', e.target.value)}
                placeholder="it:de,en:de,de:it,de:en" className="apple-input px-3 py-2 text-[13px] col-span-2" style={inputStyle} />
            </Field>
            <Field label="Timeout (ms)">
              <input type="number" value={cfg.dictionaryTimeoutMs} onChange={(e) => set('dictionaryTimeoutMs', Number(e.target.value))}
                className="apple-input px-3 py-2 text-[13px]" style={inputStyle} />
            </Field>
            <Field label="Cache-TTL (ms)">
              <input type="number" value={cfg.dictionaryCacheTtlMs} onChange={(e) => set('dictionaryCacheTtlMs', Number(e.target.value))}
                className="apple-input px-3 py-2 text-[13px]" style={inputStyle} />
            </Field>
            <Field label="Max. Cache-Einträge">
              <input type="number" value={cfg.dictionaryMaxCacheEntries} onChange={(e) => set('dictionaryMaxCacheEntries', Number(e.target.value))}
                className="apple-input px-3 py-2 text-[13px]" style={inputStyle} />
            </Field>
          </div>
        </Card>

        <Card title="Import-Limits" icon={<Upload size={17} />}>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Max. Kurse">
              <input type="number" value={cfg.importMaxCourses} onChange={(e) => set('importMaxCourses', Number(e.target.value))}
                className="apple-input px-3 py-2 text-[13px]" style={inputStyle} />
            </Field>
            <Field label="Max. Abschnitte/Kurs">
              <input type="number" value={cfg.importMaxSectionsPerCourse} onChange={(e) => set('importMaxSectionsPerCourse', Number(e.target.value))}
                className="apple-input px-3 py-2 text-[13px]" style={inputStyle} />
            </Field>
            <Field label="Max. Vokabeln/Kurs">
              <input type="number" value={cfg.importMaxVocabularyPerCourse} onChange={(e) => set('importMaxVocabularyPerCourse', Number(e.target.value))}
                className="apple-input px-3 py-2 text-[13px]" style={inputStyle} />
            </Field>
          </div>
        </Card>

        <Card title="Hinweise" icon={<GraduationCap size={17} />}>
          <ul className="text-[13px] flex flex-col gap-2" style={{ color: 'rgba(235,235,245,0.45)' }}>
            <li className="flex items-start gap-2"><span style={{ color: '#0a84ff', flexShrink: 0 }}>•</span>Änderungen wirken sofort für alle Learn-Anfragen — kein Neustart nötig.</li>
            <li className="flex items-start gap-2"><span style={{ color: '#0a84ff', flexShrink: 0 }}>•</span>Erlaubte Ursprünge (LEARN_ALLOWED_ORIGINS) bleiben bewusst serverseitig konfiguriert und sind hier nicht editierbar.</li>
            <li className="flex items-start gap-2"><span style={{ color: '#0a84ff', flexShrink: 0 }}>•</span>Die WebUntis-Genehmigungsreferenz wird nach dem Speichern nicht mehr im Klartext angezeigt.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
