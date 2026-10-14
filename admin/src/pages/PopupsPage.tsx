import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarClock, Globe, GraduationCap, Layers, LogIn, Megaphone, Moon, Pencil, Plus, Power, Save, Smartphone, Sun, Target, Trash2, UserRound, Users, X } from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { useLive } from '../live';
import { Figures, Notice, PageHeader, Segmented as KitSegmented } from '../components/kit';
import { PopupEditor } from '../components/popups/PopupEditor';
import { RecipientPicker } from '../components/popups/RecipientPicker';
import { InfoTip } from '../components/cluster/explain';
import { AndroidPopupPreview, WebPopupPreview, type PreviewTheme } from '../components/popups/PopupPreview';
import type { AdminPopup, PopupAudience, PopupInput, PopupMode, PopupPlatform, PopupStatus, PopupTargetUser } from '../types';

const dimText = { color: 'rgb(var(--ink-rgb) / 0.62)' };

const PLATFORM_LABEL: Record<PopupPlatform, string> = { all: 'Alle', android: 'Android', web: 'Website' };
const AUDIENCE_LABEL: Record<PopupAudience, string> = { all: 'Alle Besucher', users: 'Eingeloggt', guests: 'Gäste' };
const STATUS: Record<PopupStatus, { label: string; color: string }> = {
  active: { label: 'Aktiv', color: 'var(--mint-deep)' },
  scheduled: { label: 'Geplant', color: 'var(--sky-deep)' },
  expired: { label: 'Abgelaufen', color: 'rgb(var(--ink-rgb) / 0.58)' },
  disabled: { label: 'Deaktiviert', color: 'var(--amber-deep)' },
};

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

