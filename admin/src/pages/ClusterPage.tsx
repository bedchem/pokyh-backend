import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Copy, Crown, Hourglass, KeyRound, Network, Plus, Power, RefreshCw, Save, Server, Trash2, Wifi } from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import { Delta, Empty, FieldLabel, Figures, FormSection, IconButton, Notice, PageHeader, Section, Spinner, Status, Tag, type Tone } from '../components/kit';
import { RankBars, SplitBar } from '../components/charts';
import type { ClusterPeer, ClusterStatus } from '../types';

function badgeFor(peer: ClusterPeer): { label: string; tone: Tone } {
  switch (peer.status) {
    case 'PENDING': return { label: 'Kopplung läuft', tone: 'amber' };
    case 'LOCKED': return { label: 'Gesperrt (falscher Schlüssel)', tone: 'rose' };
    case 'EXPIRED': return { label: 'Kopplung abgelaufen', tone: 'rose' };
    case 'DISABLED': return { label: 'Deaktiviert', tone: 'ink' };
    case 'REMOVED': return { label: 'Von der Gegenseite entfernt', tone: 'ink' };
    default: break;
  }
  switch (peer.health) {
    case 'ONLINE': return { label: 'Online', tone: 'mint' };
    case 'SUSPECT': return { label: 'Antwortet nicht', tone: 'amber' };
    case 'OFFLINE': return { label: 'Offline', tone: 'rose' };
    default: return { label: 'Verbinde…', tone: 'ink' };
  }
}

function ago(iso: string | null): string {
  if (!iso) return 'noch nie';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return 'gerade eben';
  if (seconds < 90) return `vor ${seconds} s`;
  if (seconds < 5400) return `vor ${Math.round(seconds / 60)} min`;
  return new Date(iso).toLocaleString('de-DE');
}

const EVENT_TONE: Record<'info' | 'warn' | 'error', Tone> = { info: 'sky', warn: 'amber', error: 'rose' };

