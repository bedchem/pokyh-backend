import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, Check, Copy, Hourglass, KeyRound, LogIn, Network, Plus, Power, RefreshCw, Save, Server, ShieldCheck, Terminal, Trash2, UserPlus, Wifi, X,
} from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import { Delta, Dialog, Empty, FieldLabel, Figures, FormSection, IconButton, Notice, PageHeader, Section, Spinner, Status, Tag, type Tone } from '../components/kit';
import { Explained, InfoTip, ToggleField } from '../components/cluster/explain';
import { UpdatesSection } from '../components/cluster/UpdatesSection';
import type { ClusterInstall, ClusterPeer, ClusterStatus, CreatedClusterInstall } from '../types';
import { ReachSection } from '../components/cluster/ReachSection';

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

const INSTALL_STATE: Record<ClusterInstall['status'], { label: string; tone: Tone }> = {
  OPEN: { label: 'Wartet auf den Server', tone: 'amber' },
  PROVISIONED: { label: 'Wird installiert', tone: 'sky' },
  DONE: { label: 'Beigetreten', tone: 'mint' },
  EXPIRED: { label: 'Abgelaufen', tone: 'ink' },
  LOCKED: { label: 'Gesperrt (falscher Schlüssel)', tone: 'rose' },
  REVOKED: { label: 'Widerrufen', tone: 'ink' },
};

// The one-line install: the administrator names the new server (and, if they
// like, its domain or IP) and receives a command to run there. The command
// is shown once; several can be open at the same time.
const DOMAIN_LIKE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;
const IPV4_LIKE = /^\d{1,3}(\.\d{1,3}){3}$/;

