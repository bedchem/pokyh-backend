import { useCallback, useEffect, useRef, useState } from 'react';
import { History, RefreshCw } from 'lucide-react';
import { adminApi } from '../api';
import { useAccess } from '../access';
import { useLive } from '../live';
import { useToast } from '../components/Toast';
import { Avatar, Empty, IconButton, PageHeader, Pager, SearchField, Section, Spinner, Tag, useTableLabels, type Tone } from '../components/kit';
import { dateTime } from '../components/format';
import type { AuditEvent } from '../types';

// The admin audit trail: who changed what, in which school, when — every
// sensitive change, and every sign-in to the panel (the access record the
// Garante asks for). A school's view shows that school's events only.

const ACTIONS: Record<string, { label: string; tone: Tone }> = {
  'admin.login': { label: 'Anmeldung', tone: 'ink' },
  'admin.appoint': { label: 'Admin ernannt', tone: 'violet' },
  'admin.revoke': { label: 'Admin entzogen', tone: 'rose' },
  'admin.grant.set': { label: 'Rechte geändert', tone: 'violet' },
  'admin.grant.remove': { label: 'Rechte entzogen', tone: 'rose' },
  'user.create': { label: 'Konto angelegt', tone: 'mint' },
  'user.delete': { label: 'Konto gelöscht', tone: 'rose' },
  'user.role': { label: 'Rolle geändert', tone: 'amber' },
  'user.password': { label: 'Passwort gesetzt', tone: 'amber' },
  'sessions.revoke': { label: 'Sitzung beendet', tone: 'amber' },
  'sessions.revoke_all': { label: 'Alle Sitzungen beendet', tone: 'rose' },
  'class.create': { label: 'Klasse angelegt', tone: 'mint' },
  'class.delete': { label: 'Klasse gelöscht', tone: 'rose' },
  'reminder.delete': { label: 'Erinnerung gelöscht', tone: 'rose' },
  'comment.delete': { label: 'Kommentar gelöscht', tone: 'rose' },
  'rating.update': { label: 'Bewertung geändert', tone: 'amber' },
  'rating.delete': { label: 'Bewertung gelöscht', tone: 'rose' },
  'mensa.import': { label: 'Speiseplan importiert', tone: 'sky' },
  'mensa.reset': { label: 'Speiseplan zurückgesetzt', tone: 'rose' },
  'mensa.dish.delete': { label: 'Gericht gelöscht', tone: 'rose' },
  'popup.create': { label: 'Popup erstellt', tone: 'mint' },
  'popup.update': { label: 'Popup geändert', tone: 'amber' },
  'popup.delete': { label: 'Popup gelöscht', tone: 'rose' },
  'school.create': { label: 'Schule angelegt', tone: 'mint' },
  'school.join': { label: 'Schule neu dabei (WebUntis)', tone: 'mint' },
  'school.update': { label: 'Schule geändert', tone: 'amber' },
  'school.menu': { label: 'Mensaplan zugewiesen', tone: 'sky' },
  'menu.create': { label: 'Mensaplan angelegt', tone: 'mint' },
  'menu.rename': { label: 'Mensaplan umbenannt', tone: 'amber' },
  'menu.delete': { label: 'Mensaplan gelöscht', tone: 'rose' },
};

function describe(e: AuditEvent): string {
  const d = e.detail as Record<string, unknown>;
  const parts: string[] = [];
  if (Array.isArray(d['added']) && d['added'].length) parts.push(`+ ${(d['added'] as string[]).join(', ')}`);
  if (Array.isArray(d['removed']) && d['removed'].length) parts.push(`− ${(d['removed'] as string[]).join(', ')}`);
  for (const key of ['method', 'preset', 'name', 'from', 'to', 'plan', 'imported', 'updated', 'title']) {
    if (d[key] !== undefined && d[key] !== null && d[key] !== '') parts.push(`${key}: ${String(d[key])}`);
  }
  return parts.join(' · ');
}