function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} Min.`;
  const h = ms / 3_600_000;
  if (h < 24) return `${Number.isInteger(h) ? h : h.toFixed(1)} Std.`;
  const d = ms / 86_400_000;
  return `${Number.isInteger(d) ? d : d.toFixed(1)} ${d === 1 ? 'Tag' : 'Tage'}`;
}

function scheduleSummary(p: { mode: PopupMode; showCount: number; startsAt: string | null; endsAt: string | null }): string {
  const fmt = (iso: string) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
  const range = p.startsAt && p.endsAt ? `${fmt(p.startsAt)} – ${fmt(p.endsAt)}`
    : p.startsAt ? `ab ${fmt(p.startsAt)}`
    : p.endsAt ? `bis ${fmt(p.endsAt)}` : 'ohne Zeitlimit';
  if (p.mode === 'once') return `Einmal anzeigen · ${range}`;
  if (!p.startsAt || !p.endsAt) return `${p.showCount}× · ${range}`;
  const slot = (new Date(p.endsAt).getTime() - new Date(p.startsAt).getTime()) / p.showCount;
  return `${p.showCount}× · höchstens 1× alle ${formatDuration(slot)} · ${range}`;
}

const EMPTY: PopupInput = {
  title: '', content: '', platform: 'all', audience: 'all', mode: 'once', showCount: 7,
  startsAt: null, endsAt: null, enabled: true, targetUsers: [], targetClasses: [],
};

// "3 Personen · 2 Klassen" for the list.
function recipientSummary(p: AdminPopup): string {
  const parts: string[] = [];
  if (p.targetClasses.length > 0) parts.push(p.targetClasses.length === 1 ? `Klasse ${p.targetClasses[0]!.name}` : `${p.targetClasses.length} Klassen`);
  if (p.targetUsers.length > 0) parts.push(p.targetUsers.length === 1 ? p.targetUsers[0]!.username : `${p.targetUsers.length} Personen`);
  return parts.join(' · ');
}

export function PopupsPage() {
  const { showToast } = useToast();
  const [popups, setPopups] = useState<AdminPopup[]>([]);
  const [loading, setLoading] = useState(true);
  // null = editor closed, '' = new popup, otherwise the id being edited
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<PopupInput>(EMPTY);
  const [html, setHtml] = useState('');
  const [saving, setSaving] = useState(false);
  // Missing fields are pointed out once saving was attempted, not while typing.
  const [attempted, setAttempted] = useState(false);
  const [previewTheme, setPreviewTheme] = useState<PreviewTheme>('light');
  const [previewTarget, setPreviewTarget] = useState<'android' | 'web'>('android');
  // Recipients: everybody (by platform and audience) or only chosen ones.
  const [targeted, setTargeted] = useState(false);
  const [recipients, setRecipients] = useState<PopupTargetUser[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await adminApi.getPopups();
      setPopups(res.popups);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Laden fehlgeschlagen', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void load(); }, [load]);
  useLive(['popups'], () => { void load(); });

  // Debounced server render — the preview shows exactly what clients receive.
  useEffect(() => {
    if (editingId === null) return;
    const handle = setTimeout(() => {
      adminApi.renderPopup(form.content).then((r) => setHtml(r.html)).catch(() => { /* keep last preview */ });
    }, 250);
    return () => clearTimeout(handle);
  }, [form.content, editingId]);

  function set<K extends keyof PopupInput>(key: K, value: PopupInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function openNew() {
    setAttempted(false);
    setForm({ ...EMPTY });
    setTargeted(false);
    setRecipients([]);
    setHtml('');
    setEditingId('');
    requestAnimationFrame(() => document.getElementById('popup-editor')?.scrollIntoView({ behavior: 'smooth' }));
  }

  function openEdit(p: AdminPopup) {
    setAttempted(false);
    setForm({
      title: p.title, content: p.content, platform: p.platform, audience: p.audience, mode: p.mode,
      showCount: p.mode === 'once' ? 7 : p.showCount, startsAt: p.startsAt, endsAt: p.endsAt, enabled: p.enabled, resetSeen: false,
      targetUsers: p.targetUsers.map((user) => user.stableUid), targetClasses: p.targetClasses.map((entry) => entry.id),
    });
    setTargeted(p.targetUsers.length > 0 || p.targetClasses.length > 0);
    setRecipients(p.targetUsers);
    setHtml(p.contentHtml);
    setEditingId(p.id);
    if (p.platform === 'web') setPreviewTarget('web');
    else if (p.platform === 'android') setPreviewTarget('android');
    requestAnimationFrame(() => document.getElementById('popup-editor')?.scrollIntoView({ behavior: 'smooth' }));
  }

  function setMode(mode: PopupMode) {
    setForm((f) => {
      if (mode === 'recurring' && (!f.startsAt || !f.endsAt)) {
        const start = f.startsAt ? new Date(f.startsAt) : new Date();
        start.setSeconds(0, 0);
        const end = f.endsAt ? new Date(f.endsAt) : new Date(start.getTime() + 7 * 86_400_000);
        return { ...f, mode, startsAt: start.toISOString(), endsAt: end.toISOString() };
      }
      return { ...f, mode };
    });
  }

  // Everything still missing before the popup can be saved, each with the
  // field it belongs to. Only the title is required; the text may be empty.
  const problems = useMemo(() => {
    const list: Array<{ field: 'title' | 'schedule' | 'showCount' | 'recipients'; message: string }> = [];
    if (!form.title.trim()) list.push({ field: 'title', message: 'Titel eingeben — er erscheint als Überschrift des Popups.' });
    if (targeted && recipients.length === 0 && form.targetClasses.length === 0) {
      list.push({ field: 'recipients', message: 'Mindestens eine Klasse oder einen Benutzer auswählen — oder „Alle“ wählen.' });
    }
    if (form.startsAt && form.endsAt && new Date(form.endsAt) <= new Date(form.startsAt)) {
      list.push({ field: 'schedule', message: 'Das Ende muss nach dem Start liegen.' });
    }
    if (form.mode === 'recurring') {
      if (!form.startsAt || !form.endsAt) list.push({ field: 'schedule', message: 'Für „Mehrmals im Zeitraum“ Start und Ende angeben.' });
      if (form.showCount < 2) list.push({ field: 'showCount', message: 'Für „Mehrmals im Zeitraum“ mindestens 2 Anzeigen wählen.' });
    }
    return list;
  }, [form, targeted, recipients]);
  const showProblems = attempted && problems.length > 0;
  const invalid = (field: 'title' | 'schedule' | 'showCount' | 'recipients') => showProblems && problems.some((problem) => problem.field === field);
  const invalidStyle: React.CSSProperties = { boxShadow: 'inset 0 0 0 1.5px var(--rose-deep)' };

  async function save() {
    if (problems.length > 0) {
      setAttempted(true);
      const first = problems[0]!.field;
      const id = first === 'title' ? 'popup-title' : first === 'showCount' ? 'popup-show-count' : first === 'recipients' ? 'popup-recipients' : 'popup-starts-at';
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      document.getElementById(id)?.focus();
      return;
    }
    setSaving(true);
    try {
      // Android has no guests, so its audience is irrelevant — store the neutral value.
      const payload: PopupInput = {
        ...form,
        // Chosen recipients are signed in by definition.
        audience: targeted ? 'users' : form.platform === 'android' ? 'all' : form.audience,
        showCount: form.mode === 'once' ? 1 : form.showCount,
        targetUsers: targeted ? recipients.map((user) => user.stableUid) : [],
        targetClasses: targeted ? form.targetClasses : [],
      };
      if (editingId) await adminApi.updatePopup(editingId, payload);
      else await adminApi.createPopup(payload);
      showToast(editingId ? 'Popup gespeichert' : 'Popup erstellt', 'success');
      setEditingId(null);
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Speichern fehlgeschlagen', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function toggle(p: AdminPopup) {
    try {
      await adminApi.setPopupEnabled(p.id, !p.enabled);
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Fehlgeschlagen', 'error');
    }
  }

  async function remove(p: AdminPopup) {
    if (!window.confirm(`Popup "${p.title}" wirklich löschen?`)) return;
    try {
      await adminApi.deletePopup(p.id);
      if (editingId === p.id) setEditingId(null);
      showToast('Popup gelöscht', 'success');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Löschen fehlgeschlagen', 'error');
    }
  }

  const slotHint = form.mode === 'recurring' && form.startsAt && form.endsAt && form.showCount >= 2 && new Date(form.endsAt) > new Date(form.startsAt)
    ? `→ höchstens 1× alle ${formatDuration((new Date(form.endsAt).getTime() - new Date(form.startsAt).getTime()) / form.showCount)}. Verpasste Anzeigen werden nicht nachgeholt, nach dem Ende erscheint das Popup nicht mehr.`
    : null;

  return (
    <div>
      <PageHeader title="Popups" subtitle="Mitteilungen, die in der Android-App und/oder auf der Website als Popup erscheinen.">
        <button type="button" onClick={openNew} className="btn btn-primary">
          <Plus size={16} strokeWidth={1.8} /> Neues Popup
        </button>
      </PageHeader>

      <Figures
        className="mt-10"
        items={[
          { label: 'Popups', value: popups.length, icon: Megaphone },
          { label: 'Aktiv', value: popups.filter((p) => p.status === 'active').length, icon: Power },
          { label: 'Geplant', value: popups.filter((p) => p.status === 'scheduled').length, icon: CalendarClock },
        ]}
      />

      {editingId !== null && (
        <div id="popup-editor" className="animate-fadeInUp mt-10 scroll-mt-4 rounded-[26px] bg-well p-6 sm:p-8">
          <div className="mb-6 flex items-center justify-between">
            <div className="flex items-center gap-3.5">
              <span className="orb orb-white h-11 w-11"><Megaphone size={18} strokeWidth={1.6} /></span>
              <h2 className="text-[17px] font-semibold">{editingId ? 'Popup bearbeiten' : 'Neues Popup'}</h2>
            </div>
            <button type="button" onClick={() => setEditingId(null)} className="orb orb-white h-9 w-9" aria-label="Schließen"><X size={16} strokeWidth={1.7} /></button>
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,520px)]">
            {/* ── Form ── */}
            <div className="flex flex-col gap-4 min-w-0">
              <div>
                <label className="text-[12px] block mb-1.5" style={dimText}>Anzeigen auf</label>
                <Segmented
                  value={form.platform}
                  onChange={(v) => { set('platform', v); if (v !== 'all') setPreviewTarget(v); }}
                  options={[
                    { value: 'all', label: 'Alle', icon: <Layers size={14} /> },
                    { value: 'android', label: 'Android', icon: <Smartphone size={14} /> },
                    { value: 'web', label: 'Website', icon: <Globe size={14} /> },
                  ]}
                />
              </div>

              <div id="popup-recipients" tabIndex={-1}>
                <label className="mb-1.5 flex items-center gap-1.5 text-[12px]" style={dimText}>
                  Empfänger
                  <InfoTip>
                    <b>Alle</b>: jeder, den Plattform und Zielgruppe erlauben. <b>Nur ausgewählte</b>: das Popup erscheint ausschließlich bei den
                    gewählten Klassen und Benutzern (beliebig viele von beiden) — nur angemeldet, Gäste sehen es nie. Der Server entscheidet anhand
                    der Anmeldung; niemand sonst bekommt das Popup überhaupt zu sehen.
                  </InfoTip>
                </label>
                <Segmented
                  value={targeted ? 'chosen' : 'everyone'}
                  onChange={(v) => setTargeted(v === 'chosen')}
                  options={[
                    { value: 'everyone', label: 'Alle', icon: <Users size={14} /> },
                    { value: 'chosen', label: 'Nur ausgewählte', icon: <Target size={14} /> },
                  ]}
                />
                {targeted && (
                  <div className="mt-3">
                    <RecipientPicker
                      users={recipients}
                      classes={form.targetClasses}
                      onUsers={setRecipients}
                      onClasses={(next) => set('targetClasses', next)}
                      invalid={invalid('recipients')}
                    />
                  </div>
                )}
              </div>

              {form.platform !== 'android' && !targeted && (
                <div>
                  <label className="text-[12px] block mb-1.5" style={dimText}>Zielgruppe (Website)</label>
                  <Segmented
                    value={form.audience}
                    onChange={(v) => set('audience', v)}
                    options={[
                      { value: 'all', label: 'Beide', icon: <Users size={14} /> },
                      { value: 'users', label: 'Eingeloggt', icon: <UserRound size={14} /> },
                      { value: 'guests', label: 'Gäste', icon: <LogIn size={14} /> },
                    ]}
                  />
                  <p className="text-[11.5px] mt-1.5" style={dimText}>
                    {form.audience === 'guests'
                      ? 'Nur für nicht angemeldete Besucher (Startseite, Login, Mensa). In der Android-App erscheint es daher nicht.'
                      : form.audience === 'users'
                        ? 'Nur für angemeldete Nutzer.'
                        : 'Für angemeldete Nutzer und Gäste. In der Android-App ist man immer angemeldet.'}
                  </p>
                </div>
              )}

              <div>
                <label htmlFor="popup-title" className="text-[12px] block mb-1.5" style={dimText}>Titel <span style={{ color: 'var(--rose-deep)' }}>*</span></label>
                <input id="popup-title" value={form.title} maxLength={200} onChange={(e) => set('title', e.target.value)}
                  placeholder="z. B. Neue Funktion: Mensa-Bewertungen"
                  aria-invalid={invalid('title')} aria-describedby={invalid('title') ? 'popup-problems' : undefined}
                  className="field h-11 px-4 text-[14px] w-full" style={invalid('title') ? invalidStyle : undefined} />
              </div>

              <div>
                <label className="text-[12px] block mb-1.5" style={dimText}>Text (optional)</label>
                <PopupEditor value={form.content} onChange={(v) => set('content', v)} />
                <p className="text-[11.5px] mt-1.5" style={dimText}>
                  Darf leer bleiben — dann zeigt das Popup nur den Titel. GitHub-Markdown und HTML werden unterstützt; ein Bild-Link (…png/jpg/gif/webp) wird automatisch als Bild angezeigt.
                </p>
              </div>

              <div className="rounded-[14px] p-4 flex flex-col gap-3" style={{ background: '#141416', border: '1px solid transparent' }}>
                <label className="text-[12px] block" style={dimText}>Häufigkeit</label>
                <Segmented
                  value={form.mode}
                  onChange={setMode}
                  options={[
                    { value: 'once', label: 'Einmal anzeigen' },
                    { value: 'recurring', label: 'Mehrmals im Zeitraum' },
                  ]}
                />

                {form.mode === 'recurring' && (
                  <div className="flex items-center gap-2 text-[13px]" style={{ color: 'rgb(var(--ink-rgb) / 0.86)' }}>
                    <input id="popup-show-count" type="number" min={2} max={1000} value={form.showCount}
                      onChange={(e) => set('showCount', Math.max(1, Number(e.target.value) || 1))}
                      aria-invalid={invalid('showCount')}
                      className="field h-11 px-4 text-[14px] w-24" style={invalid('showCount') ? invalidStyle : undefined} />
                    <span>× anzeigen zwischen Start und Ende</span>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[12px] block mb-1" style={dimText}>Start {form.mode === 'once' && '(optional)'}</label>
                    <input id="popup-starts-at" type="datetime-local" value={toLocalInput(form.startsAt)} onChange={(e) => set('startsAt', fromLocalInput(e.target.value))}
                      aria-invalid={invalid('schedule')}
                      className="field h-11 px-4 text-[14px] w-full" style={invalid('schedule') ? invalidStyle : undefined} />
                  </div>
                  <div>
                    <label className="text-[12px] block mb-1" style={dimText}>Ende {form.mode === 'once' && '(optional)'}</label>
                    <input type="datetime-local" value={toLocalInput(form.endsAt)} onChange={(e) => set('endsAt', fromLocalInput(e.target.value))}
                      aria-invalid={invalid('schedule')}
                      className="field h-11 px-4 text-[14px] w-full" style={invalid('schedule') ? invalidStyle : undefined} />
                  </div>
                </div>
                {form.mode === 'recurring' && (
                  <div className="flex flex-wrap gap-1.5">
                    {[3, 7, 14, 30].map((days) => (
                      <button key={days} type="button"
                        onClick={() => {
                          const start = form.startsAt ? new Date(form.startsAt) : new Date();
                          setForm((f) => ({ ...f, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + days * 86_400_000).toISOString(), showCount: days }));
                        }}
                        className="px-2.5 py-1 rounded-full text-[12px] hover:bg-ink/[0.1]" style={{ background: 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))', color: 'rgb(var(--ink-rgb) / 0.82)' }}>
                        {days}× in {days} Tagen
                      </button>
                    ))}
                  </div>
                )}
                {slotHint && <p className="text-[12px]" style={{ color: 'var(--mint-deep)' }}>{slotHint}</p>}
                {form.mode === 'once' && (
                  <p className="text-[12px]" style={dimText}>Jedes Gerät sieht das Popup genau einmal{form.endsAt ? ', aber nur bis zum Ende' : ''}.</p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <label className="flex items-center gap-2 text-[13px]" style={{ color: 'rgb(var(--ink-rgb) / 0.86)' }}>
                  <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Aktiviert
                </label>
                {editingId && (
                  <label className="flex items-center gap-2 text-[13px]" style={{ color: 'rgb(var(--ink-rgb) / 0.86)' }}>
                    <input type="checkbox" checked={!!form.resetSeen} onChange={(e) => set('resetSeen', e.target.checked)} />
                    Allen erneut anzeigen (als ungesehen markieren)
                  </label>
                )}
              </div>

              {showProblems && (
                <div id="popup-problems">
                  <Notice tone="rose" icon={AlertTriangle}>
                    <p className="font-medium">{editingId ? 'Noch nicht gespeichert' : 'Noch nicht erstellt'} — bitte ergänzen:</p>
                    <ul className="mt-1 list-disc pl-5">
                      {problems.map((problem) => <li key={problem.message}>{problem.message}</li>)}
                    </ul>
                  </Notice>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button type="button" onClick={() => void save()} disabled={saving} className="btn btn-primary">
                  <Save size={16} strokeWidth={1.7} /> {saving ? 'Speichert…' : editingId ? 'Speichern' : 'Popup erstellen'}
                </button>
                <button type="button" onClick={() => setEditingId(null)} className="btn btn-quiet">Abbrechen</button>
              </div>
            </div>

            {/* ── Preview ── */}
            <div className="min-w-0">
              <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
                <Segmented
                  value={previewTarget}
                  onChange={setPreviewTarget}
                  options={[
                    { value: 'android', label: 'Handy', icon: <Smartphone size={14} /> },
                    { value: 'web', label: 'Web', icon: <Globe size={14} /> },
                  ]}
                />
                <Segmented
                  value={previewTheme}
                  onChange={setPreviewTheme}
                  options={[
                    { value: 'light', label: 'Hell', icon: <Sun size={14} /> },
                    { value: 'dark', label: 'Dunkel', icon: <Moon size={14} /> },
                  ]}
                />
              </div>
              {form.platform !== 'all' && form.platform !== previewTarget && (
                <p className="text-[12px] mb-2" style={{ color: 'var(--amber-deep)' }}>
                  Hinweis: Dieses Popup wird nur auf {PLATFORM_LABEL[form.platform]} angezeigt.
                </p>
              )}
              <div className="rounded-[14px] p-5" style={{ background: 'repeating-conic-gradient(#121214 0% 25%, #0f0f11 0% 50%) 50% / 24px 24px' }}>
                {previewTarget === 'android'
                  ? <AndroidPopupPreview title={form.title} html={html} theme={previewTheme} />
                  : <WebPopupPreview title={form.title} html={html} theme={previewTheme} />}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="mt-[46px]">
        <h2 className="mb-3 text-[20px] font-semibold">Alle Popups</h2>
        {loading ? (
          <div className="flex flex-col gap-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-14 rounded-[12px] shimmer" />)}</div>
        ) : popups.length === 0 ? (
          <p className="text-[13px] text-center py-8" style={dimText}>Noch keine Popups. Erstelle eins mit „Neues Popup“.</p>
        ) : (
          <div className="stack">
            {popups.map((p) => (
              <div key={p.id} className="spot flex items-center gap-4 py-[18px]" style={{ opacity: p.enabled ? 1 : 0.6 }}>
                <span className="orb h-12 w-12"><Megaphone size={19} strokeWidth={1.6} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="truncate text-[14.5px] font-medium">{p.title}</span>
                    <Badge color={STATUS[p.status].color}>{STATUS[p.status].label}</Badge>
                    <Badge color="var(--violet-deep)">
                      {p.platform === 'android' ? <Smartphone size={11} /> : p.platform === 'web' ? <Globe size={11} /> : <Layers size={11} />}
                      {PLATFORM_LABEL[p.platform]}
                    </Badge>
                    {(p.targetUsers.length > 0 || p.targetClasses.length > 0) && (
                      <Badge color="var(--sky-deep)">
                        {p.targetClasses.length > 0 ? <GraduationCap size={11} /> : <Target size={11} />}
                        {recipientSummary(p)}
                      </Badge>
                    )}
                    {p.platform !== 'android' && p.audience !== 'all' && p.targetUsers.length === 0 && p.targetClasses.length === 0 && (
                      <Badge color="var(--teal-deep)">
                        {p.audience === 'guests' ? <LogIn size={11} /> : <UserRound size={11} />}
                        {AUDIENCE_LABEL[p.audience]}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 truncate text-[13px] text-ink-3">{scheduleSummary(p)}</div>
                </div>
                <div className="flex-shrink-0 flex items-center gap-1">
                  <IconBtn label={p.enabled ? 'Deaktivieren' : 'Aktivieren'} color={p.enabled ? 'var(--mint-deep)' : 'rgb(var(--ink-rgb) / 0.58)'} onClick={() => void toggle(p)}><Power size={15} /></IconBtn>
                  <IconBtn label="Bearbeiten" color="rgb(var(--ink-rgb) / 0.82)" onClick={() => openEdit(p)}><Pencil size={15} /></IconBtn>
                  <IconBtn label="Löschen" color="var(--rose-deep)" onClick={() => void remove(p)}><Trash2 size={15} /></IconBtn>
                </div>
              </div>
            ))}
          </div>
        )}
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
