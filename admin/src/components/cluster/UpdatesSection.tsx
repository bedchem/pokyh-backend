import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, GitBranch, RefreshCw, Rocket, RotateCcw, Save, Undo2 } from 'lucide-react';
import { adminApi } from '../../api';
import { useToast } from '../Toast';
import { FieldLabel, FormSection, Notice, Spinner, Status, Tag, type Tone } from '../kit';
import type { ClusterUpdateNodeState, ClusterUpdates } from '../../types';
import { Explained, InfoTip, ToggleField } from './explain';

// Updates of the whole cluster: where they come from, the rollout order and
// this node's own state. Settings apply to every node; retry and roll back
// act on the node whose panel is open.

const short = (commit: string | null | undefined) => (commit ? commit.slice(0, 7) : '—');

const NODE_STATE: Record<ClusterUpdateNodeState, { label: string; tone: Tone }> = {
  done: { label: 'aktuell', tone: 'mint' },
  updating: { label: 'aktualisiert gerade', tone: 'sky' },
  next: { label: 'ist dran', tone: 'sky' },
  waiting: { label: 'wartet', tone: 'ink' },
  failed: { label: 'fehlgeschlagen', tone: 'rose' },
  manual: { label: 'manuell (z. B. Dokploy)', tone: 'amber' },
  skipped: { label: 'offline, übersprungen', tone: 'amber' },
};

const LOCAL_STATE: Record<ClusterUpdates['self']['state'], string> = {
  idle: 'bereit',
  fetching: 'holt die neue Version von einer anderen Node',
  requested: 'Updater beauftragt',
  preparing: 'lädt die neue Version',
  building: 'baut die neue Version',
  starting: 'startet die neue Version neben der laufenden',
  switching: 'schaltet um',
  done: 'fertig',
  failed: 'fehlgeschlagen',
};

const CI_LABEL: Record<NonNullable<ClusterUpdates['upstream']['ci']>['state'], { label: string; tone: Tone }> = {
  success: { label: 'Checks bestanden', tone: 'mint' },
  pending: { label: 'Checks laufen', tone: 'sky' },
  failure: { label: 'Checks fehlgeschlagen', tone: 'rose' },
  none: { label: 'keine Checks', tone: 'amber' },
  unsupported: { label: 'Checks nicht prüfbar', tone: 'amber' },
  error: { label: 'GitHub nicht erreichbar', tone: 'amber' },
};

// The backend explains in English; the panel says it in German.
function decisionText(data: ClusterUpdates): string {
  const decision = data.decision!;
  const label = (state: ClusterUpdateNodeState) => {
    const entry = decision.order.find((item) => item.state === state && item.id !== data.self.nodeId);
    return entry ? entry.name || entry.id.slice(0, 8) : 'einer anderen Node';
  };
  switch (decision.action) {
    case 'none': return data.self.state === 'idle' || data.self.state === 'done' ? 'Diese Node ist aktuell.' : 'Diese Node aktualisiert gerade.';
    case 'update': return 'Diese Node ist jetzt dran.';
    case 'wait': return `Wartet auf ${decision.order.some((item) => item.state === 'updating') ? label('updating') : label('next')}.`;
    case 'blocked': return `Das Update ist auf ${label('failed')} fehlgeschlagen — die Reihenfolge stoppt dort.`;
    case 'manual': return 'Diese Node wird nicht von Pokyh aktualisiert — dort aktualisieren, wo sie läuft (z. B. Dokploy).';
    case 'failed': return 'Das Update ist auf dieser Node fehlgeschlagen — die Reihenfolge wartet auf dich.';
    default: return decision.reason;
  }
}

function targetText(data: ClusterUpdates): string {
  const why = data.targetWhy;
  if (why.startsWith('no repository')) return 'Kein Repository eingestellt — keine automatischen Updates.';
  if (why.startsWith('the branch has not')) return 'Der Branch wurde noch nicht abgefragt.';
  if (why.startsWith('waiting for the checks')) return 'Wartet auf die Checks auf GitHub.';
  if (why.startsWith('checks:')) return `Checks nicht bestanden oder noch offen (${why.slice(8)}).`;
  if (why.startsWith('a new version is ready')) return 'Eine neue Version ist bereit und wartet auf deine Freigabe.';
  return why;
}

