import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Check, Copy, KeyRound, Plus, Radio, Route, Save, ShieldCheck, Stethoscope, Terminal, Trash2, Undo2 } from 'lucide-react';
import { adminApi } from '../../api';
import { useToast } from '../Toast';
import { Dialog, FieldLabel, FormSection, IconButton, Notice, Segmented, Spinner, Status, Tag } from '../kit';
import { Explained, InfoTip, ToggleField } from './explain';
import type { ClusterReach, ClusterRelay, ProxySnippets, ReachEntry, ReachKind, WayTestResult } from '../../types';

// How the other nodes reach this one, and the relays of the cluster. Every
// way ends at this node's pinned certificate: proxies and relays only carry
// encrypted bytes.

const KIND_LABEL: Record<ReachKind, string> = {
  direct: 'Direkt',
  'proxy-port': 'Proxy · eigener Port',
  'proxy-sni': 'Proxy · 443 (SNI)',
  'proxy-path': 'Proxy · API-Pfad',
};

const KIND_HINT: Record<ReachKind, { endpoint: string; placeholder: string }> = {
  direct: { endpoint: 'Adresse, unter der die anderen diese Node direkt erreichen (öffentliche IP, WireGuard-/Tailscale-IP).', placeholder: 'https://10.8.0.2:4100' },
  'proxy-port': { endpoint: 'Adresse des Proxys mit eigenem Port, der TCP unverändert an diese Node durchreicht.', placeholder: 'https://vps.example.org:4100' },
  'proxy-sni': { endpoint: 'Name unter deiner Cluster-Domain, der auf den Proxy zeigt; der Proxy reicht ihn auf 443 anhand des Namens (SNI) durch.', placeholder: 'https://node1.cluster.example.org:443' },
  'proxy-path': { endpoint: 'Die öffentliche Adresse deiner API plus ein Pfad nur für diese Node. Dein Proxy leitet diesen Pfad (ohne Präfix) an den Cluster-Eingang dieser Node weiter.', placeholder: 'https://api.example.org/cluster-node/homelab' },
};

const BACKEND_PLACEHOLDER: Record<ReachKind, string> = {
  direct: '',
  'proxy-port': '10.8.0.2:4100',
  'proxy-sni': '10.8.0.2:4100',
  'proxy-path': '10.8.0.2:4000',
};

type Draft = Pick<ReachEntry, 'kind' | 'endpoint' | 'enabled' | 'backend'> & { id?: string; snippets?: ProxySnippets | null };

function describeWay(way: string, relays: ClusterRelay[]): { label: string; tone: 'sky' | 'violet' | 'mint' } {
  if (relays.some((relay) => relay.endpoints.includes(way))) return { label: 'Relay', tone: 'violet' };
  return way.includes('?sni=') || way.endsWith(':443') ? { label: 'Proxy', tone: 'sky' } : { label: 'Weg', tone: 'mint' };
}

async function copyText(text: string, showToast: (message: string, kind: 'success' | 'error') => void): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    showToast('Kopieren nicht möglich — bitte von Hand markieren', 'error');
    return false;
  }
}

