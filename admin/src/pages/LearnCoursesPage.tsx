import { useCallback, useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Archive,
  BookOpen,
  ChevronDown,
  ChevronRight,
  GraduationCap,
  Loader2,
  Lock,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { VocabularyPanel } from '../components/VocabularyPanel';
import type {
  AdminLearnCourse,
  AdminLearnCourseAccessResponse,
  LearnCoursePermission,
  LearnCourseStatus,
} from '../types';

const inputStyle: CSSProperties = {
  background: '#1c1c1e',
  border: '1px solid rgba(255,255,255,0.08)',
  color: 'rgba(235,235,245,0.88)',
};

const mutedText: CSSProperties = { color: 'rgba(235,235,245,0.45)' };
const pageSize = 25;

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

function statusColor(status: LearnCourseStatus): string {
  switch (status) {
    case 'PUBLISHED': return '#30d158';
    case 'ARCHIVED': return '#bf5af2';
    default: return '#ff9f0a';
  }
}

function statusLabel(status: LearnCourseStatus): string {
  switch (status) {
    case 'PUBLISHED': return 'Veröffentlicht';
    case 'ARCHIVED': return 'Archiviert';
    default: return 'Entwurf';
  }
}

function visibilityLabel(visibility: AdminLearnCourse['visibility']): string {
  switch (visibility) {
    case 'PUBLIC': return 'Katalog';
    case 'TEAM': return 'Gruppe';
    default: return 'Privat';
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' });
}

function CourseAccessPanel({
  course,
  onCourseChanged,
}: {
  course: AdminLearnCourse;
  onCourseChanged: (course: AdminLearnCourse) => void;
}) {
  const { showToast } = useToast();
  const [details, setDetails] = useState<AdminLearnCourseAccessResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState('');
  const [permission, setPermission] = useState<LearnCoursePermission>('VIEW');
  const [saving, setSaving] = useState(false);
  const [changingId, setChangingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const loadAccess = useCallback(async (page = 1) => {
    setLoading(true);
    try {
      const result = await adminApi.getLearnCourseAccess(course.id, page, 50);
      setDetails(result);
      onCourseChanged(result.course);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Direkte Zugriffe konnten nicht geladen werden', 'error');
    } finally {
      setLoading(false);
    }
  }, [course.id, onCourseChanged, showToast]);

  useEffect(() => { void loadAccess(); }, [loadAccess]);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const identifier = userId.trim();
    if (!identifier) return;
    setSaving(true);
    try {
      await adminApi.saveLearnCourseAccess(course.id, { userId: identifier, permission });
      setUserId('');
      setPermission('VIEW');
      await loadAccess(1);
      showToast('Direkter Kurszugriff gespeichert', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Zugriff konnte nicht gespeichert werden', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handlePermissionChange(stableUid: string, nextPermission: LearnCoursePermission) {
    setChangingId(stableUid);
    try {
      await adminApi.saveLearnCourseAccess(course.id, { userId: stableUid, permission: nextPermission });
      await loadAccess(details?.access.page ?? 1);
      showToast('Berechtigung aktualisiert', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Berechtigung konnte nicht aktualisiert werden', 'error');
    } finally {
      setChangingId(null);
    }
  }

  async function handleRevoke(stableUid: string, username: string) {
    if (!window.confirm(`Direkten Kurszugriff für „${username}“ wirklich widerrufen?`)) return;
    setRemovingId(stableUid);
    try {
      await adminApi.revokeLearnCourseAccess(course.id, stableUid);
      const currentPage = details?.access.page ?? 1;
      await loadAccess(currentPage);
      showToast('Direkter Kurszugriff widerrufen', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Zugriff konnte nicht widerrufen werden', 'error');
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="mt-4 pt-4" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="flex items-center gap-2 mb-2">
        <ShieldCheck size={15} style={{ color: '#0a84ff' }} />
        <h3 className="text-[13px] font-semibold text-white">Direkte Zugriffe</h3>
      </div>
      <p className="text-[12px] leading-relaxed mb-3" style={mutedText}>
        Diese Liste enthält nur explizite Einzelberechtigungen. Gruppenmitgliedschaft, öffentliche Katalogsichtbarkeit und bestehende Einschreibungen werden dadurch weder angezeigt noch aufgehoben.
      </p>

      <form onSubmit={(event) => void handleSave(event)} className="rounded-[12px] p-3" style={{ background: 'rgba(10,132,255,0.055)', border: '1px solid rgba(10,132,255,0.16)' }}>
        <div className="flex items-center gap-2 mb-2">
          <UserPlus size={14} style={{ color: '#0a84ff' }} />
          <h4 className="text-[12px] font-semibold text-white">Zugriff hinzufügen oder aktualisieren</h4>
        </div>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_130px_auto]">
          <div>
            <label htmlFor={`course-access-user-${course.id}`} className="sr-only">POKYH-Benutzername oder stabile Nutzer-ID</label>
            <input
              id={`course-access-user-${course.id}`}
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
            <label htmlFor={`course-access-permission-${course.id}`} className="sr-only">Berechtigung</label>
            <select
              id={`course-access-permission-${course.id}`}
              value={permission}
              onChange={(event) => setPermission(event.target.value as LearnCoursePermission)}
              className="apple-input w-full px-3 py-2 text-[13px]"
              style={{ ...inputStyle, colorScheme: 'dark' }}
            >
              <option value="VIEW">Ansehen</option>
              <option value="EDIT">Bearbeiten</option>
              <option value="MANAGE">Verwalten</option>
            </select>
          </div>
          <button type="submit" disabled={saving || !userId.trim()} className="apple-btn flex items-center justify-center gap-1.5 px-3 py-2 text-[12px] disabled:opacity-50">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <UserPlus size={13} />} Speichern
          </button>
        </div>
      </form>

      {loading ? (
        <div className="mt-3 flex flex-col gap-2">
          {Array.from({ length: 2 }).map((_, index) => <div key={index} className="h-12 rounded-[10px] shimmer" />)}
        </div>
      ) : !details || details.access.items.length === 0 ? (
        <p className="mt-3 text-[13px] py-3 text-center rounded-[10px]" style={{ background: 'rgba(255,255,255,0.03)', ...mutedText }}>Keine direkten Zugriffe vorhanden.</p>
      ) : (
        <>
          <div className="mt-3 flex flex-col rounded-[10px] overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
            {details.access.items.map((grant, index) => {
              const busy = changingId === grant.stableUid || removingId === grant.stableUid;
              return (
                <div key={grant.stableUid} className="flex items-center gap-3 p-3 flex-wrap sm:flex-nowrap" style={{ borderTop: index === 0 ? undefined : '1px solid rgba(255,255,255,0.055)' }}>
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-semibold flex-shrink-0" style={{ background: 'rgba(10,132,255,0.18)', color: '#0a84ff', border: '1px solid rgba(10,132,255,0.34)' }}>
                    {grant.user.username.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-white truncate">{grant.user.username}</div>
                    <div className="text-[11px] mt-0.5" style={mutedText}>{grant.user.isUntisUser ? 'WebUntis verifiziert' : 'Verifikation nicht verfügbar'} · aktualisiert {formatDate(grant.updatedAt)}</div>
                  </div>
                  <label htmlFor={`course-grant-role-${course.id}-${grant.stableUid}`} className="sr-only">Berechtigung für {grant.user.username}</label>
                  <select
                    id={`course-grant-role-${course.id}-${grant.stableUid}`}
                    value={grant.permission}
                    disabled={busy}
                    onChange={(event) => void handlePermissionChange(grant.stableUid, event.target.value as LearnCoursePermission)}
                    className="apple-input px-2 py-1.5 text-[12px] disabled:opacity-50"
                    style={{ ...inputStyle, colorScheme: 'dark' }}
                  >
                    <option value="VIEW">Ansehen</option>
                    <option value="EDIT">Bearbeiten</option>
                    <option value="MANAGE">Verwalten</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => void handleRevoke(grant.stableUid, grant.user.username)}
                    disabled={busy}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] text-[12px] font-medium disabled:opacity-50"
                    style={{ background: 'rgba(255,69,58,0.09)', color: '#ff453a', border: '1px solid rgba(255,69,58,0.19)' }}
                  >
                    {removingId === grant.stableUid ? <Loader2 size={12} className="animate-spin" /> : <UserMinus size={12} />} Widerrufen
                  </button>
                </div>
              );
            })}
          </div>
          {details.access.total > details.access.limit && (
            <div className="mt-3 flex items-center justify-between gap-3 text-[12px]" style={mutedText}>
              <span>Seite {details.access.page} von {Math.max(1, Math.ceil(details.access.total / details.access.limit))}</span>
              <div className="flex gap-2">
                <button type="button" onClick={() => void loadAccess(details.access.page - 1)} disabled={loading || details.access.page <= 1} className="apple-btn-ghost px-2.5 py-1.5 disabled:opacity-50">Zurück</button>
                <button type="button" onClick={() => void loadAccess(details.access.page + 1)} disabled={loading || details.access.page * details.access.limit >= details.access.total} className="apple-btn-ghost px-2.5 py-1.5 disabled:opacity-50">Weiter</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CourseCard({
  course,
  onCourseChanged,
  onCourseDeleted,
}: {
  course: AdminLearnCourse;
  onCourseChanged: (course: AdminLearnCourse) => void;
  onCourseDeleted: (courseId: string) => void;
}) {
  const { showToast } = useToast();
  const [accessOpen, setAccessOpen] = useState(false);
  const [vocabOpen, setVocabOpen] = useState(false);
  const [lifecycleSaving, setLifecycleSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const color = statusColor(course.status);

  async function handleLifecycleChange(nextStatus: LearnCourseStatus) {
    if (nextStatus === course.status) return;
    setLifecycleSaving(true);
    try {
      const result = await adminApi.updateLearnCourseLifecycle(course.id, nextStatus);
      onCourseChanged(result.course);
      showToast(`Kursstatus: ${statusLabel(result.course.status)}`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Kursstatus konnte nicht geändert werden', 'error');
    } finally {
      setLifecycleSaving(false);
    }
  }

  async function handleDelete() {
    if (confirmation !== course.slug) return;
    setDeleting(true);
    try {
      await adminApi.deleteLearnCourse(course.id, confirmation);
      onCourseDeleted(course.id);
      showToast('Kurs dauerhaft gelöscht', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Kurs konnte nicht gelöscht werden', 'error');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="rounded-[16px] overflow-hidden" style={{ background: '#0d0d0d', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-[16px] font-semibold text-white tracking-[-0.01em]">{course.title}</h2>
              <span className="text-[11px] px-2 py-0.5 rounded-[6px] font-medium" style={{ background: `${color}1f`, color, border: `1px solid ${color}3c` }}>{statusLabel(course.status)}</span>
              <span className="text-[11px] px-2 py-0.5 rounded-[6px]" style={{ background: 'rgba(255,255,255,0.06)', ...mutedText }}>{visibilityLabel(course.visibility)}</span>
              {course.ownerLocked && <span title="Eigentümerwechsel ist gesperrt" className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-[6px]" style={{ background: 'rgba(191,90,242,0.12)', color: '#bf5af2', border: '1px solid rgba(191,90,242,0.22)' }}><Lock size={10} /> Besitz gesperrt</span>}
            </div>
            {course.summary ? (
              <p className="mt-1.5 text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: 'rgba(235,235,245,0.64)' }}>{course.summary}</p>
            ) : (
              <p className="mt-1.5 text-[13px]" style={mutedText}>Keine Zusammenfassung hinterlegt.</p>
            )}
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]" style={mutedText}>
              <span>Slug: <code>{course.slug}</code></span>
              {course.subject && <span>{course.subject}</span>}
              {course.language && <span>{course.language}</span>}
              {course.level && <span>{course.level}</span>}
              <span>Autor: {course.creator.username}</span>
              <span>Aktualisiert: {formatDate(course.updatedAt)}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <label htmlFor={`course-status-${course.id}`} className="sr-only">Kursstatus</label>
            <select
              id={`course-status-${course.id}`}
              value={course.status}
              disabled={lifecycleSaving}
              onChange={(event) => void handleLifecycleChange(event.target.value as LearnCourseStatus)}
              className="apple-input px-3 py-2 text-[12px] disabled:opacity-50"
              style={{ ...inputStyle, colorScheme: 'dark' }}
            >
              <option value="DRAFT">Entwurf</option>
              <option value="PUBLISHED">Veröffentlichen</option>
              <option value="ARCHIVED">Archivieren</option>
            </select>
            {lifecycleSaving && <Loader2 size={14} className="animate-spin" style={{ color: '#0a84ff' }} />}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 sm:grid-cols-5 gap-2">
          <div className="rounded-[10px] px-3 py-2" style={{ background: 'rgba(255,255,255,0.035)' }}><div className="text-[11px]" style={mutedText}>Abschnitte</div><div className="mt-0.5 text-[15px] font-semibold text-white">{course.counts.sections}</div></div>
          <div className="rounded-[10px] px-3 py-2" style={{ background: 'rgba(255,255,255,0.035)' }}><div className="text-[11px]" style={mutedText}>Vokabeln</div><div className="mt-0.5 text-[15px] font-semibold text-white">{course.counts.vocabulary}</div></div>
          <div className="rounded-[10px] px-3 py-2" style={{ background: 'rgba(255,255,255,0.035)' }}><div className="text-[11px]" style={mutedText}>Einschreibungen</div><div className="mt-0.5 text-[15px] font-semibold text-white">{course.counts.enrollments}</div></div>
          <div className="rounded-[10px] px-3 py-2" style={{ background: 'rgba(255,255,255,0.035)' }}><div className="text-[11px]" style={mutedText}>Direktzugriffe</div><div className="mt-0.5 text-[15px] font-semibold text-white">{course.counts.directAccess}</div></div>
          <div className="rounded-[10px] px-3 py-2" style={{ background: 'rgba(255,255,255,0.035)' }}><div className="text-[11px]" style={mutedText}>Gruppe</div><div className="mt-0.5 text-[13px] font-medium text-white truncate">{course.team?.name ?? '—'}</div></div>
        </div>

        <div className="mt-4 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-4 flex-wrap">
            <button type="button" onClick={() => setAccessOpen((value) => !value)} aria-expanded={accessOpen} className="flex items-center gap-1.5 text-[12px] font-medium" style={{ color: '#0a84ff' }}>
              {accessOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Direkte Zugriffe {accessOpen ? 'ausblenden' : 'verwalten'}
            </button>
            <button type="button" onClick={() => setVocabOpen((value) => !value)} aria-expanded={vocabOpen} className="flex items-center gap-1.5 text-[12px] font-medium" style={{ color: '#0a84ff' }}>
              {vocabOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Vokabeln {vocabOpen ? 'ausblenden' : 'verwalten'}
            </button>
          </div>
          {!deleteOpen ? (
            <button type="button" onClick={() => setDeleteOpen(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-[9px] text-[12px] font-medium" style={{ background: 'rgba(255,69,58,0.09)', color: '#ff453a', border: '1px solid rgba(255,69,58,0.19)' }}>
              <Trash2 size={12} /> Dauerhaft löschen
            </button>
          ) : null}
        </div>

        {accessOpen && <CourseAccessPanel course={course} onCourseChanged={onCourseChanged} />}
        {vocabOpen && <VocabularyPanel course={course} onCourseChanged={onCourseChanged} />}

        {deleteOpen && (
          <div className="mt-4 rounded-[12px] p-3" style={{ background: 'rgba(255,69,58,0.06)', border: '1px solid rgba(255,69,58,0.2)' }}>
            <div className="flex items-start gap-2 mb-3">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" style={{ color: '#ff453a' }} />
              <p className="text-[12px] leading-relaxed" style={{ color: 'rgba(235,235,245,0.8)' }}>Dauerhaftes Löschen entfernt den Kurs und seine verknüpften Learn-Daten. Gib zur Bestätigung den Slug <strong>{course.slug}</strong> exakt ein.</p>
            </div>
            <label htmlFor={`delete-course-${course.id}`} className="sr-only">Kurs-Slug zur Löschbestätigung</label>
            <input id={`delete-course-${course.id}`} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={course.slug} autoComplete="off" className="apple-input w-full px-3 py-2 text-[13px]" style={inputStyle} />
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => { setDeleteOpen(false); setConfirmation(''); }} disabled={deleting} className="apple-btn-ghost px-3 py-2 text-[12px] disabled:opacity-50">Abbrechen</button>
              <button type="button" onClick={() => void handleDelete()} disabled={deleting || confirmation !== course.slug} className="flex items-center gap-1.5 px-3 py-2 rounded-[9px] text-[12px] font-medium disabled:opacity-50" style={{ background: 'rgba(255,69,58,0.16)', color: '#ff453a', border: '1px solid rgba(255,69,58,0.28)' }}>
                {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Kurs endgültig löschen
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export function LearnCoursesPage() {
  const { showToast } = useToast();
  const [courses, setCourses] = useState<AdminLearnCourse[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadCourses = useCallback(async () => {
    setLoading(true);
    try {
      const result = await adminApi.listLearnCourses({ page, limit: pageSize });
      setCourses(result.courses);
      setTotal(result.total);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Learn-Kurse konnten nicht geladen werden', 'error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [page, showToast]);

  useEffect(() => { void loadCourses(); }, [loadCourses]);

  const replaceCourse = useCallback((updated: AdminLearnCourse) => {
    setCourses((current) => current.map((course) => course.id === updated.id ? updated : course));
  }, []);

  const removeCourse = useCallback((courseId: string) => {
    setCourses((current) => current.filter((course) => course.id !== courseId));
    setTotal((current) => Math.max(0, current - 1));
  }, []);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="animate-page max-w-[1040px]">
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <GraduationCap size={17} style={{ color: '#0a84ff' }} />
            <span className="text-[12px] font-medium" style={{ color: '#0a84ff' }}>Pokyh Learn · Administration</span>
          </div>
          <h1 className="text-[22px] font-bold text-white tracking-[-0.02em]">Kurse &amp; Zugriffe</h1>
          <p className="text-[13px] mt-1 max-w-[760px]" style={mutedText}>Verwalte Veröffentlichungsstatus und explizite Berechtigungen zentral. Diese Ansicht zeigt nur Kursmetadaten und Zähler, keine Lernantworten oder Kursinhalte.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link to="/learn" className="apple-btn-ghost px-3 py-2 text-[12px]">Konfiguration</Link>
          <Link to="/learn/teams" className="apple-btn-ghost px-3 py-2 text-[12px]">Teams &amp; Zugriffe</Link>
          <button type="button" onClick={() => { setRefreshing(true); void loadCourses(); }} disabled={loading || refreshing} className="apple-btn-ghost flex items-center gap-1.5 px-3 py-2 text-[12px] disabled:opacity-50"><RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> Aktualisieren</button>
        </div>
      </div>

      <div className="grid gap-4">
        <Card title={`Kurse (${total})`} icon={<BookOpen size={17} />}>
          <p className="text-[12px] leading-relaxed" style={mutedText}>Veröffentlichen macht einen öffentlichen Katalogkurs sichtbar. Archivieren ist der reversible Standard; dauerhaftes Löschen erfordert unten eine separate exakte Bestätigung.</p>
        </Card>

        {loading ? (
          <div className="grid gap-4">
            {Array.from({ length: 2 }).map((_, index) => <div key={index} className="h-72 rounded-[16px] shimmer" />)}
          </div>
        ) : courses.length === 0 ? (
          <Card title="Keine Learn-Kurse" icon={<Archive size={17} />}>
            <p className="text-[13px]" style={mutedText}>Es wurden noch keine Kurse erstellt.</p>
          </Card>
        ) : (
          <div className="grid gap-4">
            {courses.map((course) => <CourseCard key={course.id} course={course} onCourseChanged={replaceCourse} onCourseDeleted={removeCourse} />)}
          </div>
        )}

        {!loading && total > pageSize && (
          <div className="flex items-center justify-between gap-3 rounded-[12px] px-4 py-3" style={{ background: '#0d0d0d', border: '1px solid rgba(255,255,255,0.07)' }}>
            <span className="text-[12px]" style={mutedText}>Seite {page} von {pageCount}</span>
            <div className="flex gap-2">
              <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1} className="apple-btn-ghost px-3 py-1.5 text-[12px] disabled:opacity-50">Zurück</button>
              <button type="button" onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={page >= pageCount} className="apple-btn-ghost px-3 py-1.5 text-[12px] disabled:opacity-50">Weiter</button>
            </div>
          </div>
        )}

        <div className="flex items-start gap-2.5 rounded-[12px] px-4 py-3" style={{ background: 'rgba(10,132,255,0.06)', border: '1px solid rgba(10,132,255,0.15)' }}>
          <Users size={14} className="flex-shrink-0 mt-0.5" style={{ color: '#0a84ff' }} />
          <p className="text-[12px] leading-relaxed" style={{ color: 'rgba(235,235,245,0.62)' }}>Direkte Berechtigungen gelten zusätzlich zu Gruppen, Katalogsichtbarkeit und Einschreibungen. Beim Widerruf wird nur die explizite Einzelberechtigung entfernt; der Server prüft jede Kursanfrage weiterhin autoritativ.</p>
        </div>
      </div>
    </div>
  );
}
