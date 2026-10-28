import { useEffect, useState, useCallback } from 'react';
import { KeyRound, Plus, Copy, Ban, Check, AlertTriangle, CircleCheck, CircleSlash, TimerOff } from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { useLive } from '../live';
import { Empty, FieldLabel, Figures, FormSection, IconButton, Notice, PageHeader, Section, Spinner, Status, Tag, type Tone } from '../components/kit';
import type { AdminApiKey } from '../types';

const availableScopes = [
  { value: 'core:read', label: 'POKYH lesen' },
  { value: 'core:write', label: 'POKYH schreiben' },
  { value: 'auth:session', label: 'Sitzungen' },
] as const;

type KeyState = 'active' | 'expired' | 'revoked';

function keyState(key: AdminApiKey): KeyState {
  if (key.revokedAt) return 'revoked';
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) return 'expired';
  return 'active';
}

const STATE: Record<KeyState, { label: string; tone: Tone }> = {
  active:  { label: 'Aktiv',      tone: 'mint' },
  expired: { label: 'Abgelaufen', tone: 'amber' },
  revoked: { label: 'Widerrufen', tone: 'rose' },
};

export function ApiKeysPage() {
  const { showToast } = useToast();
  const [keys, setKeys] = useState<AdminApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [platform, setPlatform] = useState('');
  const [scopes, setScopes] = useState<string[]>(['core:read']);
  const [expiresAt, setExpiresAt] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
  useLive(['api-keys'], () => { void load(); });

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const result = await adminApi.createApiKey({
        name: name.trim(),
        purpose: purpose.trim() || undefined,
        platform: platform.trim() || undefined,
        scopes,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      });
      setCreatedKey(result.key);
      setCopied(false);
      setName('');
      setPurpose('');
      setPlatform('');
      setScopes(['core:read']);
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
    try {
      await navigator.clipboard.writeText(createdKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The clipboard is unavailable on plain http: the key stays selectable on screen.
      showToast('Kopieren nicht möglich — bitte den Schlüssel markieren und manuell kopieren', 'error');
    }
  }

  function toggleScope(scope: string) {
    setScopes((current) => current.includes(scope)
      ? current.filter((value) => value !== scope)
      : [...current, scope]);
  }

  const counts = { active: 0, expired: 0, revoked: 0 };
  for (const key of keys) counts[keyState(key)] += 1;

  return (
    <div>
      <PageHeader
        title="API-Keys"
        subtitle="Zusätzliche Schlüssel für externe Integrationen — mit Ablaufdatum, Plattform und Zweck. Der statische Master-Key (Umgebungsvariable) bleibt davon unberührt und funktioniert unverändert weiter."
      />

      <Figures
        className="mt-10"
        items={[
          { label: 'Aktiv',      value: counts.active,  icon: CircleCheck },
          { label: 'Abgelaufen', value: counts.expired, icon: TimerOff },
          { label: 'Widerrufen', value: counts.revoked, icon: CircleSlash },
        ]}
      />

      {createdKey && (
        <div className="animate-fadeInUp mt-10 rounded-[26px] bg-well p-6 sm:p-8">
          <div className="flex items-center gap-3.5">
            <span className="orb h-11 w-11" style={{ background: 'var(--mint-wash)', color: 'var(--mint-deep)' }}><Check size={18} strokeWidth={1.8} /></span>
            <h2 className="text-[17px] font-semibold">Neuer Schlüssel erstellt</h2>
          </div>
          <div className="mt-5">
            <Notice tone="amber" icon={AlertTriangle}>
              Dieser Schlüssel wird nur jetzt angezeigt und kann danach nicht erneut abgerufen werden. Jetzt sicher speichern!
            </Notice>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <code className="min-w-0 flex-1 select-all break-all rounded-[16px] bg-sheet px-[18px] py-3.5 font-mono text-[13px] text-mint-deep">
              {createdKey}
            </code>
            <IconButton icon={copied ? Check : Copy} tone="sky" active={copied} size={44} label={copied ? 'Kopiert' : 'Schlüssel kopieren'} onClick={() => void copyKey()} />
          </div>
          <button type="button" onClick={() => setCreatedKey(null)} className="btn btn-sm btn-quiet mt-5">Ausblenden</button>
        </div>
      )}

      <Section className="mt-[46px]" title="Bestehende Schlüssel" meta={`${keys.length} gesamt`}>
        {loading && keys.length === 0 ? (
          <div className="mt-7 flex flex-col gap-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4"><div className="shimmer h-12 w-12 rounded-full" /><div className="shimmer h-4 flex-1 rounded-full" /></div>
            ))}
          </div>
        ) : keys.length === 0 ? (
          <Empty icon={KeyRound}>Noch keine zusätzlichen Schlüssel erstellt.</Empty>
        ) : (
          <ul className="stack mt-3">
            {keys.map((key) => {
              const state = STATE[keyState(key)];
              return (
                <li key={key.id} className="spot flex flex-wrap items-center gap-x-4 gap-y-3 py-[18px]" style={{ opacity: key.revokedAt ? 0.62 : 1 }}>
                  <span className="orb h-12 w-12"><KeyRound size={19} strokeWidth={1.6} /></span>
                  <div className="min-w-[200px] flex-1">
                    <div className="text-[14.5px] font-medium">{key.name}</div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[13px] text-ink-3">
                      {key.purpose && <span>{key.purpose}</span>}
                      {key.platform && <span>{key.platform}</span>}
                      {key.expiresAt && <span>läuft ab {new Date(key.expiresAt).toLocaleDateString('de-DE')}</span>}
                      <span>{key.lastUsedAt ? `zuletzt genutzt ${new Date(key.lastUsedAt).toLocaleDateString('de-DE')}` : 'noch nie genutzt'}</span>
                    </div>
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {key.scopes.map((scope) => <Tag key={scope} mono>{scope}</Tag>)}
                    </div>
                  </div>
                  <span className="w-[112px]"><Status tone={state.tone}>{state.label}</Status></span>
                  <span className="flex w-[38px] justify-end">
                    {!key.revokedAt && (
                      <IconButton icon={Ban} tone="rose" label={`${key.name} widerrufen`} onClick={() => void handleRevoke(key)} />
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <div className="mt-6">
        <FormSection
          icon={Plus}
          title="Neuen Schlüssel erstellen"
          hint="Wähle nur die Zugriffe, die diese Integration wirklich benötigt. Der statische Master-Key bleibt unverändert."
        >
          <form onSubmit={(e) => void handleCreate(e)} className="flex max-w-[640px] flex-col gap-5">
            <FieldLabel label="Name *">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="z.B. „Mobile CI“" required maxLength={191}
                className="field h-12 w-full px-4 text-[14.5px]" />
            </FieldLabel>
            <div className="grid gap-4 sm:grid-cols-2">
              <FieldLabel label="Zweck">
                <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="optional" maxLength={255}
                  className="field h-12 w-full px-4 text-[14.5px]" />
              </FieldLabel>
              <FieldLabel label="Plattform / OS">
                <input value={platform} onChange={(e) => setPlatform(e.target.value)} placeholder="optional" maxLength={80}
                  className="field h-12 w-full px-4 text-[14.5px]" />
              </FieldLabel>
            </div>
            <FieldLabel label="Ablaufdatum" hint="Leer lassen für einen Schlüssel ohne Ablauf." className="sm:max-w-[240px]">
              <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)}
                className="field h-12 w-full px-4 text-[14.5px]" />
            </FieldLabel>
            <fieldset>
              <legend className="mb-3 text-[13px] text-ink-2">Berechtigungen</legend>
              <div className="flex flex-wrap gap-2">
                {availableScopes.map((scope) => {
                  const on = scopes.includes(scope.value);
                  return (
                    <label key={scope.value} className="scope-chip" data-on={on}>
                      <input type="checkbox" className="sr-only" checked={on} onChange={() => toggleScope(scope.value)} />
                      {on && <Check size={14} strokeWidth={2} />}
                      {scope.label}
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <div>
              <button type="submit" disabled={creating || !name.trim() || scopes.length === 0} className="btn btn-primary">
                {creating ? <Spinner /> : <Plus size={16} strokeWidth={1.8} />}
                {creating ? 'Erstelle…' : 'Schlüssel erstellen'}
              </button>
            </div>
          </form>
        </FormSection>
      </div>
    </div>
  );
}