function SnippetsDialog({ title, snippets, sni, path = false, onClose }: { title: string; snippets: ProxySnippets; sni: boolean; path?: boolean; onClose: () => void }) {
  const { showToast } = useToast();
  const [tab, setTab] = useState<keyof ProxySnippets>('nginx');
  const [copied, setCopied] = useState(false);
  return (
    <Dialog title={title} subtitle="Für deinen Proxy auf dem VPS." onClose={onClose} width={680}>
      <div className="flex flex-col gap-4">
        {path ? (
          <Notice tone="sky" icon={ShieldCheck}>
            Dein Proxy bedient den Pfad wie den Rest der API — mit seinem Zertifikat — und reicht ihn ohne Präfix an diese Node weiter.
            Was darüber läuft, ist Ende-zu-Ende verschlüsselt und mit dem Link-Schlüssel authentifiziert; der Proxy sieht nur
            verschlüsselte Nachrichten. Größe und Zeitlimits sind auf die Cluster-Einstellungen abgestimmt.
          </Notice>
        ) : (
        <Notice tone="sky" icon={ShieldCheck}>
          Der Proxy muss die Verbindung <strong>unverändert durchreichen</strong> — TLS darf er <strong>nicht</strong> beenden (kein Zertifikat,
          kein HTTP). {sni ? 'Er erkennt Cluster-Verkehr am Servernamen (SNI) im ersten Paket und schickt ihn weiter; alles andere geht wie bisher an deine Websites.' : 'Alles, was an diesem Port ankommt, geht weiter.'}
          {' '}Dein eigener Proxy braucht genau diese Fähigkeit (bei nginx: stream + ssl_preread, bei Traefik: TCP mit passthrough).
        </Notice>
        )}
        <Segmented
          label="Proxy"
          value={tab}
          onChange={setTab}
          options={[{ value: 'nginx', label: 'nginx' }, { value: 'haproxy', label: 'HAProxy' }, { value: 'traefik', label: 'Traefik' }, { value: 'caddy', label: 'Caddy' }]}
        />
        <pre className="max-h-[320px] overflow-auto rounded-[16px] bg-well p-4 font-mono text-[12px] leading-relaxed text-ink">{snippets[tab]}</pre>
        <button type="button" className="btn btn-primary self-start" onClick={() => void copyText(snippets[tab], showToast).then((ok) => { if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 2000); } })}>
          {copied ? <Check size={16} strokeWidth={1.8} /> : <Copy size={16} strokeWidth={1.7} />} {copied ? 'Kopiert' : 'Kopieren'}
        </button>
      </div>
    </Dialog>
  );
}

function AddRelayDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { showToast } = useToast();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  async function add() {
    setBusy(true);
    try {
      const res = await adminApi.addClusterRelay(key.trim());
      showToast(`Relay ${res.name} hinzugefügt — alle Nodes melden sich jetzt dort an`, 'success');
      onAdded();
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Hinzufügen fehlgeschlagen', 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Relay hinzufügen" subtitle="Den Relay-Schlüssel einfügen, den das Relay-Setup am Ende ausgegeben hat." onClose={onClose} width={560}>
      <div className="flex flex-col gap-5">
        <FieldLabel label="Relay-Schlüssel" hint="Gilt danach für alle Nodes des Clusters (wird verschlüsselt repliziert). Alternativ nur für eine Node: CLUSTER_RELAY_KEYS in deren .env.">
          <textarea value={key} onChange={(e) => setKey(e.target.value)} rows={4} spellCheck={false} autoCapitalize="off" autoCorrect="off"
            className="field w-full resize-none px-4 py-3 font-mono text-[12px] leading-relaxed" placeholder="pokyhrelay1.…" />
        </FieldLabel>
        <button type="button" className="btn btn-primary w-full sm:w-auto sm:self-start" disabled={busy || key.trim().length < 20} onClick={() => void add()}>
          {busy ? <Spinner /> : <KeyRound size={16} strokeWidth={1.7} />} {busy ? 'Füge hinzu…' : 'Hinzufügen'}
        </button>
      </div>
    </Dialog>
  );
}

