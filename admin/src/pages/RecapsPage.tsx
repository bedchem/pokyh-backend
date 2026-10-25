import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BookOpenText, CalendarClock, CalendarRange, ChartLine, Eye, GraduationCap, Pencil, Plus, Power, Save, School, Sparkles, Target, Trash2, UserMinus, UserRound, Users, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { adminApi } from '../api';
import { useAccess } from '../access';
import { useToast } from '../components/Toast';
import { useLive } from '../live';
import { Figures, Notice, PageHeader, Segmented as KitSegmented } from '../components/kit';
import { InfoTip } from '../components/cluster/explain';
import { RecapRecipientPicker } from '../components/recaps/RecapRecipientPicker';
import type { AdminRecap, RecapInput, RecapSection, RecapStatus, RecapTargetClass, RecapTargetSchool, RecapTargetUser } from '../types';

// Recaps: a look back at a period that students open in the app as a story
// (like a year in review). Here the period, when it can be opened, which
// parts it tells and who gets it — every student, or chosen schools, classes
// and students in any mix. The WebUntis figures are worked out on each
// student's own device; this page never sees them, only how many opened it.

const dimText = { color: 'rgb(var(--ink-rgb) / 0.62)' };

const STATUS: Record<RecapStatus, { label: string; color: string }> = {
  active: { label: 'Aktiv', color: 'var(--mint-deep)' },
  scheduled: { label: 'Geplant', color: 'var(--sky-deep)' },
  expired: { label: 'Abgelaufen', color: 'rgb(var(--ink-rgb) / 0.58)' },
  disabled: { label: 'Deaktiviert', color: 'var(--amber-deep)' },
};

// The parts of the story, in its order, with what each one shows.
const SECTIONS: Array<{ key: RecapSection; label: string; icon: LucideIcon; shows: string }> = [
  { key: 'school', label: 'Unterricht', icon: CalendarRange, shows: 'Stunden in der Schule, Schultage, Lieblingsfach, häufigster Lehrer und Raum, längster Tag, Entfälle und Vertretungen' },
  { key: 'absences', label: 'Abwesenheiten', icon: UserMinus, shows: 'Fehlquote (mit eigener Reaktion von 0 % bis über 25 %), Fehlstunden, entschuldigt/offen, meistverpasstes Fach, Wochentag' },
  { key: 'grades', label: 'Noten', icon: ChartLine, shows: 'Anzahl Noten, Durchschnitt, bestes Fach, beste Note' },
  { key: 'exams', label: 'Prüfungen & Hausaufgaben', icon: GraduationCap, shows: 'Prüfungen und Hausaufgaben im Zeitraum' },
  { key: 'classreg', label: 'Klassenbuch', icon: BookOpenText, shows: 'Einträge im Klassenbuch (oder keiner)' },
  { key: 'pokyh', label: 'POKYH', icon: Sparkles, shows: 'Tage in POKYH, längste Serie, Uhrzeit und Wochentag, Geräte, Todos, Erinnerungen, Lieblingsgericht, „Top x %“ der Schule' },
];

const ALL_SECTIONS = SECTIONS.map((s) => s.key);

// ISO <-> <input type="datetime-local"> (browser-local time).
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(v: string): string | null {
  return v ? new Date(v).toISOString() : null;
}

/** September of the school year a date belongs to. */
function schoolYearOf(d = new Date()): number {
  return d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1;
}

const PERIODS: Array<{ label: string; range: () => [string, string] }> = [
  { label: 'Dieses Schuljahr', range: () => { const y = schoolYearOf(); return [`${y}-09-01`, `${y + 1}-06-30`]; } },
  { label: 'Letztes Schuljahr', range: () => { const y = schoolYearOf() - 1; return [`${y}-09-01`, `${y + 1}-06-30`]; } },
  { label: '1. Semester', range: () => { const y = schoolYearOf(); return [`${y}-09-01`, `${y + 1}-01-31`]; } },
  { label: '2. Semester', range: () => { const y = schoolYearOf(); return [`${y + 1}-02-01`, `${y + 1}-06-30`]; } },
];

