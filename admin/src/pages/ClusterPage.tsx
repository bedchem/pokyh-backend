import { useCallback, useEffect, useState } from 'react';
import { Activity, Copy, KeyRound, Network, Plus, Power, RefreshCw, Save, Server, Trash2 } from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import type { ClusterPeer, ClusterStatus } from '../types';

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

const inputStyle: React.CSSProperties = { background: '#1c1c1e', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(235,235,245,0.85)' };
const dimText = { color: 'rgba(235,235,245,0.45)' };
const buttonStyle: React.CSSProperties = { background: 'rgba(10,132,255,0.15)', color: '#0a84ff', border: '1px solid rgba(10,132,255,0.25)' };

const GREEN = '#30d158';
const ORANGE = '#ff9f0a';
const RED = '#ff453a';
const GREY = 'rgba(235,235,245,0.45)';

function badgeFor(peer: ClusterPeer): { label: string; color: string } {
  switch (peer.status) {
    case 'PENDING': return { label: 'Kopplung läuft', color: ORANGE };
    case 'LOCKED': return { label: 'Gesperrt (falscher Schlüssel)', color: RED };
    case 'EXPIRED': return { label: 'Kopplung abgelaufen', color: RED };
    case 'DISABLED': return { label: 'Deaktiviert', color: GREY };
    case 'REMOVED': return { label: 'Von der Gegenseite entfernt', color: GREY };
    default: break;
  }
  switch (peer.health) {
    case 'ONLINE': return { label: 'Online', color: GREEN };
    case 'SUSPECT': return { label: 'Antwortet nicht', color: ORANGE };
    case 'OFFLINE': return { label: 'Offline', color: RED };
    default: return { label: 'Verbinde…', color: GREY };
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

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-[22px] font-bold text-white tracking-[-0.02em]">Cluster</h1>
        <p className="text-[13px] mt-1" style={dimText}>
          Mehrere Nodes halten dieselben Daten vor und gleichen Änderungen laufend verschlüsselt miteinander ab.
        </p>
      </div>

      <div className="grid gap-4 max-w-[900px]">
        <Card title="Diese Node" icon={<Server size={17} />}>
          {loading || !data ? (
            <div className="h-16 rounded-[10px] shimmer" />
          ) : (
            <>
              <div className="flex items-end gap-3 flex-wrap">
                <div className="flex-1 min-w-[220px]">
                  <label className="text-[12px] block mb-1" style={dimText}>Name</label>
                  <input value={nodeName} onChange={(e) => { setNodeName(e.target.value); setNodeNameDirty(true); }}
                    className="apple-input px-3 py-2 text-[13px] w-full" style={inputStyle} maxLength={120} />
                </div>
                <button onClick={() => void saveNodeName()} disabled={!nodeNameDirty || !nodeName.trim()}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-[10px] text-[13px] font-medium transition-all disabled:opacity-40" style={buttonStyle}>
                  <Save size={14} /> Speichern
                </button>
              </div>
              <div className="text-[12px] mt-3 flex flex-wrap gap-x-5 gap-y-1" style={dimText}>
                <span>ID: <span className="font-mono">{data.node.id || '—'}</span></span>
                <span>{data.node.isLeader ? 'Führt die einmaligen Hintergrundjobs aus' : 'Hintergrundjobs laufen auf einer anderen Node'}</span>
                {peers.length > 0 && <span>{data.node.replicatedTables} Tabellen im Abgleich</span>}
                {data.node.deferredChanges > 0 && <span style={{ color: ORANGE }}>{data.node.deferredChanges} Änderung(en) zurückgestellt</span>}
              </div>
              {!data.running && (
                <p className="text-[12px] mt-3" style={{ color: ORANGE }}>
                  Der Cluster-Dienst läuft auf dieser Node nicht (CLUSTER_ENABLED=false oder Datenbank noch nicht bereit).
                </p>
              )}
              {data.paused && <p className="text-[12px] mt-3" style={{ color: ORANGE }}>Abgleich pausiert (Wiederherstellung läuft).</p>}
              {data.node.captureGap && (
                <div className="text-[12px] mt-3" style={{ color: RED }}>
                  Die Änderungserfassung fehlte zeitweise (z. B. nach einem manuellen Restore). In dieser Zeit gemachte Änderungen
                  wurden nicht übertragen.{' '}
                  <button onClick={() => void rebuild()} className="underline" style={{ color: RED }}>
                    Datenstand dieser Node an alle übertragen
                  </button>
                </div>
              )}
              {data.node.captureError && (
                <p className="text-[12px] mt-3" style={{ color: RED }}>
                  Änderungserfassung konnte nicht eingerichtet werden: {data.node.captureError}
                </p>
              )}
            </>
          )}
        </Card>

        <Card title="Node hinzufügen" icon={<Plus size={17} />}>
          <p className="text-[12px] mb-4" style={dimText}>
            Auf <strong>beiden</strong> Nodes die Adresse der jeweils anderen und <strong>denselben</strong> Pairing-Schlüssel eintragen.
            Der Schlüssel wird nur für die einmalige Kopplung gebraucht und danach verworfen; ab dann verwenden die Nodes einen eigenen,
            daraus ausgehandelten Schlüssel.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-[12px] block mb-1" style={dimText}>Adresse der anderen Node (IP oder Host, optional mit Port)</label>
              <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="z. B. 203.0.113.10:4000"
                className="apple-input px-3 py-2 text-[13px] w-full font-mono" style={inputStyle} />
            </div>
            <div>
              <label className="text-[12px] block mb-1" style={dimText}>Anzeigename (optional)</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Server 2" maxLength={120}
                className="apple-input px-3 py-2 text-[13px] w-full" style={inputStyle} />
            </div>
          </div>
          <div className="mt-3">
            <label className="text-[12px] block mb-1" style={dimText}>Pairing-Schlüssel (mindestens 16 Zeichen)</label>
            <div className="flex gap-2 flex-wrap">
              <input value={pairingKey} onChange={(e) => setPairingKey(e.target.value)} autoComplete="off" spellCheck={false}
                className="apple-input px-3 py-2 text-[13px] flex-1 min-w-[240px] font-mono" style={inputStyle} />
              <button onClick={() => void generateKey()} type="button"
                className="flex items-center gap-2 px-3 py-2 rounded-[10px] text-[13px] font-medium" style={buttonStyle}>
                <KeyRound size={14} /> Erzeugen
              </button>
              <button onClick={() => void copyKey()} type="button" disabled={!pairingKey}
                className="flex items-center gap-2 px-3 py-2 rounded-[10px] text-[13px] font-medium disabled:opacity-40" style={buttonStyle}>
                <Copy size={14} /> Kopieren
              </button>
            </div>
          </div>
          <button onClick={() => void addPeer()} disabled={!canAdd}
            className="mt-4 flex items-center gap-2 px-4 py-2.5 rounded-[10px] text-[13px] font-medium transition-all disabled:opacity-40" style={buttonStyle}>
            <Network size={14} /> {adding ? 'Starte Kopplung…' : 'Koppeln'}
          </button>
        </Card>

        <Card title={`Nodes (${peers.length})`} icon={<Network size={17} />}>
          {loading ? (
            <div className="flex flex-col gap-2">{Array.from({ length: 2 }).map((_, i) => <div key={i} className="h-16 rounded-[10px] shimmer" />)}</div>
          ) : peers.length === 0 ? (
            <p className="text-[13px] text-center py-6" style={dimText}>Noch keine weitere Node gekoppelt — diese Node läuft eigenständig.</p>
          ) : (
            <div className="flex flex-col divide-y" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
              {peers.map((peer) => {
                const badge = badgeFor(peer);
                const busy = busyPeer === peer.id;
                return (
                  <div key={peer.id} className="py-3.5">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: badge.color }} />
                          <span className="text-[14px] font-medium text-white">{peer.name || peer.address}</span>
                          <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ color: badge.color, border: `1px solid ${badge.color}55` }}>{badge.label}</span>
                          {peer.isLeader && <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ color: '#0a84ff', border: '1px solid rgba(10,132,255,0.35)' }}>Leader</span>}
                        </div>
                        <div className="text-[12px] mt-1 font-mono" style={dimText}>{peer.address}</div>
                        {peer.status === 'ACTIVE' && (
                          <div className="text-[12px] mt-1 flex flex-wrap gap-x-4 gap-y-0.5" style={dimText}>
                            <span>Zuletzt gesehen: {ago(peer.lastSeenAt)}</span>
                            {peer.latencyMs !== null && <span>Antwortzeit: {peer.latencyMs} ms</span>}
                            <span style={peer.queuedRows > 0 ? { color: ORANGE } : undefined}>Wartend: {peer.queuedRows}</span>
                            {peer.fullTransfer && <span style={{ color: ORANGE }}>Vollständiger Abgleich läuft…</span>}
                            <span>Gesendet: {peer.rowsSent} · Empfangen: {peer.rowsReceived}</span>
                          </div>
                        )}
                        {peer.pairing && (
                          <div className="text-[12px] mt-1" style={dimText}>
                            {peer.pairing.message}
                            {peer.pairing.expiresAt && ` · gültig bis ${new Date(peer.pairing.expiresAt).toLocaleTimeString('de-DE')}`}
                            {peer.pairing.failures > 0 && ` · Fehlversuche: ${peer.pairing.failures}`}
                          </div>
                        )}
                        {peer.status === 'ACTIVE' && peer.lastError && peer.health !== 'ONLINE' && (
                          <div className="text-[12px] mt-1" style={{ color: ORANGE }}>{peer.lastError}</div>
                        )}
                        {peer.warnings.map((warning) => (
                          <div key={warning} className="text-[12px] mt-1" style={{ color: ORANGE }}>⚠ {warning}</div>
                        ))}
                      </div>
                      <div className="flex-shrink-0 flex items-center gap-1.5">
                        {peer.status === 'ACTIVE' && (
                          <button onClick={() => resync(peer)} disabled={busy} aria-label="Vollständig abgleichen" title="Vollständig abgleichen"
                            className="p-2 rounded-[8px] transition-colors disabled:opacity-40" style={{ color: 'rgba(235,235,245,0.6)' }}>
                            <RefreshCw size={15} />
                          </button>
                        )}
                        {(peer.status === 'ACTIVE' || peer.status === 'DISABLED') && (
                          <button onClick={() => void withPeer(peer, () => adminApi.updateClusterPeer(peer.id, { enabled: peer.status !== 'ACTIVE' }), peer.status === 'ACTIVE' ? 'Abgleich deaktiviert' : 'Abgleich aktiviert')}
                            disabled={busy} aria-label={peer.status === 'ACTIVE' ? 'Deaktivieren' : 'Aktivieren'} title={peer.status === 'ACTIVE' ? 'Deaktivieren' : 'Aktivieren'}
                            className="p-2 rounded-[8px] transition-colors disabled:opacity-40" style={{ color: peer.status === 'ACTIVE' ? ORANGE : GREEN }}>
                            <Power size={15} />
                          </button>
                        )}
                        <button onClick={() => repair(peer)} disabled={busy} aria-label="Neu koppeln" title="Neu koppeln"
                          className="p-2 rounded-[8px] transition-colors disabled:opacity-40" style={{ color: 'rgba(235,235,245,0.6)' }}>
                          <KeyRound size={15} />
                        </button>
                        <button onClick={() => remove(peer)} disabled={busy} aria-label="Entfernen" title="Entfernen"
                          className="p-2 rounded-[8px] transition-colors disabled:opacity-40" style={{ color: RED }}>
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {data && data.events.length > 0 && (
          <Card title="Ereignisse" icon={<Activity size={17} />}>
            <div className="flex flex-col gap-1.5">
              {data.events.slice(0, 25).map((event, index) => (
                <div key={`${event.at}-${index}`} className="text-[12px] flex gap-3">
                  <span className="font-mono flex-shrink-0" style={dimText}>{new Date(event.at).toLocaleTimeString('de-DE')}</span>
                  <span style={{ color: event.level === 'error' ? RED : event.level === 'warn' ? ORANGE : 'rgba(235,235,245,0.75)' }}>{event.message}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
