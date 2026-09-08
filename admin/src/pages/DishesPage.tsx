import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  UtensilsCrossed, Plus, Pencil, Trash2, Download, X, ChevronDown, ChevronUp, Leaf, Sprout, Star,
  GripVertical, CalendarPlus, Sun, Snowflake, RotateCcw,
} from 'lucide-react';
import { adminApi } from '../api';
import type { AdminDishFull, AdminDish, AdminDishRatingEntry, DishPlan } from '../types';
import { useToast } from '../components/Toast';

// ─── helpers ────────────────────────────────────────────────────────────────

// Format a Date as YYYY-MM-DD in LOCAL time (not UTC). Using toISOString here
// silently rolls the date back a day in +HH timezones (e.g. CET), which shifts
// week keys and corrupts drag-reorder. Every date arithmetic below must go
// through this helper.
function toLocalIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDate(iso: string) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('de-AT', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
}

function weekKey(iso: string) {
  const d = new Date(iso + 'T00:00:00');
  const day = d.getDay() || 7;
  const mon = new Date(d);
  mon.setDate(d.getDate() - day + 1);
  return toLocalIso(mon);
}

function getDayOfWeek(iso: string): number {
  const d = new Date(iso + 'T00:00:00');
  const day = d.getDay();
  return day === 0 ? 7 : day; // Mon=1 … Sun=7
}

function dateForWeekAndDow(monIso: string, dow: number): string {
  const mon = new Date(monIso + 'T00:00:00');
  mon.setDate(mon.getDate() + dow - 1);
  return toLocalIso(mon);
}

function nextWeekKey(after: string): string {
  const d = new Date(after + 'T00:00:00');
  d.setDate(d.getDate() + 7);
  return toLocalIso(d);
}

function currentMondayIso(): string {
  const today = new Date();
  const dow = today.getDay() || 7;
  const mon = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dow + 1);
  return toLocalIso(mon);
}

function formatWeekRange(monIso: string): string {
  const mon = new Date(monIso + 'T00:00:00');
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return `${mon.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' })} – ${sun.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' })}`;
}

function buildDishPayload(dish: AdminDishFull, date: string) {
  return {
    nameDe: dish.nameDe, nameIt: dish.nameIt, nameEn: dish.nameEn,
    descDe: dish.descDe, descIt: dish.descIt, descEn: dish.descEn,
    imageUrl: dish.imageUrl, category: dish.category,
    tags: dish.tags, allergens: dish.allergens,
    prepTime: dish.prepTime, calories: dish.calories, price: dish.price,
    protein: dish.protein, fat: dish.fat,
    isVegetarian: dish.isVegetarian, isVegan: dish.isVegan,
    sortOrder: dish.sortOrder, plan: dish.plan, date,
  };
}

function emptyDish(defaultDate?: string, plan: DishPlan = 'summer'): Omit<AdminDishFull, 'id' | 'createdAt' | 'updatedAt'> {
  const today = defaultDate ?? new Date().toISOString().split('T')[0];
  return {
    nameDe: '', nameIt: '', nameEn: '',
    descDe: '', descIt: '', descEn: '',
    imageUrl: '', category: '',
    tags: [], allergens: [],
    prepTime: 0, calories: 0, price: 0, protein: 0, fat: 0,
    isVegetarian: false, isVegan: false,
    date: today, sortOrder: 0, plan,
  };
}

// Summer runs April 1 – October 31; winter is the rest. Mirrors backend logic.
function currentSeason(now: Date = new Date()): DishPlan {
  const m = now.getMonth() + 1;
  return m >= 4 && m <= 10 ? 'summer' : 'winter';
}

// Which season the given ISO date logically belongs to. Used to warn the user
// when a week of the active plan has drifted into the other season's window —
// on that Monday the public /dishes endpoint will switch to the other plan.
function seasonOfIsoDate(iso: string): DishPlan {
  return currentSeason(new Date(iso + 'T00:00:00'));
}


// ─── StarsDisplay ────────────────────────────────────────────────────────────

function StarsDisplay({ value, size = 13 }: { value: number; size?: number }) {
  return (
    <div className="flex gap-0.5 items-center">
      {[1, 2, 3, 4, 5].map((s) => (
        <Star
          key={s}
          size={size}
          fill={value >= s ? '#ffd60a' : 'transparent'}
          stroke={value >= s ? '#ffd60a' : 'rgba(235,235,245,0.12)'}
          strokeWidth={1.5}
        />
      ))}
    </div>
  );
}

function StarSelector({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [hovered, setHovered] = useState(0);
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((s) => (
        <button
          key={s}
          type="button"
          onMouseEnter={() => setHovered(s)}
          onMouseLeave={() => setHovered(0)}
          onClick={() => onChange(s)}
          className="transition-transform hover:scale-110 active:scale-95"
        >
          <Star
            size={18}
            fill={(hovered || value) >= s ? '#ffd60a' : 'transparent'}
            stroke={(hovered || value) >= s ? '#ffd60a' : 'rgba(235,235,245,0.3)'}
            strokeWidth={1.5}
          />
        </button>
      ))}
    </div>
  );
}

// ─── RatingRow ───────────────────────────────────────────────────────────────