function dayText(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
}

function windowSummary(r: { startsAt: string | null; endsAt: string | null }): string {
  const fmt = (iso: string) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
  if (r.startsAt && r.endsAt) return `sichtbar ${fmt(r.startsAt)} – ${fmt(r.endsAt)}`;
  if (r.startsAt) return `sichtbar ab ${fmt(r.startsAt)}`;
  if (r.endsAt) return `sichtbar bis ${fmt(r.endsAt)}`;
  return 'sichtbar ohne Zeitlimit';
}

// "2 Schulen · 3 Klassen · 4 Schüler" for the list.
function recipientSummary(r: AdminRecap): string {
  const parts: string[] = [];
  if (r.targetSchools.length > 0) parts.push(r.targetSchools.length === 1 ? r.targetSchools[0]!.name : `${r.targetSchools.length} Schulen`);
  if (r.targetClasses.length > 0) parts.push(r.targetClasses.length === 1 ? `Klasse ${r.targetClasses[0]!.name}` : `${r.targetClasses.length} Klassen`);
  if (r.targetUsers.length > 0) parts.push(r.targetUsers.length === 1 ? r.targetUsers[0]!.username : `${r.targetUsers.length} Schüler`);
  return parts.join(' · ');
}

interface Form {
  title: string;
  periodFrom: string;
  periodTo: string;
  startsAt: string | null;
  endsAt: string | null;
  sections: RecapSection[];
  enabled: boolean;
  resetSeen: boolean;
}

function emptyForm(): Form {
  const y = schoolYearOf();
  return {
    title: `Dein Schuljahr ${y}/${String(y + 1).slice(2)}`,
    periodFrom: `${y}-09-01`,
    periodTo: `${y + 1}-06-30`,
    startsAt: null,
    endsAt: null,
    sections: [...ALL_SECTIONS],
    enabled: true,
    resetSeen: false,
  };
}

type Field = 'title' | 'period' | 'window' | 'sections' | 'recipients';