export function AuditPage() {
  const { view } = useAccess();
  const { showToast } = useToast();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [total, setTotal] = useState(0);
  const [retention, setRetention] = useState(365);
  const [page, setPage] = useState(1);
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [debounced, setDebounced] = useState('');
  const [loading, setLoading] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  useTableLabels(ref);
  const limit = 50;

  useEffect(() => {
    const t = window.setTimeout(() => { setDebounced(actor.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(t);
  }, [actor]);
  useEffect(() => { setPage(1); }, [action]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.auditEvents({ page, limit, actor: debounced || undefined, action: action || undefined });
      setEvents(res.events);
      setTotal(res.total);
      setRetention(res.retentionDays);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Protokoll konnte nicht geladen werden', 'error');
    } finally {
      setLoading(false);
    }
  }, [page, debounced, action, showToast]);

  useEffect(() => { void load(); }, [load]);
  useLive(['access', 'users', 'schools'], () => { if (page === 1) void load(); }, 4000);

  return (
    <div>
      <PageHeader
        title="Admin-Protokoll"
        subtitle={`Wer wann was geändert hat${view?.kind === 'school' ? ` in ${view.school.name}` : ''} — und jede Anmeldung im Panel. Ohne Passwörter, Tokens oder Inhalte; ${retention} Tage aufbewahrt.`}
      >
        <IconButton icon={RefreshCw} label="Aktualisieren" size={42} busy={loading} onClick={() => void load()} />
      </PageHeader>

      <Section
        className="mt-10"
        title="Ereignisse"
        meta={`${total.toLocaleString('de-AT')}`}
        action={(
          <>
            <SearchField value={actor} onChange={setActor} placeholder="Admin" className="w-full sm:w-[200px]" />
            <select className="field h-11 px-4 text-[14px]" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Art">
              <option value="">Alle Arten</option>
              <option value="admin.login">Anmeldungen</option>
              <option value="admin.">Admins & Rechte</option>
              <option value="user.">Konten</option>
              <option value="comment.">Kommentare</option>
              <option value="rating.">Bewertungen</option>
              <option value="mensa.">Speiseplan</option>
              <option value="school">Schulen</option>
              <option value="menu.">Mensapläne</option>
              <option value="popup.">Popups</option>
              <option value="sessions.">Sitzungen</option>
              <option value="class.">Klassen</option>
            </select>
          </>
        )}
      >
        {!events ? (
          <div className="mt-8"><Spinner /></div>
        ) : events.length === 0 ? (
          <Empty icon={History}>Keine Einträge.</Empty>
        ) : (
          <div ref={ref} className="tbl-scroll mt-6">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Zeit</th>
                  <th>Admin</th>
                  <th>Aktion</th>
                  <th className="hidden md:table-cell">Was</th>
                  {view?.kind === 'global' && <th className="hidden lg:table-cell">Schule</th>}
                </tr>
              </thead>
              <tbody>
                {events.map((e) => {
                  const a = ACTIONS[e.action] ?? { label: e.action, tone: 'ink' as Tone };
                  return (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap text-ink-2">{dateTime(e.at)}</td>
                      <td><div className="flex items-center gap-3"><Avatar name={e.actor} size={30} /><span className="truncate">{e.actor}</span></div></td>
                      <td><Tag tone={a.tone}>{a.label}</Tag></td>
                      <td className="hidden md:table-cell">
                        <div className="truncate text-[13.5px]">{e.targetType}{e.targetId ? ` · ${e.targetId}` : ''}</div>
                        <div className="truncate text-[12.5px] text-ink-3">{describe(e)}</div>
                      </td>
                      {view?.kind === 'global' && <td className="hidden text-ink-2 lg:table-cell">{e.schoolName ?? '–'}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} pages={Math.ceil(total / limit)} onChange={setPage} />
      </Section>
    </div>
  );
}