function RatingRow({
  dishId,
  entry,
  onChanged,
}: {
  dishId: string;
  entry: AdminDishRatingEntry;
  onChanged: () => void;
}) {
  const { showToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [editStars, setEditStars] = useState(entry.stars);
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await adminApi.updateDishRating(dishId, entry.stableUid, editStars);
      setEditing(false);
      showToast('Bewertung aktualisiert', 'success');
      onChanged();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Fehler', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await adminApi.deleteDishRating(dishId, entry.stableUid);
      showToast('Bewertung gelöscht', 'success');
      onChanged();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Fehler', 'error');
      setDeleting(false);
    }
  }

  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5 rounded-[12px]"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}
    >
      <span className="flex-1 text-sm font-medium truncate" style={{ color: 'rgba(235,235,245,0.7)' }}>
        {entry.username}
      </span>

      {editing ? (
        <div className="flex items-center gap-2 flex-shrink-0">
          <StarSelector value={editStars} onChange={setEditStars} />
          <button onClick={handleSave} disabled={saving}
            className="px-2.5 py-1 rounded-[8px] text-xs font-semibold"
            style={{ background: 'rgba(10,132,255,0.2)', color: '#0a84ff', border: '1px solid rgba(10,132,255,0.3)' }}>
            {saving ? '...' : 'OK'}
          </button>
          <button onClick={() => { setEditing(false); setEditStars(entry.stars); }}
            className="px-2.5 py-1 rounded-[8px] text-xs"
            style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(235,235,245,0.6)' }}>
            Abbrechen
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-shrink-0">
          <StarsDisplay value={entry.stars} />
          <span className="text-xs w-3 text-center" style={{ color: '#ffd60a' }}>{entry.stars}</span>
          <button onClick={() => setEditing(true)}
            className="p-1.5 rounded-[8px] transition-colors"
            style={{ color: 'rgba(235,235,245,0.3)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#0a84ff'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(235,235,245,0.3)'; }}>
            <Pencil size={13} />
          </button>
          {confirmDel ? (
            <div className="flex items-center gap-1">
              <button onClick={handleDelete} disabled={deleting}
                className="px-2 py-1 rounded-[8px] text-xs font-semibold"
                style={{ background: 'rgba(255,69,58,0.14)', color: '#ff453a', border: '1px solid rgba(255,69,58,0.2)' }}>
                {deleting ? '...' : 'Sicher?'}
              </button>
              <button onClick={() => setConfirmDel(false)}
                className="px-2 py-1 rounded-[8px] text-xs"
                style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(235,235,245,0.6)' }}>
                Nein
              </button>
            </div>
          ) : (
            <button onClick={() => setConfirmDel(true)}
              className="p-1.5 rounded-[8px] transition-colors"
              style={{ color: 'rgba(235,235,245,0.3)' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff453a'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(235,235,245,0.3)'; }}>
              <Trash2 size={13} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── DishForm (centered modal) ───────────────────────────────────────────────

interface DishFormProps {
  dish: AdminDishFull | null;
  ratingData: AdminDish | null;
  initialDate?: string;
  activePlan: DishPlan;
  onSaved: (d: AdminDishFull) => void;
  onClose: () => void;
  onRatingChanged: () => void;
}

function DishForm({ dish, ratingData, initialDate, activePlan, onSaved, onClose, onRatingChanged }: DishFormProps) {
  const { showToast } = useToast();
  const isEdit = dish !== null;

  const [form, setForm] = useState(() =>
    dish
      ? { ...dish, tagsText: dish.tags.join('\n'), allergensText: dish.allergens.join('\n') }
      : { ...emptyDish(initialDate, activePlan), tagsText: '', allergensText: '' }
  );
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'basic' | 'nutrition' | 'ratings'>('basic');

  function set<K extends keyof typeof form>(k: K, v: typeof form[K]) {
    setForm((p) => ({ ...p, [k]: v }));
  }

  async function handleSave() {
    if (!form.nameDe.trim()) { showToast('Name (DE) ist erforderlich', 'error'); return; }
    if (!form.date) { showToast('Datum ist erforderlich', 'error'); return; }
    setSaving(true);
    try {
      const payload = {
        nameDe: form.nameDe.trim(),
        nameIt: form.nameIt.trim(),
        nameEn: form.nameEn.trim(),
        descDe: form.descDe.trim(),
        descIt: form.descIt.trim(),
        descEn: form.descEn.trim(),
        imageUrl: form.imageUrl.trim(),
        category: form.category.trim(),
        tags: form.tagsText.split('\n').map((s) => s.trim()).filter(Boolean),
        allergens: form.allergensText.split('\n').map((s) => s.trim()).filter(Boolean),
        prepTime: Number(form.prepTime) || 0,
        calories: Number(form.calories) || 0,
        price: Number(form.price) || 0,
        protein: Number(form.protein) || 0,
        fat: Number(form.fat) || 0,
        isVegetarian: Boolean(form.isVegetarian),
        isVegan: Boolean(form.isVegan),
        date: form.date,
        sortOrder: Number(form.sortOrder) || 0,
        plan: form.plan,
      };
      const saved = isEdit
        ? await adminApi.updateDish(dish!.id, payload)
        : await adminApi.createDish(payload);
      onSaved(saved);
      showToast(isEdit ? 'Gericht gespeichert' : 'Gericht erstellt', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Fehler beim Speichern', 'error');
    } finally {
      setSaving(false);
    }
  }

  const inp = 'w-full px-3 py-2 rounded-[8px] text-sm outline-none transition-all';
  const inpStyle = { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)', color: 'rgba(235,235,245,0.8)' };
  const focusStyle = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    (e.target as HTMLElement).style.borderColor = 'rgba(10,132,255,0.45)';
    (e.target as HTMLElement).style.boxShadow = '0 0 0 3px rgba(10,132,255,0.08)';
  };
  const blurStyle = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    (e.target as HTMLElement).style.borderColor = 'rgba(255,255,255,0.09)';
    (e.target as HTMLElement).style.boxShadow = '';
  };
  const lbl = 'block text-xs font-medium mb-1 uppercase tracking-wide';
  const lblStyle = { color: 'rgba(235,235,245,0.4)' };

  const tabs = [
    { key: 'basic' as const, label: 'Allgemein' },
    { key: 'nutrition' as const, label: 'Nährwerte' },
    ...(isEdit ? [{ key: 'ratings' as const, label: `Ratings${ratingData && ratingData.count > 0 ? ` (${ratingData.count})` : ''}` }] : []),
  ];

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-lg flex flex-col animate-scaleIn overflow-hidden rounded-[16px]"
        style={{
          background: '#1c1c1e',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
          maxHeight: 'calc(100dvh - 32px)',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 flex-shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <h2 className="font-semibold" style={{ color: 'rgba(235,235,245,0.9)' }}>
            {isEdit ? 'Gericht bearbeiten' : 'Neues Gericht'}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-[8px] transition-colors" style={{ color: 'rgba(235,235,245,0.3)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ffffff'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(235,235,245,0.3)'; }}>
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex flex-shrink-0 px-5 pt-3 gap-1" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className="px-4 py-2 text-xs font-semibold rounded-t-lg transition-all"
              style={{
                color: tab === t.key ? '#0a84ff' : 'rgba(235,235,245,0.4)',
                borderBottom: tab === t.key ? '2px solid #0a84ff' : '2px solid transparent',
                background: tab === t.key ? 'rgba(10,132,255,0.06)' : 'transparent',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-4 scroll-touch scrollbar-thin">

          {tab === 'basic' && (
            <>
              {form.imageUrl && (
                <div className="w-full h-36 rounded-[12px] overflow-hidden flex-shrink-0"
                  style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
                  <img src={form.imageUrl} alt="" className="w-full h-full object-cover"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                </div>
              )}

              <div>
                <label style={lblStyle} className={lbl}>Name (Deutsch) *</label>
                <input className={inp} style={inpStyle} value={form.nameDe}
                  onChange={(e) => set('nameDe', e.target.value)}
                  onFocus={focusStyle} onBlur={blurStyle} placeholder="z.B. Spaghetti Bolognese" />
              </div>

              <div>
                <label style={lblStyle} className={lbl}>Beschreibung (Deutsch)</label>
                <textarea
                  className={`${inp} resize-none`}
                  style={{ ...inpStyle, minHeight: '72px' }}
                  value={form.descDe}
                  onChange={(e) => set('descDe', e.target.value)}
                  onFocus={focusStyle}
                  onBlur={blurStyle}
                  placeholder="Beschreibung unter dem Namen im Frontend"
                />
              </div>

              <div className="grid grid-cols-[1fr_auto] gap-3">
                <div>
                  <label style={lblStyle} className={lbl}>Datum *</label>
                  <input type="date" className={inp} style={inpStyle} value={form.date}
                    onChange={(e) => set('date', e.target.value)}
                    onFocus={focusStyle} onBlur={blurStyle} />
                </div>
                <div>
                  <label style={lblStyle} className={lbl}>Plan</label>
                  <div className="flex gap-1 h-[38px]">
                    <button
                      type="button"
                      onClick={() => set('plan', 'summer')}
                      className="flex items-center gap-1.5 px-3 rounded-[8px] text-xs font-semibold transition-all"
                      style={{
                        background: form.plan === 'summer' ? 'rgba(255,159,10,0.18)' : 'rgba(255,255,255,0.04)',
                        border: form.plan === 'summer' ? '1px solid rgba(255,159,10,0.45)' : '1px solid rgba(255,255,255,0.09)',
                        color: form.plan === 'summer' ? '#ff9f0a' : 'rgba(235,235,245,0.4)',
                      }}
                    >
                      <Sun size={13} /> Sommer
                    </button>
                    <button
                      type="button"
                      onClick={() => set('plan', 'winter')}
                      className="flex items-center gap-1.5 px-3 rounded-[8px] text-xs font-semibold transition-all"
                      style={{
                        background: form.plan === 'winter' ? 'rgba(64,156,255,0.18)' : 'rgba(255,255,255,0.04)',
                        border: form.plan === 'winter' ? '1px solid rgba(64,156,255,0.45)' : '1px solid rgba(255,255,255,0.09)',
                        color: form.plan === 'winter' ? '#409cff' : 'rgba(235,235,245,0.4)',
                      }}
                    >
                      <Snowflake size={13} /> Winter
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <label style={lblStyle} className={lbl}>Kategorie</label>
                <input className={inp} style={inpStyle} value={form.category}
                  onChange={(e) => set('category', e.target.value)}
                  onFocus={focusStyle} onBlur={blurStyle} placeholder="z.B. Vegetarisch, Hauptgericht" />
              </div>

              <div>
                <label style={lblStyle} className={lbl}>Bild-URL</label>
                <input className={inp} style={inpStyle} value={form.imageUrl}
                  onChange={(e) => set('imageUrl', e.target.value)}
                  onFocus={focusStyle} onBlur={blurStyle} placeholder="https://..." />
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setForm((p) => ({ ...p, isVegetarian: !p.isVegetarian }))}
                  className="flex items-center gap-2 px-4 py-2 rounded-[12px] text-sm font-medium transition-all select-none"
                  style={{
                    background: form.isVegetarian ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.04)',
                    border: form.isVegetarian ? '1px solid rgba(34,197,94,0.4)' : '1px solid rgba(255,255,255,0.09)',
                    color: form.isVegetarian ? '#4ade80' : 'rgba(235,235,245,0.4)',
                  }}
                >
                  <Leaf size={14} />
                  Vegetarisch
                </button>
                <button
                  type="button"
                  onClick={() => setForm((p) => ({ ...p, isVegan: !p.isVegan }))}
                  className="flex items-center gap-2 px-4 py-2 rounded-[12px] text-sm font-medium transition-all select-none"
                  style={{
                    background: form.isVegan ? 'rgba(134,239,172,0.15)' : 'rgba(255,255,255,0.04)',
                    border: form.isVegan ? '1px solid rgba(134,239,172,0.4)' : '1px solid rgba(255,255,255,0.09)',
                    color: form.isVegan ? '#30d158' : 'rgba(235,235,245,0.4)',
                  }}
                >
                  <Sprout size={14} />
                  Vegan
                </button>
              </div>

              <div>
                <label style={lblStyle} className={lbl}>Tags (eine pro Zeile)</label>
                <textarea className={`${inp} resize-none`} style={{ ...inpStyle, minHeight: '72px' }}
                  value={form.tagsText}
                  onChange={(e) => set('tagsText', e.target.value)}
                  onFocus={focusStyle} onBlur={blurStyle} placeholder="Fisch&#10;Vegetarisch" />
              </div>

              <div>
                <label style={lblStyle} className={lbl}>Allergene (eine pro Zeile)</label>
                <textarea className={`${inp} resize-none`} style={{ ...inpStyle, minHeight: '72px' }}
                  value={form.allergensText}
                  onChange={(e) => set('allergensText', e.target.value)}
                  onFocus={focusStyle} onBlur={blurStyle} placeholder="Gluten&#10;Milch" />
              </div>
            </>
          )}

          {tab === 'nutrition' && (
            <div className="grid grid-cols-2 gap-3">
              {([
                ['calories', 'Kalorien (kcal)'],
                ['protein', 'Protein (g)'],
                ['fat', 'Fett (g)'],
              ] as const).map(([field, label]) => (
                <div key={field}>
                  <label style={lblStyle} className={lbl}>{label}</label>
                  <input type="number" step="0.1" min="0" className={inp} style={inpStyle}
                    value={form[field as keyof typeof form] as number}
                    onChange={(e) => set(field as 'calories', Number(e.target.value))}
                    onFocus={focusStyle} onBlur={blurStyle} />
                </div>
              ))}
            </div>
          )}

          {tab === 'ratings' && (
            <>
              {ratingData && ratingData.count > 0 ? (
                <>
                  <div className="flex items-center gap-3 px-4 py-3 rounded-[12px]"
                    style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.15)' }}>
                    <StarsDisplay value={Math.round(ratingData.avgStars)} size={16} />
                    <span className="text-base font-bold" style={{ color: '#ffd60a' }}>
                      {ratingData.avgStars.toFixed(1)}
                    </span>
                    <span className="text-sm" style={{ color: 'rgba(235,235,245,0.4)' }}>
                      · {ratingData.count} {ratingData.count === 1 ? 'Bewertung' : 'Bewertungen'}
                    </span>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    {ratingData.ratings.map((entry) => (
                      <RatingRow
                        key={entry.stableUid}
                        dishId={ratingData.dishId}
                        entry={entry}
                        onChanged={onRatingChanged}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center py-10 gap-2">
                  <Star size={28} style={{ color: 'rgba(235,235,245,0.12)' }} />
                  <p className="text-sm" style={{ color: 'rgba(235,235,245,0.3)' }}>Noch keine Bewertungen</p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {tab !== 'ratings' && (
          <div className="flex items-center justify-end gap-3 px-5 py-4 flex-shrink-0" style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
            <button onClick={onClose} className="px-4 py-2 rounded-[12px] text-sm transition-colors"
              style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(235,235,245,0.6)', border: '1px solid rgba(255,255,255,0.08)' }}>
              Abbrechen
            </button>
            <button onClick={handleSave} disabled={saving}
              className="px-5 py-2 rounded-[12px] text-sm font-semibold transition-all"
              style={{
                background: saving ? 'rgba(10,132,255,0.4)' : 'linear-gradient(135deg,#0a84ff,#0a84ff)',
                color: '#fff',
                boxShadow: saving ? 'none' : '0 4px 16px rgba(10,132,255,0.3)',
              }}>
              {saving ? 'Speichern...' : isEdit ? 'Speichern' : 'Erstellen'}
            </button>
          </div>
        )}
        {tab === 'ratings' && (
          <div className="flex items-center justify-end px-5 py-4 flex-shrink-0" style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
            <button onClick={onClose} className="px-4 py-2 rounded-[12px] text-sm transition-colors"
              style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(235,235,245,0.6)', border: '1px solid rgba(255,255,255,0.08)' }}>
              Schließen
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

// ─── DishCard ────────────────────────────────────────────────────────────────

function DishCard({ dish, ratingData, onEdit, onDelete, onDragStart, onDragEnd, isDragging }: {
  dish: AdminDishFull;
  ratingData: AdminDish | undefined;
  onEdit: (d: AdminDishFull) => void;
  onDelete: (id: string) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  isDragging: boolean;
}) {
  const [imgError, setImgError] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { showToast } = useToast();

  async function handleDelete() {
    setDeleting(true);
    try {
      await adminApi.deleteDish(dish.id);
      onDelete(dish.id);
      showToast('Gericht gelöscht', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Fehler beim Löschen', 'error');
      setDeleting(false);
    }
  }

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/dish-id', dish.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className="flex items-center gap-3 px-4 py-3 rounded-[12px] card-hover transition-all"
      style={{
        background: '#1c1c1e',
        border: '1px solid rgba(255,255,255,0.06)',
        opacity: isDragging ? 0.35 : 1,
        cursor: isDragging ? 'grabbing' : 'default',
        transition: 'opacity 0.15s',
      }}
    >
      {/* Drag grip */}
      <div
        className="flex-shrink-0"
        style={{ color: 'rgba(235,235,245,0.2)', cursor: 'grab' }}
        title="Ziehen zum Verschieben"
      >
        <GripVertical size={15} />
      </div>

      {/* Image */}
      <div className="w-12 h-12 rounded-[8px] flex-shrink-0 overflow-hidden flex items-center justify-center"
        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
        {dish.imageUrl && !imgError ? (
          <img src={dish.imageUrl} alt={dish.nameDe} className="w-full h-full object-cover"
            onError={() => setImgError(true)} />
        ) : (
          <UtensilsCrossed size={18} style={{ color: 'rgba(235,235,245,0.12)' }} />
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium truncate" style={{ color: 'rgba(235,235,245,0.85)' }}>{dish.nameDe}</span>
          {!!dish.isVegan && <Sprout size={13} style={{ color: '#30d158' }} />}
          {!!dish.isVegetarian && !dish.isVegan && <Leaf size={13} style={{ color: '#22c55e' }} />}
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {dish.category && (
            <span className="text-xs px-1.5 py-0.5 rounded-md" style={{ background: 'rgba(10,132,255,0.1)', color: '#0a84ff' }}>
              {dish.category}
            </span>
          )}
          {dish.calories > 0 && (
            <span className="text-xs" style={{ color: 'rgba(235,235,245,0.3)' }}>{dish.calories} kcal</span>
          )}
          {ratingData && ratingData.count > 0 ? (
            <div className="flex items-center gap-1">
              <StarsDisplay value={Math.round(ratingData.avgStars)} size={11} />
              <span className="text-xs font-semibold" style={{ color: '#ffd60a' }}>{ratingData.avgStars.toFixed(1)}</span>
              <span className="text-xs" style={{ color: 'rgba(235,235,245,0.12)' }}>({ratingData.count})</span>
            </div>
          ) : (
            <span className="text-xs" style={{ color: 'rgba(235,235,245,0.12)' }}>Keine Bewertungen</span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <button onClick={() => onEdit(dish)}
          className="p-2 rounded-[8px] transition-colors"
          style={{ color: 'rgba(235,235,245,0.3)' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#0a84ff'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(235,235,245,0.3)'; }}>
          <Pencil size={15} />
        </button>
        {confirmDel ? (
          <div className="flex items-center gap-1">
            <button onClick={handleDelete} disabled={deleting}
              className="px-2.5 py-1 rounded-[8px] text-xs font-semibold transition-colors"
              style={{ background: 'rgba(255,69,58,0.14)', color: '#ff453a', border: '1px solid rgba(255,69,58,0.2)' }}>
              {deleting ? '...' : 'Löschen?'}
            </button>
            <button onClick={() => setConfirmDel(false)}
              className="px-2 py-1 rounded-[8px] text-xs transition-colors"
              style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(235,235,245,0.6)' }}>
              Nein
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirmDel(true)}
            className="p-2 rounded-[8px] transition-colors"
            style={{ color: 'rgba(235,235,245,0.3)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff453a'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(235,235,245,0.3)'; }}>
            <Trash2 size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── ImportDialog ────────────────────────────────────────────────────────────

function ImportDialog({ defaultPlan, onDone, onClose }: { defaultPlan: DishPlan; onDone: () => void; onClose: () => void }) {
  const { showToast } = useToast();
  const [url, setUrl] = useState('https://mensa.plattnericus.dev/mensa.json');
  const [plan, setPlan] = useState<DishPlan>(defaultPlan);
  const [loading, setLoading] = useState(false);

  async function handleImport() {
    setLoading(true);
    try {
      const result = await adminApi.importDishesFromUrl(plan, url.trim() || undefined);
      showToast(`Importiert (${plan === 'summer' ? 'Sommer' : 'Winter'}): ${result.imported} neu, ${result.updated} aktualisiert`, 'success');
      onDone();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Import fehlgeschlagen', 'error');
    } finally {
      setLoading(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-[16px] p-6 animate-scaleIn"
        style={{ background: '#1c1c1e', border: '1px solid rgba(10,132,255,0.2)' }}>
        <h3 className="font-bold mb-1" style={{ color: 'rgba(235,235,245,0.9)' }}>Gerichte importieren</h3>
        <p className="text-xs mb-4" style={{ color: 'rgba(235,235,245,0.4)' }}>
          Lädt alle Gerichte von der externen URL und speichert sie im ausgewählten Plan. Vorhandene werden aktualisiert.
        </p>

        <label className="block text-xs font-medium mb-1.5 uppercase tracking-wide" style={{ color: 'rgba(235,235,245,0.4)' }}>Plan</label>
        <div className="flex gap-2 mb-4">
          <button
            type="button"
            onClick={() => setPlan('summer')}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-[10px] text-sm font-semibold transition-all"
            style={{
              background: plan === 'summer' ? 'rgba(255,159,10,0.18)' : 'rgba(255,255,255,0.04)',
              border: plan === 'summer' ? '1px solid rgba(255,159,10,0.5)' : '1px solid rgba(255,255,255,0.09)',
              color: plan === 'summer' ? '#ff9f0a' : 'rgba(235,235,245,0.5)',
            }}
          >
            <Sun size={15} /> Sommer
          </button>
          <button
            type="button"
            onClick={() => setPlan('winter')}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-[10px] text-sm font-semibold transition-all"
            style={{
              background: plan === 'winter' ? 'rgba(64,156,255,0.18)' : 'rgba(255,255,255,0.04)',
              border: plan === 'winter' ? '1px solid rgba(64,156,255,0.5)' : '1px solid rgba(255,255,255,0.09)',
              color: plan === 'winter' ? '#409cff' : 'rgba(235,235,245,0.5)',
            }}
          >
            <Snowflake size={15} /> Winter
          </button>
        </div>

        <label className="block text-xs font-medium mb-1.5 uppercase tracking-wide" style={{ color: 'rgba(235,235,245,0.4)' }}>Quell-URL</label>
        <input
          className="w-full px-3 py-2 rounded-[8px] text-sm outline-none mb-4 transition-all"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)', color: 'rgba(235,235,245,0.8)' }}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://..."
        />
        <div className="flex items-center justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded-[12px] text-sm"
            style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(235,235,245,0.6)' }}>
            Abbrechen
          </button>
          <button onClick={handleImport} disabled={loading}
            className="flex items-center gap-2 px-5 py-2 rounded-[12px] text-sm font-semibold transition-all"
            style={{
              background: loading ? 'rgba(10,132,255,0.4)' : 'linear-gradient(135deg,#0a84ff,#0a84ff)',
              color: '#fff', boxShadow: loading ? 'none' : '0 4px 16px rgba(10,132,255,0.25)',
            }}>
            <Download size={15} />
            {loading ? 'Importiere...' : 'Importieren'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── WeekDropzone ──────────────────────────────────────────────────────────
// Insert-target between weeks. Invisible until a week is being dragged and
// this dropzone is not directly adjacent to that week. Grows and highlights
// as the pointer enters.

function WeekDropzone({
  visible, active, onEnter, onLeave, onDrop,
}: {
  visible: boolean; active: boolean;
  onEnter: () => void; onLeave: () => void; onDrop: () => void;
}) {
  return (
    <div
      onDragOver={(e) => { if (visible) { e.preventDefault(); onEnter(); } }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) onLeave();
      }}
      onDrop={(e) => { if (visible) { e.preventDefault(); onDrop(); } }}
      style={{
        height: visible ? (active ? 48 : 32) : 8,
        marginTop: visible ? 6 : 0,
        marginBottom: visible ? 6 : 0,
        borderRadius: 10,
        border: visible ? `2px dashed ${active ? 'rgba(10,132,255,0.7)' : 'rgba(10,132,255,0.28)'}` : '2px dashed transparent',
        background: active ? 'rgba(10,132,255,0.12)' : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'height 160ms ease, background 160ms ease, border-color 160ms ease, margin 160ms ease',
        pointerEvents: visible ? 'auto' : 'none',
      }}
    >
      {visible && (
        <span className="text-xs font-medium select-none" style={{ color: active ? '#0a84ff' : 'rgba(10,132,255,0.55)' }}>
          Hier ablegen
        </span>
      )}
    </div>
  );
}

// ─── DishesPage ───────────────────────────────────────────────────────────────

export function DishesPage() {
  const { showToast } = useToast();
  const [activePlan, setActivePlan] = useState<DishPlan>(() => currentSeason());
  const [dishes, setDishes] = useState<AdminDishFull[]>([]);
  const [ratingsMap, setRatingsMap] = useState<Map<string, AdminDish>>(new Map());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [editDish, setEditDish] = useState<AdminDishFull | null | 'new'>(null);
  const [showImport, setShowImport] = useState(false);
  // We store which weeks the user has *expanded*; everything else is collapsed.
  // That way newly loaded weeks come in collapsed by default without extra work.
  const [expandedWeeks, setExpandedWeeks] = useState<Set<string>>(new Set());
  // drag state
  const [draggingDishId, setDraggingDishId] = useState<string | null>(null);
  const [draggingWeekKey, setDraggingWeekKey] = useState<string | null>(null);
  const [dragOverWeekKey, setDragOverWeekKey] = useState<string | null>(null);
  const [dragOverInsertIdx, setDragOverInsertIdx] = useState<number | null>(null);

  // empty weeks (manually added via "Neue Woche" button), keyed per plan
  const [emptyWeeks, setEmptyWeeks] = useState<Map<DishPlan, Set<string>>>(new Map());
  const planEmptyWeeks = emptyWeeks.get(activePlan) ?? new Set<string>();

  // pre-fill date when opening "new dish" from a week's + button
  const [newDishInitialDate, setNewDishInitialDate] = useState<string | undefined>();

  // Inline week-date editor: which week is being edited + the pending value.
  const [editingWeekKey, setEditingWeekKey] = useState<string | null>(null);
  const [editingWeekDraft, setEditingWeekDraft] = useState<string>('');

  // Reset-from-JSON confirmation state.
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Track which plans we've already auto-rotated this session so we don't
  // hammer the server every time the user flips tabs.
  const rotatedPlans = useRef<Set<DishPlan>>(new Set());

  const loadRatings = useCallback(async () => {
    try {
      const ratingData = await adminApi.dishRatings();
      const map = new Map<string, AdminDish>();
      ratingData.forEach((r) => map.set(r.dishId, r));
      setRatingsMap(map);
    } catch { /* non-fatal */ }
  }, []);

  const loadDishes = useCallback(async (plan: DishPlan) => {
    setLoading(true);
    try {
      const data = await adminApi.dishes(plan);
      setDishes(data);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Fehler beim Laden', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { loadRatings(); }, [loadRatings]);

  // Load dishes for the active plan. First time we visit a plan this session,
  // also ask the server to rotate any past weeks to the end so the plan stays
  // "rolling" without manual intervention.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!rotatedPlans.current.has(activePlan)) {
        rotatedPlans.current.add(activePlan);
        try {
          const res = await adminApi.autoRotateDishes(activePlan);
          if (res.rotated > 0 && !cancelled) {
            showToast(`${res.rotated} vergangene Gerichte automatisch verschoben`, 'success');
          }
        } catch { /* non-fatal — proceed with load anyway */ }
      }
      if (!cancelled) await loadDishes(activePlan);
    })();
    return () => { cancelled = true; };
  }, [activePlan, loadDishes, showToast]);

  // Poll auto-rotate every 5 min AND whenever the tab regains focus, so a week
  // that expires while the admin is left open loops on its own without needing
  // a manual reload. Silent when there's nothing to rotate; reloads dishes if
  // rows were actually moved.
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await adminApi.autoRotateDishes(activePlan);
        if (!cancelled && res.rotated > 0) {
          showToast(`${res.rotated} Gerichte automatisch weitergerollt`, 'success');
          await loadDishes(activePlan);
        }
      } catch { /* non-fatal */ }
    }

    const intervalId = window.setInterval(poll, 5 * 60 * 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') poll(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [activePlan, loadDishes, showToast]);

  // ── drag handlers ──────────────────────────────────────────────────────────

  async function handleDishDropOnWeek(dishId: string, targetWk: string) {
    const dish = dishes.find((d) => d.id === dishId);
    if (!dish) return;
    if (weekKey(dish.date) === targetWk) return;

    const dow = getDayOfWeek(dish.date);
    const newDate = dateForWeekAndDow(targetWk, dow);

    try {
      const updated = await adminApi.updateDish(dish.id, buildDishPayload(dish, newDate));
      setDishes((prev) => prev.map((d) => (d.id === dish.id ? updated : d)));
      setEmptyWeeks((prev) => {
        const next = new Map(prev);
        const s = new Set(next.get(activePlan) ?? []);
        s.delete(targetWk);
        next.set(activePlan, s);
        return next;
      });
      showToast('Gericht verschoben', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Fehler beim Verschieben', 'error');
    }
  }

  // Insert-based week reorder: user drops week `fromWk` at position `insertIdx`
  // in the current sorted week list. Every week keeps its OWN dishes and their
  // weekdays — only the Monday date of each week is reassigned so the new order
  // is chronological. Uses the existing PATCH endpoint in a Promise.all batch.
  async function handleWeekInsert(fromWk: string, insertIdx: number) {
    const currentOrder = sortedWeeks.map(([wk]) => wk);
    const fromIdx = currentOrder.indexOf(fromWk);
    if (fromIdx === -1) return;
    // Normalise: dropping right before/after own position is a no-op.
    const targetIdx = insertIdx > fromIdx ? insertIdx - 1 : insertIdx;
    if (targetIdx === fromIdx) return;

    const newOrder = [...currentOrder];
    newOrder.splice(fromIdx, 1);
    newOrder.splice(targetIdx, 0, fromWk);

    // Original Mondays in ascending order — we redistribute them to the new
    // week order so the whole plan stays chronological.
    const mondays = [...currentOrder].sort();
    const wkToNewMonday = new Map<string, string>();
    newOrder.forEach((wk, i) => { wkToNewMonday.set(wk, mondays[i]); });

    // Build per-dish date updates and per-week empty-marker updates.
    const dishUpdates: Array<{ dish: AdminDishFull; newDate: string }> = [];
    for (const d of dishes) {
      const oldWk = weekKey(d.date);
      const newMon = wkToNewMonday.get(oldWk);
      if (!newMon || newMon === oldWk) continue;
      const dow = getDayOfWeek(d.date);
      const newDate = dateForWeekAndDow(newMon, dow);
      dishUpdates.push({ dish: d, newDate });
    }

    // Optimistic update first — makes the drop feel instant.
    if (dishUpdates.length > 0) {
      const updateMap = new Map(dishUpdates.map((u) => [u.dish.id, u.newDate]));
      setDishes((prev) => prev.map((d) => {
        const nd = updateMap.get(d.id);
        return nd ? { ...d, date: nd } : d;
      }));
    }
    setEmptyWeeks((prev) => {
      const next = new Map(prev);
      const oldSet = next.get(activePlan) ?? new Set<string>();
      const newSet = new Set<string>();
      for (const wk of oldSet) {
        const nm = wkToNewMonday.get(wk);
        newSet.add(nm ?? wk);
      }
      next.set(activePlan, newSet);
      return next;
    });

    try {
      await Promise.all(
        dishUpdates.map(({ dish, newDate }) =>
          adminApi.updateDish(dish.id, buildDishPayload(dish, newDate))
        )
      );
      showToast('Woche verschoben', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Fehler beim Verschieben', 'error');
      loadDishes(activePlan);
    }
  }

  function addNewWeek() {
    const allKeys = [
      ...new Set([...dishes.map((d) => weekKey(d.date)), ...planEmptyWeeks]),
    ].sort();

    let newKey: string;
    if (allKeys.length > 0) {
      newKey = nextWeekKey(allKeys[allKeys.length - 1]);
    } else {
      newKey = currentMondayIso();
    }

    setEmptyWeeks((prev) => {
      const next = new Map(prev);
      const s = new Set(next.get(activePlan) ?? []);
      s.add(newKey);
      next.set(activePlan, s);
      return next;
    });
  }

  // "Anchor" this week to a chosen Monday. Delegates to the server which shifts
  // the ENTIRE plan by (target - chosen) days atomically and rotates any weeks
  // that fall into the past back to the end. So if the user picks "Diese Woche"
  // on Woche 2, every week in the plan slides by the same offset — Woche 2
  // lands on the current Monday, Woche 3 on next Monday, and Woche 1 (now
  // past) auto-rolls to the end. Collisions are impossible because the entire
  // sequence moves together.
  async function handleWeekMove(oldWk: string, newMonIso: string) {
    setEditingWeekKey(null);
    if (oldWk === newMonIso) return;

    try {
      const res = await adminApi.anchorWeek(activePlan, oldWk, newMonIso);
      let msg = `Plan verschoben (${res.offsetDays > 0 ? '+' : ''}${res.offsetDays} Tage)`;
      if (res.rotated > 0) msg += ` · ${res.rotated} weitergerollt`;
      showToast(msg, 'success');
      await loadDishes(activePlan);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Fehler beim Verschieben', 'error');
      loadDishes(activePlan);
    }
  }

  function removeEmptyWeek(wk: string) {
    setEmptyWeeks((prev) => {
      const next = new Map(prev);
      const s = new Set(next.get(activePlan) ?? []);
      s.delete(wk);
      next.set(activePlan, s);
      return next;
    });
  }

  // ── CRUD callbacks ─────────────────────────────────────────────────────────

  function handleSaved(_d: AdminDishFull) {
    setEditDish(null);
    setNewDishInitialDate(undefined);
    loadDishes(activePlan);
  }

  function handleDeleted(id: string) {
    setDishes((prev) => prev.filter((d) => d.id !== id));
  }

  async function handleReset() {
    setResetting(true);
    try {
      const res = await adminApi.resetDishesFromUrl(activePlan);
      showToast(
        `Reset (${activePlan === 'summer' ? 'Sommer' : 'Winter'}): ${res.deleted} gelöscht, ${res.imported} neu importiert`,
        'success'
      );
      // Wipe local edit state that no longer makes sense after reset.
      setEmptyWeeks((prev) => {
        const next = new Map(prev);
        next.set(activePlan, new Set());
        return next;
      });
      setExpandedWeeks(new Set());
      setEditingWeekKey(null);
      rotatedPlans.current.delete(activePlan); // re-rotate on next mount
      await loadDishes(activePlan);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Reset fehlgeschlagen', 'error');
    } finally {
      setResetting(false);
      setConfirmingReset(false);
    }
  }

  // ── derived data ───────────────────────────────────────────────────────────

  const filtered = search.trim()
    ? dishes.filter((d) =>
        d.nameDe.toLowerCase().includes(search.toLowerCase()) ||
        d.nameIt.toLowerCase().includes(search.toLowerCase()) ||
        d.nameEn.toLowerCase().includes(search.toLowerCase()) ||
        d.category.toLowerCase().includes(search.toLowerCase()) ||
        d.date.includes(search)
      )
    : dishes;

  const weeksMap = new Map<string, AdminDishFull[]>();
  for (const d of filtered) {
    const k = weekKey(d.date);
    const arr = weeksMap.get(k) ?? [];
    arr.push(d);
    weeksMap.set(k, arr);
  }
  if (!search.trim()) {
    for (const k of planEmptyWeeks) {
      if (!weeksMap.has(k)) weeksMap.set(k, []);
    }
  }
  const sortedWeeks = [...weeksMap.entries()].sort(([a], [b]) => a.localeCompare(b));

  function toggleWeek(k: string) {
    setExpandedWeeks((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  }

  function expandAll() {
    setExpandedWeeks(new Set(sortedWeeks.map(([wk]) => wk)));
  }

  function collapseAll() {
    setExpandedWeeks(new Set());
  }

  const editRatingData = editDish && editDish !== 'new'
    ? (ratingsMap.get((editDish as AdminDishFull).id) ?? null)
    : null;

  const draggingWeekIdx = draggingWeekKey
    ? sortedWeeks.findIndex(([wk]) => wk === draggingWeekKey)
    : -1;

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <div className="animate-page">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: '#ffffff' }}>Speiseplan</h1>
          <p className="text-sm mt-0.5" style={{ color: 'rgba(235,235,245,0.4)' }}>
            {dishes.length} {dishes.length === 1 ? 'Gericht' : 'Gerichte'} im {activePlan === 'summer' ? 'Sommer' : 'Winter'}plan
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-[12px] text-sm font-medium transition-all"
            style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(235,235,245,0.6)', border: '1px solid rgba(255,255,255,0.08)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.09)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)'; }}>
            <Download size={15} />
            Importieren
          </button>
          {confirmingReset ? (
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleReset}
                disabled={resetting}
                className="flex items-center gap-2 px-4 py-2 rounded-[12px] text-sm font-semibold transition-all"
                style={{ background: 'rgba(255,69,58,0.18)', color: '#ff453a', border: '1px solid rgba(255,69,58,0.4)' }}
              >
                <RotateCcw size={15} />
                {resetting ? 'Reset...' : `Sicher? ${activePlan === 'summer' ? 'Sommer' : 'Winter'} überschreiben`}
              </button>
              <button
                onClick={() => setConfirmingReset(false)}
                disabled={resetting}
                className="px-3 py-2 rounded-[12px] text-sm transition-colors"
                style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(235,235,245,0.6)' }}
              >
                Nein
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmingReset(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-[12px] text-sm font-medium transition-all"
              style={{ background: 'rgba(255,159,10,0.1)', color: '#ff9f0a', border: '1px solid rgba(255,159,10,0.25)' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,159,10,0.18)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,159,10,0.1)'; }}
              title="Diesen Plan auf den Stand der JSON zurücksetzen"
            >
              <RotateCcw size={15} />
              Reset auf JSON
            </button>
          )}
          <button
            onClick={expandedWeeks.size === 0 ? expandAll : collapseAll}
            className="flex items-center gap-2 px-4 py-2 rounded-[12px] text-sm font-medium transition-all"
            style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(235,235,245,0.6)', border: '1px solid rgba(255,255,255,0.08)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.09)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)'; }}
            title={expandedWeeks.size === 0 ? 'Alle ausklappen' : 'Alle einklappen'}
          >
            {expandedWeeks.size === 0 ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
            {expandedWeeks.size === 0 ? 'Ausklappen' : 'Einklappen'}
          </button>
          <button
            onClick={addNewWeek}
            className="flex items-center gap-2 px-4 py-2 rounded-[12px] text-sm font-medium transition-all"
            style={{ background: 'rgba(10,132,255,0.1)', color: '#0a84ff', border: '1px solid rgba(10,132,255,0.2)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(10,132,255,0.18)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(10,132,255,0.1)'; }}>
            <CalendarPlus size={15} />
            Neue Woche
          </button>
          <button
            onClick={() => { setNewDishInitialDate(undefined); setEditDish('new'); }}
            className="flex items-center gap-2 px-4 py-2 rounded-[12px] text-sm font-semibold transition-all"
            style={{
              background: 'linear-gradient(135deg,#0a84ff,#0a84ff)',
              color: '#fff',
              boxShadow: '0 4px 16px rgba(10,132,255,0.3)',
            }}>
            <Plus size={15} />
            Neues Gericht
          </button>
        </div>
      </div>

      {/* Season tabs */}
      <div
        className="inline-flex items-center gap-1 mb-4 p-1 rounded-[14px]"
        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
      >
        {(['summer', 'winter'] as const).map((p) => {
          const isActive = p === activePlan;
          const isCurrent = p === currentSeason();
          const icon = p === 'summer' ? <Sun size={14} /> : <Snowflake size={14} />;
          const bg = isActive
            ? p === 'summer'
              ? 'linear-gradient(135deg, rgba(255,159,10,0.22), rgba(255,159,10,0.14))'
              : 'linear-gradient(135deg, rgba(64,156,255,0.22), rgba(64,156,255,0.14))'
            : 'transparent';
          const fg = isActive
            ? p === 'summer' ? '#ff9f0a' : '#409cff'
            : 'rgba(235,235,245,0.55)';
          const border = isActive
            ? p === 'summer' ? '1px solid rgba(255,159,10,0.4)' : '1px solid rgba(64,156,255,0.4)'
            : '1px solid transparent';
          return (
            <button
              key={p}
              onClick={() => setActivePlan(p)}
              className="flex items-center gap-2 px-4 py-2 rounded-[10px] text-sm font-semibold transition-all"
              style={{ background: bg, color: fg, border }}
            >
              {icon}
              {p === 'summer' ? 'Sommer' : 'Winter'}
              <span className="text-[10px] font-medium opacity-70">
                {p === 'summer' ? 'Apr–Okt' : 'Nov–Mär'}
              </span>
              {isCurrent && (
                <span
                  className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-full"
                  style={{
                    background: isActive ? 'rgba(255,255,255,0.15)' : 'rgba(48,209,88,0.18)',
                    color: isActive ? fg : '#30d158',
                  }}
                >
                  aktiv
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Search */}
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Suche nach Name, Kategorie, Datum..."
        className="w-full px-4 py-2.5 rounded-[12px] text-sm mb-5 outline-none transition-all"
        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(235,235,245,0.8)' }}
        onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = 'rgba(10,132,255,0.4)'; (e.target as HTMLInputElement).style.boxShadow = '0 0 0 3px rgba(10,132,255,0.08)'; }}
        onBlur={(e) => { (e.target as HTMLInputElement).style.borderColor = 'rgba(255,255,255,0.08)'; (e.target as HTMLInputElement).style.boxShadow = ''; }}
      />

      {/* Content */}
      {loading && dishes.length === 0 ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-2 border-[#0a84ff] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : sortedWeeks.length === 0 ? (
        <div className="rounded-[16px] p-12 text-center" style={{ background: '#1c1c1e', border: '1px solid rgba(255,255,255,0.06)' }}>
          <UtensilsCrossed size={32} className="mx-auto mb-3" style={{ color: 'rgba(235,235,245,0.12)' }} />
          <p className="text-sm mb-3" style={{ color: 'rgba(235,235,245,0.3)' }}>
            {search
              ? 'Keine Gerichte gefunden'
              : `Noch keine Gerichte im ${activePlan === 'summer' ? 'Sommer' : 'Winter'}plan`}
          </p>
          {!search && (
            <button onClick={() => setShowImport(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-[12px] text-sm font-medium mx-auto transition-all"
              style={{ background: 'rgba(10,132,255,0.15)', color: '#0a84ff', border: '1px solid rgba(10,132,255,0.2)' }}>
              <Download size={15} />
              Aus externer URL importieren
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-col">
          {/* Top dropzone (insert before first week) */}
          <WeekDropzone
            visible={draggingWeekKey !== null && draggingWeekIdx !== 0 && draggingWeekIdx !== -1}
            active={dragOverInsertIdx === 0}
            onEnter={() => setDragOverInsertIdx(0)}
            onLeave={() => setDragOverInsertIdx((v) => v === 0 ? null : v)}
            onDrop={() => {
              if (draggingWeekKey) handleWeekInsert(draggingWeekKey, 0);
              setDragOverInsertIdx(null);
              setDraggingWeekKey(null);
            }}
          />

          {sortedWeeks.map(([wk, wDishes], wi) => {
            const collapsed    = !expandedWeeks.has(wk);
            const isDragTarget = dragOverWeekKey === wk;
            const isDraggingSelf = draggingWeekKey === wk;

            // Dropzone AFTER this week — hide if it's directly adjacent to the
            // dragged week (dropping right where it already is is a no-op).
            const dropAfterIdx = wi + 1;
            const showDropAfter =
              draggingWeekKey !== null &&
              !isDraggingSelf &&
              dropAfterIdx !== draggingWeekIdx &&
              dropAfterIdx !== draggingWeekIdx + 1;

            return (
              <div key={wk} className="contents">
                <div
                  className="animate-fadeInUp"
                  style={{
                    animationDelay: `${wi * 40}ms`,
                    opacity: isDraggingSelf ? 0.45 : 1,
                    borderRadius: '1rem',
                    outline: isDraggingSelf
                      ? '2px solid rgba(10,132,255,0.6)'
                      : isDragTarget ? '2px solid rgba(10,132,255,0.5)' : '2px solid transparent',
                    outlineOffset: '3px',
                    transition: 'opacity 0.15s, outline 0.15s',
                  }}
                  onDragOver={(e) => {
                    // Only dish→week drops accept here; week→week goes via dropzones.
                    if (draggingDishId) {
                      e.preventDefault();
                      setDragOverWeekKey(wk);
                    }
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                      setDragOverWeekKey(null);
                    }
                  }}
                  onDrop={async (e) => {
                    setDragOverWeekKey(null);
                    const dishId = e.dataTransfer.getData('text/dish-id');
                    if (dishId) {
                      e.preventDefault();
                      await handleDishDropOnWeek(dishId, wk);
                    }
                  }}
                >
                  {/* Week header */}
                  <div
                    className="flex items-center gap-2 px-4 py-2.5 rounded-[12px] mb-2 transition-colors"
                    style={{
                      background: isDragTarget ? 'rgba(10,132,255,0.15)' : 'rgba(10,132,255,0.07)',
                      border: isDragTarget ? '1px solid rgba(10,132,255,0.4)' : '1px solid rgba(10,132,255,0.1)',
                    }}
                  >
                    {/* Week drag grip */}
                    <div
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/week-key', wk);
                        e.dataTransfer.effectAllowed = 'move';
                        setDraggingWeekKey(wk);
                      }}
                      onDragEnd={() => { setDraggingWeekKey(null); setDragOverInsertIdx(null); }}
                      className="flex-shrink-0 p-0.5 rounded transition-colors"
                      style={{ color: 'rgba(235,235,245,0.2)', cursor: 'grab' }}
                      title="Ganze Woche verschieben"
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#0a84ff'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(235,235,245,0.2)'; }}
                    >
                      <GripVertical size={15} />
                    </div>

                    {/* Clickable label → collapse; or inline editor when editing */}
                    {editingWeekKey === wk ? (
                      <div className="flex-1 flex items-center gap-1.5 min-w-0 flex-wrap">
                        <input
                          type="date"
                          className="px-2 py-1 rounded-[8px] text-xs outline-none"
                          style={{
                            background: 'rgba(255,255,255,0.06)',
                            border: '1px solid rgba(10,132,255,0.4)',
                            color: 'rgba(235,235,245,0.9)',
                          }}
                          value={editingWeekDraft}
                          onChange={(e) => setEditingWeekDraft(e.target.value)}
                          autoFocus
                        />
                        <button
                          onClick={() => setEditingWeekDraft(currentMondayIso())}
                          className="px-2 py-1 rounded-[8px] text-[11px] font-semibold transition-colors"
                          style={{ background: 'rgba(48,209,88,0.15)', color: '#30d158', border: '1px solid rgba(48,209,88,0.3)' }}
                        >
                          Diese Woche
                        </button>
                        <button
                          onClick={() => setEditingWeekDraft(nextWeekKey(currentMondayIso()))}
                          className="px-2 py-1 rounded-[8px] text-[11px] font-semibold transition-colors"
                          style={{ background: 'rgba(10,132,255,0.15)', color: '#0a84ff', border: '1px solid rgba(10,132,255,0.3)' }}
                        >
                          Nächste Woche
                        </button>
                        <button
                          onClick={() => {
                            const draft = editingWeekDraft;
                            if (!/^\d{4}-\d{2}-\d{2}$/.test(draft)) {
                              showToast('Ungültiges Datum', 'error');
                              return;
                            }
                            // Snap to Monday of the chosen date.
                            const mon = weekKey(draft);
                            handleWeekMove(wk, mon);
                          }}
                          className="px-2.5 py-1 rounded-[8px] text-[11px] font-semibold transition-colors"
                          style={{ background: 'linear-gradient(135deg,#0a84ff,#0a84ff)', color: '#fff' }}
                        >
                          Speichern
                        </button>
                        <button
                          onClick={() => setEditingWeekKey(null)}
                          className="px-2 py-1 rounded-[8px] text-[11px] transition-colors"
                          style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(235,235,245,0.6)' }}
                        >
                          Abbrechen
                        </button>
                      </div>
                    ) : (
                      <button
                        className="flex-1 text-left min-w-0"
                        onClick={() => toggleWeek(wk)}
                      >
                        <span className="text-xs font-bold uppercase tracking-widest" style={{ color: '#0a84ff' }}>
                          Woche {wi + 1}&nbsp;&middot;&nbsp;{formatWeekRange(wk)}&nbsp;&middot;&nbsp;{wDishes.length} {wDishes.length === 1 ? 'Gericht' : 'Gerichte'}
                        </span>
                      </button>
                    )}

                    {/* Season boundary badge — this week's Monday falls in the
                        other season, so the public endpoint will serve the other
                        plan for it. */}
                    {editingWeekKey !== wk && seasonOfIsoDate(wk) !== activePlan && (
                      <span
                        className="flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-[8px] text-[10px] font-bold uppercase tracking-wider"
                        style={{
                          background: seasonOfIsoDate(wk) === 'winter' ? 'rgba(64,156,255,0.18)' : 'rgba(255,159,10,0.18)',
                          color: seasonOfIsoDate(wk) === 'winter' ? '#409cff' : '#ff9f0a',
                          border: seasonOfIsoDate(wk) === 'winter' ? '1px solid rgba(64,156,255,0.35)' : '1px solid rgba(255,159,10,0.35)',
                        }}
                        title={`Am ${formatWeekRange(wk).split('–')[0].trim()} übernimmt der ${seasonOfIsoDate(wk) === 'winter' ? 'Winter' : 'Sommer'}plan diesen Zeitraum`}
                      >
                        {seasonOfIsoDate(wk) === 'winter' ? <Snowflake size={11} /> : <Sun size={11} />}
                        {seasonOfIsoDate(wk) === 'winter' ? 'Winterplan aktiv' : 'Sommerplan aktiv'}
                      </span>
                    )}

                    {/* Edit week date */}
                    {editingWeekKey !== wk && (
                      <button
                        onClick={() => { setEditingWeekKey(wk); setEditingWeekDraft(wk); }}
                        className="flex-shrink-0 p-1.5 rounded-[8px] transition-colors"
                        style={{ color: 'rgba(235,235,245,0.3)' }}
                        title="Wochendatum ändern"
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#0a84ff'; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(235,235,245,0.3)'; }}
                      >
                        <Pencil size={13} />
                      </button>
                    )}

                    {/* Add dish to this week */}
                    <button
                      onClick={() => { setNewDishInitialDate(wk); setEditDish('new'); }}
                      className="flex-shrink-0 p-1.5 rounded-[8px] transition-colors"
                      style={{ color: 'rgba(235,235,245,0.3)' }}
                      title="Gericht zu dieser Woche hinzufügen"
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#0a84ff'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(235,235,245,0.3)'; }}
                    >
                      <Plus size={14} />
                    </button>

                    {/* Collapse toggle */}
                    <button
                      onClick={() => toggleWeek(wk)}
                      className="flex-shrink-0"
                      style={{ color: '#0a84ff' }}
                    >
                      {collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
                    </button>

                    {/* Remove empty week */}
                    {wDishes.length === 0 && planEmptyWeeks.has(wk) && (
                      <button
                        onClick={() => removeEmptyWeek(wk)}
                        className="flex-shrink-0 p-1.5 rounded-[8px] transition-colors"
                        style={{ color: 'rgba(235,235,245,0.3)' }}
                        title="Leere Woche entfernen"
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff453a'; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(235,235,245,0.3)'; }}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>

                  {/* Week body */}
                  {!collapsed && (
                    <div className="flex flex-col gap-2">
                      {wDishes.length === 0 ? (
                        <div
                          className="py-10 rounded-[12px] flex flex-col items-center gap-2"
                          style={{
                            border: `2px dashed ${isDragTarget ? 'rgba(10,132,255,0.55)' : 'rgba(10,132,255,0.15)'}`,
                            background: isDragTarget ? 'rgba(10,132,255,0.06)' : 'transparent',
                            transition: 'all 0.15s',
                          }}
                        >
                          <UtensilsCrossed size={22} style={{ color: isDragTarget ? '#0a84ff' : 'rgba(235,235,245,0.12)' }} />
                          <p className="text-sm select-none" style={{ color: isDragTarget ? '#0a84ff' : 'rgba(235,235,245,0.12)' }}>
                            {isDragTarget ? 'Hier loslassen' : 'Gerichte hier reinziehen'}
                          </p>
                        </div>
                      ) : (
                        wDishes.map((dish) => (
                          <div key={dish.id}>
                            <div className="flex items-center gap-2 mb-1 mt-2 first:mt-0">
                              <span className="text-xs font-medium" style={{ color: 'rgba(235,235,245,0.3)' }}>
                                {formatDate(dish.date)}
                              </span>
                              <div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.04)' }} />
                            </div>
                            <DishCard
                              dish={dish}
                              ratingData={ratingsMap.get(dish.id)}
                              onEdit={setEditDish}
                              onDelete={handleDeleted}
                              onDragStart={() => setDraggingDishId(dish.id)}
                              onDragEnd={() => setDraggingDishId(null)}
                              isDragging={draggingDishId === dish.id}
                            />
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>

                {/* Dropzone AFTER this week */}
                <WeekDropzone
                  visible={showDropAfter}
                  active={dragOverInsertIdx === dropAfterIdx}
                  onEnter={() => setDragOverInsertIdx(dropAfterIdx)}
                  onLeave={() => setDragOverInsertIdx((v) => v === dropAfterIdx ? null : v)}
                  onDrop={() => {
                    if (draggingWeekKey) handleWeekInsert(draggingWeekKey, dropAfterIdx);
                    setDragOverInsertIdx(null);
                    setDraggingWeekKey(null);
                  }}
                />
              </div>
            );
          })}
        </div>
      )}

      {editDish !== null && (
        <DishForm
          key={editDish === 'new' ? '__new__' : (editDish as AdminDishFull).id}
          dish={editDish === 'new' ? null : editDish as AdminDishFull}
          ratingData={editRatingData}
          initialDate={editDish === 'new' ? newDishInitialDate : undefined}
          activePlan={activePlan}
          onSaved={handleSaved}
          onClose={() => { setEditDish(null); setNewDishInitialDate(undefined); }}
          onRatingChanged={loadRatings}
        />
      )}

      {showImport && (
        <ImportDialog
          defaultPlan={activePlan}
          onDone={() => { setShowImport(false); loadDishes(activePlan); }}
          onClose={() => setShowImport(false)}
        />
      )}

    </div>
  );
}
