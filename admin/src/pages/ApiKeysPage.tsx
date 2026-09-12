import { useEffect, useState, useCallback } from 'react';
import { KeyRound, Plus, Copy, Ban, Check, AlertTriangle } from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import type { AdminApiKey } from '../types';

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

function keyStatus(key: AdminApiKey): { label: string; color: string } {
  if (key.revokedAt) return { label: 'Widerrufen', color: '#ff453a' };
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) return { label: 'Abgelaufen', color: '#ff9f0a' };
  return { label: 'Aktiv', color: '#30d158' };
}

export function ApiKeysPage() {
  const { showToast } = useToast();
  const [keys, setKeys] = useState<AdminApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [platform, setPlatform] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const dimText = { color: 'rgba(235,235,245,0.45)' };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.listApiKeys();
      setKeys(res.apiKeys);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Laden fehlgeschlagen', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void load(); }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const result = await adminApi.createApiKey({
        name: name.trim(),
        purpose: purpose.trim() || undefined,
        platform: platform.trim() || undefined,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      });
      setCreatedKey(result.key);
      setName('');
      setPurpose('');
      setPlatform('');
      setExpiresAt('');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erstellen fehlgeschlagen', 'error');
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(key: AdminApiKey) {
    const confirmed = window.confirm(`API-Key "${key.name}" wirklich widerrufen? Dies kann nicht rückgängig gemacht werden.`);
    if (!confirmed) return;
    try {
      await adminApi.revokeApiKey(key.id);
      showToast('API-Key widerrufen', 'success');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Widerrufen fehlgeschlagen', 'error');
    }
  }

  async function copyKey() {
    if (!createdKey) return;
    await navigator.clipboard.writeText(createdKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-[22px] font-bold text-white tracking-[-0.02em]">API-Keys</h1>
        <p className="text-[13px] mt-1" style={dimText}>
          Zusätzliche Schlüssel für externe Integrationen — mit Ablaufdatum, Plattform und Zweck. Der statische
          Master-Key (Umgebungsvariable) bleibt davon unberührt und funktioniert unverändert weiter.
        </p>
      </div>

      <div className="grid gap-4 max-w-[720px]">
        {createdKey && (
          <Card title="Neuer Schlüssel erstellt" icon={<Check size={17} />}>
            <div className="flex items-start gap-2.5 mb-3 px-3 py-2.5 rounded-[10px]" style={{ background: 'rgba(255,159,10,0.08)', border: '1px solid rgba(255,159,10,0.2)' }}>
              <AlertTriangle size={14} style={{ color: '#ff9f0a', marginTop: '1px', flexShrink: 0 }} />
              <p className="text-[12px]" style={{ color: '#ff9f0a' }}>
                Dieser Schlüssel wird nur jetzt angezeigt und kann danach nicht erneut abgerufen werden. Jetzt sicher speichern!
              </p>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2.5 rounded-[10px] text-[12px] font-mono break-all" style={{ background: '#1c1c1e', color: '#30d158', border: '1px solid rgba(255,255,255,0.08)' }}>
                {createdKey}
              </code>
              <button onClick={() => void copyKey()} className="flex-shrink-0 p-2.5 rounded-[10px] transition-colors" style={{ background: 'rgba(10,132,255,0.15)', color: '#0a84ff', border: '1px solid rgba(10,132,255,0.25)' }}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            <button onClick={() => setCreatedKey(null)} className="mt-3 text-[12px] transition-colors" style={{ color: 'rgba(235,235,245,0.4)' }}>
              Ausblenden
            </button>
          </Card>
        )}

        <Card title="Neuen Schlüssel erstellen" icon={<Plus size={17} />}>
          <form onSubmit={(e) => void handleCreate(e)} className="flex flex-col gap-3">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (z.B. „Mobile CI“)" required maxLength={191}
              className="apple-input px-3 py-2 text-[13px]" />
            <div className="grid grid-cols-2 gap-3">
              <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Zweck (optional)" maxLength={255}
                className="apple-input px-3 py-2 text-[13px]" />
              <input value={platform} onChange={(e) => setPlatform(e.target.value)} placeholder="Plattform/OS (optional)" maxLength={80}
                className="apple-input px-3 py-2 text-[13px]" />
            </div>
            <div>
              <label className="text-[12px] block mb-1" style={dimText}>Ablaufdatum (optional)</label>
              <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)}
                className="px-3 py-2 rounded-[10px] text-[13px] outline-none" style={{ background: '#1c1c1e', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(235,235,245,0.7)' }} />
            </div>
            <button type="submit" disabled={creating || !name.trim()}
              className="self-start flex items-center gap-2 px-4 py-2.5 rounded-[10px] text-[13px] font-medium transition-all disabled:opacity-50"
              style={{ background: 'rgba(10,132,255,0.15)', color: '#0a84ff', border: '1px solid rgba(10,132,255,0.25)' }}>
              <Plus size={14} /> {creating ? 'Erstelle…' : 'Schlüssel erstellen'}
            </button>
          </form>
        </Card>

        <Card title={`Bestehende Schlüssel (${keys.length})`} icon={<KeyRound size={17} />}>
          {loading ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-12 rounded-[10px] shimmer" />)}
            </div>
          ) : keys.length === 0 ? (
            <p className="text-[13px] text-center py-6" style={dimText}>Noch keine zusätzlichen Schlüssel erstellt.</p>
          ) : (
            <div className="flex flex-col divide-y" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
              {keys.map((key) => {
                const status = keyStatus(key);
                return (
                  <div key={key.id} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[13px] font-semibold text-white">{key.name}</span>
                        <span className="text-[11px] px-2 py-0.5 rounded-[6px] font-medium" style={{ background: `${status.color}22`, color: status.color, border: `1px solid ${status.color}44` }}>
                          {status.label}
                        </span>
                      </div>
                      <div className="text-[12px] mt-0.5 flex flex-wrap gap-x-3" style={dimText}>
                        {key.purpose && <span>{key.purpose}</span>}
                        {key.platform && <span>{key.platform}</span>}
                        {key.expiresAt && <span>läuft ab {new Date(key.expiresAt).toLocaleDateString('de-DE')}</span>}
                        {key.lastUsedAt && <span>zuletzt genutzt {new Date(key.lastUsedAt).toLocaleDateString('de-DE')}</span>}
                      </div>
                    </div>
                    {!key.revokedAt && (
                      <button onClick={() => void handleRevoke(key)}
                        className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[12px] font-medium transition-colors"
                        style={{ background: 'rgba(255,69,58,0.1)', color: '#ff453a', border: '1px solid rgba(255,69,58,0.2)' }}>
                        <Ban size={12} /> Widerrufen
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
