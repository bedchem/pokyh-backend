import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, Check, Copy, Hourglass, LogIn, Network, Power, RefreshCw, Save, Server, ShieldCheck, Trash2, UserPlus, Wifi,
} from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import { Delta, Dialog, Empty, FieldLabel, Figures, FormSection, IconButton, Notice, PageHeader, Section, Spinner, Status, Tag, type Tone } from '../components/kit';
import type { ClusterPeer, ClusterStatus } from '../types';

function badgeFor(peer: ClusterPeer): { label: string; tone: Tone } {
  switch (peer.status) {
    case 'PENDING': return peer.role === 'HOST' ? { label: 'Wartet auf Beitritt', tone: 'amber' } : { label: 'Tritt bei…', tone: 'amber' };
    case 'LOCKED': return { label: 'Gesperrt (falscher Code)', tone: 'rose' };
    case 'EXPIRED': return { label: 'Einladung abgelaufen', tone: 'rose' };
    case 'DISABLED': return { label: 'Ausgeschaltet', tone: 'ink' };
    case 'REMOVED': return { label: 'Entfernt', tone: 'ink' };
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

function remaining(iso: string | null, now: number): string {
  if (!iso) return '';
  const seconds = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));
  if (seconds === 0) return 'abgelaufen';
  return `noch ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} min`;
}

const EVENT_TONE: Record<'info' | 'warn' | 'error', Tone> = { info: 'sky', warn: 'amber', error: 'rose' };

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

// The address this node is reached at, prefilled from the server's setting,
// else from where the panel is open right now (the usual case behind a proxy).
function initialAddress(data: ClusterStatus | null): string {
  return data?.node.advertiseUrl || window.location.origin;
}

function OwnAddressField({ value, onChange, fixed }: { value: string; onChange: (next: string) => void; fixed: boolean }) {
  return (
    <FieldLabel
      label="Adresse dieser Node"
      hint={fixed ? 'Fest eingestellt über CLUSTER_ADVERTISE_URL.' : 'Unter dieser Adresse erreichen die anderen Nodes diese hier — z. B. https://node1.deinedomain.at oder http://10.0.0.5:4100.'}
    >
      <input value={value} onChange={(e) => onChange(e.target.value)} disabled={fixed} spellCheck={false} autoCapitalize="off" autoCorrect="off"
        className="field h-12 w-full px-4 font-mono text-[13.5px]" placeholder="https://node1.example.org" />
    </FieldLabel>
  );
}

function InviteDialog({ data, onClose, onCreated }: { data: ClusterStatus | null; onClose: () => void; onCreated: () => void }) {
  const { showToast } = useToast();
  const [address, setAddress] = useState(() => initialAddress(data));
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<{ code: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const now = useNow(invite !== null);

  async function create() {
    setBusy(true);
    try {
      const res = await adminApi.createClusterInvite(address.trim());
      setInvite({ code: res.code, expiresAt: res.expiresAt });
      onCreated();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Einladung fehlgeschlagen', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast('Kopieren nicht möglich — bitte von Hand markieren', 'error');
    }
  }

  return (
    <Dialog title="Node einladen" subtitle="Erzeugt einen Einladungscode für eine neue Node." onClose={onClose} width={520}>
      {!invite ? (
        <div className="flex flex-col gap-5">
          <OwnAddressField value={address} onChange={setAddress} fixed={Boolean(data?.node.advertiseFromEnv)} />
          <button type="button" onClick={() => void create()} disabled={busy || !address.trim()} className="btn btn-primary w-full sm:w-auto sm:self-start">
            {busy ? <Spinner /> : <UserPlus size={16} strokeWidth={1.7} />}
            {busy ? 'Erzeuge…' : 'Code erzeugen'}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="rounded-[16px] bg-well p-4 font-mono text-[12.5px] leading-relaxed text-ink" style={{ wordBreak: 'break-all' }}>
            {invite.code}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => void copy()} className="btn btn-primary">
              {copied ? <Check size={16} strokeWidth={1.8} /> : <Copy size={16} strokeWidth={1.7} />}
              {copied ? 'Kopiert' : 'Code kopieren'}
            </button>
            <span className="tabular text-[13px] text-ink-3">{remaining(invite.expiresAt, now)}</span>
          </div>
          <Notice tone="amber" icon={AlertTriangle}>
            Der Code gilt einmal und läuft in {data?.node.inviteMinutes ?? 15} Minuten ab. Wer ihn hat, kann beitreten und erhält alle Daten —
            nur über einen sicheren Weg weitergeben. Auf der neuen Node: Cluster → Beitreten → Code einfügen.
          </Notice>
        </div>
      )}
    </Dialog>
  );
}

