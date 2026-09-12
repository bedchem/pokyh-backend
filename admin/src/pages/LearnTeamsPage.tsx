import { useCallback, useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Edit3,
  GraduationCap,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import type { AdminLearnTeam, AdminLearnTeamMember, LearnTeamAssignableRole } from '../types';

const inputStyle: CSSProperties = {
  background: '#1c1c1e',
  border: '1px solid rgba(255,255,255,0.08)',
  color: 'rgba(235,235,245,0.88)',
};

const mutedText: CSSProperties = { color: 'rgba(235,235,245,0.45)' };

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' });
}

function roleLabel(role: AdminLearnTeamMember['role']): string {
  switch (role) {
    case 'OWNER': return 'Eigentümer';
    case 'MANAGER': return 'Verwalter';
    default: return 'Mitglied';
  }
}

function roleColor(role: AdminLearnTeamMember['role']): string {
  switch (role) {
    case 'OWNER': return '#bf5af2';
    case 'MANAGER': return '#0a84ff';
    default: return '#30d158';
  }
}

function Card({ children, title, icon }: { children: ReactNode; title: string; icon: ReactNode }) {
  return (
    <section className="rounded-[16px] p-5" style={{ background: '#0d0d0d', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="flex items-center gap-2.5 mb-4">
        <span style={{ color: '#0a84ff' }}>{icon}</span>
        <h2 className="text-[15px] font-semibold text-white tracking-[-0.01em]">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function TeamCard({
  team,
  onChanged,
  onDeleted,
  onRefreshed,
}: {
  team: AdminLearnTeam;
  onChanged: (team: AdminLearnTeam) => void;
  onDeleted: (teamId: string) => void;
  onRefreshed: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description);
  const [savingDetails, setSavingDetails] = useState(false);
  const [userId, setUserId] = useState('');
  const [memberRole, setMemberRole] = useState<LearnTeamAssignableRole>('MEMBER');
  const [savingMember, setSavingMember] = useState(false);
  const [changingMemberId, setChangingMemberId] = useState<string | null>(null);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);

  function cancelEdit() {
    setName(team.name);
    setDescription(team.description);
    setEditing(false);
  }

  async function handleDetailsSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = name.trim();
    const nextDescription = description.trim();
    if (!nextName) return;

    const payload: { name?: string; description?: string } = {};
    if (nextName !== team.name) payload.name = nextName;
    if (nextDescription !== team.description) payload.description = nextDescription;
    if (Object.keys(payload).length === 0) {
      setEditing(false);
      return;
    }

    setSavingDetails(true);
    try {
      const result = await adminApi.updateLearnTeam(team.id, payload);
      onChanged(result.team);
      setName(result.team.name);
      setDescription(result.team.description);
      setEditing(false);
      showToast('Gruppe aktualisiert', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Gruppe konnte nicht aktualisiert werden', 'error');
    } finally {
      setSavingDetails(false);
    }
  }

  async function handleMemberSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const identifier = userId.trim();
    if (!identifier) return;

    setSavingMember(true);
    try {
      await adminApi.saveLearnTeamMember(team.id, { userId: identifier, role: memberRole });
      setUserId('');
      setMemberRole('MEMBER');
      await onRefreshed();
      showToast('Gruppenzugriff gespeichert', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Zugriff konnte nicht gespeichert werden', 'error');
    } finally {
      setSavingMember(false);
    }
  }

  async function handleMemberRoleChange(member: AdminLearnTeamMember, nextRole: LearnTeamAssignableRole) {
    setChangingMemberId(member.stableUid);
    try {
      await adminApi.saveLearnTeamMember(team.id, { userId: member.stableUid, role: nextRole });
      await onRefreshed();
      showToast(`Rolle für ${member.user?.username ?? 'Mitglied'} aktualisiert`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Rolle konnte nicht aktualisiert werden', 'error');
    } finally {
      setChangingMemberId(null);
    }
  }

  async function handleMemberRemoval(member: AdminLearnTeamMember) {
    const memberName = member.user?.username ?? member.stableUid;
    if (!window.confirm(`Mitglied „${memberName}“ wirklich aus „${team.name}“ entfernen?`)) return;

    setRemovingMemberId(member.stableUid);
    try {
      await adminApi.removeLearnTeamMember(team.id, member.stableUid);
      await onRefreshed();
      showToast('Mitglied entfernt', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Mitglied konnte nicht entfernt werden', 'error');
    } finally {
      setRemovingMemberId(null);
    }
  }

  async function handleTeamDelete() {
    if (deleteConfirmation !== team.name || team.courseCount > 0) return;
    setDeleting(true);
    try {
      await adminApi.deleteLearnTeam(team.id, deleteConfirmation);
      onDeleted(team.id);
      showToast('Gruppe gelöscht', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Gruppe konnte nicht gelöscht werden', 'error');
    } finally {
      setDeleting(false);
    }
  }

  const canDelete = team.courseCount === 0;

  return (
    <section className="rounded-[16px] overflow-hidden" style={{ background: '#0d0d0d', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            {editing ? (
              <form onSubmit={(event) => void handleDetailsSave(event)} className="flex flex-col gap-3">
                <div>
                  <label htmlFor={`team-name-${team.id}`} className="block text-[12px] mb-1" style={mutedText}>Gruppenname</label>
                  <input
                    id={`team-name-${team.id}`}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={120}
                    required
                    className="apple-input w-full px-3 py-2 text-[13px]"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label htmlFor={`team-description-${team.id}`} className="block text-[12px] mb-1" style={mutedText}>Beschreibung</label>
                  <textarea
                    id={`team-description-${team.id}`}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    maxLength={1000}
                    rows={3}
                    className="apple-input w-full px-3 py-2 text-[13px] resize-y"
                    style={inputStyle}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button type="submit" disabled={savingDetails || !name.trim()} className="apple-btn flex items-center gap-1.5 px-3 py-2 text-[12px] disabled:opacity-50">
                    {savingDetails ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Speichern
                  </button>
                  <button type="button" onClick={cancelEdit} disabled={savingDetails} className="apple-btn-ghost px-3 py-2 text-[12px] disabled:opacity-50">
                    Abbrechen
                  </button>
                </div>
              </form>
            ) : (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-[16px] font-semibold text-white tracking-[-0.01em]">{team.name}</h2>
                  <span className="text-[11px] px-2 py-0.5 rounded-[6px]" style={{ background: 'rgba(10,132,255,0.13)', color: '#0a84ff', border: '1px solid rgba(10,132,255,0.22)' }}>
                    Learn-Gruppe
                  </span>
                </div>
                {team.description ? (
                  <p className="mt-1.5 text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: 'rgba(235,235,245,0.64)' }}>{team.description}</p>
                ) : (
                  <p className="mt-1.5 text-[13px]" style={mutedText}>Keine Beschreibung hinterlegt.</p>
                )}
              </>
            )}
          </div>
          {!editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="flex-shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-[9px] text-[12px] font-medium transition-colors"
              style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(235,235,245,0.68)', border: '1px solid rgba(255,255,255,0.08)' }}
            >
              <Edit3 size={12} /> Bearbeiten
            </button>
          )}
        </div>

        {!editing && (
          <>
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="rounded-[10px] px-3 py-2" style={{ background: 'rgba(255,255,255,0.035)' }}>
                <div className="text-[11px]" style={mutedText}>Mitglieder</div>
                <div className="mt-0.5 text-[15px] font-semibold text-white">{team.memberCount}</div>
              </div>
              <div className="rounded-[10px] px-3 py-2" style={{ background: 'rgba(255,255,255,0.035)' }}>
                <div className="text-[11px] flex items-center gap-1" style={mutedText}><BookOpen size={11} /> Kurse</div>
                <div className="mt-0.5 text-[15px] font-semibold text-white">{team.courseCount}</div>
              </div>
              <div className="rounded-[10px] px-3 py-2 col-span-2" style={{ background: 'rgba(255,255,255,0.035)' }}>
                <div className="text-[11px]" style={mutedText}>Erstellt von</div>
                <div className="mt-0.5 text-[13px] font-medium truncate" style={{ color: 'rgba(235,235,245,0.82)' }}>{team.creator?.username ?? 'Nicht verfügbar'}</div>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 flex-wrap text-[11px]" style={mutedText}>
              <span>Zuletzt geändert: {formatDate(team.updatedAt)}</span>
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                aria-expanded={expanded}
                className="flex items-center gap-1 transition-colors"
                style={{ color: '#0a84ff' }}
              >
                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                Mitglieder &amp; Zugriffe {expanded ? 'ausblenden' : 'anzeigen'}
              </button>
            </div>
          </>
        )}
      </div>

      {expanded && !editing && (
        <div className="px-5 pb-5 pt-4" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="flex items-center gap-2 mb-3">
            <Users size={15} style={{ color: '#0a84ff' }} />
            <h3 className="text-[13px] font-semibold text-white">Mitglieder &amp; Rollen</h3>
          </div>
          <p className="text-[12px] mb-3 leading-relaxed" style={mutedText}>
            Neue Personen müssen bereits als verifizierte WebUntis-Nutzer in POKYH existieren. Gruppen gewähren Kurszugriff; sie geben keine Admin-Rechte.
          </p>

          {team.members.length === 0 ? (
            <p className="text-[13px] py-3 text-center rounded-[10px]" style={{ background: 'rgba(255,255,255,0.03)', ...mutedText }}>Keine Mitglieder vorhanden.</p>
          ) : (
            <div className="flex flex-col rounded-[10px] overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
              {team.members.map((member, index) => {
                const color = roleColor(member.role);
                const displayName = member.user?.username ?? 'Nicht verfügbar';
                const isOwner = member.role === 'OWNER';
                const isBusy = changingMemberId === member.stableUid || removingMemberId === member.stableUid;
                return (
                  <div key={member.stableUid} className="flex items-center gap-3 p-3 flex-wrap sm:flex-nowrap" style={{ borderTop: index === 0 ? undefined : '1px solid rgba(255,255,255,0.055)' }}>
                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-semibold flex-shrink-0" style={{ background: `${color}22`, color, border: `1px solid ${color}44` }}>
                      {displayName.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-white truncate">{displayName}</div>
                      <div className="text-[11px] mt-0.5" style={mutedText}>{member.user?.isUntisUser ? 'WebUntis verifiziert' : 'Verifikation nicht verfügbar'} · seit {formatDate(member.joinedAt)}</div>
                    </div>
                    {isOwner ? (
                      <span className="text-[11px] px-2 py-1 rounded-[6px] font-medium" style={{ background: `${color}1f`, color, border: `1px solid ${color}3e` }}>{roleLabel(member.role)}</span>
                    ) : (
                      <label className="sr-only" htmlFor={`member-role-${team.id}-${member.stableUid}`}>Rolle für {displayName}</label>
                    )}
                    {!isOwner && (
                      <select
                        id={`member-role-${team.id}-${member.stableUid}`}
                        value={member.role}
                        disabled={isBusy}
                        onChange={(event) => void handleMemberRoleChange(member, event.target.value as LearnTeamAssignableRole)}
                        className="apple-input px-2 py-1.5 text-[12px] disabled:opacity-50"
                        style={{ ...inputStyle, colorScheme: 'dark' }}
                      >
                        <option value="MEMBER">Mitglied</option>
                        <option value="MANAGER">Verwalter</option>
                      </select>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleMemberRemoval(member)}
                      disabled={isBusy}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] text-[12px] font-medium disabled:opacity-50"
                      style={{ background: 'rgba(255,69,58,0.09)', color: '#ff453a', border: '1px solid rgba(255,69,58,0.19)' }}
                    >
                      {removingMemberId === member.stableUid ? <Loader2 size={12} className="animate-spin" /> : <UserMinus size={12} />}
                      Entfernen
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <form onSubmit={(event) => void handleMemberSave(event)} className="mt-4 rounded-[12px] p-3" style={{ background: 'rgba(10,132,255,0.055)', border: '1px solid rgba(10,132,255,0.16)' }}>
            <div className="flex items-center gap-2 mb-2">
              <UserPlus size={14} style={{ color: '#0a84ff' }} />
              <h4 className="text-[12px] font-semibold text-white">Mitglied hinzufügen oder Rolle aktualisieren</h4>
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_130px_auto]">
              <div>
                <label htmlFor={`member-identifier-${team.id}`} className="sr-only">POKYH-Benutzername oder stabile Nutzer-ID</label>
                <input
                  id={`member-identifier-${team.id}`}
                  value={userId}
                  onChange={(event) => setUserId(event.target.value)}
                  placeholder="POKYH-Benutzername oder Nutzer-ID"
                  maxLength={100}
                  required
                  className="apple-input w-full px-3 py-2 text-[13px]"
                  style={inputStyle}
                />
              </div>
              <div>
                <label htmlFor={`new-member-role-${team.id}`} className="sr-only">Rolle</label>
                <select
                  id={`new-member-role-${team.id}`}
                  value={memberRole}
                  onChange={(event) => setMemberRole(event.target.value as LearnTeamAssignableRole)}
                  className="apple-input w-full px-3 py-2 text-[13px]"
                  style={{ ...inputStyle, colorScheme: 'dark' }}
                >
                  <option value="MEMBER">Mitglied</option>
                  <option value="MANAGER">Verwalter</option>
                </select>
              </div>
              <button type="submit" disabled={savingMember || !userId.trim()} className="apple-btn flex items-center justify-center gap-1.5 px-3 py-2 text-[12px] disabled:opacity-50">
                {savingMember ? <Loader2 size={13} className="animate-spin" /> : <UserPlus size={13} />} Speichern
              </button>
            </div>
          </form>

          <div className="mt-5 pt-4" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex items-center gap-2">
              <BookOpen size={14} style={{ color: '#0a84ff' }} />
              <h3 className="text-[13px] font-semibold text-white">Kurszuordnung</h3>
            </div>
            <p className="text-[12px] mt-1.5 leading-relaxed" style={mutedText}>
              {team.courseCount === 0
                ? 'Dieser Gruppe sind keine Kurse zugeordnet.'
                : `${team.courseCount} ${team.courseCount === 1 ? 'Kurs ist' : 'Kurse sind'} zugeordnet.`}{' '}
              Der Verwaltungsendpunkt liefert bewusst nur die Anzahl; Kursinhalte und Lernantworten bleiben außerhalb der Gruppenverwaltung geschützt.
            </p>
          </div>

          <div className="mt-5 pt-4" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            {!canDelete ? (
              <div className="flex items-start gap-2.5 rounded-[10px] px-3 py-2.5" style={{ background: 'rgba(255,159,10,0.08)', border: '1px solid rgba(255,159,10,0.2)' }}>
                <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" style={{ color: '#ff9f0a' }} />
                <p className="text-[12px] leading-relaxed" style={{ color: '#ff9f0a' }}>Löschen gesperrt: Zuerst müssen alle {team.courseCount} zugeordneten Kurse entkoppelt oder archiviert werden.</p>
              </div>
            ) : !showDelete ? (
              <button
                type="button"
                onClick={() => setShowDelete(true)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-[9px] text-[12px] font-medium"
                style={{ background: 'rgba(255,69,58,0.09)', color: '#ff453a', border: '1px solid rgba(255,69,58,0.19)' }}
              >
                <Trash2 size={12} /> Leere Gruppe löschen
              </button>
            ) : (
              <div className="rounded-[12px] p-3" style={{ background: 'rgba(255,69,58,0.06)', border: '1px solid rgba(255,69,58,0.2)' }}>
                <div className="flex items-start gap-2 mb-3">
                  <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" style={{ color: '#ff453a' }} />
                  <p className="text-[12px] leading-relaxed" style={{ color: 'rgba(235,235,245,0.8)' }}>Diese Aktion entfernt die leere Gruppe. Gib zur Bestätigung den Namen <strong>{team.name}</strong> exakt ein.</p>
                </div>
                <label htmlFor={`delete-confirm-${team.id}`} className="sr-only">Gruppenname zur Löschbestätigung</label>
                <input
                  id={`delete-confirm-${team.id}`}
                  value={deleteConfirmation}
                  onChange={(event) => setDeleteConfirmation(event.target.value)}
                  placeholder={team.name}
                  className="apple-input w-full px-3 py-2 text-[13px]"
                  style={inputStyle}
                  autoComplete="off"
                />
                <div className="mt-3 flex gap-2">
                  <button type="button" onClick={() => { setShowDelete(false); setDeleteConfirmation(''); }} disabled={deleting} className="apple-btn-ghost px-3 py-2 text-[12px] disabled:opacity-50">Abbrechen</button>
                  <button
                    type="button"
                    onClick={() => void handleTeamDelete()}
                    disabled={deleting || deleteConfirmation !== team.name}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-[9px] text-[12px] font-medium disabled:opacity-50"
                    style={{ background: 'rgba(255,69,58,0.16)', color: '#ff453a', border: '1px solid rgba(255,69,58,0.28)' }}
                  >
                    {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Gruppe endgültig löschen
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export function LearnTeamsPage() {
  const { showToast } = useToast();
  const [teams, setTeams] = useState<AdminLearnTeam[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);

  const loadTeams = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    else setRefreshing(true);
    try {
      const result = await adminApi.listLearnTeams();
      setTeams(result.teams);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Gruppen konnten nicht geladen werden', 'error');
    } finally {
      if (showLoading) setLoading(false);
      else setRefreshing(false);
    }
  }, [showToast]);

  useEffect(() => { void loadTeams(true); }, [loadTeams]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName) return;
    setCreating(true);
    try {
      const result = await adminApi.createLearnTeam({ name: nextName, description: description.trim() || undefined });
      setTeams((current) => [result.team, ...current]);
      setName('');
      setDescription('');
      showToast('Learn-Gruppe erstellt', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Gruppe konnte nicht erstellt werden', 'error');
    } finally {
      setCreating(false);
    }
  }

  function replaceTeam(updated: AdminLearnTeam) {
    setTeams((current) => current.map((team) => team.id === updated.id ? updated : team));
  }

  function removeTeam(teamId: string) {
    setTeams((current) => current.filter((team) => team.id !== teamId));
  }

  return (
    <div className="animate-page max-w-[980px]">
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <GraduationCap size={17} style={{ color: '#0a84ff' }} />
            <span className="text-[12px] font-medium" style={{ color: '#0a84ff' }}>Pokyh Learn · Administration</span>
          </div>
          <h1 className="text-[22px] font-bold text-white tracking-[-0.02em]">Teams &amp; Zugriffe</h1>
          <p className="text-[13px] mt-1 max-w-[720px]" style={mutedText}>
            Gruppen steuern den Zugriff auf Learn-Kurse. Nur POKYH-Administratoren können sie verwalten; Mitglieder erhalten dadurch keine Admin-Rechte.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/learn" className="apple-btn-ghost px-3 py-2 text-[12px]">Konfiguration</Link>
          <button type="button" onClick={() => void loadTeams(false)} disabled={loading || refreshing} className="apple-btn-ghost flex items-center gap-1.5 px-3 py-2 text-[12px] disabled:opacity-50">
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> Aktualisieren
          </button>
        </div>
      </div>

      <div className="grid gap-4">
        <Card title="Neue Learn-Gruppe" icon={<Plus size={17} />}>
          <form onSubmit={(event) => void handleCreate(event)} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto] sm:items-end">
            <div>
              <label htmlFor="new-team-name" className="block text-[12px] mb-1" style={mutedText}>Name</label>
              <input id="new-team-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required placeholder="z. B. Englisch 4A" className="apple-input w-full px-3 py-2 text-[13px]" style={inputStyle} />
            </div>
            <div>
              <label htmlFor="new-team-description" className="block text-[12px] mb-1" style={mutedText}>Beschreibung <span style={{ color: 'rgba(235,235,245,0.28)' }}>(optional)</span></label>
              <input id="new-team-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} placeholder="Zweck oder Klasse" className="apple-input w-full px-3 py-2 text-[13px]" style={inputStyle} />
            </div>
            <button type="submit" disabled={creating || !name.trim()} className="apple-btn flex items-center justify-center gap-1.5 px-4 py-2 text-[12px] disabled:opacity-50">
              {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Erstellen
            </button>
          </form>
        </Card>

        <div className="flex items-center justify-between gap-3 pt-1">
          <div className="flex items-center gap-2">
            <Users size={16} style={{ color: '#0a84ff' }} />
            <h2 className="text-[15px] font-semibold text-white">Bestehende Gruppen</h2>
            {!loading && <span className="text-[11px] px-2 py-0.5 rounded-[6px]" style={{ background: 'rgba(255,255,255,0.06)', ...mutedText }}>{teams.length}</span>}
          </div>
          <span className="text-[11px]" style={mutedText}>Kursinhalte bleiben separat geschützt.</span>
        </div>

        {loading ? (
          <div className="grid gap-4">
            {Array.from({ length: 2 }).map((_, index) => <div key={index} className="h-64 rounded-[16px] shimmer" />)}
          </div>
        ) : teams.length === 0 ? (
          <Card title="Noch keine Learn-Gruppen" icon={<Users size={17} />}>
            <p className="text-[13px] leading-relaxed" style={mutedText}>Erstelle eine Gruppe, wenn ein Kurs gezielt für eine Klasse oder ein Team verfügbar sein soll. Persönliche und öffentliche Kurse brauchen keine Gruppe.</p>
          </Card>
        ) : (
          <div className="grid gap-4">
            {teams.map((team) => (
              <TeamCard
                key={team.id}
                team={team}
                onChanged={replaceTeam}
                onDeleted={removeTeam}
                onRefreshed={() => loadTeams(false)}
              />
            ))}
          </div>
        )}

        <div className="flex items-start gap-2.5 rounded-[12px] px-4 py-3" style={{ background: 'rgba(10,132,255,0.06)', border: '1px solid rgba(10,132,255,0.15)' }}>
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" style={{ color: '#0a84ff' }} />
          <p className="text-[12px] leading-relaxed" style={{ color: 'rgba(235,235,245,0.62)' }}>
            Eine Gruppe lässt sich nur löschen, wenn sie keine Kurse mehr enthält; der Gruppenname muss zusätzlich exakt bestätigt werden. Die API prüft beide Bedingungen erneut auf dem Server.
          </p>
        </div>
      </div>
    </div>
  );
}