export function UpdatesSection({ running }: { running: boolean }) {
  const { showToast } = useToast();
  const [data, setData] = useState<ClusterUpdates | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [auto, setAuto] = useState(true);
  const [requireCi, setRequireCi] = useState(true);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await adminApi.getClusterUpdates();
      setData(res);
      setError(null);
      if (!dirty) {
        setRepo(res.settings.repo);
        setBranch(res.settings.branch);
        setAuto(res.settings.auto);
        setRequireCi(res.settings.requireCi);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Laden fehlgeschlagen');
    }
  }, [dirty]);

  useEffect(() => {
    if (!running) return;
    void load();
    const timer = window.setInterval(() => void load(), 8000);
    return () => window.clearInterval(timer);
  }, [load, running]);

  async function act(key: string, action: () => Promise<unknown>, done: string) {
    setBusy(key);
    try {
      await action();
      showToast(done, 'success');
      setDirty(false);
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Fehlgeschlagen', 'error');
    } finally {
      setBusy(null);
    }
  }

  const edit = <T,>(setter: (value: T) => void) => (value: T) => { setter(value); setDirty(true); };

  if (!running) return null;
  const self = data?.self;
  const newer = data?.upstream.commit && self?.commit && data.upstream.commit !== self.commit;
  const waitingForRelease = data && !data.settings.auto && data.upstream.commit && data.settings.approvedCommit !== data.upstream.commit && newer;

  return (
    <FormSection
      icon={Rocket}
      title={<Explained tip={<>
        Neue Versionen kommen aus deinem Git-Repository. Jede Node schaut selbst nach, ob es auf dem Branch etwas Neues gibt (und ob die
        Checks auf GitHub grün sind). Dann aktualisieren sich die Nodes <b>nacheinander</b> — es gibt keinen Leader: alle rechnen dieselbe
        Reihenfolge aus. Jede Node startet die neue Version neben der laufenden und schaltet erst um, wenn sie gesund ist; die App ist
        dabei nie weg. Geht etwas schief, bleibt die Node auf der alten Version und die Reihenfolge stoppt dort. Funktioniert auch mit nur einer Node.
      </>}>Updates</Explained>}
      hint="Automatisch, Node für Node, ohne Ausfall. Einstellungen gelten für alle Nodes."
    >
      {!data ? (
        error ? <Notice tone="amber" icon={AlertTriangle}>{error}</Notice> : <div className="shimmer h-24 max-w-[620px] rounded-[18px]" />
      ) : (
        <div className="flex max-w-[620px] flex-col gap-6">
          <div className="stack">
            <div className="flex flex-wrap items-center justify-between gap-3 py-3">
              <span className="flex items-center gap-1.5 text-[14px] text-ink-2">
                Diese Node läuft auf
                <InfoTip>Der Git-Commit, aus dem diese Node gebaut wurde{self?.builtAt ? ` (gebaut am ${new Date(self.builtAt).toLocaleString('de-DE')})` : ''}. „—“ heißt: unbekannt, z. B. bei einem lokalen Build ohne Git.</InfoTip>
              </span>
              <span className="flex items-center gap-2">
                <span className="font-mono text-[13px]">{short(self?.commit)}</span>
                {self?.color && <Tag>{self.color === 'blue' ? 'blau' : 'grün'}</Tag>}
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 py-3">
              <span className="flex items-center gap-1.5 text-[14px] text-ink-2">
                Neueste Version auf {data.settings.branch}
                <InfoTip>Der letzte Commit auf dem Branch, alle {data.defaults.pollMinutes} Minute(n) neu abgefragt. {data.settings.requireCi ? 'Ausgerollt wird nur, wenn alle Checks auf GitHub bestanden sind.' : 'Checks werden nicht verlangt.'}</InfoTip>
              </span>
              <span className="flex flex-wrap items-center justify-end gap-2">
                <span className="font-mono text-[13px]">{short(data.upstream.commit)}</span>
                {data.settings.requireCi && data.upstream.ci && data.upstream.ci.commit === data.upstream.commit && (
                  <Status tone={CI_LABEL[data.upstream.ci.state].tone}>{CI_LABEL[data.upstream.ci.state].label}</Status>
                )}
                {data.upstream.commit && data.upstream.commit === self?.commit && <Status tone="mint">aktuell</Status>}
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 py-3">
              <span className="flex items-center gap-1.5 text-[14px] text-ink-2">
                Updater auf diesem Server
                <InfoTip>Der Pokyh-Updater ist ein kleiner Dienst neben der App, der als Einziger Docker steuern darf. Server, die mit dem Einzeiler eingerichtet wurden, haben ihn. Läuft eine Node anders (z. B. über Dokploy), wird sie dort aktualisiert und hier in der Reihenfolge übersprungen.</InfoTip>
              </span>
              {self?.selfUpdating ? <Status tone="mint">läuft</Status> : <Status tone="amber">keiner — manuell aktualisieren</Status>}
            </div>
            {self && self.state !== 'idle' && (
              <div className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span className="text-[14px] text-ink-2">Stand</span>
                <span className={`text-right text-[13px] ${self.state === 'failed' ? 'text-rose-deep' : 'text-ink-2'}`}>{LOCAL_STATE[self.state]}{self.message ? ` — ${self.message}` : ''}</span>
              </div>
            )}
          </div>

          {data.upstream.error && <Notice tone="amber" icon={AlertTriangle}>{data.upstream.error}</Notice>}
          {self?.failed && (
            <Notice tone="rose" icon={AlertTriangle}>
              Das Update auf <span className="font-mono">{short(self.failed)}</span> ist auf dieser Node fehlgeschlagen{self.failedMessage ? `: ${self.failedMessage}` : ''}.
              Sie läuft weiter auf der bisherigen Version; die nächsten Nodes warten. Behebe die Ursache und versuche es erneut.
              <div className="mt-3">
                <button type="button" className="btn btn-quiet btn-sm" disabled={busy !== null} onClick={() => void act('retry', () => adminApi.retryClusterUpdate(), 'Wird erneut versucht')}>
                  {busy === 'retry' ? <Spinner /> : <RotateCcw size={15} strokeWidth={1.7} />} Erneut versuchen
                </button>
              </div>
            </Notice>
          )}
          {waitingForRelease && (
            <Notice tone="sky" icon={Rocket}>
              Version <span className="font-mono">{short(data.upstream.commit)}</span> ist bereit. Automatische Updates sind aus — gib sie frei, dann aktualisieren sich alle Nodes nacheinander.
              <div className="mt-3">
                <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void act('release', () => adminApi.releaseClusterUpdate(data.upstream.commit!), 'Freigegeben — die Nodes aktualisieren sich nacheinander')}>
                  {busy === 'release' ? <Spinner /> : <Rocket size={15} strokeWidth={1.7} />} Jetzt ausrollen
                </button>
              </div>
            </Notice>
          )}

          {data.decision && data.decision.order.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="flex items-center gap-1.5 text-[13px] text-ink-2">
                Reihenfolge für <span className="font-mono">{short(data.target)}</span>
                <InfoTip>Jede Node rechnet diese Reihenfolge selbst aus (aus Version und Node-ID) — alle kommen aufs selbe Ergebnis, ohne dass jemand bestimmt. Eine Node ist dran, wenn alle davor aktuell sind, nicht von Pokyh aktualisiert werden oder länger als {data.defaults.skipOfflineMinutes} Minuten offline sind.</InfoTip>
              </span>
              <ol className="flex flex-col gap-1.5">
                {data.decision.order.map((entry, index) => (
                  <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px]">
                    <span className="tabular w-5 text-ink-3">{index + 1}.</span>
                    <span className="min-w-0 font-medium">{entry.name || entry.id.slice(0, 8)}{entry.id === self?.nodeId ? ' (diese)' : ''}</span>
                    <Status tone={NODE_STATE[entry.state].tone}>{NODE_STATE[entry.state].label}</Status>
                  </li>
                ))}
              </ol>
              <span className="text-[12.5px] text-ink-3">{decisionText(data)}</span>
            </div>
          )}
          {!data.decision && data.targetWhy && <span className="text-[12.5px] text-ink-3">{targetText(data)}</span>}

          <div className="flex flex-col gap-4 rounded-[18px] bg-well p-4">
            <FieldLabel
              label={<Explained tip="Die https-Adresse deines Git-Repositorys, z. B. https://github.com/bedchem/pokyh-backend. Öffentliche Repositories brauchen keinen Zugang. Leer: keine automatischen Updates.">Repository</Explained>}
            >
              <input value={repo} onChange={(e) => edit(setRepo)(e.target.value)} spellCheck={false} autoCapitalize="off"
                className="field h-11 w-full px-4 font-mono text-[13px]" placeholder="https://github.com/owner/name" />
            </FieldLabel>
            <FieldLabel label={<Explained tip="Der Branch, dessen neuester Stand ausgerollt wird — meist main.">Branch</Explained>}>
              <input value={branch} onChange={(e) => edit(setBranch)(e.target.value)} spellCheck={false} autoCapitalize="off"
                className="field h-11 w-full px-4 font-mono text-[13px]" placeholder="main" />
            </FieldLabel>
            <ToggleField
              checked={auto}
              onChange={edit(setAuto)}
              label="Automatisch ausrollen"
              hint={auto ? 'Neue Versionen gehen ohne Zutun raus.' : 'Neue Versionen warten auf „Jetzt ausrollen“.'}
              tip="An: Sobald eine neue Version da ist (und die Checks grün sind), aktualisieren sich die Nodes nacheinander von selbst. Aus: Die neue Version wird hier angezeigt und erst ausgerollt, wenn du sie freigibst."
            />
            <ToggleField
              checked={requireCi}
              onChange={edit(setRequireCi)}
              label="Nur mit bestandenen Checks"
              hint="Nur für Repositories auf github.com."
              tip="Ausgerollt wird nur ein Commit, dessen GitHub-Checks (z. B. Actions: Build und Tests) alle bestanden sind. So kommt kein kaputter Stand auf deine Server. Für andere Git-Hosts ausschalten."
            />
            <div className="flex flex-wrap items-center gap-2.5">
              <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || busy !== null}
                onClick={() => void act('save', () => adminApi.saveClusterUpdateSettings({ repo: repo.trim(), branch: branch.trim(), auto, requireCi }), 'Gespeichert — gilt für alle Nodes')}>
                {busy === 'save' ? <Spinner /> : <Save size={15} strokeWidth={1.7} />} Speichern
              </button>
              {dirty && (
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => { setDirty(false); setRepo(data.settings.repo); setBranch(data.settings.branch); setAuto(data.settings.auto); setRequireCi(data.settings.requireCi); }}>
                  <Undo2 size={15} strokeWidth={1.7} /> Verwerfen
                </button>
              )}
              <span className="text-[12px] text-ink-3">
                {data.settings.source === 'env' ? 'derzeit aus der .env (CLUSTER_UPDATE_*)' : `zuletzt geändert von ${data.settings.updatedBy ?? '—'}`}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2.5">
            <button type="button" className="btn btn-quiet btn-sm" disabled={busy !== null || !data.settings.repo}
              onClick={() => void act('check', async () => setData(await adminApi.checkClusterUpdates()), 'Nachgesehen')}>
              {busy === 'check' ? <Spinner /> : <RefreshCw size={15} strokeWidth={1.7} />} Jetzt nachsehen
            </button>
            {self?.canRollBack && (
              <span className="inline-flex items-center gap-1.5">
                <button type="button" className="btn btn-quiet btn-sm" disabled={busy !== null}
                  onClick={() => {
                    if (!window.confirm('Diese Node auf ihre vorherige Version zurücksetzen? Sie wird danach nicht automatisch wieder aktualisiert, bis du „Erneut versuchen“ wählst.')) return;
                    void act('rollback', () => adminApi.rollBackClusterNode(), 'Wird auf die vorherige Version zurückgesetzt');
                  }}>
                  {busy === 'rollback' ? <Spinner /> : <RotateCcw size={15} strokeWidth={1.7} />} Auf vorherige Version zurück
                </button>
                <InfoTip>Startet die vorherige Version dieser Node wieder (sie ist noch vorhanden) und schaltet ohne Ausfall um. Nur diese Node; die Reihenfolge der anderen hält an, bis du „Erneut versuchen“ wählst.</InfoTip>
              </span>
            )}
            {data.upstream.checkedAt && (
              <span className="flex items-center gap-1.5 text-[12px] text-ink-3"><GitBranch size={13} strokeWidth={1.7} /> zuletzt nachgesehen {new Date(data.upstream.checkedAt).toLocaleTimeString('de-DE')}</span>
            )}
            {!newer && data.upstream.commit && <span className="flex items-center gap-1.5 text-[12px] text-mint-deep"><CheckCircle2 size={13} strokeWidth={1.7} /> auf dem neuesten Stand</span>}
          </div>
        </div>
      )}
    </FormSection>
  );
}
