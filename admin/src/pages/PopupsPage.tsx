import { useCallback, useEffect, useMemo, useState } from 'react';
import { Globe, Layers, LogIn, Megaphone, Moon, Pencil, Plus, Power, Save, Smartphone, Sun, Trash2, UserRound, Users, X } from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { PopupEditor } from '../components/popups/PopupEditor';
import { AndroidPopupPreview, WebPopupPreview, type PreviewTheme } from '../components/popups/PopupPreview';
import type { AdminPopup, PopupAudience, PopupInput, PopupMode, PopupPlatform, PopupStatus } from '../types';

const inputStyle: React.CSSProperties = { background: '#1c1c1e', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(235,235,245,0.85)' };
const dimText = { color: 'rgba(235,235,245,0.45)' };
const blueBtn: React.CSSProperties = { background: 'rgba(10,132,255,0.15)', color: '#0a84ff', border: '1px solid rgba(10,132,255,0.25)' };

const PLATFORM_LABEL: Record<PopupPlatform, string> = { all: 'Alle', android: 'Android', web: 'Website' };
const AUDIENCE_LABEL: Record<PopupAudience, string> = { all: 'Alle Besucher', users: 'Eingeloggt', guests: 'Gäste' };
const STATUS: Record<PopupStatus, { label: string; color: string }> = {
  active: { label: 'Aktiv', color: '#30d158' },
  scheduled: { label: 'Geplant', color: '#0a84ff' },
  expired: { label: 'Abgelaufen', color: 'rgba(235,235,245,0.4)' },
  disabled: { label: 'Deaktiviert', color: '#ff9f0a' },
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
  startsAt: null, endsAt: null, enabled: true,
};

export function PopupsPage() {
  const { showToast } = useToast();
  const [popups, setPopups] = useState<AdminPopup[]>([]);
  const [loading, setLoading] = useState(true);
  // null = editor closed, '' = new popup, otherwise the id being edited
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<PopupInput>(EMPTY);
  const [html, setHtml] = useState('');
  const [saving, setSaving] = useState(false);
  const [previewTheme, setPreviewTheme] = useState<PreviewTheme>('light');
  const [previewTarget, setPreviewTarget] = useState<'android' | 'web'>('android');

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
    setForm({ ...EMPTY });
    setHtml('');
    setEditingId('');
    requestAnimationFrame(() => document.getElementById('popup-editor')?.scrollIntoView({ behavior: 'smooth' }));
  }

  function openEdit(p: AdminPopup) {
    setForm({
      title: p.title, content: p.content, platform: p.platform, audience: p.audience, mode: p.mode,
      showCount: p.mode === 'once' ? 7 : p.showCount, startsAt: p.startsAt, endsAt: p.endsAt, enabled: p.enabled, resetSeen: false,
    });
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

  const validation = useMemo(() => {
    if (!form.title.trim()) return 'Titel fehlt';
    if (!form.content.trim()) return 'Text fehlt';
    if (form.startsAt && form.endsAt && new Date(form.endsAt) <= new Date(form.startsAt)) return 'Ende muss nach dem Start liegen';
    if (form.mode === 'recurring') {
      if (!form.startsAt || !form.endsAt) return 'Start und Ende angeben';
      if (form.showCount < 2) return 'Mindestens 2 Anzeigen';
    }
    return null;
  }, [form]);

  async function save() {
    if (validation) { showToast(validation, 'error'); return; }
    setSaving(true);
    try {
      // Android has no guests, so its audience is irrelevant — store the neutral value.
      const payload: PopupInput = {
        ...form,
        audience: form.platform === 'android' ? 'all' : form.audience,
        showCount: form.mode === 'once' ? 1 : form.showCount,
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
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[22px] font-bold text-white tracking-[-0.02em]">Popups</h1>
          <p className="text-[13px] mt-1" style={dimText}>
            Mitteilungen, die in der Android-App und/oder auf der Website als Popup erscheinen.
          </p>
        </div>
        <button onClick={openNew} className="flex items-center gap-2 px-4 py-2.5 rounded-[10px] text-[13px] font-medium" style={blueBtn}>
          <Plus size={14} /> Neues Popup
        </button>
      </div>

      {editingId !== null && (
        <div id="popup-editor" className="rounded-[16px] p-5 mb-6 scroll-mt-4" style={{ background: '#0d0d0d', border: '1px solid rgba(255,255,255,0.07)' }}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              <span style={{ color: '#0a84ff' }}><Megaphone size={17} /></span>
              <h2 className="text-[15px] font-semibold text-white">{editingId ? 'Popup bearbeiten' : 'Neues Popup'}</h2>
            </div>
            <button onClick={() => setEditingId(null)} className="p-2 rounded-[8px] hover:bg-white/[0.06]" style={dimText} aria-label="Schließen"><X size={16} /></button>
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

              {form.platform !== 'android' && (
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
                <label className="text-[12px] block mb-1.5" style={dimText}>Titel</label>
                <input value={form.title} maxLength={200} onChange={(e) => set('title', e.target.value)}
                  placeholder="z. B. Neue Funktion: Mensa-Bewertungen"
                  className="apple-input px-3 py-2.5 text-[14px] w-full" style={inputStyle} />
              </div>

              <div>
                <label className="text-[12px] block mb-1.5" style={dimText}>Text</label>
                <PopupEditor value={form.content} onChange={(v) => set('content', v)} />
                <p className="text-[11.5px] mt-1.5" style={dimText}>
                  GitHub-Markdown und HTML werden unterstützt. Ein Bild-Link (…png/jpg/gif/webp) wird automatisch als Bild angezeigt.
                </p>
              </div>

              <div className="rounded-[12px] p-4 flex flex-col gap-3" style={{ background: '#141416', border: '1px solid rgba(255,255,255,0.06)' }}>
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
                  <div className="flex items-center gap-2 text-[13px]" style={{ color: 'rgba(235,235,245,0.75)' }}>
                    <input type="number" min={2} max={1000} value={form.showCount}
                      onChange={(e) => set('showCount', Math.max(1, Number(e.target.value) || 1))}
                      className="apple-input px-3 py-2 text-[13px] w-24" style={inputStyle} />
                    <span>× anzeigen zwischen Start und Ende</span>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[12px] block mb-1" style={dimText}>Start {form.mode === 'once' && '(optional)'}</label>
                    <input type="datetime-local" value={toLocalInput(form.startsAt)} onChange={(e) => set('startsAt', fromLocalInput(e.target.value))}
                      className="apple-input px-3 py-2 text-[13px] w-full" style={{ ...inputStyle, colorScheme: 'dark' }} />
                  </div>
                  <div>
                    <label className="text-[12px] block mb-1" style={dimText}>Ende {form.mode === 'once' && '(optional)'}</label>
                    <input type="datetime-local" value={toLocalInput(form.endsAt)} onChange={(e) => set('endsAt', fromLocalInput(e.target.value))}
                      className="apple-input px-3 py-2 text-[13px] w-full" style={{ ...inputStyle, colorScheme: 'dark' }} />
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
                        className="px-2.5 py-1 rounded-full text-[12px] hover:bg-white/[0.08]" style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(235,235,245,0.7)' }}>
                        {days}× in {days} Tagen
                      </button>
                    ))}
                  </div>
                )}
                {slotHint && <p className="text-[12px]" style={{ color: '#30d158' }}>{slotHint}</p>}
                {form.mode === 'once' && (
                  <p className="text-[12px]" style={dimText}>Jedes Gerät sieht das Popup genau einmal{form.endsAt ? ', aber nur bis zum Ende' : ''}.</p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <label className="flex items-center gap-2 text-[13px]" style={{ color: 'rgba(235,235,245,0.75)' }}>
                  <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Aktiviert
                </label>
                {editingId && (
                  <label className="flex items-center gap-2 text-[13px]" style={{ color: 'rgba(235,235,245,0.75)' }}>
                    <input type="checkbox" checked={!!form.resetSeen} onChange={(e) => set('resetSeen', e.target.checked)} />
                    Allen erneut anzeigen (als ungesehen markieren)
                  </label>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button onClick={() => void save()} disabled={saving}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-[10px] text-[13px] font-medium disabled:opacity-50" style={blueBtn}>
                  <Save size={14} /> {saving ? 'Speichert…' : editingId ? 'Speichern' : 'Erstellen'}
                </button>
                <button onClick={() => setEditingId(null)} className="px-4 py-2.5 rounded-[10px] text-[13px]" style={dimText}>Abbrechen</button>
                {validation && <span className="text-[12px]" style={{ color: '#ff9f0a' }}>{validation}</span>}
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
                <p className="text-[12px] mb-2" style={{ color: '#ff9f0a' }}>
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

      <div className="rounded-[16px] p-5" style={{ background: '#0d0d0d', border: '1px solid rgba(255,255,255,0.07)' }}>
        <h2 className="text-[15px] font-semibold text-white mb-4">Alle Popups ({popups.length})</h2>
        {loading ? (
          <div className="flex flex-col gap-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-14 rounded-[10px] shimmer" />)}</div>
        ) : popups.length === 0 ? (
          <p className="text-[13px] text-center py-8" style={dimText}>Noch keine Popups. Erstelle eins mit „Neues Popup“.</p>
        ) : (
          <div className="flex flex-col divide-y divide-white/[0.06]">
            {popups.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[14px] font-medium text-white truncate">{p.title}</span>
                    <Badge color={STATUS[p.status].color}>{STATUS[p.status].label}</Badge>
                    <Badge color="#bf5af2">
                      {p.platform === 'android' ? <Smartphone size={11} /> : p.platform === 'web' ? <Globe size={11} /> : <Layers size={11} />}
                      {PLATFORM_LABEL[p.platform]}
                    </Badge>
                    {p.platform !== 'android' && p.audience !== 'all' && (
                      <Badge color="#40c8e0">
                        {p.audience === 'guests' ? <LogIn size={11} /> : <UserRound size={11} />}
                        {AUDIENCE_LABEL[p.audience]}
                      </Badge>
                    )}
                  </div>
                  <div className="text-[12px] mt-0.5 truncate" style={dimText}>{scheduleSummary(p)}</div>
                </div>
                <div className="flex-shrink-0 flex items-center gap-1">
                  <IconBtn label={p.enabled ? 'Deaktivieren' : 'Aktivieren'} color={p.enabled ? '#30d158' : 'rgba(235,235,245,0.4)'} onClick={() => void toggle(p)}><Power size={15} /></IconBtn>
                  <IconBtn label="Bearbeiten" color="rgba(235,235,245,0.7)" onClick={() => openEdit(p)}><Pencil size={15} /></IconBtn>
                  <IconBtn label="Löschen" color="#ff453a" onClick={() => void remove(p)}><Trash2 size={15} /></IconBtn>
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
    <div className="inline-flex p-1 rounded-[10px] gap-1" style={{ background: '#1c1c1e' }}>
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[13px] font-medium transition-colors"
          style={value === o.value
            ? { background: 'rgba(10,132,255,0.2)', color: '#0a84ff' }
            : { color: 'rgba(235,235,245,0.6)' }}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  );
}

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium"
      style={{ color, background: 'rgba(255,255,255,0.06)' }}>
      {children}
    </span>
  );
}

function IconBtn({ label, color, onClick, children }: { label: string; color: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} className="p-2 rounded-[8px] transition-colors hover:bg-white/[0.06]" style={{ color }}>
      {children}
    </button>
  );
}
