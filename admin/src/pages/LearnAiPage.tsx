import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Save, Users, UsersRound, Trash2, ShieldCheck } from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { PageHeader, Toggle as Switch } from '../components/kit';
import type { LearnAiConfigValues, LearnAiGrant, LearnAiTeamGrant, AdminLearnTeam } from '../types';

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

const inputStyle: React.CSSProperties = {};

export function LearnAiPage() {
  const { showToast } = useToast();
  const [cfg, setCfg] = useState<LearnAiConfigValues | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [grants, setGrants] = useState<LearnAiGrant[]>([]);
  const [teamGrants, setTeamGrants] = useState<LearnAiTeamGrant[]>([]);
  const [teams, setTeams] = useState<AdminLearnTeam[]>([]);

  const [newUsername, setNewUsername] = useState('');
  const [newUserNote, setNewUserNote] = useState('');
  const [grantingUser, setGrantingUser] = useState(false);

  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [newTeamNote, setNewTeamNote] = useState('');
  const [grantingTeam, setGrantingTeam] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cfgRes, grantsRes, teamGrantsRes, teamsRes] = await Promise.all([
        adminApi.getLearnAiConfig(),
        adminApi.getLearnAiGrants(),
        adminApi.getLearnAiTeamGrants(),
        adminApi.listLearnTeams(),
      ]);
      setCfg(cfgRes);
      setGrants(grantsRes.grants);
      setTeamGrants(teamGrantsRes.grants);
      setTeams(teamsRes.teams);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Laden fehlgeschlagen', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void load(); }, [load]);

  function set<K extends keyof LearnAiConfigValues>(key: K, value: LearnAiConfigValues[K]) {
    setCfg((prev) => prev ? { ...prev, [key]: value } : prev);
  }

  async function handleSave() {
    if (!cfg) return;
    setSaving(true);
    try {
      await adminApi.updateLearnAiConfig(cfg);
      showToast('KI-Konfiguration gespeichert', 'success');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Speichern fehlgeschlagen', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleGrantUser() {
    if (!newUsername.trim()) return;
    setGrantingUser(true);
    try {
      await adminApi.grantLearnAi(newUsername.trim(), newUserNote.trim() || undefined);
      showToast(`Zugriff für "${newUsername.trim()}" erteilt`, 'success');
      setNewUsername('');
      setNewUserNote('');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Zugriff konnte nicht erteilt werden', 'error');
    } finally {
      setGrantingUser(false);
    }
  }

  async function handleRevokeUser(stableUid: string, username: string) {
    try {
      await adminApi.revokeLearnAi(stableUid);
      showToast(`Zugriff für "${username}" entzogen`, 'success');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Entziehen fehlgeschlagen', 'error');
    }
  }

  async function handleGrantTeam() {
    if (!selectedTeamId) return;
    setGrantingTeam(true);
    try {
      await adminApi.grantLearnAiTeam(selectedTeamId, newTeamNote.trim() || undefined);
      const team = teams.find((t) => t.id === selectedTeamId);
      showToast(`Zugriff für Team "${team?.name ?? selectedTeamId}" erteilt`, 'success');
      setSelectedTeamId('');
      setNewTeamNote('');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Zugriff konnte nicht erteilt werden', 'error');
    } finally {
      setGrantingTeam(false);
    }
  }

  async function handleRevokeTeam(teamId: string, teamName: string) {
    try {
      await adminApi.revokeLearnAiTeam(teamId);
      showToast(`Zugriff für Team "${teamName}" entzogen`, 'success');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Entziehen fehlgeschlagen', 'error');
    }
  }

  if (loading || !cfg) {
    return (
      <div className="flex flex-col gap-4">
        {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-40 rounded-[22px] shimmer" />)}
      </div>
    );
  }

  const activeGrants = grants.filter((g) => !g.revokedAt);
  const revokedGrants = grants.filter((g) => g.revokedAt);
  const activeTeamGrants = teamGrants.filter((g) => !g.revokedAt);
  const revokedTeamGrants = teamGrants.filter((g) => g.revokedAt);

  return (
    <div>
      <PageHeader title="Pokyh AI" subtitle="Selbst gehosteter, CPU-only KI-Vokabeltrainer für Pokyh Learn — nur beim Vokabeltraining, ohne allgemeinen Chat.">
        <Link to="/learn" className="btn btn-quiet"><ShieldCheck size={16} strokeWidth={1.7} /> Learn-Konfiguration</Link>
        <button type="button" onClick={() => void handleSave()} disabled={saving} className="btn btn-primary">
          <Save size={16} strokeWidth={1.7} /> {saving ? 'Speichere…' : 'Speichern'}
        </button>
      </PageHeader>

      <div className="mt-10">
        <Card title="Modell & Verhalten" icon={<Bot size={17} />}>
          <Toggle checked={cfg.enabled} onChange={(v) => set('enabled', v)} label="Vokabeltrainer aktiviert (Kill-Switch)" />
          <p className="text-[12px] mt-2 mb-3 leading-relaxed" style={{ color: 'rgb(var(--ink-rgb) / 0.62)' }}>
            Dieser Schalter allein macht den Trainer für niemanden zugänglich — zusätzlich braucht jede Person eine persönliche oder Team-Freigabe (siehe unten).
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Modell">
              <input value={cfg.modelName} onChange={(e) => set('modelName', e.target.value)}
                className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label="Ollama-Basis-URL">
              <input value={cfg.ollamaBaseUrl} onChange={(e) => set('ollamaBaseUrl', e.target.value)}
                className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label="Kontextfenster (Tokens)">
              <input type="number" min={512} max={32768} value={cfg.contextTokens} onChange={(e) => set('contextTokens', Number(e.target.value))}
                className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label="Max. Antwortlänge (Tokens)">
              <input type="number" min={32} max={4096} value={cfg.numPredictFast} onChange={(e) => set('numPredictFast', Number(e.target.value))}
                className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label="Timeout (ms)">
              <input type="number" value={cfg.ollamaTimeoutMs} onChange={(e) => set('ollamaTimeoutMs', Number(e.target.value))}
                className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label="KI-Modellaufrufe / Stunde / Person">
              <input type="number" min={1} max={1000} value={cfg.rateLimitMessagesPerHour} onChange={(e) => set('rateLimitMessagesPerHour', Number(e.target.value))}
                className="field h-11 px-4 text-[14px]" />
            </Field>
            <Field label="Gleichzeitige KI-Trainingseinheiten">
              <input type="number" min={1} max={32} value={cfg.maxConcurrentTrainingGenerations} onChange={(e) => set('maxConcurrentTrainingGenerations', Number(e.target.value))}
                className="field h-11 px-4 text-[14px]" />
            </Field>
          </div>
        </Card>

        <Card title="Persönliche Freigaben" icon={<Users size={17} />}>
          <p className="text-[12px] mb-3 leading-relaxed" style={{ color: 'rgb(var(--ink-rgb) / 0.62)' }}>
            Nur Personen mit einer aktiven Freigabe (hier oder über ein Team) können KI-Übungssätze erzeugen.
          </p>
          <div className="flex items-end gap-2 mb-4 flex-wrap">
            <Field label="Benutzername">
              <input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="username"
                className="field h-11 px-4 text-[14px]" style={{ ...inputStyle, minWidth: 160 }} />
            </Field>
            <Field label="Notiz (optional)">
              <input value={newUserNote} onChange={(e) => setNewUserNote(e.target.value)} placeholder="z. B. Pilot"
                className="field h-11 px-4 text-[14px]" style={{ ...inputStyle, minWidth: 160 }} />
            </Field>
            <button
              onClick={() => void handleGrantUser()}
              disabled={grantingUser || !newUsername.trim()}
              className="flex items-center gap-2 px-4 py-2.5 rounded-full text-[13px] font-medium transition-all disabled:opacity-50"
              style={{ background: 'rgba(40,170,125,0.12)', color: 'var(--mint-deep)', border: '1px solid transparent' }}
            >
              <Users size={14} /> Freigeben
            </button>
          </div>
          {activeGrants.length === 0 && revokedGrants.length === 0 && (
            <p className="text-[12px]" style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>Noch keine persönlichen Freigaben.</p>
          )}
          {activeGrants.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {activeGrants.map((g) => (
                <div key={g.stableUid} className="flex items-center justify-between gap-3 px-3 py-2 rounded-[12px]" style={{ background: 'rgb(var(--ink-rgb) / calc(0.024 * var(--veil)))' }}>
                  <div>
                    <span className="text-[13px] text-ink">{g.username}</span>
                    <span className="text-[11px] ml-2" style={{ color: 'rgb(var(--ink-rgb) / 0.58)' }}>
                      von {g.grantedBy} · {new Date(g.grantedAt).toLocaleDateString('de-DE')}{g.note ? ` · ${g.note}` : ''}
                    </span>
                  </div>
                  <button onClick={() => void handleRevokeUser(g.stableUid, g.username)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium"
                    style={{ background: 'rgba(225,70,75,0.1)', color: 'var(--rose-deep)', border: '1px solid transparent' }}>
                    <Trash2 size={12} /> Entziehen
                  </button>
                </div>
              ))}
            </div>
          )}
          {revokedGrants.length > 0 && (
            <details className="mt-3">
              <summary className="text-[12px] cursor-pointer" style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>{revokedGrants.length} entzogene Freigabe(n)</summary>
              <div className="flex flex-col gap-1.5 mt-2">
                {revokedGrants.map((g) => (
                  <div key={g.stableUid} className="px-3 py-2 rounded-[12px] text-[12px]" style={{ background: 'rgb(var(--ink-rgb) / calc(0.016 * var(--veil)))', color: 'rgb(var(--ink-rgb) / 0.54)' }}>
                    <span style={{ textDecoration: 'line-through' }}>{g.username}</span> — entzogen von {g.revokedBy} am {g.revokedAt ? new Date(g.revokedAt).toLocaleDateString('de-DE') : ''}
                  </div>
                ))}
              </div>
            </details>
          )}
        </Card>

        <Card title="Team-Freigaben" icon={<UsersRound size={17} />}>
          <p className="text-[12px] mb-3 leading-relaxed" style={{ color: 'rgb(var(--ink-rgb) / 0.62)' }}>
            Gibt allen aktuellen und künftigen Mitgliedern eines Teams Zugriff, ohne jede Person einzeln freizugeben.
          </p>
          <div className="flex items-end gap-2 mb-4 flex-wrap">
            <Field label="Team">
              <select value={selectedTeamId} onChange={(e) => setSelectedTeamId(e.target.value)}
                className="field h-11 px-4 text-[14px]" style={{ ...inputStyle, minWidth: 220 }}>
                <option value="">Team wählen…</option>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.memberCount} Mitglieder)</option>)}
              </select>
            </Field>
            <Field label="Notiz (optional)">
              <input value={newTeamNote} onChange={(e) => setNewTeamNote(e.target.value)} placeholder="z. B. Pilot-Klasse"
                className="field h-11 px-4 text-[14px]" style={{ ...inputStyle, minWidth: 160 }} />
            </Field>
            <button
              onClick={() => void handleGrantTeam()}
              disabled={grantingTeam || !selectedTeamId}
              className="flex items-center gap-2 px-4 py-2.5 rounded-full text-[13px] font-medium transition-all disabled:opacity-50"
              style={{ background: 'rgba(40,170,125,0.12)', color: 'var(--mint-deep)', border: '1px solid transparent' }}
            >
              <UsersRound size={14} /> Freigeben
            </button>
          </div>
          {activeTeamGrants.length === 0 && revokedTeamGrants.length === 0 && (
            <p className="text-[12px]" style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>Noch keine Team-Freigaben.</p>
          )}
          {activeTeamGrants.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {activeTeamGrants.map((g) => (
                <div key={g.teamId} className="flex items-center justify-between gap-3 px-3 py-2 rounded-[12px]" style={{ background: 'rgb(var(--ink-rgb) / calc(0.024 * var(--veil)))' }}>
                  <div>
                    <span className="text-[13px] text-ink">{g.teamName}</span>
                    <span className="text-[11px] ml-2" style={{ color: 'rgb(var(--ink-rgb) / 0.58)' }}>
                      {g.memberCount} Mitglieder · von {g.grantedBy} · {new Date(g.grantedAt).toLocaleDateString('de-DE')}{g.note ? ` · ${g.note}` : ''}
                    </span>
                  </div>
                  <button onClick={() => void handleRevokeTeam(g.teamId, g.teamName)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium"
                    style={{ background: 'rgba(225,70,75,0.1)', color: 'var(--rose-deep)', border: '1px solid transparent' }}>
                    <Trash2 size={12} /> Entziehen
                  </button>
                </div>
              ))}
            </div>
          )}
          {revokedTeamGrants.length > 0 && (
            <details className="mt-3">
              <summary className="text-[12px] cursor-pointer" style={{ color: 'rgb(var(--ink-rgb) / 0.54)' }}>{revokedTeamGrants.length} entzogene Team-Freigabe(n)</summary>
              <div className="flex flex-col gap-1.5 mt-2">
                {revokedTeamGrants.map((g) => (
                  <div key={g.teamId} className="px-3 py-2 rounded-[12px] text-[12px]" style={{ background: 'rgb(var(--ink-rgb) / calc(0.016 * var(--veil)))', color: 'rgb(var(--ink-rgb) / 0.54)' }}>
                    <span style={{ textDecoration: 'line-through' }}>{g.teamName}</span> — entzogen von {g.revokedBy} am {g.revokedAt ? new Date(g.revokedAt).toLocaleDateString('de-DE') : ''}
                  </div>
                ))}
              </div>
            </details>
          )}
        </Card>

        <Card title="Hinweise" icon={<ShieldCheck size={17} />}>
          <ul className="text-[13px] flex flex-col gap-2" style={{ color: 'rgb(var(--ink-rgb) / 0.62)' }}>
            <li className="flex items-start gap-2"><span style={{ color: 'var(--sky-deep)', flexShrink: 0 }}>•</span>Änderungen wirken sofort — kein Neustart nötig.</li>
            <li className="flex items-start gap-2"><span style={{ color: 'var(--sky-deep)', flexShrink: 0 }}>•</span>Zugriff braucht immer eine aktive persönliche ODER Team-Freigabe — der Kill-Switch allein reicht nie aus.</li>
            <li className="flex items-start gap-2"><span style={{ color: 'var(--sky-deep)', flexShrink: 0 }}>•</span>Das Modell läuft ausschließlich CPU-basiert im internen Docker-Netzwerk, ohne GPU.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