function JoinDialog({ data, onClose, onJoined }: { data: ClusterStatus | null; onClose: () => void; onJoined: () => void }) {
  const { showToast } = useToast();
  const [code, setCode] = useState('');
  const [address, setAddress] = useState(() => initialAddress(data));
  const [busy, setBusy] = useState(false);

  async function join() {
    setBusy(true);
    try {
      await adminApi.joinCluster(code.trim(), address.trim());
      showToast('Beitritt gestartet — die Nodes verbinden sich jetzt', 'success');
      onJoined();
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Beitritt fehlgeschlagen', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Cluster beitreten" subtitle="Einladungscode einer bestehenden Node einfügen." onClose={onClose} width={520}>
      <div className="flex flex-col gap-5">
        <FieldLabel label="Einladungscode">
          <textarea value={code} onChange={(e) => setCode(e.target.value)} rows={4} spellCheck={false} autoCapitalize="off" autoCorrect="off"
            className="field w-full resize-none px-4 py-3 font-mono text-[12.5px] leading-relaxed" placeholder="pokyh1.…" />
        </FieldLabel>
        <OwnAddressField value={address} onChange={setAddress} fixed={Boolean(data?.node.advertiseFromEnv)} />
        <button type="button" onClick={() => void join()} disabled={busy || code.trim().length < 10 || !address.trim()} className="btn btn-primary w-full sm:w-auto sm:self-start">
          {busy ? <Spinner /> : <LogIn size={16} strokeWidth={1.7} />}
          {busy ? 'Trete bei…' : 'Beitreten'}
        </button>
      </div>
    </Dialog>
  );
}

function ChannelRow({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3">
      <span className="text-[14px] text-ink-2">{label}</span>
      <Status tone={tone}><span className="whitespace-normal">{value}</span></Status>
    </div>
  );
}

export function ClusterPage() {
  const { showToast } = useToast();
  const [data, setData] = useState<ClusterStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyPeer, setBusyPeer] = useState<string | null>(null);
  const [nodeName, setNodeName] = useState('');
  const [nodeNameDirty, setNodeNameDirty] = useState(false);
  const [dialog, setDialog] = useState<'invite' | 'join' | null>(null);
  const now = useNow(true);

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
  useAutoRefresh(load, 4000);

  async function withPeer(peer: ClusterPeer, action: () => Promise<unknown>, done: string | ((result: unknown) => string)) {
    setBusyPeer(peer.id);
    try {
      const result = await action();
      showToast(typeof done === 'function' ? done(result) : done, 'success');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Aktion fehlgeschlagen', 'error');
    } finally {
      setBusyPeer(null);
    }
  }

  function resync(peer: ClusterPeer) {
    const stale = peer.warnings.some((warning) => warning.includes('longer than deleted rows'));
    if (stale && !window.confirm(
      `"${peer.name || peer.address}" war sehr lange nicht erreichbar. Ein Abgleich kann Daten zurückbringen, die inzwischen gelöscht wurden.\n\nTrotzdem abgleichen?`,
    )) return;
    void withPeer(peer, () => adminApi.resyncClusterPeer(peer.id, stale), 'Vollständiger Abgleich gestartet');
  }

  function remove(peer: ClusterPeer) {
    const label = peer.name || peer.address || 'diese Einladung';
    const active = peer.status === 'ACTIVE' || peer.status === 'DISABLED';
    const question = active
      ? `Verbindung zu "${label}" entfernen? Die Daten bleiben auf beiden Nodes, werden aber nicht mehr direkt abgeglichen. Die Nodes verbinden sich auch nicht von selbst wieder.`
      : peer.status === 'REMOVED'
        ? `Eintrag "${label}" löschen? Danach dürfen sich die beiden Nodes wieder verbinden (z. B. über Auto-Mesh).`
        : `"${label}" verwerfen?`;
    if (!window.confirm(question)) return;
    void withPeer(peer, () => adminApi.removeClusterPeer(peer.id), active ? 'Verbindung entfernt' : 'Eintrag gelöscht');
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
  const active = peers.filter((p) => p.status === 'ACTIVE');
  const online = active.filter((p) => p.health === 'ONLINE').length;
  const pending = active.reduce((sum, p) => sum + p.pendingRows, 0);
  const verified = active.map((p) => p.verify?.lastAt).filter((at): at is string => Boolean(at)).sort().at(0) ?? null;
  const checking = active.some((p) => p.verify?.running);
  const channel = data?.channel;

  return (
    <div>
      <PageHeader
        title="Cluster"
        subtitle="Alle Nodes sind gleichberechtigt: jede nimmt Änderungen an, alle halten dieselben Daten und prüfen sich laufend gegenseitig."
      >
        <button type="button" onClick={() => setDialog('invite')} className="btn btn-primary" disabled={!data?.running}>
          <UserPlus size={16} strokeWidth={1.7} /> Node einladen
        </button>
        <button type="button" onClick={() => setDialog('join')} className="btn btn-quiet" disabled={!data?.running}>
          <LogIn size={16} strokeWidth={1.7} /> Beitreten
        </button>
      </PageHeader>

      <Figures
        className="mt-10"
        items={[
          { label: 'Nodes', value: active.length + 1, icon: Network, note: <Delta>inkl. dieser</Delta> },
          { label: 'Online', value: online, icon: Wifi, note: active.length > 0 ? <Delta tone={online === active.length ? 'mint' : 'amber'}>von {active.length}</Delta> : undefined },
          { label: 'Ausstehend', value: pending, icon: Hourglass, note: pending > 0 ? <Delta tone="amber">wird übertragen</Delta> : <Delta tone="mint">im Gleichstand</Delta> },
          { label: 'Selbstcheck', value: checking ? 'läuft' : active.length === 0 ? '–' : ago(verified), icon: ShieldCheck, note: data ? <Delta>alle {data.node.verifyIntervalMinutes} min</Delta> : undefined },
        ]}
      />

      {data && (!data.running || data.paused || data.node.captureGap || data.node.captureError || (channel?.warnings.length ?? 0) > 0) && (
        <div className="mt-8 flex flex-col gap-3">
          {!data.running && (
            <Notice tone="amber" icon={AlertTriangle}>Der Cluster-Dienst läuft auf dieser Node nicht (CLUSTER_ENABLED=false oder Datenbank noch nicht bereit).</Notice>
          )}
          {data.paused && <Notice tone="amber" icon={AlertTriangle}>Abgleich pausiert (Wiederherstellung läuft).</Notice>}
          {data.node.captureGap && (
            <Notice tone="rose" icon={AlertTriangle}>
              Die Änderungserfassung fehlte zeitweise (z. B. nach einem manuellen Restore). In dieser Zeit gemachte Änderungen
              wurden nicht übertragen.{' '}
              <button type="button" onClick={() => void rebuild()} className="underline">Datenstand dieser Node an alle übertragen</button>
            </Notice>
          )}
          {data.node.captureError && (
            <Notice tone="rose" icon={AlertTriangle}>Änderungserfassung konnte nicht eingerichtet werden: {data.node.captureError}</Notice>
          )}
          {channel?.warnings.map((warning) => <Notice key={warning} tone="amber" icon={AlertTriangle}>{warning}</Notice>)}
        </div>
      )}

      <Section className="mt-[52px]" title="Nodes" meta={`${active.length} verbunden`}>
        {loading ? (
          <div className="mt-7 flex flex-col gap-5">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4"><div className="shimmer h-12 w-12 rounded-full" /><div className="shimmer h-4 flex-1 rounded-full" /></div>
            ))}
          </div>
        ) : peers.length === 0 ? (
          <Empty icon={Network}>Noch keine weitere Node — diese läuft eigenständig. Lade eine Node ein oder tritt mit einem Code einem Cluster bei.</Empty>
        ) : (
          <ul className="stack mt-3">
            {peers.map((peer) => {
              const badge = badgeFor(peer);
              const busy = busyPeer === peer.id;
              const isActive = peer.status === 'ACTIVE';
              return (
                <li key={peer.id} className="flex flex-col gap-3 py-5">
                  <div className="flex items-start gap-4">
                    <span className="orb h-12 w-12"><Server size={19} strokeWidth={1.6} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                        <span className="min-w-0 break-words text-[15px] font-medium">{peer.name || peer.address || (peer.role === 'HOST' ? 'Offene Einladung' : 'Neue Node')}</span>
                        <Status tone={badge.tone}>{badge.label}</Status>
                      </div>
                      {peer.name && peer.address && <div className="mt-1 font-mono text-[12.5px] text-ink-3">{peer.address}</div>}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {peer.introducedBy ? <Tag tone="violet">automatisch vorgestellt</Tag> : peer.role === 'HOST' ? <Tag>eingeladen</Tag> : <Tag>beigetreten</Tag>}
                        {peer.fullTransfer && <Tag tone="amber">vollständiger Abgleich läuft</Tag>}
                        {peer.verify?.running && <Tag tone="sky">Selbstcheck läuft</Tag>}
                      </div>
                    </div>
                  </div>

                  {isActive && (
                    <div className="flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-ink-3 sm:pl-16">
                      <span>Zuletzt gesehen: {ago(peer.lastSeenAt)}</span>
                      {peer.latencyMs !== null && <span>Antwortzeit: {peer.latencyMs} ms</span>}
                      <span style={peer.pendingRows > 0 ? { color: 'var(--amber-deep)' } : undefined}>Ausstehend: {peer.pendingRows.toLocaleString('de-AT')}</span>
                      <span>Gesendet: {peer.rowsSent.toLocaleString('de-AT')} · Empfangen: {peer.rowsReceived.toLocaleString('de-AT')}</span>
                      {peer.verify && (
                        <span style={peer.verify.error ? { color: 'var(--amber-deep)' } : undefined}>
                          Selbstcheck: {peer.verify.error ? `fehlgeschlagen (${peer.verify.error})` : `${ago(peer.verify.lastAt)}${peer.verify.repaired > 0 ? `, ${peer.verify.repaired} repariert` : ', alles gleich'}`}
                        </span>
                      )}
                    </div>
                  )}
                  {peer.pairing && (
                    <div className="text-[13px] text-ink-3 sm:pl-16">
                      {peer.pairing.message}
                      {peer.pairing.expiresAt && ` · ${remaining(peer.pairing.expiresAt, now)}`}
                      {peer.pairing.failures > 0 && ` · Fehlversuche: ${peer.pairing.failures}`}
                    </div>
                  )}
                  {isActive && peer.lastError && peer.health !== 'ONLINE' && (
                    <div className="break-words text-[13px] text-amber-deep sm:pl-16">{peer.lastError}</div>
                  )}
                  {peer.warnings.map((warning) => (
                    <div key={warning} className="flex items-start gap-2 text-[13px] text-amber-deep sm:pl-16">
                      <AlertTriangle size={14} strokeWidth={1.7} className="mt-0.5 flex-shrink-0" /> <span className="min-w-0">{warning}</span>
                    </div>
                  ))}

                  <div className="flex flex-wrap gap-1.5 sm:pl-16">
                    {isActive && (
                      <IconButton icon={ShieldCheck} tone="sky" label="Jetzt prüfen" disabled={busy || peer.health !== 'ONLINE'} busy={busy && peer.verify?.running}
                        onClick={() => void withPeer(peer, () => adminApi.verifyClusterPeer(peer.id), (result) => {
                          const repaired = (result as { repaired: number }).repaired;
                          return repaired > 0 ? `${repaired} abweichende Zeile(n) übertragen` : 'Alles im Gleichstand';
                        })} />
                    )}
                    {isActive && <IconButton icon={RefreshCw} label="Vollständig abgleichen" disabled={busy} onClick={() => resync(peer)} />}
                    {(isActive || peer.status === 'DISABLED') && (
                      <IconButton
                        icon={Power}
                        tone={isActive ? 'amber' : 'mint'}
                        label={isActive ? 'Ausschalten' : 'Einschalten'}
                        disabled={busy}
                        onClick={() => void withPeer(peer, () => adminApi.updateClusterPeer(peer.id, { enabled: !isActive }), isActive ? 'Abgleich ausgeschaltet' : 'Abgleich eingeschaltet')}
                      />
                    )}
                    <IconButton icon={Trash2} tone="rose" label={isActive || peer.status === 'DISABLED' ? 'Verbindung entfernen' : 'Eintrag löschen'} disabled={busy} onClick={() => remove(peer)} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <div className="mt-6">
        <FormSection icon={Network} title="Verbindung" hint="Wie die Nodes einander erreichen. Festgelegt in der .env (CLUSTER_PUBLIC_PATH, CLUSTER_PORT, CLUSTER_ALLOWLIST, CLUSTER_AUTO_MESH); jede Nachricht ist zusätzlich Ende-zu-Ende verschlüsselt.">
          {!channel ? (
            <div className="shimmer h-24 max-w-[620px] rounded-[18px]" />
          ) : (
            <div className="stack max-w-[620px]">
              <ChannelRow label="Über den API-Port (Reverse-Proxy)" value={channel.publicPath ? 'an' : 'aus'} tone={channel.publicPath ? 'mint' : 'ink'} />
              <ChannelRow
                label="Eigener Cluster-Port"
                value={channel.port === 0 ? 'aus' : `${channel.bindAddress}:${channel.port}${channel.listening ? '' : ' — lauscht nicht'}`}
                tone={channel.port === 0 ? 'ink' : channel.listening ? 'mint' : 'rose'}
              />
              <ChannelRow label="IP-Allowlist" value={channel.allowlistEntries > 0 ? `${channel.allowlistEntries} Einträge` : 'aus (alle Adressen)'} tone={channel.allowlistEntries > 0 ? 'mint' : 'amber'} />
              <ChannelRow label="Auto-Mesh" value={channel.autoMesh ? 'an — neue Nodes verbinden sich mit allen' : 'aus'} tone={channel.autoMesh ? 'mint' : 'ink'} />
            </div>
          )}
        </FormSection>

        <FormSection icon={Server} title="Diese Node" hint="Der Name, unter dem diese Node bei den anderen erscheint.">
          {loading || !data ? (
            <div className="shimmer h-16 max-w-[620px] rounded-[18px]" />
          ) : (
            <div className="flex max-w-[620px] flex-col gap-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <FieldLabel label="Name" className="flex-1">
                  <input value={nodeName} onChange={(e) => { setNodeName(e.target.value); setNodeNameDirty(true); }}
                    className="field h-12 w-full px-4 text-[14.5px]" maxLength={120} />
                </FieldLabel>
                <button type="button" onClick={() => void saveNodeName()} disabled={!nodeNameDirty || !nodeName.trim()} className="btn btn-quiet h-12">
                  <Save size={16} strokeWidth={1.7} /> Speichern
                </button>
              </div>
              <dl className="grid gap-x-6 gap-y-2.5 text-[13px] sm:grid-cols-[auto_minmax(0,1fr)]">
                <dt className="text-ink-3">ID</dt>
                <dd className="min-w-0 font-mono text-ink-2">{data.node.id || '—'}</dd>
                <dt className="text-ink-3">Adresse</dt>
                <dd className="min-w-0 font-mono text-ink-2">{data.node.advertiseUrl || 'noch nicht festgelegt'}</dd>
                <dt className="text-ink-3">Hintergrundjobs</dt>
                <dd className="min-w-0 text-ink-2">
                  verteilt auf {data.node.workNodes} {data.node.workNodes === 1 ? 'Node' : 'Nodes'}
                  {active.length > 0 && (data.node.exclusiveJobsHere ? ' · einmalige Jobs laufen hier' : ' · einmalige Jobs laufen anderswo oder warten, bis alle Nodes erreichbar sind')}
                </dd>
                {active.length > 0 && (
                  <>
                    <dt className="text-ink-3">Abgleich</dt>
                    <dd className="min-w-0 text-ink-2">{data.node.replicatedTables} Tabellen{data.node.deferredChanges > 0 ? ` · ${data.node.deferredChanges} Änderung(en) zurückgestellt` : ''}</dd>
                  </>
                )}
              </dl>
            </div>
          )}
        </FormSection>
      </div>

      {data && data.events.length > 0 && (
        <Section className="border-t border-line pt-[38px]" title="Ereignisse" meta={`Letzte ${Math.min(data.events.length, 25)}`}>
          <ul className="mt-6 flex flex-col gap-3.5">
            {data.events.slice(0, 25).map((event, index) => (
              <li key={`${event.at}-${index}`} className="flex items-baseline gap-3 text-[13.5px] sm:gap-4">
                <time className="tabular w-[64px] flex-shrink-0 font-mono text-[12px] text-ink-3">{new Date(event.at).toLocaleTimeString('de-DE')}</time>
                <span className="min-w-0"><Status tone={EVENT_TONE[event.level]}><span className="whitespace-normal">{event.message}</span></Status></span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {dialog === 'invite' && <InviteDialog data={data} onClose={() => setDialog(null)} onCreated={() => void load()} />}
      {dialog === 'join' && <JoinDialog data={data} onClose={() => setDialog(null)} onJoined={() => void load()} />}
    </div>
  );
}