export function RecapsPage() {
  const { showToast } = useToast();
  const { view, can } = useAccess();
  const [recaps, setRecaps] = useState<AdminRecap[]>([]);
  const [loading, setLoading] = useState(true);
  // null = editor closed, '' = new recap, otherwise the id being edited
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  // Recipients: every student, or only chosen schools, classes and students.
  const [targeted, setTargeted] = useState(false);
  const [schools, setSchools] = useState<RecapTargetSchool[]>([]);
  const [classes, setClasses] = useState<RecapTargetClass[]>([]);
  const [users, setUsers] = useState<RecapTargetUser[]>([]);
  // The school the edited recap belongs to (always the view's school in a school's view).
  const [ownSchool, setOwnSchool] = useState<{ id: string; name: string } | null>(null);
  const mayManage = can('recaps.manage');

  const load = useCallback(async () => {
    try {
      const res = await adminApi.getRecaps();
      setRecaps(res.recaps);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Laden fehlgeschlagen', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void load(); }, [load]);
  useLive(['recaps'], () => { void load(); });

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const viewSchool = view?.kind === 'school' ? { id: view.school.id, name: view.school.shortName || view.school.name } : null;

  function openNew() {
    setAttempted(false);
    setForm(emptyForm());
    setTargeted(false);
    setSchools([]);
    setClasses([]);
    setUsers([]);
    setOwnSchool(viewSchool);
    setEditingId('');
    requestAnimationFrame(() => document.getElementById('recap-editor')?.scrollIntoView({ behavior: 'smooth' }));
  }

  function openEdit(r: AdminRecap) {
    setAttempted(false);
    setForm({
      title: r.title, periodFrom: r.periodFrom, periodTo: r.periodTo, startsAt: r.startsAt, endsAt: r.endsAt,
      sections: r.sections, enabled: r.enabled, resetSeen: false,
    });
    setTargeted(r.targetSchools.length > 0 || r.targetClasses.length > 0 || r.targetUsers.length > 0);
    setSchools(r.targetSchools);
    setClasses(r.targetClasses);
    setUsers(r.targetUsers);
    setOwnSchool(r.schoolId ? { id: r.schoolId, name: r.schoolName ?? '' } : viewSchool);
    setEditingId(r.id);
    requestAnimationFrame(() => document.getElementById('recap-editor')?.scrollIntoView({ behavior: 'smooth' }));
  }

  function toggleSection(key: RecapSection) {
    setForm((f) => ({ ...f, sections: f.sections.includes(key) ? f.sections.filter((s) => s !== key) : ALL_SECTIONS.filter((s) => s === key || f.sections.includes(s)) }));
  }

  const problems = useMemo(() => {
    const list: Array<{ field: Field; message: string }> = [];
    if (!form.title.trim()) list.push({ field: 'title', message: 'Titel eingeben — er steht auf der ersten Seite der Story.' });
    if (!form.periodFrom || !form.periodTo) list.push({ field: 'period', message: 'Anfang und Ende des Zeitraums angeben.' });
    else if (form.periodTo < form.periodFrom) list.push({ field: 'period', message: 'Das Ende des Zeitraums muss nach seinem Anfang liegen.' });
    if (form.startsAt && form.endsAt && new Date(form.endsAt) <= new Date(form.startsAt)) list.push({ field: 'window', message: '„Sichtbar bis“ muss nach „Sichtbar ab“ liegen.' });
    if (form.sections.length === 0) list.push({ field: 'sections', message: 'Mindestens einen Teil auswählen, den die Story zeigt.' });
    if (targeted && schools.length === 0 && classes.length === 0 && users.length === 0) {
      list.push({ field: 'recipients', message: 'Mindestens eine Schule, Klasse oder einen Schüler wählen — oder „Alle Schüler“.' });
    }
    return list;
  }, [form, targeted, schools, classes, users]);
  const showProblems = attempted && problems.length > 0;
  const invalid = (field: Field) => showProblems && problems.some((p) => p.field === field);
  const invalidStyle: React.CSSProperties = { boxShadow: 'inset 0 0 0 1.5px var(--rose-deep)' };

  async function save() {
    if (problems.length > 0) {
      setAttempted(true);
      const id = `recap-${problems[0]!.field}`;
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      document.getElementById(id)?.focus();
      return;
    }
    setSaving(true);
    try {
      const payload: RecapInput = {
        title: form.title.trim(),
        periodFrom: form.periodFrom,
        periodTo: form.periodTo,
        startsAt: form.startsAt,
        endsAt: form.endsAt,
        sections: form.sections,
        enabled: form.enabled,
        ...(editingId ? { resetSeen: form.resetSeen } : {}),
        targetSchools: targeted ? schools.map((s) => s.id) : [],
        targetClasses: targeted ? classes.map((c) => ({ schoolId: c.schoolId, klasseId: c.id })) : [],
        targetUsers: targeted ? users.map((u) => u.stableUid) : [],
      };
      if (editingId) await adminApi.updateRecap(editingId, payload);
      else await adminApi.createRecap(payload);
      showToast(editingId ? 'Recap gespeichert' : 'Recap erstellt', 'success');
      setEditingId(null);
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Speichern fehlgeschlagen', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function toggle(r: AdminRecap) {
    try {
      await adminApi.setRecapEnabled(r.id, !r.enabled);
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Fehlgeschlagen', 'error');
    }
  }

  async function remove(r: AdminRecap) {
    if (!window.confirm(`Recap „${r.title}“ wirklich löschen?`)) return;
    try {
      await adminApi.deleteRecap(r.id);
      if (editingId === r.id) setEditingId(null);
      showToast('Recap gelöscht', 'success');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Löschen fehlgeschlagen', 'error');
    }
  }

  const openedTotal = recaps.reduce((sum, r) => sum + r.opened, 0);

  return (
    <div>
      <PageHeader title="Recaps" subtitle="Rückblicke auf einen Zeitraum, die Schüler in der App als Story öffnen — mit ihren eigenen Zahlen aus WebUntis und POKYH.">
        {mayManage && (
          <button type="button" onClick={openNew} className="btn btn-primary">
            <Plus size={16} strokeWidth={1.8} /> Neue Recap
          </button>
        )}
      </PageHeader>

      <Figures
        className="mt-10"
        items={[
          { label: 'Recaps', value: recaps.length, icon: Sparkles },
          { label: 'Aktiv', value: recaps.filter((r) => r.status === 'active').length, icon: Power },
          { label: 'Geplant', value: recaps.filter((r) => r.status === 'scheduled').length, icon: CalendarClock },
          { label: 'Geöffnet', value: openedTotal, icon: Eye },
        ]}
      />

      {editingId !== null && (
        <div id="recap-editor" className="animate-fadeInUp mt-10 scroll-mt-4 rounded-[26px] bg-well p-6 sm:p-8">
          <div className="mb-6 flex items-center justify-between">
            <div className="flex items-center gap-3.5">
              <span className="orb orb-white h-11 w-11"><Sparkles size={18} strokeWidth={1.6} /></span>
              <h2 className="text-[17px] font-semibold">{editingId ? 'Recap bearbeiten' : 'Neue Recap'}</h2>
            </div>
            <button type="button" onClick={() => setEditingId(null)} className="orb orb-white h-9 w-9" aria-label="Schließen"><X size={16} strokeWidth={1.7} /></button>
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
            <div className="flex min-w-0 flex-col gap-5">
              <div>
                <label htmlFor="recap-title" className="mb-1.5 block text-[12px]" style={dimText}>Titel <span style={{ color: 'var(--rose-deep)' }}>*</span></label>
                <input id="recap-title" value={form.title} maxLength={120} onChange={(e) => set('title', e.target.value)}
                  placeholder="z. B. Dein Schuljahr 2025/26" aria-invalid={invalid('title')}
                  className="field h-11 w-full px-4 text-[14px]" style={invalid('title') ? invalidStyle : undefined} />
              </div>

              <div className="flex flex-col gap-3 rounded-[14px] p-4" style={{ background: '#141416' }}>
                <span className="flex items-center gap-1.5 text-[12px]" style={dimText}>
                  Zeitraum der Zahlen
                  <InfoTip>Über diese Tage erzählt die Recap: Unterricht, Abwesenheiten, Noten und POKYH zählen nur, was dazwischen liegt (beide Tage eingeschlossen). Liegt das Ende in der Zukunft, zählt alles bis heute.</InfoTip>
                </span>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-[12px]" style={dimText}>Von</label>
                    <input id="recap-period" type="date" value={form.periodFrom} onChange={(e) => set('periodFrom', e.target.value)}
                      aria-invalid={invalid('period')} className="field h-11 w-full px-4 text-[14px]" style={invalid('period') ? invalidStyle : undefined} />
                  </div>
                  <div>
                    <label className="mb-1 block text-[12px]" style={dimText}>Bis</label>
                    <input type="date" value={form.periodTo} onChange={(e) => set('periodTo', e.target.value)}
                      aria-invalid={invalid('period')} className="field h-11 w-full px-4 text-[14px]" style={invalid('period') ? invalidStyle : undefined} />
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {PERIODS.map((p) => (
                    <button key={p.label} type="button"
                      onClick={() => { const [from, to] = p.range(); setForm((f) => ({ ...f, periodFrom: from, periodTo: to })); }}
                      className="rounded-full px-2.5 py-1 text-[12px] hover:bg-ink/[0.1]" style={{ background: 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))', color: 'rgb(var(--ink-rgb) / 0.82)' }}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-3 rounded-[14px] p-4" style={{ background: '#141416' }}>
                <span className="flex items-center gap-1.5 text-[12px]" style={dimText}>
                  Wann sie erscheint
                  <InfoTip>Ab diesem Zeitpunkt öffnet sich die Recap nach der Anmeldung einmal von selbst — gesehen auf einem Gerät heißt gesehen auf allen (der Server merkt es sich). Weggeklickt bleibt sie als Banner oben neben der Suche, bis „Sichtbar bis“. Leer: sofort und ohne Ende.</InfoTip>
                </span>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-[12px]" style={dimText}>Sichtbar ab (optional)</label>
                    <input id="recap-window" type="datetime-local" value={toLocalInput(form.startsAt)} onChange={(e) => set('startsAt', fromLocalInput(e.target.value))}
                      aria-invalid={invalid('window')} className="field h-11 w-full px-4 text-[14px]" style={invalid('window') ? invalidStyle : undefined} />
                  </div>
                  <div>
                    <label className="mb-1 block text-[12px]" style={dimText}>Sichtbar bis (optional)</label>
                    <input type="datetime-local" value={toLocalInput(form.endsAt)} onChange={(e) => set('endsAt', fromLocalInput(e.target.value))}
                      aria-invalid={invalid('window')} className="field h-11 w-full px-4 text-[14px]" style={invalid('window') ? invalidStyle : undefined} />
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {[14, 30, 60].map((days) => (
                    <button key={days} type="button"
                      onClick={() => { const start = new Date(); start.setSeconds(0, 0); setForm((f) => ({ ...f, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + days * 86_400_000).toISOString() })); }}
                      className="rounded-full px-2.5 py-1 text-[12px] hover:bg-ink/[0.1]" style={{ background: 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))', color: 'rgb(var(--ink-rgb) / 0.82)' }}>
                      Ab jetzt, {days} Tage
                    </button>
                  ))}
                </div>
              </div>

              <div id="recap-sections" tabIndex={-1}>
                <label className="mb-1.5 block text-[12px]" style={dimText}>Was die Story zeigt</label>
                <div className="grid gap-2 sm:grid-cols-2" style={invalid('sections') ? { ...invalidStyle, borderRadius: 14, padding: 4 } : undefined}>
                  {SECTIONS.map((s) => {
                    const on = form.sections.includes(s.key);
                    return (
                      <button key={s.key} type="button" onClick={() => toggleSection(s.key)} aria-pressed={on}
                        className="flex items-start gap-3 rounded-[14px] p-3.5 text-left transition-colors"
                        style={on ? { background: 'var(--sky-wash)', color: 'var(--sky-deep)' } : { background: 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))' }}>
                        <s.icon size={17} strokeWidth={1.7} className="mt-0.5 shrink-0" />
                        <span className="min-w-0">
                          <span className="block text-[13.5px] font-medium">{s.label}</span>
                          <span className="mt-0.5 block text-[12px] leading-snug" style={on ? { opacity: 0.8 } : dimText}>{s.shows}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div id="recap-recipients" tabIndex={-1}>
                <label className="mb-1.5 flex items-center gap-1.5 text-[12px]" style={dimText}>
                  Empfänger
                  <InfoTip>
                    <b>Alle Schüler</b>: jeder Schüler {ownSchool ? `von ${ownSchool.name}` : 'aller Schulen'}. <b>Nur ausgewählte</b>: Schulen, Klassen und
                    einzelne Schüler, beliebig gemischt. Der Server entscheidet anhand der Anmeldung; wer nicht gemeint ist, sieht die Recap nie.
                  </InfoTip>
                </label>
                <Segmented
                  value={targeted ? 'chosen' : 'everyone'}
                  onChange={(v) => setTargeted(v === 'chosen')}
                  options={[
                    { value: 'everyone', label: 'Alle Schüler', icon: <Users size={14} /> },
                    { value: 'chosen', label: 'Nur ausgewählte', icon: <Target size={14} /> },
                  ]}
                />
                {targeted && (
                  <div className="mt-3">
                    <RecapRecipientPicker
                      lockedSchool={ownSchool}
                      schools={schools}
                      classes={classes}
                      users={users}
                      onSchools={setSchools}
                      onClasses={setClasses}
                      onUsers={setUsers}
                      invalid={invalid('recipients')}
                    />
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <label className="flex items-center gap-2 text-[13px]" style={{ color: 'rgb(var(--ink-rgb) / 0.86)' }}>
                  <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Aktiviert
                </label>
                {editingId && (
                  <label className="flex items-center gap-2 text-[13px]" style={{ color: 'rgb(var(--ink-rgb) / 0.86)' }}>
                    <input type="checkbox" checked={form.resetSeen} onChange={(e) => set('resetSeen', e.target.checked)} />
                    Allen wieder als neu zeigen (öffnet sich erneut)
                  </label>
                )}
              </div>

              {showProblems && (
                <Notice tone="rose" icon={AlertTriangle}>
                  <p className="font-medium">{editingId ? 'Noch nicht gespeichert' : 'Noch nicht erstellt'} — bitte ergänzen:</p>
                  <ul className="mt-1 list-disc pl-5">
                    {problems.map((p) => <li key={p.message}>{p.message}</li>)}
                  </ul>
                </Notice>
              )}

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button type="button" onClick={() => void save()} disabled={saving} className="btn btn-primary">
                  <Save size={16} strokeWidth={1.7} /> {saving ? 'Speichert…' : editingId ? 'Speichern' : 'Recap erstellen'}
                </button>
                <button type="button" onClick={() => setEditingId(null)} className="btn btn-quiet">Abbrechen</button>
              </div>
            </div>

            <StoryOutline title={form.title} from={form.periodFrom} to={form.periodTo} sections={form.sections} />
          </div>
        </div>
      )}

      <div className="mt-[46px]">
        <h2 className="mb-3 text-[20px] font-semibold">Alle Recaps</h2>
        {loading ? (
          <div className="flex flex-col gap-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-14 rounded-[12px] shimmer" />)}</div>
        ) : recaps.length === 0 ? (
          <p className="py-8 text-center text-[13px]" style={dimText}>Noch keine Recaps. Erstelle eine mit „Neue Recap“.</p>
        ) : (
          <div className="stack">
            {recaps.map((r) => (
              <div key={r.id} className="spot flex items-center gap-4 py-[18px]" style={{ opacity: r.enabled ? 1 : 0.6 }}>
                <span className="orb h-12 w-12"><Sparkles size={19} strokeWidth={1.6} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[14.5px] font-medium">{r.title}</span>
                    <Badge color={STATUS[r.status].color}>{STATUS[r.status].label}</Badge>
                    {recipientSummary(r) ? (
                      <Badge color="var(--sky-deep)">
                        {r.targetSchools.length > 0 ? <School size={11} /> : r.targetClasses.length > 0 ? <GraduationCap size={11} /> : <UserRound size={11} />}
                        {recipientSummary(r)}
                      </Badge>
                    ) : (
                      <Badge color="var(--violet-deep)"><Users size={11} />{r.schoolName ? `Alle in ${r.schoolName}` : 'Alle Schüler'}</Badge>
                    )}
                  </div>
                  <div className="mt-1 truncate text-[13px] text-ink-3">
                    {dayText(r.periodFrom)} – {dayText(r.periodTo)} · {windowSummary(r)}
                  </div>
                  <div className="mt-0.5 truncate text-[12.5px]" style={dimText}>
                    erreicht {r.reached} · geöffnet {r.opened} · bis zum Ende {r.finished}
                  </div>
                </div>
                {mayManage && (
                  <div className="flex flex-shrink-0 items-center gap-1">
                    <IconBtn label={r.enabled ? 'Deaktivieren' : 'Aktivieren'} color={r.enabled ? 'var(--mint-deep)' : 'rgb(var(--ink-rgb) / 0.58)'} onClick={() => void toggle(r)}><Power size={15} /></IconBtn>
                    <IconBtn label="Bearbeiten" color="rgb(var(--ink-rgb) / 0.82)" onClick={() => openEdit(r)}><Pencil size={15} /></IconBtn>
                    <IconBtn label="Löschen" color="var(--rose-deep)" onClick={() => void remove(r)}><Trash2 size={15} /></IconBtn>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// What the student will step through, page by page, for the chosen parts.
const PAGES: Record<RecapSection, string[]> = {
  school: ['Stunden in der Schule', 'Lieblingsfach', 'Häufigster Lehrer & Raum', 'Längster Tag', 'Entfälle & Vertretungen'],
  absences: ['Fehlquote — Reaktion je nach Wert', 'Fehlstunden & Entschuldigungen', 'Meistverpasstes Fach & Wochentag'],
  grades: ['Noten & Durchschnitt', 'Bestes Fach & beste Note'],
  exams: ['Prüfungen & Hausaufgaben'],
  classreg: ['Klassenbuch'],
  pokyh: ['Tage in POKYH & Serie', 'Wann du online bist', 'Was du in POKYH gemacht hast', '„Top x %“ deiner Schule'],
};

// The outline in the story's own look (pixel art, solid colours): a night
// sky with the steps, the ground below.
const PIXEL_CORNERS = 'polygon(0 8px, 4px 8px, 4px 4px, 8px 4px, 8px 0, calc(100% - 8px) 0, calc(100% - 8px) 4px, calc(100% - 4px) 4px, calc(100% - 4px) 8px, 100% 8px, 100% calc(100% - 8px), calc(100% - 4px) calc(100% - 8px), calc(100% - 4px) calc(100% - 4px), calc(100% - 8px) calc(100% - 4px), calc(100% - 8px) 100%, 8px 100%, 8px calc(100% - 4px), 4px calc(100% - 4px), 4px calc(100% - 8px), 0 calc(100% - 8px))';

function StoryOutline({ title, from, to, sections }: { title: string; from: string; to: string; sections: RecapSection[] }) {
  let n = 1;
  return (
    <div className="min-w-0">
      <p className="mb-3 text-[12px]" style={dimText}>So läuft die Story ab</p>
      <div style={{ background: '#1b1640', clipPath: PIXEL_CORNERS }}>
        <div className="p-5">
          <p className="text-[12px]" style={{ color: '#a9a3d9' }}>{from && to ? `${dayText(from)} – ${dayText(to)}` : 'Zeitraum fehlt'}</p>
          <p className="mt-1 text-[19px] font-semibold leading-tight" style={{ color: '#ffd166' }}>{title.trim() || 'Ohne Titel'}</p>
          <ol className="mt-4 flex flex-col gap-1.5">
            <li className="text-[12.5px]" style={{ color: '#cfc9ff' }}>{n++}. Begrüßung mit dem Maskottchen</li>
            {SECTIONS.filter((s) => sections.includes(s.key)).flatMap((s) => PAGES[s.key].map((page) => (
              <li key={`${s.key}-${page}`} className="flex items-center gap-2 text-[12.5px]" style={{ color: '#e9e6ff' }}>
                <s.icon size={12} strokeWidth={1.8} className="shrink-0" style={{ color: '#8f88c9' }} />
                {n++}. {page}
              </li>
            )))}
            <li className="text-[12.5px]" style={{ color: '#cfc9ff' }}>{n++}. Karte zum Teilen: 5 Designs, Pose und Zahlen wählbar, als PNG oder geteilt mit Link</li>
          </ol>
          <p className="mt-4 text-[11.5px] leading-snug" style={{ color: '#8f88c9' }}>
            Seiten ohne Daten (z. B. keine Noten im Zeitraum, POKYH-Zeit ohne Einwilligung) werden übersprungen. Die Zahlen sieht nur der Schüler selbst.
          </p>
        </div>
        <div style={{ height: 6, background: '#3d3488' }} />
        <div style={{ height: 18, background: '#2c2566' }} />
      </div>
    </div>
  );
}

function Segmented<T extends string>({ value, onChange, options }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: React.ReactNode }[];
}) {
  return (
    <div>
      <KitSegmented
        label="Auswahl"
        value={value}
        onChange={onChange}
        options={options.map((o) => ({ value: o.value, label: <>{o.icon}{o.label}</> }))}
      />
    </div>
  );
}

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-[3px] text-[12px] font-medium"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}>
      {children}
    </span>
  );
}

function IconBtn({ label, color, onClick, children }: { label: string; color: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} className="orb icon-btn h-[38px] w-[38px]" data-tone="ink" style={{ color }}>
      {children}
    </button>
  );
}