function RelaySetupDialog({ onClose }: { onClose: () => void }) {
  const { showToast } = useToast();
  const [name, setName] = useState('vps');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(4100);
  const [publicPort, setPublicPort] = useState(true);
  const [viaProxy, setViaProxy] = useState(false);
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const res = await adminApi.createRelayCommand({
        origin: window.location.origin, host: host.trim(), port, publicPort, domain: viaProxy ? domain.trim() : '', name: name.trim(),
      });
      setCommand(res.command);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erzeugen fehlgeschlagen', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Relay auf VPS einrichten" subtitle="Für Nodes ohne offene Ports: ein kleiner Dienst auf einem Server mit öffentlicher Adresse." onClose={onClose} width={620}>
      {!command ? (
        <div className="flex flex-col gap-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <FieldLabel label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="field h-12 w-full px-4 text-[14px]" />
            </FieldLabel>
            <FieldLabel label="Port des Relays">
              <input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Math.max(1, Math.min(65535, Number(e.target.value) || 4100)))} className="field h-12 w-full px-4 text-[14px]" />
            </FieldLabel>
          </div>
          <ToggleField checked={publicPort} onChange={setPublicPort} label="Eigener Port öffentlich erreichbar"
            hint="Die Nodes verbinden sich direkt mit dem Relay, z. B. auf Port 4100."
            tip="Der Relay-Server öffnet einen eigenen Port im Internet. Nodes hinter NAT (z. B. im Homelab) halten von sich aus eine Verbindung dorthin offen; die anderen Nodes erreichen sie dann über diesen Port." />
          {publicPort && (
            <FieldLabel label="Öffentliche Adresse des VPS" hint="Name oder IPv4, unter der die Nodes den VPS erreichen.">
              <input value={host} onChange={(e) => setHost(e.target.value)} spellCheck={false} autoCapitalize="off" className="field h-12 w-full px-4 font-mono text-[13.5px]" placeholder="vps.example.org" />
            </FieldLabel>
          )}
          <ToggleField checked={viaProxy} onChange={setViaProxy} label="Zusätzlich über 443 durch meinen Proxy"
            hint="Dein Proxy erkennt Cluster-Verkehr am Namen (SNI) und reicht ihn durch."
            tip="Praktisch, wenn nur 443 offen sein darf: Dein Proxy auf dem VPS (nginx, Caddy, Traefik, eigener) schaut nur auf den Servernamen im ersten Paket und reicht Cluster-Verbindungen unverändert an das Relay weiter. Verschlüsselung und Zertifikate bleiben Ende-zu-Ende." />
          {viaProxy && (
            <FieldLabel label="Cluster-Domain" hint="DNS: *.DOMAIN → VPS. Dein Proxy reicht TLS für *.DOMAIN auf 443 unverändert an das Relay durch.">
              <input value={domain} onChange={(e) => setDomain(e.target.value)} spellCheck={false} autoCapitalize="off" className="field h-12 w-full px-4 font-mono text-[13.5px]" placeholder="cluster.example.org" />
            </FieldLabel>
          )}
          <button type="button" className="btn btn-primary w-full sm:w-auto sm:self-start" disabled={busy || (!publicPort && !viaProxy) || (publicPort && !host.trim()) || (viaProxy && !domain.trim())} onClick={() => void create()}>
            {busy ? <Spinner /> : <Terminal size={16} strokeWidth={1.7} />} {busy ? 'Erzeuge…' : 'Befehl erzeugen'}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-[13.5px] text-ink-2">Auf dem VPS als root ausführen:</p>
          <div className="max-h-[200px] overflow-y-auto rounded-[16px] bg-well p-4 font-mono text-[12px] leading-relaxed text-ink" style={{ wordBreak: 'break-all' }}>{command}</div>
          <button type="button" className="btn btn-primary self-start" onClick={() => void copyText(command, showToast).then((ok) => { if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 2000); } })}>
            {copied ? <Check size={16} strokeWidth={1.8} /> : <Copy size={16} strokeWidth={1.7} />} {copied ? 'Kopiert' : 'Befehl kopieren'}
          </button>
          <Notice tone="sky" icon={KeyRound}>
            Am Ende zeigt das Skript den <strong>Relay-Schlüssel</strong>. Den hier unter „Relay hinzufügen“ einfügen — danach melden sich alle Nodes
            selbst beim Relay an. Der Befehl funktioniert 30 Minuten lang; das Skript ist per SHA-256 geprüft und enthält nichts Geheimes.
          </Notice>
        </div>
      )}
    </Dialog>
  );
}