export function ClusterPage() {
  const { showToast } = useToast();
  const [data, setData] = useState<ClusterStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [address, setAddress] = useState('');
  const [name, setName] = useState('');
  const [pairingKey, setPairingKey] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyPeer, setBusyPeer] = useState<string | null>(null);
  const [nodeName, setNodeName] = useState('');
  const [nodeNameDirty, setNodeNameDirty] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await adminApi.getCluster();
      setData(res);
      setNodeNameDirty((dirty) => {
        if (!dirty) setNodeName(res.node.name);
        return dirty;
      });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Laden fehlgeschlagen', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void load(); }, [load]);
  useAutoRefresh(load, 5000);

  async function generateKey() {
    try {
      const res = await adminApi.generatePairingKey();
      setPairingKey(res.pairingKey);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Schlüssel konnte nicht erzeugt werden', 'error');
    }
  }

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(pairingKey);
      showToast('Schlüssel kopiert', 'success');
    } catch {
      showToast('Kopieren nicht möglich — bitte von Hand markieren', 'error');
    }
  }

  async function addPeer() {
    setAdding(true);
    try {
      await adminApi.addClusterPeer({ address: address.trim(), name: name.trim() || undefined, pairingKey });
      showToast('Kopplung gestartet — jetzt denselben Schlüssel auf der anderen Node eingeben', 'success');
      setAddress('');
      setName('');
      setPairingKey('');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Hinzufügen fehlgeschlagen', 'error');
    } finally {
      setAdding(false);
    }
  }

  async function withPeer(peer: ClusterPeer, action: () => Promise<unknown>, done: string) {
    setBusyPeer(peer.id);
    try {
      await action();
      showToast(done, 'success');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Aktion fehlgeschlagen', 'error');
    } finally {
      setBusyPeer(null);
    }
  }

  function repair(peer: ClusterPeer) {
    const key = window.prompt(
      `Neuen Pairing-Schlüssel für "${peer.name || peer.address}" eingeben.\n\nDerselbe Schlüssel muss auch auf der anderen Node für diese Node eingegeben werden.`,
    );
    if (!key) return;
    void withPeer(peer, () => adminApi.pairClusterPeer(peer.id, key), 'Kopplung neu gestartet');
  }

  function resync(peer: ClusterPeer) {
    const stale = peer.warnings.some((warning) => warning.includes('longer than deleted rows'));
    if (stale && !window.confirm(
      `"${peer.name || peer.address}" war sehr lange nicht erreichbar. Ein Abgleich kann Daten zurückbringen, die inzwischen gelöscht wurden.\n\nTrotzdem abgleichen?`,
    )) return;
    void withPeer(peer, () => adminApi.resyncClusterPeer(peer.id, stale), 'Vollständiger Abgleich gestartet');
  }

  function remove(peer: ClusterPeer) {
    if (!window.confirm(`Node "${peer.name || peer.address}" wirklich entfernen? Die Daten bleiben auf beiden Nodes erhalten, werden aber nicht mehr abgeglichen.`)) return;
    void withPeer(peer, () => adminApi.removeClusterPeer(peer.id), 'Node entfernt');
  }

  async function rebuild() {
    if (!window.confirm(
      'Den Datenstand DIESER Node als maßgeblich erklären?\n\nAlle Zeilen dieser Node werden an die anderen Nodes übertragen und überschreiben dort abweichende Stände. Nur verwenden, wenn die Datenbank dieser Node außerhalb der Anwendung verändert wurde (z. B. manueller Restore).',
    )) return;
    try {
      const res = await adminApi.rebuildCluster();
      showToast(`${res.rows} Zeilen werden an alle Nodes übertragen`, 'success');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Aktion fehlgeschlagen', 'error');
    }
  }

  async function saveNodeName() {
    try {
      await adminApi.renameClusterNode(nodeName.trim());
      setNodeNameDirty(false);
      showToast('Name gespeichert', 'success');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Speichern fehlgeschlagen', 'error');
    }
  }

  const peers = data?.peers ?? [];
  const canAdd = address.trim().length > 0 && pairingKey.trim().length >= 16 && !adding;
  const active = peers.filter((p) => p.status === 'ACTIVE');
  const online = active.filter((p) => p.health === 'ONLINE').length;
  const suspect = active.filter((p) => p.health === 'SUSPECT').length;
  const offline = active.filter((p) => p.health === 'OFFLINE').length;
  const other = peers.length - online - suspect - offline;
  const queued = peers.reduce((sum, p) => sum + p.queuedRows, 0);
  const withLatency = active.filter((p) => p.latencyMs !== null);

  return (
    <div>
      <PageHeader title="Cluster" subtitle="Mehrere Nodes halten dieselben Daten vor und gleichen Änderungen laufend verschlüsselt miteinander ab." />

      <Figures
        className="mt-10"
        items={[
          { label: 'Nodes', value: peers.length + 1, icon: Network, note: <Delta>inkl. dieser</Delta> },
          { label: 'Online', value: online, icon: Wifi, note: peers.length > 0 ? <Delta tone={online === active.length ? 'mint' : 'amber'}>von {active.length}</Delta> : undefined },
          { label: 'Wartende Zeilen', value: queued, icon: Hourglass, note: queued > 0 ? <Delta tone="amber">werden übertragen</Delta> : <Delta tone="mint">im Gleichstand</Delta> },
          { label: 'Hintergrundjobs', value: data ? (data.node.isLeader ? 'Diese Node' : 'Andere Node') : '–', icon: Crown },
        ]}
      />

      {peers.length > 0 && (
        <div className="mt-[46px] grid gap-x-16 gap-y-12 xl:grid-cols-2">
          <Section title="Antwortzeit" meta="je Node">
            <div className="mt-8">
              <RankBars
                unit=" ms"
                items={withLatency.map((p) => ({ label: p.name || p.address, value: p.latencyMs ?? 0 }))}
                empty="Noch keine Messwerte."
              />
            </div>
          </Section>
          <Section title="Erreichbarkeit">
            <div className="mt-9">
              <SplitBar
                ariaLabel="Nodes nach Erreichbarkeit"
                parts={[
                  { label: 'Online',          value: online,  color: 'var(--mint)' },
                  { label: 'Antwortet nicht', value: suspect, color: 'var(--amber)' },
                  { label: 'Offline',         value: offline, color: 'var(--rose)' },
                  { label: 'Nicht aktiv',     value: other,   color: 'var(--ink-4)' },
                ]}
              />
            </div>
          </Section>
        </div>
      )}

      <Section className="mt-[52px]" title="Nodes" meta={`${peers.length} gekoppelt`}>
        {loading ? (
          <div className="mt-7 flex flex-col gap-5">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4"><div className="shimmer h-12 w-12 rounded-full" /><div className="shimmer h-4 flex-1 rounded-full" /></div>
            ))}
          </div>
        ) : peers.length === 0 ? (
          <Empty icon={Network}>Noch keine weitere Node gekoppelt — diese Node läuft eigenständig.</Empty>
        ) : (
          <ul className="stack mt-3">
            {peers.map((peer) => {
              const badge = badgeFor(peer);
              const busy = busyPeer === peer.id;
              return (
                <li key={peer.id} className="spot flex flex-wrap items-start gap-x-4 gap-y-3 py-5">
                  <span className="orb h-12 w-12"><Server size={19} strokeWidth={1.6} /></span>
                  <div className="min-w-[220px] flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <span className="text-[14.5px] font-medium">{peer.name || peer.address}</span>
                      {peer.isLeader && <Tag tone="sky"><Crown size={11} /> Leader</Tag>}
                    </div>
                    <div className="mt-1 font-mono text-[12.5px] text-ink-3">{peer.address}</div>
                    {peer.status === 'ACTIVE' && (
                      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-ink-3">
                        <span>Zuletzt gesehen: {ago(peer.lastSeenAt)}</span>
                        {peer.latencyMs !== null && <span>Antwortzeit: {peer.latencyMs} ms</span>}
                        <span style={peer.queuedRows > 0 ? { color: 'var(--amber-deep)' } : undefined}>Wartend: {peer.queuedRows}</span>
                        {peer.fullTransfer && <span style={{ color: 'var(--amber-deep)' }}>Vollständiger Abgleich läuft…</span>}
                        <span>Gesendet: {peer.rowsSent.toLocaleString('de-AT')} · Empfangen: {peer.rowsReceived.toLocaleString('de-AT')}</span>
                      </div>
                    )}
                    {peer.pairing && (
                      <div className="mt-2 text-[13px] text-ink-3">
                        {peer.pairing.message}
                        {peer.pairing.expiresAt && ` · gültig bis ${new Date(peer.pairing.expiresAt).toLocaleTimeString('de-DE')}`}
                        {peer.pairing.failures > 0 && ` · Fehlversuche: ${peer.pairing.failures}`}
                      </div>
                    )}
                    {peer.status === 'ACTIVE' && peer.lastError && peer.health !== 'ONLINE' && (
                      <div className="mt-2 text-[13px] text-amber-deep">{peer.lastError}</div>
                    )}
                    {peer.warnings.map((warning) => (
                      <div key={warning} className="mt-2 flex items-start gap-2 text-[13px] text-amber-deep">
                        <AlertTriangle size={14} strokeWidth={1.7} className="mt-0.5 flex-shrink-0" /> {warning}
                      </div>
                    ))}
                  </div>
                  <span className="w-[170px] pt-3"><Status tone={badge.tone}>{badge.label}</Status></span>
                  <div className="flex flex-shrink-0 gap-1.5 pt-1">
                    {peer.status === 'ACTIVE' && (
                      <IconButton icon={RefreshCw} label="Vollständig abgleichen" disabled={busy} onClick={() => resync(peer)} />
                    )}
                    {(peer.status === 'ACTIVE' || peer.status === 'DISABLED') && (
                      <IconButton
                        icon={Power}
                        tone={peer.status === 'ACTIVE' ? 'amber' : 'mint'}
                        label={peer.status === 'ACTIVE' ? 'Deaktivieren' : 'Aktivieren'}
                        disabled={busy}
                        onClick={() => void withPeer(peer, () => adminApi.updateClusterPeer(peer.id, { enabled: peer.status !== 'ACTIVE' }), peer.status === 'ACTIVE' ? 'Abgleich deaktiviert' : 'Abgleich aktiviert')}
                      />
                    )}
                    <IconButton icon={KeyRound} label="Neu koppeln" disabled={busy} onClick={() => repair(peer)} />
                    <IconButton icon={Trash2} tone="rose" label="Entfernen" disabled={busy} onClick={() => remove(peer)} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <div className="mt-6">
        <FormSection icon={Server} title="Diese Node" hint="Der Name, unter dem diese Node bei den anderen erscheint.">
          {loading || !data ? (
            <div className="shimmer h-16 max-w-[620px] rounded-[18px]" />
          ) : (
            <div className="flex max-w-[620px] flex-col gap-5">
              <div className="flex flex-wrap items-end gap-3">
                <FieldLabel label="Name" className="min-w-[220px] flex-1">
                  <input value={nodeName} onChange={(e) => { setNodeName(e.target.value); setNodeNameDirty(true); }}
                    className="field h-12 w-full px-4 text-[14.5px]" maxLength={120} />
                </FieldLabel>
                <button type="button" onClick={() => void saveNodeName()} disabled={!nodeNameDirty || !nodeName.trim()} className="btn btn-quiet h-12">
                  <Save size={16} strokeWidth={1.7} /> Speichern
                </button>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-[13px] text-ink-3">
                <span>ID: <span className="font-mono">{data.node.id || '—'}</span></span>
                <span>{data.node.isLeader ? 'Führt die einmaligen Hintergrundjobs aus' : 'Hintergrundjobs laufen auf einer anderen Node'}</span>
                {peers.length > 0 && <span>{data.node.replicatedTables} Tabellen im Abgleich</span>}
                {data.node.deferredChanges > 0 && <span className="text-amber-deep">{data.node.deferredChanges} Änderung(en) zurückgestellt</span>}
              </div>
              {!data.running && (
                <Notice tone="amber" icon={AlertTriangle}>
                  Der Cluster-Dienst läuft auf dieser Node nicht (CLUSTER_ENABLED=false oder Datenbank noch nicht bereit).
                </Notice>
              )}
              {data.paused && <Notice tone="amber" icon={AlertTriangle}>Abgleich pausiert (Wiederherstellung läuft).</Notice>}
              {data.node.captureGap && (
                <Notice tone="rose" icon={AlertTriangle}>
                  Die Änderungserfassung fehlte zeitweise (z. B. nach einem manuellen Restore). In dieser Zeit gemachte Änderungen
                  wurden nicht übertragen.{' '}
                  <button type="button" onClick={() => void rebuild()} className="underline">
                    Datenstand dieser Node an alle übertragen
                  </button>
                </Notice>
              )}
              {data.node.captureError && (
                <Notice tone="rose" icon={AlertTriangle}>
                  Änderungserfassung konnte nicht eingerichtet werden: {data.node.captureError}
                </Notice>
              )}
            </div>
          )}
        </FormSection>

        <FormSection
          icon={Plus}
          title="Node hinzufügen"
          hint={<>Auf <strong className="font-medium text-ink-2">beiden</strong> Nodes die Adresse der jeweils anderen und <strong className="font-medium text-ink-2">denselben</strong> Pairing-Schlüssel eintragen. Der Schlüssel wird nur für die einmalige Kopplung gebraucht und danach verworfen; ab dann verwenden die Nodes einen eigenen, daraus ausgehandelten Schlüssel.</>}
        >
          <div className="flex max-w-[620px] flex-col gap-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <FieldLabel label="Adresse der anderen Node" hint="IP oder Host, optional mit Port.">
                <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="z. B. 203.0.113.10:4000"
                  className="field h-12 w-full px-4 font-mono text-[13.5px]" />
              </FieldLabel>
              <FieldLabel label="Anzeigename" hint="Optional.">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Server 2" maxLength={120}
                  className="field h-12 w-full px-4 text-[14.5px]" />
              </FieldLabel>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-[13px] text-ink-2">Pairing-Schlüssel (mindestens 16 Zeichen)</span>
              <div className="flex flex-wrap gap-2.5">
                <input value={pairingKey} onChange={(e) => setPairingKey(e.target.value)} autoComplete="off" spellCheck={false}
                  aria-label="Pairing-Schlüssel"
                  className="field h-12 min-w-[240px] flex-1 px-4 font-mono text-[13.5px]" />
                <button type="button" onClick={() => void generateKey()} className="btn btn-quiet h-12">
                  <KeyRound size={16} strokeWidth={1.7} /> Erzeugen
                </button>
                <IconButton icon={Copy} label="Schlüssel kopieren" size={48} disabled={!pairingKey} onClick={() => void copyKey()} />
              </div>
            </div>
            <div>
              <button type="button" onClick={() => void addPeer()} disabled={!canAdd} className="btn btn-primary">
                {adding ? <Spinner /> : <Network size={16} strokeWidth={1.7} />}
                {adding ? 'Starte Kopplung…' : 'Koppeln'}
              </button>
            </div>
          </div>
        </FormSection>
      </div>

      {data && data.events.length > 0 && (
        <Section className="border-t border-line pt-[38px]" title="Ereignisse" meta={`Letzte ${Math.min(data.events.length, 25)}`}>
          <ul className="mt-6 flex flex-col gap-3.5">
            {data.events.slice(0, 25).map((event, index) => (
              <li key={`${event.at}-${index}`} className="flex items-baseline gap-4 text-[13.5px]">
                <time className="tabular w-[70px] flex-shrink-0 font-mono text-[12.5px] text-ink-3">{new Date(event.at).toLocaleTimeString('de-DE')}</time>
                <Status tone={EVENT_TONE[event.level]}><span className="whitespace-normal">{event.message}</span></Status>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