function InstallDialog({ data, onClose, onCreated }: { data: ClusterStatus | null; onClose: () => void; onCreated: () => void }) {
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [acmeEmail, setAcmeEmail] = useState('');
  const [withAi, setWithAi] = useState(Boolean(data?.node.aiEnabled));
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedClusterInstall | null>(null);
  const [count, setCount] = useState(0);
  const [copied, setCopied] = useState(false);
  const now = useNow(created !== null);
  const mtls = data?.channel.mtls;
  const channelReady = Boolean(mtls?.listening && mtls.url);
  const origin = window.location.origin;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  const originOk = window.location.protocol === 'https:' || loopback;
  const trimmed = address.trim().replace(/\.$/, '');
  const isDomain = trimmed !== '' && DOMAIN_LIKE.test(trimmed) && !IPV4_LIKE.test(trimmed);
  const minutes = data?.node.installMinutes ?? 30;

  async function create() {
    setBusy(true);
    try {
      const res = await adminApi.createClusterInstall({
        name: name.trim(),
        address: trimmed || undefined,
        acmeEmail: isDomain ? acmeEmail.trim() || undefined : undefined,
        withAi,
        origin,
      });
      setCreated(res);
      setCount((value) => value + 1);
      onCreated();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erzeugen fehlgeschlagen', 'error');
    } finally {
      setBusy(false);
    }
  }

  function another() {
    setCreated(null);
    setCopied(false);
    setName('');
    setAddress('');
  }

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast('Kopieren nicht möglich — bitte von Hand markieren', 'error');
    }
  }

  return (
    <Dialog
      title="Server per Einzeiler hinzufügen"
      subtitle="Ein Befehl richtet einen frischen Debian- oder Ubuntu-Server komplett als Node ein und verbindet ihn mit dem Cluster."
      onClose={onClose}
      width={660}
    >
      {!created ? (
        <div className="flex flex-col gap-5">
          {!channelReady && (
            <Notice tone="amber" icon={AlertTriangle}>
              Der gesicherte Cluster-Kanal (mTLS) läuft auf dieser Node nicht. Setze <code>CLUSTER_MTLS_PORT=4100</code> (und
              falls nötig <code>CLUSTER_MTLS_URL</code>), veröffentliche den Port und öffne ihn für die anderen Server.
            </Notice>
          )}
          {!originOk && (
            <Notice tone="amber" icon={AlertTriangle}>
              Öffne das Admin-Panel über die öffentliche <b>https</b>-Adresse dieser Node — der neue Server lädt seine Einrichtung genau von dort.
            </Notice>
          )}
          {count > 0 && <Notice tone="mint" icon={Check}>{count} {count === 1 ? 'Befehl' : 'Befehle'} erzeugt. Jeder gilt für genau einen Server.</Notice>}
          <FieldLabel
            label={<Explained tip="Unter diesem Namen erscheint der neue Server bei allen Nodes, z. B. „Wien“ oder „Homelab“. Erlaubt sind Buchstaben, Ziffern, Leerzeichen, Punkt, Bindestrich und Unterstrich.">Name</Explained>}
          >
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className="field h-12 w-full px-4 text-[14px]" placeholder="z. B. Homelab" autoFocus />
          </FieldLabel>
          <FieldLabel
            label={(
              <Explained tip={<>
                <b>Leer lassen</b> (empfohlen, wenn du unsicher bist): Beim Einrichten erkennt diese Node die öffentliche IP des neuen Servers selbst. Der Server bekommt keine eigene Web-Adresse — Apps reden weiter mit deinen bisherigen Adressen, die Nodes verbinden sich über Port 4100 (oder über ein Relay, wenn der Server hinter NAT steht).<br /><br />
                <b>Domain</b> (z. B. node2.example.org): Der Server bekommt zusätzlich eigenes HTTPS mit Let’s-Encrypt-Zertifikat und kann selbst Anfragen annehmen. Die Domain muss schon per DNS auf ihn zeigen, Ports 80 und 443 müssen offen sein.<br /><br />
                <b>IP</b>: wie „leer“, nur fest vorgegeben (z. B. wenn der Server mehrere Adressen hat).
              </>}>Adresse (optional)</Explained>
            )}
            hint={trimmed === '' ? 'Leer: IP wird beim Einrichten automatisch erkannt, keine eigene Web-Adresse.' : isDomain ? 'Domain: eigener HTTPS-Zugang über Caddy und Let’s Encrypt.' : 'IP: feste Adresse für den Cluster, keine eigene Web-Adresse.'}
          >
            <input value={address} onChange={(e) => setAddress(e.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off"
              className="field h-12 w-full px-4 font-mono text-[13.5px]" placeholder="leer, node2.example.org oder 203.0.113.20" />
          </FieldLabel>
          {isDomain && (
            <FieldLabel label={<Explained tip="Let’s Encrypt schickt an diese Adresse nur Warnungen, falls ein Zertifikat nicht erneuert werden kann. Leer lassen geht auch.">E-Mail für Let’s Encrypt (optional)</Explained>}>
              <input value={acmeEmail} onChange={(e) => setAcmeEmail(e.target.value)} spellCheck={false} autoCapitalize="off"
                className="field h-12 w-full px-4 text-[14px]" placeholder="ops@example.org" />
            </FieldLabel>
          )}
          <ToggleField
            checked={withAi}
            onChange={setWithAi}
            label="KI-Vokabeltrainer mitinstallieren"
            hint="Ollama auf dem neuen Server — braucht mindestens 12 GB RAM."
            tip="Installiert zusätzlich Ollama, das Sprachmodell für den KI-Vokabeltrainer. Hat der Server zu wenig Arbeitsspeicher, lässt der Installer es weg und sagt Bescheid. Ohne KI läuft alles andere ganz normal."
          />
          <div className="flex flex-col gap-1.5 rounded-[16px] bg-well px-4 py-3 text-[12.5px] leading-relaxed text-ink-3">
            <span className="flex items-center gap-1.5 text-[13px] text-ink-2">
              <ShieldCheck size={14} strokeWidth={1.7} /> So bleibt das sicher
              <InfoTip>
                Der Befehl lädt das Installationsskript von <span className="font-mono">{origin}/setup</span>. Diese Adresse gibt es nur, solange ein
                Einzeiler offen ist (höchstens {minutes} Minuten) — sonst antwortet sie wie jede unbekannte Seite mit 404. Das Skript ist per
                SHA-256 im Befehl festgeschrieben: Ändert es jemand unterwegs, bricht der Befehl ab, bevor etwas läuft. Die Konfiguration mit allen
                Schlüsseln bekommt nur, wer den Schlüssel im Befehl hat — verschlüsselt, genau einmal. Fünf falsche Versuche sperren den Befehl.
              </InfoTip>
            </span>
            <span><span className="font-mono">/setup</span> ist nur offen, während du Server hinzufügst — sonst 404.</span>
          </div>
          <button type="button" onClick={() => void create()} disabled={busy || !name.trim() || !channelReady || !originOk} className="btn btn-primary w-full sm:w-auto sm:self-start">
            {busy ? <Spinner /> : <Terminal size={16} strokeWidth={1.7} />}
            {busy ? 'Erzeuge…' : 'Einzeiler erzeugen'}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-[13.5px] text-ink-2">
            Auf dem neuen Server <b>{created.name}</b>{created.address && <> (<span className="font-mono">{created.address}</span>)</>} ausführen —
            als root oder als Benutzer mit sudo (Debian 12+ oder Ubuntu 22.04+):
          </p>
          <div className="max-h-[220px] overflow-y-auto rounded-[16px] bg-well p-4 font-mono text-[12px] leading-relaxed text-ink" style={{ wordBreak: 'break-all' }}>
            {created.command}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => void copy()} className="btn btn-primary">
              {copied ? <Check size={16} strokeWidth={1.8} /> : <Copy size={16} strokeWidth={1.7} />}
              {copied ? 'Kopiert' : 'Befehl kopieren'}
            </button>
            <button type="button" onClick={another} className="btn btn-quiet">
              <Plus size={16} strokeWidth={1.7} /> Noch einen Server hinzufügen
            </button>
            <span className="tabular text-[13px] text-ink-3">{remaining(created.expiresAt, now)}</span>
          </div>
          <Notice tone="amber" icon={AlertTriangle}>
            Der Befehl gilt für einen Server und muss innerhalb von {minutes} Minuten gestartet werden. Wer ihn hat, kann einen Server
            mit allen Daten in den Cluster bringen — nur über einen sicheren Weg weitergeben. Er wird nicht noch einmal angezeigt.
          </Notice>
          <Notice tone="sky" icon={ShieldCheck}>
            Der Installer richtet Docker ein, härtet den Server (automatische Sicherheitsupdates, Firewall nur für SSH und Pokyh) und startet
            die Node. Am neuen Server muss Port 4100 (Cluster) erreichbar sein{created.address && DOMAIN_LIKE.test(created.address) && !IPV4_LIKE.test(created.address) ? ', dazu 80 und 443 für HTTPS' : ''} —
            steht er hinter NAT, verbindet er sich über ein Relay. Die Firewall-Härtung lässt sich mit <code>POKYH_HARDEN=0</code> vor dem Befehl abschalten.
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
  const [dialog, setDialog] = useState<'invite' | 'join' | 'install' | null>(null);
  const [installs, setInstalls] = useState<ClusterInstall[]>([]);
  const [rotating, setRotating] = useState(false);
  const now = useNow(true);

  const load = useCallback(async () => {
    try {
      const res = await adminApi.getCluster();
      setData(res);
      if (res.running) {
        adminApi.getClusterInstalls().then((list) => setInstalls(list.installs)).catch(() => { /* shown again next round */ });
      }
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

  async function revokeInstall(install: ClusterInstall) {
    if (!window.confirm(`Den Einzeiler für ${install.name || install.address} widerrufen? Er funktioniert danach nicht mehr.`)) return;
    try {
      await adminApi.revokeClusterInstall(install.id);
      showToast('Einzeiler widerrufen', 'success');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Widerrufen fehlgeschlagen', 'error');
    }
  }

  async function rotateCertificate() {
    if (!window.confirm('Das Zertifikat dieser Node erneuern?\n\nAlle verbundenen Nodes müssen online sein; sie übernehmen das neue Zertifikat sofort. Ein ausgegebener, noch nicht gestarteter Einzeiler funktioniert danach nicht mehr.')) return;
    setRotating(true);
    try {
      const res = await adminApi.rotateClusterCertificate();
      showToast(`Zertifikat erneuert — ${res.peers} Node(s) haben es übernommen`, 'success');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erneuern fehlgeschlagen', 'error');
    } finally {
      setRotating(false);
    }
  }

  const peers = data?.peers ?? [];
  const openInstalls = installs.filter((install) => install.status === 'OPEN' || install.status === 'PROVISIONED');
  const recentInstalls = installs.slice(0, 8);
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
        subtitle={(
          <Explained tip={<>
            Ein Cluster sind mehrere Server (Nodes) mit denselben Daten. Es gibt <b>keinen Chef</b>: jede Node nimmt Änderungen an und gibt sie
            an alle anderen weiter. Fällt eine aus, arbeiten die anderen einfach weiter — und holt sie danach alles nach. Eine Node allein
            funktioniert genauso; weitere machen das Ganze ausfallsicher. Du kannst beliebig viele hinzufügen, auch mehrere gleichzeitig.
          </>}>Alle Nodes sind gleichberechtigt: jede nimmt Änderungen an, alle halten dieselben Daten und prüfen sich laufend gegenseitig.</Explained>
        )}
      >
        <button type="button" onClick={() => setDialog('install')} className="btn btn-primary" disabled={!data?.running}>
          <Terminal size={16} strokeWidth={1.7} /> Server per Einzeiler hinzufügen
        </button>
        <button type="button" onClick={() => setDialog('invite')} className="btn btn-quiet" disabled={!data?.running}>
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

      <Section className="mt-[52px]" title={<Explained tip="Die anderen Server dieses Clusters. „mTLS · gepinnt“ heißt: Die Verbindung läuft über den gesicherten Kanal, und jede Seite akzeptiert nur das eine Zertifikat, das sie von der anderen kennt. „Ausstehend“ sind Änderungen, die noch übertragen werden.">Nodes</Explained>} meta={`${active.length} verbunden`}>
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
                      {peer.tls && <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[11.5px] text-ink-3" title={`sha256//${peer.tls.pin}`}><KeyRound size={12} strokeWidth={1.7} /> sha256//{peer.tls.pin.slice(0, 16)}…</div>}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {peer.introducedBy ? <Tag tone="violet">automatisch vorgestellt</Tag> : peer.role === 'HOST' ? <Tag>eingeladen</Tag> : <Tag>beigetreten</Tag>}
                        {peer.tls?.locked && <Tag tone="mint">mTLS · gepinnt</Tag>}
                        {peer.tls && !peer.tls.locked && <Tag tone="sky">{peer.tls.active ? 'wechselt auf mTLS' : 'mTLS gepinnt, noch nicht erreichbar'}</Tag>}
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

      {recentInstalls.length > 0 && (
        <Section className="mt-6" title={<Explained tip="Die Befehle, mit denen du neue Server hinzugefügt hast. Solange einer offen ist (höchstens 30 Minuten), ist /setup erreichbar; danach antwortet es mit 404. Einen offenen Befehl kannst du jederzeit widerrufen — er funktioniert dann sofort nicht mehr.">Einzeiler</Explained>} meta={openInstalls.length > 0 ? `${openInstalls.length} offen` : 'keiner offen'}>
          <ul className="stack mt-3">
            {recentInstalls.map((install) => {
              const state = INSTALL_STATE[install.status];
              const open = install.status === 'OPEN' || install.status === 'PROVISIONED';
              return (
                <li key={install.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-4">
                  <span className="orb h-10 w-10"><Terminal size={16} strokeWidth={1.6} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-[14px] font-medium">{install.name || 'Server'}</span>
                      <span className="font-mono text-[12.5px] text-ink-3">{install.address || 'IP wird erkannt'}</span>
                      <Status tone={state.tone}>{state.label}</Status>
                      {install.withAi && <Tag tone="violet">mit KI</Tag>}
                    </div>
                    <div className="mt-1 text-[12.5px] text-ink-3">
                      {install.status === 'OPEN' ? `startbar ${remaining(install.expiresAt, now)}` : `erstellt ${ago(install.createdAt)}`}
                      {install.failures > 0 && ` · Fehlversuche: ${install.failures}`}
                    </div>
                  </div>
                  {open && <IconButton icon={X} tone="rose" label="Widerrufen" onClick={() => void revokeInstall(install)} />}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      <div className="mt-6">
        <FormSection icon={Network} title={<Explained tip="So reden die Nodes miteinander: über einen eigenen, gegenseitig per Zertifikat abgesicherten Kanal (mTLS, Standard-Port 4100). Jede Node kennt das Zertifikat jeder anderen genau (gepinnt) — niemand dazwischen kann sich als Node ausgeben, auch nicht mit einem gültigen Web-Zertifikat. Zusätzlich ist jede Nachricht Ende-zu-Ende verschlüsselt.">Verbindung</Explained>} hint="Wie die Nodes einander erreichen. Festgelegt in der .env (CLUSTER_MTLS_PORT, CLUSTER_PUBLIC_PATH, CLUSTER_PORT, CLUSTER_ALLOWLIST, CLUSTER_AUTO_MESH); jede Nachricht ist zusätzlich Ende-zu-Ende verschlüsselt.">
          {!channel ? (
            <div className="shimmer h-24 max-w-[620px] rounded-[18px]" />
          ) : (
            <div className="stack max-w-[620px]">
              <ChannelRow
                label="Gesicherter Kanal (mTLS, gepinnte Zertifikate)"
                value={channel.mtls.port === 0 ? 'aus' : `${channel.mtls.url ?? `${channel.mtls.bindAddress}:${channel.mtls.port}`}${channel.mtls.listening ? '' : ' — lauscht nicht'}`}
                tone={channel.mtls.port === 0 ? 'amber' : channel.mtls.listening ? 'mint' : 'rose'}
              />
              <ChannelRow label="Über den API-Port (Reverse-Proxy)" value={channel.publicPath ? 'an' : 'aus'} tone={channel.publicPath ? 'mint' : 'ink'} />
              <ChannelRow
                label="Eigener Cluster-Port"
                value={channel.port === 0 ? 'aus' : `${channel.bindAddress}:${channel.port}${channel.listening ? '' : ' — lauscht nicht'}`}
                tone={channel.port === 0 ? 'ink' : channel.listening ? 'mint' : 'rose'}
              />
              <ChannelRow label="IP-Allowlist" value={channel.allowlistEntries > 0 ? `${channel.allowlistEntries} Einträge` : 'aus (alle Adressen)'} tone={channel.allowlistEntries > 0 ? 'mint' : 'amber'} />
              <ChannelRow label="Auto-Mesh" value={channel.autoMesh ? 'an — neue Nodes verbinden sich mit allen' : 'aus'} tone={channel.autoMesh ? 'mint' : 'ink'} />
              {channel.mtls.pin && (
                <div className="flex flex-col gap-3 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                    <span className="text-[14px] text-ink-2">Zertifikat dieser Node</span>
                    <span className="text-[12.5px] text-ink-3">gültig bis {channel.mtls.certificateEnds ? new Date(channel.mtls.certificateEnds).toLocaleDateString('de-DE') : '—'}</span>
                  </div>
                  <div className="break-all font-mono text-[12px] text-ink-2">sha256//{channel.mtls.pin}</div>
                  <button type="button" onClick={() => void rotateCertificate()} disabled={rotating} className="btn btn-quiet btn-sm self-start">
                    {rotating ? <Spinner /> : <KeyRound size={15} strokeWidth={1.7} />} Zertifikat erneuern
                  </button>
                </div>
              )}
            </div>
          )}
        </FormSection>

        <ReachSection running={Boolean(data?.running)} />

        <UpdatesSection running={Boolean(data?.running)} />

        <FormSection icon={Server} title={<Explained tip="Die Node, deren Admin-Panel du gerade offen hast. Hintergrundjobs (z. B. Erinnerungen) werden auf alle erreichbaren Nodes verteilt; einmalige Jobs laufen nur auf einer, damit nichts doppelt passiert.">Diese Node</Explained>} hint="Der Name, unter dem diese Node bei den anderen erscheint.">
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
        <Section className="border-t border-line pt-[38px]" title={<Explained tip="Was im Cluster zuletzt passiert ist — neue Nodes, Ausfälle, Updates, Warnungen. Nur auf dieser Node, die letzten 100.">Ereignisse</Explained>} meta={`Letzte ${Math.min(data.events.length, 25)}`}>
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

      {dialog === 'install' && <InstallDialog data={data} onClose={() => setDialog(null)} onCreated={() => void load()} />}
      {dialog === 'invite' && <InviteDialog data={data} onClose={() => setDialog(null)} onCreated={() => void load()} />}
      {dialog === 'join' && <JoinDialog data={data} onClose={() => setDialog(null)} onJoined={() => void load()} />}
    </div>
  );
}