export function ReachSection({ running }: { running: boolean }) {
  const { showToast } = useToast();
  const [reach, setReach] = useState<ClusterReach | null>(null);
  const [draft, setDraft] = useState<Draft[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyRelay, setBusyRelay] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'add-relay' | 'setup-relay' | { title: string; snippets: ProxySnippets; sni: boolean; path?: boolean } | null>(null);
  // Results of "Weg testen", by address.
  const [tests, setTests] = useState<Record<string, WayTestResult | 'running'>>({});

  const load = useCallback(async () => {
    if (!running) return;
    try {
      const res = await adminApi.getClusterReach();
      setReach(res);
      setDirty((wasDirty) => {
        if (!wasDirty) setDraft(res.entries.map((entry) => ({ ...entry })));
        return wasDirty;
      });
    } catch {
      /* shown again with the next round */
    }
  }, [running]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => { void load(); }, 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  function change(index: number, patch: Partial<Draft>) {
    setDraft((list) => list.map((entry, i) => (i === index ? { ...entry, ...patch, snippets: patch.backend !== undefined || patch.endpoint !== undefined ? null : entry.snippets } : entry)));
    setDirty(true);
  }

  function move(index: number, by: -1 | 1) {
    setDraft((list) => {
      const next = [...list];
      const [item] = next.splice(index, 1);
      next.splice(Math.max(0, Math.min(next.length, index + by)), 0, item!);
      return next;
    });
    setDirty(true);
  }

  function add(kind: ReachKind) {
    // A way without certificate pinning is switched on deliberately.
    setDraft((list) => [...list, { kind, endpoint: '', enabled: kind !== 'proxy-path', backend: '' }]);
    setDirty(true);
  }

  async function testWay(kind: ReachKind, endpoint: string) {
    const key = `${kind} ${endpoint}`;
    setTests((all) => ({ ...all, [key]: 'running' }));
    try {
      const result = await adminApi.testClusterWay(kind, endpoint.trim());
      setTests((all) => ({ ...all, [key]: result }));
    } catch (err) {
      setTests((all) => ({ ...all, [key]: { ok: false, ms: 0, message: err instanceof Error ? err.message : 'Test fehlgeschlagen' } }));
    }
  }

  async function save() {
    setSaving(true);
    try {
      const res = await adminApi.saveClusterReach(draft.map(({ id, kind, endpoint, enabled, backend }) => ({ id, kind, endpoint: endpoint.trim(), enabled, backend: backend.trim() })));
      setReach(res);
      setDraft(res.entries.map((entry) => ({ ...entry })));
      setDirty(false);
      showToast('Gespeichert — die anderen Nodes erfahren es sofort', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Speichern fehlgeschlagen', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function relayAction(relay: ClusterRelay, action: () => Promise<unknown>, done: string) {
    setBusyRelay(relay.pin);
    try {
      await action();
      showToast(done, 'success');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Aktion fehlgeschlagen', 'error');
    } finally {
      setBusyRelay(null);
    }
  }

  if (!running) return null;
  const relays = reach?.relays ?? [];

  return (
    <>
      <FormSection
        icon={Route}
        title={<Explained tip={<>
          Alle Wege, auf denen die anderen Nodes diese erreichen — der Reihe nach probiert, bis einer klappt. <b>Direkt</b>: öffentliche IP
          oder VPN-Adresse (WireGuard/Tailscale) mit Port 4100. <b>Proxy · eigener Port</b>: dein VPS reicht einen Port unverändert durch.
          <b>Proxy · 443 (SNI)</b>: dein VPS-Proxy erkennt Cluster-Verkehr am Namen und reicht ihn durch, alles andere geht an deine Websites.
          Jeder dieser Wege endet an dem gepinnten Zertifikat dieser Node — ein Proxy sieht nur verschlüsselte Bytes.<br /><br />
          <b>Proxy · API-Pfad</b> (schaltbar, standardmäßig aus): über die öffentliche Adresse deiner API, z. B. api.example.org/cluster-node/name — dein
          Proxy beendet dort TLS wie für die API und reicht den Pfad an den Cluster-Eingang dieser Node weiter. Die Nachrichten bleiben
          Ende-zu-Ende verschlüsselt und gegenseitig authentifiziert, nur das Zertifikats-Pinning fehlt. Deshalb nehmen die anderen Nodes
          diesen Weg nur, wenn alle gepinnten Wege ausfallen.
        </>}>Erreichbarkeit dieser Node</Explained>}
        hint="Wie die anderen Nodes diese erreichen — in dieser Reihenfolge probiert, bei Ausfall automatisch der nächste Weg. Egal welcher Weg: Ende-zu-Ende geschützt durch die gepinnten Zertifikate; Proxy und Relay sehen nur verschlüsselte Bytes."
      >
        {!reach ? (
          <div className="shimmer h-24 max-w-[720px] rounded-[18px]" />
        ) : (
          <div className="flex max-w-[720px] flex-col gap-5">
            {reach.port === 0 && (
              <Notice tone="amber" icon={AlertTriangle}>Der gesicherte Kanal ist aus — setze CLUSTER_MTLS_PORT (z. B. 4100) in der .env.</Notice>
            )}
            {reach.envInvalid.length > 0 && (
              <Notice tone="rose" icon={AlertTriangle}>Unbrauchbar in CLUSTER_MTLS_ENDPOINTS: {reach.envInvalid.join(', ')}</Notice>
            )}

            <div>
              <div className="mb-2 text-[13px] text-ink-3">Wirksam, in dieser Reihenfolge</div>
              {reach.effective.length === 0 ? (
                <div className="text-[13.5px] text-amber-deep">Noch kein Weg — füge unten einen hinzu oder ein Relay.</div>
              ) : (
                <ol className="flex flex-col gap-1.5">
                  {reach.effective.map((way, index) => {
                    const kind = describeWay(way, relays);
                    return (
                      <li key={way} className="flex flex-wrap items-center gap-2 text-[13px]">
                        <span className="tabular w-5 text-ink-3">{index + 1}.</span>
                        <Tag tone={kind.tone}>{kind.label}</Tag>
                        <span className="min-w-0 break-all font-mono text-[12.5px] text-ink-2">{way}</span>
                        {reach.env.includes(way) && <Tag>aus .env</Tag>}
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>

            {(reach.pathWays.length > 0 || reach.pathEnvInvalid.length > 0) && (
              <div>
                <div className="mb-2 flex items-center gap-1.5 text-[13px] text-ink-3">
                  Über deinen Web-Proxy (nur wenn alle Wege oben ausfallen)
                  <InfoTip>Diese Wege bieten die anderen Nodes erst an, wenn kein gepinnter Weg mehr funktioniert. Sie kommen am Cluster-Eingang des API-Ports an ({reach.pathEntry.apiPort ? `Port ${reach.pathEntry.apiPortNumber}, Pfad /cluster` : 'aus — CLUSTER_PUBLIC_PATH=false'}){reach.pathEntry.clusterPort > 0 ? ` oder am eigenen Cluster-Port ${reach.pathEntry.clusterPort}` : ''}.</InfoTip>
                </div>
                {reach.pathEnvInvalid.length > 0 && (
                  <Notice tone="rose" icon={AlertTriangle}>Unbrauchbar in CLUSTER_PATH_ENDPOINTS: {reach.pathEnvInvalid.join(', ')}</Notice>
                )}
                <ol className="flex flex-col gap-1.5">
                  {reach.pathWays.map((way) => (
                    <li key={way} className="flex flex-wrap items-center gap-2 text-[13px]">
                      <Tag tone="amber">Web-Proxy</Tag>
                      <span className="min-w-0 break-all font-mono text-[12.5px] text-ink-2">{way}</span>
                      {reach.pathEnv.includes(way) && <Tag>aus .env</Tag>}
                    </li>
                  ))}
                </ol>
                {!reach.pathEntry.apiPort && reach.pathEntry.clusterPort === 0 && (
                  <div className="mt-2"><Notice tone="amber" icon={AlertTriangle}>Kein Eingang für diesen Weg: CLUSTER_PUBLIC_PATH ist aus und CLUSTER_PORT nicht gesetzt.</Notice></div>
                )}
              </div>
            )}

            <div className="flex flex-col gap-4">
              {draft.map((entry, index) => (
                <div key={entry.id ?? `new-${index}`} className="flex flex-col gap-3 rounded-[18px] bg-well p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <Segmented
                      label="Art"
                      value={entry.kind}
                      onChange={(kind) => change(index, { kind })}
                      options={(Object.keys(KIND_LABEL) as ReachKind[]).map((kind) => ({ value: kind, label: KIND_LABEL[kind] }))}
                    />
                    <div className="flex items-center gap-1.5">
                      <ToggleField checked={entry.enabled} onChange={(enabled) => change(index, { enabled })} label="Aktiv" />
                      <IconButton icon={ArrowUp} label="Nach oben" size={34} disabled={index === 0} onClick={() => move(index, -1)} />
                      <IconButton icon={ArrowDown} label="Nach unten" size={34} disabled={index === draft.length - 1} onClick={() => move(index, 1)} />
                      <IconButton icon={Trash2} tone="rose" label="Entfernen" size={34} onClick={() => { setDraft((list) => list.filter((_, i) => i !== index)); setDirty(true); }} />
                    </div>
                  </div>
                  <FieldLabel label="Adresse" hint={KIND_HINT[entry.kind].endpoint}>
                    <input value={entry.endpoint} onChange={(e) => change(index, { endpoint: e.target.value })} spellCheck={false} autoCapitalize="off"
                      className="field h-11 w-full px-4 font-mono text-[13px]" placeholder={KIND_HINT[entry.kind].placeholder} />
                  </FieldLabel>
                  {entry.kind === 'proxy-path' && (
                    <Notice tone="amber" icon={AlertTriangle}>
                      Ohne Zertifikats-Pinning: Nachrichten bleiben Ende-zu-Ende verschlüsselt und authentifiziert, aber dein Proxy beendet TLS.
                      Die anderen Nodes nehmen diesen Weg nur, wenn alle gepinnten Wege ausfallen. Erst einschalten, wenn „Weg testen“ grün ist.
                    </Notice>
                  )}
                  {entry.kind !== 'direct' && (
                    <FieldLabel
                      label="Ziel hinter dem Proxy (optional)"
                      hint={entry.kind === 'proxy-path'
                        ? `Diese Node, wie dein Proxy sie erreicht — z. B. ihre WireGuard-IP und der API-Port (${reach.pathEntry.apiPortNumber}${reach.pathEntry.clusterPort > 0 ? ` oder der Cluster-Port ${reach.pathEntry.clusterPort}` : ''}). Damit zeigt das Panel die passende Proxy-Konfiguration.`
                        : 'Diese Node, wie der Proxy sie erreicht — z. B. ihre WireGuard-IP und der Cluster-Port. Damit zeigt das Panel die passende Proxy-Konfiguration.'}
                    >
                      <input value={entry.backend} onChange={(e) => change(index, { backend: e.target.value })} spellCheck={false} autoCapitalize="off"
                        className="field h-11 w-full px-4 font-mono text-[13px]" placeholder={BACKEND_PLACEHOLDER[entry.kind]} />
                    </FieldLabel>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className="btn btn-quiet btn-sm" disabled={!entry.endpoint.trim() || tests[`${entry.kind} ${entry.endpoint.trim()}`] === 'running'}
                      onClick={() => void testWay(entry.kind, entry.endpoint)}>
                      {tests[`${entry.kind} ${entry.endpoint.trim()}`] === 'running' ? <Spinner /> : <Stethoscope size={15} strokeWidth={1.7} />} Weg testen
                    </button>
                    <InfoTip>Diese Node verbindet sich selbst über genau diesen Weg (durch Proxy, Relay, VPN …) und prüft, ob sie bei sich ankommt — am eigenen Zertifikat bzw. an einer Antwort, die nur sie geben kann. So siehst du sofort, ob dein Proxy richtig weiterleitet.</InfoTip>
                    {entry.snippets && !dirty && (
                      <button type="button" className="btn btn-quiet btn-sm"
                        onClick={() => setDialog({ title: `Proxy-Konfiguration · ${KIND_LABEL[entry.kind]}`, snippets: entry.snippets!, sni: entry.kind === 'proxy-sni', path: entry.kind === 'proxy-path' })}>
                        <Terminal size={15} strokeWidth={1.7} /> Proxy-Konfiguration anzeigen
                      </button>
                    )}
                  </div>
                  {(() => {
                    const result = tests[`${entry.kind} ${entry.endpoint.trim()}`];
                    if (!result || result === 'running') return null;
                    return (
                      <div className={`text-[12.5px] ${result.ok ? 'text-mint-deep' : 'text-rose-deep'}`}>
                        {result.ok ? '✓' : '✗'} {result.message}{result.ms > 0 ? ` · ${result.ms} ms` : ''}
                      </div>
                    );
                  })()}
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                {(Object.keys(KIND_LABEL) as ReachKind[]).map((kind) => (
                  <button key={kind} type="button" className="btn btn-quiet btn-sm" disabled={draft.length >= 8} onClick={() => add(kind)}>
                    <Plus size={15} strokeWidth={1.8} /> {KIND_LABEL[kind]}
                  </button>
                ))}
              </div>
              {dirty && (
                <div className="flex flex-wrap gap-3">
                  <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
                    {saving ? <Spinner /> : <Save size={16} strokeWidth={1.7} />} {saving ? 'Speichert…' : 'Wege speichern'}
                  </button>
                  <button type="button" className="btn btn-quiet" onClick={() => { setDraft(reach.entries.map((entry) => ({ ...entry }))); setDirty(false); }}>
                    <Undo2 size={16} strokeWidth={1.7} /> Verwerfen
                  </button>
                </div>
              )}
            </div>

            {reach.peers.length > 0 && (
              <div>
                <div className="mb-2 text-[13px] text-ink-3">Gerade benutzte Wege</div>
                <ul className="flex flex-col gap-2 text-[12.5px]">
                  {reach.peers.map((peer) => (
                    <li key={peer.id} className="flex flex-col gap-0.5">
                      <span className="text-[13.5px] text-ink">{peer.name}</span>
                      <span className="break-all font-mono text-ink-3">→ {peer.outgoing ?? 'noch keiner'}</span>
                      <span className="break-all font-mono text-ink-3">← {peer.incoming ?? 'noch keiner'}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </FormSection>

      <FormSection
        icon={Radio}
        title={<Explained tip="Ein Relay ist ein kleiner Dienst auf einem Server mit öffentlicher Adresse (z. B. einem VPS). Nodes ohne offene Ports — etwa daheim hinter dem Router — verbinden sich von selbst dorthin und sind dann über das Relay erreichbar. Das Relay leitet nur verschlüsselte Bytes weiter; es kennt keine Schlüssel und keine Daten.">Relays</Explained>}
        hint="Für Nodes ohne offene Ports (Homelab hinter NAT, ohne VPN): Die Node verbindet sich von sich aus mit dem Relay und ist darüber erreichbar. Kein Leader — ein hier hinzugefügtes Relay gilt automatisch für alle Nodes, jede meldet sich selbst an, und alle anderen Wege bleiben bestehen."
      >
        <div className="flex max-w-[720px] flex-col gap-4">
          {relays.length === 0 ? (
            <div className="text-[13.5px] text-ink-3">Noch kein Relay.</div>
          ) : (
            <ul className="stack">
              {relays.map((relay) => {
                const busy = busyRelay === relay.pin;
                const editable = relay.source === 'panel' && relay.id !== null;
                return (
                  <li key={relay.pin} className="flex flex-col gap-3 py-4">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <span className="text-[15px] font-medium">{relay.name || 'Relay'}</span>
                      {relay.error ? <Status tone="rose">Fehler</Status> : !relay.enabled ? <Status tone="ink">Aus</Status> : relay.parked > 0 ? <Status tone="mint">Verbunden · {relay.parked} bereit</Status> : <Status tone="amber">Verbinde…</Status>}
                      <Tag>{relay.source === 'env' ? 'aus .env (nur diese Node)' : 'alle Nodes'}</Tag>
                    </div>
                    {relay.error && <div className="break-words text-[13px] text-rose-deep">{relay.error}</div>}
                    {relay.route && <div className="font-mono text-[12px] text-ink-3">Name dieser Node am Relay: {relay.route}</div>}
                    <div className="flex flex-wrap gap-x-5 gap-y-2">
                      <ToggleField checked={relay.enabled} disabled={!editable || busy} label="Aktiv"
                        onChange={(enabled) => void relayAction(relay, () => adminApi.updateClusterRelay(relay.id!, { enabled }), enabled ? 'Relay eingeschaltet' : 'Relay ausgeschaltet')} />
                      {relay.ports.length > 0 && (
                        <ToggleField checked={relay.usePorts} disabled={!editable || busy} label={`Über eigenen Port (${relay.ports.map((port) => port.replace('https://', '')).join(', ')})`}
                          tip="Die Nodes verbinden sich über den eigenen Port des Relays."
                          onChange={(usePorts) => void relayAction(relay, () => adminApi.updateClusterRelay(relay.id!, { usePorts }), 'Gespeichert')} />
                      )}
                      {relay.domain && (
                        <ToggleField checked={relay.useSni} disabled={!editable || busy} label={`Über 443 (SNI, *.${relay.domain})`}
                          tip="Die Nodes verbinden sich über Port 443 deines Proxys, der den Verkehr anhand des Namens an das Relay durchreicht."
                          onChange={(useSni) => void relayAction(relay, () => adminApi.updateClusterRelay(relay.id!, { useSni }), 'Gespeichert')} />
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {relay.snippets && (
                        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setDialog({ title: `Proxy-Konfiguration · Relay ${relay.name}`, snippets: relay.snippets!, sni: true })}>
                          <Terminal size={15} strokeWidth={1.7} /> Proxy-Konfiguration für 443
                        </button>
                      )}
                      {editable && (
                        <IconButton icon={Trash2} tone="rose" label="Relay entfernen" disabled={busy}
                          onClick={() => {
                            if (!window.confirm(`Relay "${relay.name}" für alle Nodes entfernen? Nodes, die nur darüber erreichbar sind, sind danach nicht mehr erreichbar.`)) return;
                            void relayAction(relay, () => adminApi.removeClusterRelay(relay.id!), 'Relay entfernt');
                          }} />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setDialog('add-relay')}>
              <KeyRound size={15} strokeWidth={1.7} /> Relay hinzufügen
            </button>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => setDialog('setup-relay')}>
              <Terminal size={15} strokeWidth={1.7} /> Relay auf VPS einrichten
            </button>
          </div>
        </div>
      </FormSection>

      {dialog === 'add-relay' && <AddRelayDialog onClose={() => setDialog(null)} onAdded={() => void load()} />}
      {dialog === 'setup-relay' && <RelaySetupDialog onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === 'object' && <SnippetsDialog title={dialog.title} snippets={dialog.snippets} sni={dialog.sni} path={dialog.path} onClose={() => setDialog(null)} />}
    </>
  );
}
