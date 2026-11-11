import { useState, useEffect, useCallback, useRef, useMemo, createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useHanded } from '../useHanded';
import {
  UtensilsCrossed, Plus, Pencil, Trash2, Download, X, ChevronDown, ChevronUp, Leaf, Sprout, Star,
  GripVertical, CalendarPlus, Sun, Snowflake, RotateCcw, School, CalendarDays, ImagePlus, CloudDownload,
} from 'lucide-react';
import { adminApi, setMenuContext } from '../api';
import { useAccess } from '../access';
import { relative } from '../components/format';
import { useSwitchView } from '../useSwitchView';
import { MenuDeleteDialog, MenuNameDialog, MenuSchoolsDialog } from '../components/MenuDialogs';
import type { AdminDishFull, AdminDish, AdminDishRatingEntry, DishPictureStatus, DishPlan, MensaMenu, MenuBreakReason, MenuCalendar, MenuDayOverride, MenuMode, MenuPullMode, MenuScheduleInfo, MenuWeekCount } from '../types';
import { useToast } from '../components/Toast';
import { useLive } from '../live';
import { Collapse, Delta, Dialog, Figures, IconButton, Notice, PageHeader, SearchField, Segmented, Spinner, Tag } from '../components/kit';

// What the signed-in admin may change here: the menu (mensa.manage) and the
// votes on it (comments.moderate). Without them the plan is shown read-only;
// the server refuses such changes in any case.
const MensaRights = createContext({ edit: true, moderate: true });

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

// "2026-10-12" -> { weekday: "Montag", short: "12.10." }, parsed as a local date.
function dayParts(iso: string): { weekday: string; short: string } {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  if (isNaN(date.getTime())) return { weekday: iso, short: '' };
  return {
    weekday: date.toLocaleDateString('de-AT', { weekday: 'long' }),
    short: date.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' }),
  };
}

// Consecutive dishes of the same date become one day group (input is date-ordered).
function groupByDay<T extends { date: string }>(dishes: T[]): Array<[string, T[]]> {
  const groups: Array<[string, T[]]> = [];
  for (const dish of dishes) {
    const last = groups[groups.length - 1];
    if (last && last[0] === dish.date) last[1].push(dish);
    else groups.push([dish.date, [dish]]);
  }
  return groups;
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

// The last Sunday of `month` (0-based) in `year`, the day the clocks change.
function lastSundayIso(year: number, month: number): string {
  const last = new Date(year, month + 1, 0);
  last.setDate(last.getDate() - last.getDay());
  return toLocalIso(last);
}

// The menu's rule (GET /dishes/schedule); until it is known, the canteens' usual dates.
let seasonRule: { kind: 'dates' | 'clock'; summerFrom: string; winterFrom: string } = { kind: 'dates', summerFrom: '04-01', winterFrom: '11-01' };

// The season of today, i.e. the plan the public /dishes endpoint serves now.
function currentSeason(): DishPlan {
  return seasonOfIsoDate(toLocalIso(new Date()));
}

// Mirror of the backend slugifyDishName. Used as a fallback so rating/comment
// lookups still work for dishes that haven't been re-migrated yet.
function slugifyDishName(name: string): string {
  const s = (name ?? '').toString();
  const stripped = s
    .toLowerCase()
    .normalize('NFD')
    .replace(new RegExp('[̀-ͯ]', 'g'), '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return stripped.slice(0, 180);
}

// The stable key ratings/comments are stored under. Prefer the server-supplied
// stableKey; fall back to a fresh slug so the UI still stitches things together
// even against slightly older API responses.
function dishKeyOf(dish: { stableKey?: string; nameDe: string }): string {
  return dish.stableKey && dish.stableKey.length > 0 ? dish.stableKey : slugifyDishName(dish.nameDe);
}

// Which season the given day is in: by its date, on the canteen's dates (as
// the top right corner of its plans has them), or with the clocks (summer
// from the switch to summer time, the last Sunday of March, to the switch to
// winter time, the last Sunday of October; by the week's Monday). Mirrors
// backend utils/mensaSeason.seasonOfDay. Used to warn the user when days of a
// week of the active plan lie in the other season — those days the public
// /dishes endpoint serves the other plan.
function seasonOfIsoDate(iso: string): DishPlan {
  if (seasonRule.kind === 'dates') {
    const day = iso.slice(5);
    const { summerFrom: from, winterFrom: to } = seasonRule;
    return (from < to ? day >= from && day < to : day >= from || day < to) ? 'summer' : 'winter';
  }
  const mon = weekKey(iso);
  const year = Number(mon.slice(0, 4));
  return mon > lastSundayIso(year, 2) && mon < lastSundayIso(year, 9) ? 'summer' : 'winter';
}

const SHORT_WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr'];

// The school days (Monday to Friday) of the week of `monIso` that lie in the
// other season than `plan`'s, by their short names: [] when none.
function otherSeasonDays(monIso: string, plan: DishPlan): string[] {
  return SHORT_WEEKDAYS.filter((_, i) => seasonOfIsoDate(dateForWeekAndDow(monIso, i + 1)) !== plan);
}


// ─── StarsDisplay ────────────────────────────────────────────────────────────

function StarsDisplay({ value, size = 13 }: { value: number; size?: number }) {
  return (
    <div className="flex gap-0.5 items-center">
      {[1, 2, 3, 4, 5].map((s) => (
        <Star
          key={s}
          size={size}
          fill={value >= s ? 'var(--gold-deep)' : 'transparent'}
          stroke={value >= s ? 'var(--gold-deep)' : 'rgb(var(--ink-rgb) / 0.42)'}
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
            fill={(hovered || value) >= s ? 'var(--gold-deep)' : 'transparent'}
            stroke={(hovered || value) >= s ? 'var(--gold-deep)' : 'rgb(var(--ink-rgb) / 0.5)'}
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
  const rights = useContext(MensaRights);
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
      className="flex items-center gap-3 px-3 py-2.5 rounded-[14px]"
      style={{ background: 'rgb(var(--ink-rgb) / calc(0.024 * var(--veil)))', border: '1px solid transparent' }}
    >
      <span className="flex-1 text-sm font-medium truncate" style={{ color: 'rgb(var(--ink-rgb) / 0.82)' }}>
        {entry.username}
      </span>

      {editing ? (
        <div className="flex items-center gap-2 flex-shrink-0">
          <StarSelector value={editStars} onChange={setEditStars} />
          <button onClick={handleSave} disabled={saving}
            className="px-2.5 py-1 rounded-full text-xs font-semibold"
            style={{ background: 'rgba(60,135,215,0.2)', color: 'var(--sky-deep)', border: '1px solid transparent' }}>
            {saving ? '...' : 'OK'}
          </button>
          <button onClick={() => { setEditing(false); setEditStars(entry.stars); }}
            className="px-2.5 py-1 rounded-full text-xs"
            style={{ background: 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))', color: 'rgb(var(--ink-rgb) / 0.74)' }}>
            Abbrechen
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-shrink-0">
          <StarsDisplay value={entry.stars} />
          <span className="text-xs w-3 text-center" style={{ color: 'var(--gold-deep)' }}>{entry.stars}</span>
          {rights.moderate && <><button onClick={() => setEditing(true)}
            className="p-1.5 rounded-full transition-colors"
            style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--sky-deep)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgb(var(--ink-rgb) / 0.5)'; }}>
            <Pencil size={13} />
          </button>
          {confirmDel ? (
            <div className="flex items-center gap-1">
              <button onClick={handleDelete} disabled={deleting}
                className="px-2 py-1 rounded-full text-xs font-semibold"
                style={{ background: 'rgba(225,70,75,0.14)', color: 'var(--rose-deep)', border: '1px solid transparent' }}>
                {deleting ? '...' : 'Sicher?'}
              </button>
              <button onClick={() => setConfirmDel(false)}
                className="px-2 py-1 rounded-full text-xs"
                style={{ background: 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))', color: 'rgb(var(--ink-rgb) / 0.74)' }}>
                Nein
              </button>
            </div>
          ) : (
            <button onClick={() => setConfirmDel(true)}
              className="p-1.5 rounded-full transition-colors"
              style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--rose-deep)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgb(var(--ink-rgb) / 0.5)'; }}>
              <Trash2 size={13} />
            </button>
          )}</>}
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

function DishForm({ dish, ratingData: ratingSummary, initialDate, activePlan, onSaved, onClose, onRatingChanged }: DishFormProps) {
  const { showToast } = useToast();
  const isEdit = dish !== null;
  // The list holds only each dish's average and count; this dish's votes
  // are read when its editor opens, and again after one changes.
  const [ratingDetail, setRatingDetail] = useState<AdminDish | null>(null);
  const [ratingsVersion, setRatingsVersion] = useState(0);
  const summaryKey = ratingSummary?.dishId;
  const summaryCount = ratingSummary?.count ?? 0;
  useEffect(() => {
    if (!isEdit || !summaryKey || summaryCount === 0) return;
    let cancelled = false;
    adminApi.dishRatings({ dishKey: summaryKey })
      .then((rows) => { if (!cancelled) setRatingDetail(rows.find((r) => r.dishId === summaryKey) ?? null); })
      .catch(() => { /* the summary still shows the average */ });
    return () => { cancelled = true; };
  }, [isEdit, summaryKey, summaryCount, ratingsVersion]);
  const ratingData = ratingDetail ?? ratingSummary;
  const ratingChanged = () => { setRatingsVersion((v) => v + 1); onRatingChanged(); };

  const [form, setForm] = useState(() =>
    dish
      ? { ...dish, tagsText: dish.tags.join('\n'), allergensText: dish.allergens.join('\n') }
      : { ...emptyDish(initialDate, activePlan), tagsText: '', allergensText: '' }
  );
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'basic' | 'nutrition' | 'ratings'>('basic');
  const [uploading, setUploading] = useState(false);
  // A new dish has no id yet: its picture goes up right after it is saved.
  const [pendingImage, setPendingImage] = useState<{ data: string; mimeType: string; preview: string } | null>(null);
  const uploadedHere = isEdit && dish.imageUrl.includes(`/dishes/${dish.id}/image`);

  async function chooseImage(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    try {
      const image = await imageForUpload(file);
      if (isEdit) {
        const res = await adminApi.uploadDishImage(dish.id, image.data, image.mimeType);
        set('imageUrl', res.imageUrl);
        showToast(res.dishes > 1 ? `Bild gespeichert, gilt für ${res.dishes} Tage mit diesem Gericht` : 'Bild gespeichert', 'success');
      } else {
        setPendingImage({ ...image, preview: `data:${image.mimeType};base64,${image.data}` });
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Das Bild konnte nicht hochgeladen werden', 'error');
    } finally {
      setUploading(false);
    }
  }

  async function removeImage() {
    setPendingImage(null);
    if (isEdit && (uploadedHere || form.imageUrl.includes(`/dishes/${dish.id}/image`))) {
      try {
        await adminApi.deleteDishImage(dish.id);
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Das Bild konnte nicht entfernt werden', 'error');
        return;
      }
    }
    set('imageUrl', '');
  }

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
      const { picture, ...answer } = isEdit
        ? await adminApi.updateDish(dish!.id, payload)
        : await adminApi.createDish(payload);
      let saved: AdminDishFull = answer;
      if (pendingImage) {
        const res = await adminApi.uploadDishImage(saved.id, pendingImage.data, pendingImage.mimeType);
        saved = { ...saved, imageUrl: res.imageUrl };
      }
      onSaved(saved);
      const done = isEdit ? 'Gericht gespeichert' : 'Gericht erstellt';
      // A pasted picture link is fetched into the database (services/dishPictures.ts).
      if (picture && !pendingImage) {
        if (picture.ok) showToast(`${done} · Bild in die Datenbank übernommen`, 'success');
        else if (picture.pending) showToast(`${done} · Das Bild wird im Hintergrund übernommen`, 'success');
        else showToast(`${done}, aber das Bild wurde nicht übernommen: ${picture.error}. POKYH versucht es später erneut.`, 'error');
      } else {
        showToast(done, 'success');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Fehler beim Speichern', 'error');
    } finally {
      setSaving(false);
    }
  }

  const inp = 'w-full px-3 py-2 rounded-[10px] text-sm outline-none transition-all';
  const inpStyle = { background: 'rgb(var(--ink-rgb) / calc(0.032 * var(--veil)))', border: '1px solid transparent', color: 'rgb(var(--ink-rgb) / 0.9)' };
  const focusStyle = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    (e.target as HTMLElement).style.borderColor = 'rgba(60,135,215,0.45)';
    (e.target as HTMLElement).style.boxShadow = '0 0 0 3px rgba(60,135,215,0.04)';
  };
  const blurStyle = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    (e.target as HTMLElement).style.borderColor = 'rgb(var(--ink-rgb) / calc(0.109 * var(--veil)))';
    (e.target as HTMLElement).style.boxShadow = '';
  };
  const lbl = 'block text-[13px] mb-1.5';
  const lblStyle = { color: 'rgb(var(--ink-rgb) / 0.58)' };

  const tabs = [
    { key: 'basic' as const, label: 'Allgemein' },
    { key: 'nutrition' as const, label: 'Nährwerte' },
    ...(isEdit ? [{ key: 'ratings' as const, label: `Ratings${ratingData && ratingData.count > 0 ? ` (${ratingData.count})` : ''}` }] : []),
  ];

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ background: 'var(--scrim)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-lg flex flex-col animate-scaleIn overflow-hidden rounded-[22px]"
        style={{
          background: 'var(--raise)',
          border: '1px solid transparent',
          boxShadow: '0 44px 70px -40px rgb(0 0 0 / 0.4)',
          maxHeight: 'calc(100dvh - 32px)',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 flex-shrink-0" style={{ borderBottom: '1px solid rgb(var(--ink-rgb) / calc(0.087 * var(--veil)))' }}>
          <h2 className="font-semibold" style={{ color: 'rgb(var(--ink-rgb) / 0.98)' }}>
            {isEdit ? 'Gericht bearbeiten' : 'Neues Gericht'}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-full transition-colors" style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ink)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgb(var(--ink-rgb) / 0.5)'; }}>
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex flex-shrink-0 px-5 pt-3 gap-1" style={{ borderBottom: '1px solid rgb(var(--ink-rgb) / calc(0.076 * var(--veil)))' }}>
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className="px-4 py-2 text-xs font-semibold rounded-t-lg transition-all"
              style={{
                color: tab === t.key ? 'var(--sky-deep)' : 'rgb(var(--ink-rgb) / 0.58)',
                borderBottom: tab === t.key ? '2px solid var(--sky-deep)' : '2px solid transparent',
                background: tab === t.key ? 'rgba(60,135,215,0.06)' : 'transparent',
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
              {(pendingImage || form.imageUrl) && (
                <div className="w-full h-36 rounded-[14px] overflow-hidden flex-shrink-0"
                  style={{ border: '1px solid rgb(var(--ink-rgb) / calc(0.087 * var(--veil)))' }}>
                  <img src={pendingImage?.preview ?? form.imageUrl} alt="" className="w-full h-full object-cover"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <label className="btn btn-quiet btn-sm cursor-pointer">
                  <ImagePlus size={15} strokeWidth={1.7} />
                  {uploading ? 'Lädt…' : 'Bild hochladen'}
                  <input
                    type="file"
                    accept={IMAGE_TYPES.join(',')}
                    className="sr-only"
                    disabled={uploading}
                    onChange={(e) => { void chooseImage(e.target.files?.[0]); e.target.value = ''; }}
                  />
                </label>
                {(pendingImage || form.imageUrl) && (
                  <button type="button" className="btn btn-quiet btn-sm" disabled={uploading} onClick={() => void removeImage()}>Bild entfernen</button>
                )}
                <span className="text-[12px] text-ink-4">JPG, PNG, WebP oder GIF. Gilt für alle Tage mit diesem Gericht.</span>
              </div>

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
                      className="flex items-center gap-1.5 px-3 rounded-full text-xs font-semibold transition-all"
                      style={{
                        background: form.plan === 'summer' ? 'rgba(236,140,40,0.18)' : 'rgb(var(--ink-rgb) / calc(0.032 * var(--veil)))',
                        border: form.plan === 'summer' ? '1px solid transparent' : '1px solid transparent',
                        color: form.plan === 'summer' ? 'var(--amber-deep)' : 'rgb(var(--ink-rgb) / 0.58)',
                      }}
                    >
                      <Sun size={13} /> Sommer
                    </button>
                    <button
                      type="button"
                      onClick={() => set('plan', 'winter')}
                      className="flex items-center gap-1.5 px-3 rounded-full text-xs font-semibold transition-all"
                      style={{
                        background: form.plan === 'winter' ? 'rgba(60,135,215,0.18)' : 'rgb(var(--ink-rgb) / calc(0.032 * var(--veil)))',
                        border: form.plan === 'winter' ? '1px solid transparent' : '1px solid transparent',
                        color: form.plan === 'winter' ? 'var(--sky-deep)' : 'rgb(var(--ink-rgb) / 0.58)',
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
                <label style={lblStyle} className={lbl}>Bild-Link</label>
                <input className={inp} style={inpStyle} value={form.imageUrl}
                  onChange={(e) => set('imageUrl', e.target.value)}
                  onFocus={focusStyle} onBlur={blurStyle} placeholder="https://..." />
                <p className="mt-1 text-[12px] text-ink-4">Ein Link wird beim Speichern heruntergeladen und als eigenes Bild in der Datenbank gespeichert, so ist es in jedem Backup.</p>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setForm((p) => ({ ...p, isVegetarian: !p.isVegetarian }))}
                  className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all select-none"
                  style={{
                    background: form.isVegetarian ? 'rgba(34,197,94,0.15)' : 'rgb(var(--ink-rgb) / calc(0.032 * var(--veil)))',
                    border: form.isVegetarian ? '1px solid transparent' : '1px solid transparent',
                    color: form.isVegetarian ? '#4ade80' : 'rgb(var(--ink-rgb) / 0.58)',
                  }}
                >
                  <Leaf size={14} />
                  Vegetarisch
                </button>
                <button
                  type="button"
                  onClick={() => setForm((p) => ({ ...p, isVegan: !p.isVegan }))}
                  className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all select-none"
                  style={{
                    background: form.isVegan ? 'rgba(134,239,172,0.15)' : 'rgb(var(--ink-rgb) / calc(0.032 * var(--veil)))',
                    border: form.isVegan ? '1px solid transparent' : '1px solid transparent',
                    color: form.isVegan ? 'var(--mint-deep)' : 'rgb(var(--ink-rgb) / 0.58)',
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
                  <div className="flex items-center gap-3 px-4 py-3 rounded-[14px]"
                    style={{ background: 'rgba(236,140,40,0.08)', border: '1px solid transparent' }}>
                    <StarsDisplay value={Math.round(ratingData.avgStars)} size={16} />
                    <span className="text-base font-bold" style={{ color: 'var(--gold-deep)' }}>
                      {ratingData.avgStars.toFixed(1)}
                    </span>
                    <span className="text-sm" style={{ color: 'rgb(var(--ink-rgb) / 0.58)' }}>
                      · {ratingData.count} {ratingData.count === 1 ? 'Bewertung' : 'Bewertungen'}
                    </span>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    {ratingData.ratings.map((entry) => (
                      <RatingRow
                        key={entry.stableUid}
                        dishId={ratingData.dishId}
                        entry={entry}
                        onChanged={ratingChanged}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center py-10 gap-2">
                  <Star size={28} style={{ color: 'rgb(var(--ink-rgb) / 0.42)' }} />
                  <p className="text-sm" style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}>Noch keine Bewertungen</p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {tab !== 'ratings' && (
          <div className="flex items-center justify-end gap-3 px-5 py-4 flex-shrink-0" style={{ borderTop: '1px solid rgb(var(--ink-rgb) / calc(0.087 * var(--veil)))' }}>
            <button onClick={onClose} className="px-4 py-2 rounded-full text-sm transition-colors"
              style={{ background: 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))', color: 'rgb(var(--ink-rgb) / 0.74)', border: '1px solid transparent' }}>
              Abbrechen
            </button>
            <button onClick={handleSave} disabled={saving}
              className="px-5 py-2 rounded-full text-sm font-semibold transition-all"
              style={{
                background: saving ? 'rgba(60,135,215,0.4)' : 'var(--sky)',
                color: 'var(--on-sky)',
                boxShadow: 'none',
              }}>
              {saving ? 'Speichern...' : isEdit ? 'Speichern' : 'Erstellen'}
            </button>
          </div>
        )}
        {tab === 'ratings' && (
          <div className="flex items-center justify-end px-5 py-4 flex-shrink-0" style={{ borderTop: '1px solid rgb(var(--ink-rgb) / calc(0.087 * var(--veil)))' }}>
            <button onClick={onClose} className="px-4 py-2 rounded-full text-sm transition-colors"
              style={{ background: 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))', color: 'rgb(var(--ink-rgb) / 0.74)', border: '1px solid transparent' }}>
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
  const rights = useContext(MensaRights);
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
      draggable={rights.edit}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/dish-id', dish.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className="dish-row spot flex items-center gap-4 py-3.5 pl-3"
      style={{
        opacity: isDragging ? 0.35 : 1,
        cursor: isDragging ? 'grabbing' : 'default',
        transition: 'opacity 0.15s',
      }}
    >
      {/* Drag grip */}
      <div
        className="flex-shrink-0"
        style={{ color: 'rgb(var(--ink-rgb) / 0.42)', cursor: 'grab' }}
        title="Ziehen zum Verschieben"
      >
        <GripVertical size={15} />
      </div>

      {/* Image */}
      <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-well">
        {dish.imageUrl && !imgError ? (
          <img src={dish.imageUrl} alt={dish.nameDe} className="w-full h-full object-cover"
            onError={() => setImgError(true)} />
        ) : (
          <UtensilsCrossed size={18} style={{ color: 'rgb(var(--ink-rgb) / 0.42)' }} />
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="truncate text-[14.5px] font-medium">{dish.nameDe}</span>
          {!!dish.isVegan && <Sprout size={13} style={{ color: 'var(--mint-deep)' }} />}
          {!!dish.isVegetarian && !dish.isVegan && <Leaf size={13} style={{ color: '#22c55e' }} />}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          {dish.category && <Tag tone="sky">{dish.category}</Tag>}
          {dish.calories > 0 && (
            <span className="text-xs" style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}>{dish.calories} kcal</span>
          )}
          {ratingData && ratingData.count > 0 ? (
            <div className="flex items-center gap-1">
              <StarsDisplay value={Math.round(ratingData.avgStars)} size={11} />
              <span className="text-xs font-semibold" style={{ color: 'var(--gold-deep)' }}>{ratingData.avgStars.toFixed(1)}</span>
              <span className="text-xs" style={{ color: 'rgb(var(--ink-rgb) / 0.42)' }}>({ratingData.count})</span>
            </div>
          ) : (
            <span className="text-xs" style={{ color: 'rgb(var(--ink-rgb) / 0.42)' }}>Keine Bewertungen</span>
          )}
        </div>
      </div>

      {/* Actions */}
      {rights.edit && <div className="flex flex-shrink-0 items-center gap-1.5">
        {confirmDel ? (
          <>
            <button type="button" onClick={handleDelete} disabled={deleting} className="btn btn-sm btn-danger">
              {deleting ? 'Lösche…' : 'Wirklich löschen?'}
            </button>
            <button type="button" onClick={() => setConfirmDel(false)} className="btn btn-sm btn-quiet">Nein</button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => onEdit(dish)} className="orb icon-btn h-[38px] w-[38px]" data-tone="sky" title="Gericht bearbeiten" aria-label={`${dish.nameDe} bearbeiten`}>
              <Pencil size={16} strokeWidth={1.7} />
            </button>
            <button type="button" onClick={() => setConfirmDel(true)} className="orb icon-btn h-[38px] w-[38px]" data-tone="rose" title="Gericht löschen" aria-label={`${dish.nameDe} löschen`}>
              <Trash2 size={16} strokeWidth={1.7} />
            </button>
          </>
        )}
      </div>}
    </div>
  );
}

// ─── ImportDialog ────────────────────────────────────────────────────────────

function ImportDialog({ defaultPlan, onDone, onClose }: { defaultPlan: DishPlan; onDone: () => void; onClose: () => void }) {
  const { showToast } = useToast();
  // Empty: the server uses MENSA_IMPORT_URL.
  const [url, setUrl] = useState('');
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
      style={{ background: 'var(--scrim)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-[22px] p-6 animate-scaleIn"
        style={{ background: 'var(--well)', border: '1px solid transparent' }}>
        <h3 className="font-bold mb-1" style={{ color: 'rgb(var(--ink-rgb) / 0.98)' }}>Gerichte importieren</h3>
        <p className="text-xs mb-4" style={{ color: 'rgb(var(--ink-rgb) / 0.58)' }}>
          Lädt alle Gerichte von der externen URL und speichert sie im ausgewählten Plan. Vorhandene werden aktualisiert.
        </p>

        <label className="block text-[13px] mb-1.5" style={{ color: 'rgb(var(--ink-rgb) / 0.58)' }}>Plan</label>
        <div className="flex gap-2 mb-4">
          <button
            type="button"
            onClick={() => setPlan('summer')}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-full text-sm font-semibold transition-all"
            style={{
              background: plan === 'summer' ? 'rgba(236,140,40,0.18)' : 'rgb(var(--ink-rgb) / calc(0.032 * var(--veil)))',
              border: plan === 'summer' ? '1px solid transparent' : '1px solid transparent',
              color: plan === 'summer' ? 'var(--amber-deep)' : 'rgb(var(--ink-rgb) / 0.66)',
            }}
          >
            <Sun size={15} /> Sommer
          </button>
          <button
            type="button"
            onClick={() => setPlan('winter')}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-full text-sm font-semibold transition-all"
            style={{
              background: plan === 'winter' ? 'rgba(60,135,215,0.18)' : 'rgb(var(--ink-rgb) / calc(0.032 * var(--veil)))',
              border: plan === 'winter' ? '1px solid transparent' : '1px solid transparent',
              color: plan === 'winter' ? 'var(--sky-deep)' : 'rgb(var(--ink-rgb) / 0.66)',
            }}
          >
            <Snowflake size={15} /> Winter
          </button>
        </div>

        <label className="block text-[13px] mb-1.5" style={{ color: 'rgb(var(--ink-rgb) / 0.58)' }}>Quell-URL</label>
        <input
          className="field h-11 px-4 text-[14px] w-full mb-4"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="leer = MENSA_IMPORT_URL aus der .env"
        />
        <div className="flex items-center justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded-full text-sm"
            style={{ background: 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))', color: 'rgb(var(--ink-rgb) / 0.74)' }}>
            Abbrechen
          </button>
          <button onClick={handleImport} disabled={loading}
            className="flex items-center gap-2 px-5 py-2 rounded-full text-sm font-semibold transition-all"
            style={{
              background: loading ? 'rgba(60,135,215,0.4)' : 'var(--sky)',
              color: 'var(--on-sky)', boxShadow: 'none',
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
        border: visible ? `2px dashed ${active ? 'rgba(60,135,215,0.7)' : 'rgba(60,135,215,0.28)'}` : '2px dashed transparent',
        background: active ? 'rgba(60,135,215,0.12)' : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'height 160ms ease, background 160ms ease, border-color 160ms ease, margin 160ms ease',
        pointerEvents: visible ? 'auto' : 'none',
      }}
    >
      {visible && (
        <span className="text-xs font-medium select-none" style={{ color: active ? 'var(--sky-deep)' : 'rgba(42,120,204,0.55)' }}>
          Hier ablegen
        </span>
      )}
    </div>
  );
}

// ─── MenuPlan ─────────────────────────────────────────────────────────────────

interface HandedDish { menuId: string; search: string; plan: DishPlan }

// ─── A dish's picture ───────────────────────────────────────────────────────

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
// The server takes 3 MB at most; a larger picture is made smaller here first.
const IMAGE_MAX_BYTES = 2.5 * 1024 * 1024;
const IMAGE_MAX_SIDE = 1600;

async function smallerImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Das Bild konnte nicht verkleinert werden'))), 'image/jpeg', 0.85);
  });
}

// What the upload route takes: base64 without the "data:…" in front.
async function imageForUpload(file: File): Promise<{ data: string; mimeType: string }> {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error('Nur JPG, PNG, WebP oder GIF');
  const blob = file.size > IMAGE_MAX_BYTES ? await smallerImage(file) : file;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Das Bild konnte nicht gelesen werden'));
    reader.readAsDataURL(blob);
  });
  return { data: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: blob.type };
}

// ─── How the menu moves along the calendar ──────────────────────────────────

const BREAK_NAMES: Record<MenuBreakReason, string> = {
  summer: 'Sommerferien',
  allSaints: 'Allerheiligenferien',
  christmas: 'Weihnachtsferien',
  winter: 'Faschingsferien',
  easter: 'Osterferien',
  holiday: 'Feiertag',
  bridge: 'Fenstertag',
  school: 'Schulfrei',
  closed: 'Mensa zu',
};

function breakRange(start: string, end: string): string {
  const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('de-AT', { day: 'numeric', month: 'numeric' });
  return start === end ? day(start) : `${day(start)}–${day(end)}`;
}

// A whole school week (Monday to Friday) within breaks.
function weekInBreak(monIso: string, schedule: MenuScheduleInfo): boolean {
  return [1, 2, 3, 4, 5].every((dow) => {
    const day = dateForWeekAndDow(monIso, dow);
    return schedule.breaks.some((b) => b.start <= day && day <= b.end);
  });
}

const fieldClass = 'field h-11 px-4 text-[14px]';

// "heute 14:30", "morgen 08:00", "Fr, 7.11. 09:15": when something happens next.
function upcomingTime(iso: string): string {
  const at = new Date(iso);
  const now = new Date();
  const time = at.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
  const dayDiff = Math.round((new Date(at.toDateString()).getTime() - new Date(now.toDateString()).getTime()) / 86_400_000);
  if (at.getTime() - now.getTime() < 60_000) return 'in Kürze';
  if (dayDiff === 0) return `heute ${time}`;
  if (dayDiff === 1) return `morgen ${time}`;
  return `${at.toLocaleDateString('de-AT', { weekday: 'short', day: 'numeric', month: 'numeric' })} ${time}`;
}

const weekdayDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('de-AT', { weekday: 'short', day: 'numeric', month: 'numeric' });

function OverridesEditor({ overrides, canEdit, busy, onChange }: {
  overrides: MenuDayOverride[];
  canEdit: boolean;
  busy: boolean;
  onChange: (next: MenuDayOverride[]) => void;
}) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  const endBeforeStart = Boolean(start && end && end < start);
  const full = overrides.length >= 60;
  const add = () => {
    if (!start || endBeforeStart) return;
    onChange([...overrides, { start, end: end || start, open, ...(note.trim() ? { note: note.trim() } : {}) }]);
    setStart('');
    setEnd('');
    setNote('');
  };
  const sorted = overrides.map((o, i) => ({ o, i })).sort((a, b) => a.o.start.localeCompare(b.o.start));
  return (
    <div>
      <div className="text-[13.5px] font-medium text-ink">Eigene Tage</div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">Tage, an denen die Mensa anders als der Kalender zu oder offen ist, z. B. ein Betriebsausflug oder ein Projekttag.</p>
      {overrides.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-4">Keine eigenen Tage.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {sorted.map(({ o, i }) => (
            <li key={`${o.start}-${i}`} className="flex flex-wrap items-center gap-2.5">
              <Tag tone={o.open ? 'mint' : 'amber'}>{o.open ? 'Offen' : 'Zu'}</Tag>
              <span className="tabular text-[13.5px] text-ink-2">{breakRange(o.start, o.end)}</span>
              {o.note && <span className="text-[13px] text-ink-3">{o.note}</span>}
              {canEdit && (confirmRemove === i ? (
                <span className="flex items-center gap-2">
                  <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => { setConfirmRemove(null); onChange(overrides.filter((_, n) => n !== i)); }}>Entfernen</button>
                  <button type="button" className="btn btn-sm btn-quiet" onClick={() => setConfirmRemove(null)}>Behalten</button>
                </span>
              ) : (
                <button type="button" aria-label={`Eintrag ${breakRange(o.start, o.end)} entfernen`} className="text-ink-4 hover:text-ink" disabled={busy} onClick={() => setConfirmRemove(i)}>
                  <X size={14} />
                </button>
              ))}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (full ? (
        <p className="mt-3 text-[12.5px] text-ink-3">60 eigene Tage sind das Höchste. Entferne vergangene, um neue einzutragen.</p>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-[repeat(2,minmax(0,170px))_minmax(0,1fr)] sm:items-end">
          <label className="block text-[12.5px] text-ink-3">
            Von
            <input type="date" className={`${fieldClass} mt-1 w-full`} value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="block text-[12.5px] text-ink-3">
            Bis <span className="text-ink-4">(optional)</span>
            <input type="date" className={`${fieldClass} mt-1 w-full`} value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} aria-invalid={endBeforeStart} />
          </label>
          <label className="block text-[12.5px] text-ink-3">
            Grund <span className="text-ink-4">(optional)</span>
            <input className={`${fieldClass} mt-1 w-full`} maxLength={80} value={note} onChange={(e) => setNote(e.target.value)} placeholder="z. B. Betriebsausflug" />
          </label>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
            <Segmented<'closed' | 'open'>
              label="Mensa an diesen Tagen"
              value={open ? 'open' : 'closed'}
              onChange={(v) => setOpen(v === 'open')}
              options={[{ value: 'closed', label: 'Zu' }, { value: 'open', label: 'Offen' }]}
            />
            <button type="button" className="btn btn-quiet btn-sm" disabled={!start || endBeforeStart || busy} onClick={add}>
              <Plus size={14} /> Eintragen
            </button>
            {endBeforeStart && <span className="text-[12.5px]" style={{ color: 'var(--rose-deep)' }}>„Bis“ liegt vor „Von“.</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

const LINE_NAMES: Record<string, string> = { summer: 'Sommerplan', winter: 'Winterplan', 'summer-veg': 'Sommer vegetarisch', 'winter-veg': 'Winter vegetarisch' };

function SourceEditor({ schedule, canEdit, onSaved, onPulled }: {
  schedule: MenuScheduleInfo;
  canEdit: boolean;
  onSaved: (next: MenuScheduleInfo) => void;
  onPulled: () => void;
}) {
  const { showToast } = useToast();
  const urlOf = useCallback((plan: DishPlan) => schedule.sources.find((s) => s.plan === plan)?.url ?? '', [schedule.sources]);
  const [summerUrl, setSummerUrl] = useState(urlOf('summer'));
  const [winterUrl, setWinterUrl] = useState(urlOf('winter'));
  const [page, setPage] = useState(schedule.sourcePage);
  const [canteen, setCanteen] = useState(schedule.sourceCanteen);
  const [busy, setBusy] = useState<'mode' | 'save' | 'pull' | null>(null);
  const changed = summerUrl.trim() !== urlOf('summer') || winterUrl.trim() !== urlOf('winter') || page.trim() !== schedule.sourcePage || canteen.trim() !== schedule.sourceCanteen;
  // What is stored arrives (another admin, a pull): fields nobody is editing follow it.
  const dirty = useRef(false);
  dirty.current = changed;
  useEffect(() => {
    if (dirty.current) return;
    setSummerUrl(urlOf('summer'));
    setWinterUrl(urlOf('winter'));
    setPage(schedule.sourcePage);
    setCanteen(schedule.sourceCanteen);
  }, [schedule.sourcePage, schedule.sourceCanteen, urlOf]);
  const usable = schedule.sourcePage !== '' || schedule.sources.some((s) => s.url || s.usesServerSource);
  const pullOff = (schedule.pullIntervalHours ?? 6) <= 0;

  async function store(pullMode: MenuPullMode, fields: { summerUrl: string; winterUrl: string; sourcePage: string; sourceCanteen: string }, what: 'mode' | 'save') {
    setBusy(what);
    try {
      onSaved(await adminApi.setMenuSource({ pullMode, ...fields }));
      showToast(what === 'mode' ? (pullMode === 'auto' ? 'Plan wird automatisch geholt' : 'Plan wird nur noch von Hand geholt') : 'Quelle gespeichert', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Die Quelle konnte nicht gespeichert werden', 'error');
    } finally {
      setBusy(null);
    }
  }

  // Switching how plans are pulled keeps the stored addresses, whatever is typed below.
  const setMode = (pullMode: MenuPullMode) => {
    if (pullMode === schedule.pullMode || busy) return;
    void store(pullMode, { summerUrl: urlOf('summer'), winterUrl: urlOf('winter'), sourcePage: schedule.sourcePage, sourceCanteen: schedule.sourceCanteen }, 'mode');
  };
  const save = () => void store(schedule.pullMode, { summerUrl: summerUrl.trim(), winterUrl: winterUrl.trim(), sourcePage: page.trim(), sourceCanteen: canteen.trim() }, 'save');

  async function pull(force: boolean) {
    setBusy('pull');
    try {
      const { results, schedule: next } = await adminApi.pullMenuSource(force);
      onSaved(next);
      onPulled();
      const failed = results.find((r) => r.status === 'error' || r.status === 'held');
      if (failed) showToast(`${LINE_NAMES[failed.plan] ?? failed.plan}: ${failed.message}`, 'error');
      else {
        const sum = (key: 'created' | 'updated' | 'removed') => results.reduce((n, r) => n + r[key], 0);
        showToast(`Geholt · ${sum('created')} neu, ${sum('updated')} geändert, ${sum('removed')} entfernt`, 'success');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Der Plan konnte nicht geholt werden', 'error');
    } finally {
      setBusy(null);
    }
  }

  const held = schedule.sources.filter((s) => s.status === 'held');
  const failed = schedule.sources.filter((s) => s.status === 'error');
  const lines = schedule.sources.filter((s) => s.checkedAt || s.nextPullAt);
  const pullHint = !usable ? 'Trag zuerst eine Quelle ein.' : changed ? 'Speichere zuerst die geänderte Quelle.' : '';
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span className="flex items-center gap-2 text-[14.5px] font-medium text-ink"><CloudDownload size={16} strokeWidth={1.7} /> Quelle</span>
        {canEdit ? (
          <Segmented<MenuPullMode>
            label="Plan holen"
            value={schedule.pullMode}
            onChange={setMode}
            options={[{ value: 'auto', label: 'Automatisch' }, { value: 'manual', label: 'Nur von Hand' }]}
          />
        ) : (
          <Tag>{schedule.pullMode === 'auto' ? 'Automatisch' : 'Nur von Hand'}</Tag>
        )}
        {busy === 'mode' && <Spinner size={15} />}
        {canEdit && (
          <span className="flex items-center gap-2.5">
            <button type="button" className="btn btn-quiet btn-sm" disabled={busy !== null || pullHint !== ''} title={pullHint || undefined} onClick={() => void pull(false)}>
              {busy === 'pull' ? <Spinner size={14} /> : <CloudDownload size={15} strokeWidth={1.7} />} Jetzt holen
            </button>
            {pullHint && <span className="text-[12.5px] text-ink-4">{pullHint}</span>}
          </span>
        )}
      </div>
      <p className="mt-3 max-w-[78ch] text-[13.5px] leading-relaxed text-ink-3">
        {schedule.pullMode === 'auto'
          ? pullOff
            ? 'Automatisches Holen ist auf diesem Server ausgeschaltet (MENSA_PULL_INTERVAL_HOURS=0): Der Plan kommt nur, wenn du ihn hier holst.'
            : `POKYH schaut alle ${schedule.pullIntervalHours ?? 6} Stunden bei der Quelle nach und übernimmt nur, was sich dort geändert hat. Die Position im Plan, hochgeladene Bilder und deine Änderungen bleiben; aus einem PDF kommen bei einem gleichen Gericht nur die Allergene. Eine fehlerhafte Datei ändert nichts.`
          : 'Der Plan wird nur geholt, wenn du es hier auslöst.'}
      </p>
      {canEdit && (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <label className="block text-[12.5px] text-ink-3">
              Seite mit den Menüplänen (PDF)
              <input type="url" className={`${fieldClass} mt-1 w-full`} value={page} onChange={(e) => setPage(e.target.value)} placeholder="https://www.gemeinde.brixen.bz.it/Dienste/…" />
            </label>
            <label className="block text-[12.5px] text-ink-3">
              Name der Mensa dort
              <input className={`${fieldClass} mt-1 w-full`} value={canteen} onChange={(e) => setCanteen(e.target.value)} placeholder="Mensa St. Michael" />
            </label>
          </div>
          <p className="mt-1.5 text-[12px] text-ink-4">Mit einer Seite werden Sommer, Winter und die vegetarischen Menüs bei jedem Holen dort neu gesucht. Ohne Seite gelten die Adressen darunter (mensa.json oder PDF).</p>
          {!page.trim() && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {([['summer', 'Sommerplan', summerUrl, setSummerUrl], ['winter', 'Winterplan', winterUrl, setWinterUrl]] as const).map(([plan, label, value, set]) => (
                <label key={plan} className="block text-[12.5px] text-ink-3">
                  {label}
                  <input
                    type="url"
                    className={`${fieldClass} mt-1 w-full`}
                    value={value}
                    onChange={(e) => set(e.target.value)}
                    placeholder={schedule.sources.find((s) => s.plan === plan)?.usesServerSource ? 'Quelle des Servers' : 'https://…/mensa.json oder …pdf'}
                  />
                </label>
              ))}
            </div>
          )}
          {changed && (
            <div className="mt-3 flex flex-wrap items-center gap-2.5">
              <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} onClick={save}>
                {busy === 'save' && <Spinner size={14} />} Quelle speichern
              </button>
              <button
                type="button"
                className="btn btn-quiet btn-sm"
                disabled={busy !== null}
                onClick={() => { setSummerUrl(urlOf('summer')); setWinterUrl(urlOf('winter')); setPage(schedule.sourcePage); setCanteen(schedule.sourceCanteen); }}
              >
                Verwerfen
              </button>
            </div>
          )}
        </>
      )}
      {lines.length > 0 && (
        <div className="tbl-scroll mt-4">
          <table className="tbl">
            <thead>
              <tr><th>Plan</th><th>Geprüft</th><th className="hidden sm:table-cell">Geändert</th><th>Nächster Abruf</th></tr>
            </thead>
            <tbody>
              {lines.map((s) => (
                <tr key={s.plan}>
                  <td>
                    <div className="flex items-center gap-2">
                      <span>{LINE_NAMES[s.plan] ?? s.plan}</span>
                      {s.status === 'error' && <Tag tone="rose">Fehler</Tag>}
                      {s.status === 'held' && <Tag tone="amber">Zurückgehalten</Tag>}
                    </div>
                    {s.status === 'ok' && s.message && <div className="text-[12px] text-ink-3">{s.message}</div>}
                  </td>
                  <td className="whitespace-nowrap text-ink-3">{relative(s.checkedAt)}</td>
                  <td className="hidden whitespace-nowrap text-ink-3 sm:table-cell">{s.changedAt ? relative(s.changedAt) : '–'}</td>
                  <td className="whitespace-nowrap text-ink-3">{s.nextPullAt ? upcomingTime(s.nextPullAt) : schedule.pullMode === 'manual' || pullOff ? 'von Hand' : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {failed.map((s) => (
        <div key={s.plan} className="mt-3"><Notice tone="rose" icon={CloudDownload}>{LINE_NAMES[s.plan] ?? s.plan}: {s.message}. Der Plan bleibt, wie er ist; POKYH versucht es in einer Stunde wieder.</Notice></div>
      ))}
      {held.map((s) => (
        <div key={s.plan} className="mt-3">
          <Notice tone="amber" icon={CloudDownload}>
            {LINE_NAMES[s.plan] ?? s.plan} zurückgehalten: {s.message}. Der Plan bleibt, bis du entscheidest.{' '}
            {canEdit && <button type="button" className="font-medium underline underline-offset-2" disabled={busy !== null} onClick={() => void pull(true)}>Trotzdem übernehmen</button>}
          </Notice>
        </div>
      ))}
    </div>
  );
}

const dayMonth = (md: string) => `${Number(md.slice(3))}.${Number(md.slice(0, 2))}.`;
// The day before a day of the year (MM-DD), in a year without 29 February.
const dayBefore = (md: string) => {
  const d = new Date(Date.UTC(2001, Number(md.slice(0, 2)) - 1, Number(md.slice(3)) - 1));
  return d.toISOString().slice(5, 10);
};
// "04-01/10-31" as the PDF says it: "1.4.–31.10."; null when it says nothing.
const validityRange = (v: string | undefined) => {
  const m = (v ?? '').match(/^(\d{2}-\d{2})\/(\d{2}-\d{2})?$/);
  return m ? `${dayMonth(m[1]!)}–${m[2] ? dayMonth(m[2]) : '?'}` : null;
};
// When each plan applies: as its PDF says, else from the menu's dates.
function seasonRanges(schedule: MenuScheduleInfo): { summer: string; winter: string; fromPdf: boolean } {
  const { summerFrom, winterFrom } = schedule.season.kind === 'dates' ? schedule.season : { summerFrom: '04-01', winterFrom: '11-01' };
  const summer = validityRange(schedule.seasonDates?.summer);
  const winter = validityRange(schedule.seasonDates?.winter);
  return {
    summer: summer ?? `${dayMonth(summerFrom)}–${dayMonth(dayBefore(winterFrom))}`,
    winter: winter ?? `${dayMonth(winterFrom)}–${dayMonth(dayBefore(summerFrom))}`,
    fromPdf: Boolean(summer || winter),
  };
}
const dayMonthYear = (day: string) => `${Number(day.slice(8))}.${Number(day.slice(5, 7))}.${day.slice(0, 4)}`;
const planLabel = (plan: DishPlan) => (plan === 'summer' ? 'Sommerplan' : 'Winterplan');

// The figures at the head of the panel: what POKYH does next, and did last.
function ScheduleStatus({ schedule }: { schedule: MenuScheduleInfo }) {
  const auto = schedule.mode === 'auto';
  const today = new Date().toLocaleDateString('sv-SE');
  const current = schedule.breaks.find((b) => b.start <= today && today <= b.end && b.reason !== 'holiday' && b.reason !== 'bridge');
  const next = schedule.breaks.find((b) => b.start > today && b.reason !== 'holiday' && b.reason !== 'bridge');
  const nextPull = schedule.sources.map((s) => s.nextPullAt).filter((v): v is string => Boolean(v)).sort()[0];
  const pullOff = schedule.pullMode === 'manual' || (schedule.pullIntervalHours ?? 6) <= 0;
  const items: Array<{ label: string; value: string; note?: string }> = [
    {
      label: 'Ablauf',
      value: auto ? 'Autonom' : 'Manuell',
      note: auto ? (schedule.weekCount === 'school' ? 'zählt nur Schulwochen' : 'zählt jede Kalenderwoche') : 'Daten bleiben, wie du sie setzt',
    },
    ...(auto && schedule.thisWeek ? [{
      label: 'Diese Woche',
      value: `Woche ${schedule.thisWeek.week}`,
      note: `${planLabel(schedule.thisWeek.plan)} · ${schedule.thisWeek.anchored ? 'von Hand: ' : ''}Woche ${schedule.thisWeek.fromWeek} ab ${dayMonthYear(schedule.thisWeek.from)}`,
    }] : []),
    {
      label: 'Nächster Abruf',
      value: pullOff ? 'Von Hand' : nextPull ? upcomingTime(nextPull) : 'Keine Quelle',
      note: pullOff ? (schedule.pullMode === 'manual' ? 'automatisches Holen aus' : 'auf diesem Server aus') : `alle ${schedule.pullIntervalHours ?? 6} Std.`,
    },
    {
      label: 'Zuletzt neu gelegt',
      value: schedule.arranged ? relative(schedule.arranged.at) : 'Noch nie',
      note: schedule.arranged ? `${schedule.arranged.moved} ${schedule.arranged.moved === 1 ? 'Gericht' : 'Gerichte'} verschoben` : undefined,
    },
    {
      label: current ? 'Gerade' : 'Nächste Pause',
      value: current ? BREAK_NAMES[current.reason] : next ? BREAK_NAMES[next.reason] : 'Keine bekannt',
      note: current ? `bis ${breakRange(current.end, current.end)}` : next ? breakRange(next.start, next.end) : undefined,
    },
  ];
  return (
    <dl className={`grid gap-3 sm:grid-cols-2 ${items.length > 4 ? 'xl:grid-cols-5' : 'xl:grid-cols-4'}`}>
      {items.map((item) => (
        <div key={item.label} className="rounded-[18px] px-[18px] py-3.5" style={{ background: 'var(--sheet)' }}>
          <dt className="text-[12.5px] text-ink-3">{item.label}</dt>
          <dd className="mt-1 text-[16px] font-semibold leading-tight text-ink">{item.value}</dd>
          {item.note && <dd className="mt-0.5 text-[12px] text-ink-3">{item.note}</dd>}
        </div>
      ))}
    </dl>
  );
}

// The next school days as the menu serves them: a glance at what the layout does.
function UpcomingDays({ schedule }: { schedule: MenuScheduleInfo }) {
  const days = schedule.upcoming ?? [];
  if (days.length === 0) return null;
  return (
    <div>
      <div className="text-[13.5px] font-medium text-ink">Die nächsten Schultage</div>
      <ol className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Was die Mensa an den nächsten Schultagen serviert">
        {days.map((d) => (
          <li key={d.date} className="rounded-[14px] px-3 py-2.5" style={{ background: d.off ? 'transparent' : 'var(--sheet)', boxShadow: d.off ? 'inset 0 0 0 1px var(--line)' : undefined }}>
            <div className="tabular text-[12px] text-ink-3">{weekdayDate(d.date)}</div>
            <div className="mt-0.5 text-[13px] font-medium" style={{ color: d.off ? 'var(--ink-3)' : 'var(--ink)' }}>
              {d.off ? BREAK_NAMES[d.off] : d.week ? `Woche ${d.week}` : d.plan ? 'Plan' : 'Kein Menü'}
            </div>
            {!d.off && d.plan && <div className="text-[11.5px] text-ink-4">{d.plan === 'summer' ? 'Sommerplan' : 'Winterplan'}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}

// Where the menu's pictures are: in the database (in every backup) or only
// linked somewhere else, which POKYH fetches by itself (services/dishPictures.ts).
function PicturesStatus({ pictures, canEdit, onTaken }: { pictures: DishPictureStatus; canEdit: boolean; onTaken: (next: MenuScheduleInfo) => void }) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  async function take() {
    setBusy(true);
    try {
      const r = await adminApi.takeDishPictures();
      onTaken(await adminApi.menuSchedule());
      if (r.failed.length > 0) showToast(`${r.taken} ${r.taken === 1 ? 'Bild' : 'Bilder'} übernommen, ${r.failed.length} ${r.failed.length === 1 ? 'Link' : 'Links'} gingen nicht`, 'error');
      else showToast(r.taken > 0 ? `${r.taken} ${r.taken === 1 ? 'Bild' : 'Bilder'} in die Datenbank übernommen` : 'Alle Bilder sind schon in der Datenbank', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Die Bilder konnten nicht geholt werden', 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 text-[13.5px] font-medium text-ink"><ImagePlus size={15} strokeWidth={1.7} /> Bilder</span>
        <Tag tone={pictures.linked === 0 ? 'mint' : 'amber'}>{pictures.kept} in der Datenbank{pictures.linked > 0 ? ` · ${pictures.linked} nur verlinkt` : ''}</Tag>
        {canEdit && pictures.linked > 0 && (
          <button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={() => void take()}>
            {busy ? <Spinner size={13} /> : <CloudDownload size={14} />} Jetzt holen
          </button>
        )}
      </div>
      <p className="mt-1 max-w-[78ch] text-[12.5px] leading-relaxed text-ink-3">
        Hochgeladene Bilder und Bilder aus Links liegen in der Datenbank und sind in jedem Backup. Ein Bild, das nur verlinkt ist (z. B. aus einer mensa.json), holt POKYH von selbst; ein Link, der nicht geht, wird später erneut versucht.
      </p>
      {pictures.failing.length > 0 && (
        <ul className="mt-2 space-y-1 text-[12.5px] text-ink-3">
          {pictures.failing.slice(0, 5).map((f) => (
            <li key={f.url} className="truncate" title={f.url}>{f.error}: {f.url}</li>
          ))}
          {pictures.failing.length > 5 && <li>und {pictures.failing.length - 5} weitere</li>}
        </ul>
      )}
    </div>
  );
}

type ScheduleChange = { mode: MenuMode; calendar: MenuCalendar; overrides: MenuDayOverride[]; seasonRule: 'dates' | 'clock'; weekCount: MenuWeekCount; resetAnchors?: boolean };

function SchedulePanel({ schedule, canEdit, busy, onChange, onSourceSaved, onPulled }: {
  schedule: MenuScheduleInfo;
  canEdit: boolean;
  busy: boolean;
  onChange: (change: ScheduleChange) => void;
  onSourceSaved: (next: MenuScheduleInfo) => void;
  onPulled: () => void;
}) {
  const auto = schedule.mode === 'auto';
  const [allBreaks, setAllBreaks] = useState(false);
  const base: ScheduleChange = { mode: schedule.mode, calendar: schedule.calendar, overrides: schedule.overrides, seasonRule: schedule.season.kind, weekCount: schedule.weekCount ?? 'calendar' };
  // The administrator's corrections; the server's own first anchor is no correction.
  const corrections = (schedule.anchors ?? []).filter((a) => !a.auto);
  const ranges = seasonRanges(schedule);
  const planLength = schedule.thisWeek?.length;
  const change = (patch: Partial<ScheduleChange>) => { if (!busy) onChange({ ...base, ...patch }); };
  // The named breaks and the menu's own closed days; single holidays are simply days without a menu.
  const breaks = schedule.breaks.filter((b) => b.reason !== 'holiday' && b.reason !== 'bridge');
  const shown = allBreaks ? breaks : breaks.slice(0, 6);
  const onlyInAuto = !auto ? 'Gilt nur im Autonom-Modus.' : '';
  return (
    <section className="panel mt-8 flex flex-col gap-7 p-6" aria-label="Ablauf des Speiseplans" aria-busy={busy}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span className="flex items-center gap-2 text-[15px] font-medium text-ink"><CalendarDays size={17} strokeWidth={1.7} /> Ablauf</span>
        {canEdit ? (
          <Segmented<MenuMode>
            label="Ablauf"
            value={schedule.mode}
            onChange={(mode) => { if (mode !== schedule.mode) change({ mode }); }}
            options={[{ value: 'auto', label: 'Autonom' }, { value: 'manual', label: 'Manuell' }]}
          />
        ) : (
          <Tag tone={auto ? 'mint' : 'amber'}>{auto ? 'Autonom' : 'Manuell'}</Tag>
        )}
        {busy && <span className="flex items-center gap-2 text-[12.5px] text-ink-3"><Spinner size={14} /> Wird angewendet…</span>}
      </div>

      <ScheduleStatus schedule={schedule} />

      <p className="max-w-[78ch] text-[13.5px] leading-relaxed text-ink-3">
        {auto
          ? `POKYH zählt die Planwochen selbst, wie die Mensa: eine Runde von Woche 1 bis ${planLength ?? 6}, die beim Planwechsel nicht neu beginnt. Sommer und Winter bestimmen nur, aus welchem Plan die Gerichte eines Tages kommen (${schedule.season.kind === 'dates' ? `Sommerplan ${ranges.summer}, Winterplan ${ranges.winter}, Tag für Tag${ranges.fromPdf ? ', wie oben rechts in ihren PDFs' : ''}` : 'Wechsel mit der Zeitumstellung'}). Die Runde geht ${schedule.weekCount === 'school' ? 'in jeder Woche mit Schule' : 'jede Kalenderwoche, auch in den Ferien,'} eine Woche weiter${schedule.thisWeek ? `, gezählt ab Woche ${schedule.thisWeek.fromWeek} in der Woche des ${dayMonthYear(schedule.thisWeek.from)}` : ''}. An freien Tagen gibt es kein Menü. Liegt die Mensa einmal daneben, setze bei der Woche, die sie gerade serviert, das Datum auf diese Woche: POKYH zählt dann von dort weiter, auch über den nächsten Planwechsel hinaus.`
          : 'Die Daten bleiben, wie du sie setzt. Ferien werden nicht beachtet; vergangene Wochen rollen nur ans Ende ihres Plans.'}
      </p>

      {auto && <UpcomingDays schedule={schedule} />}

      <div className="grid gap-6 lg:grid-cols-2" style={{ opacity: auto ? 1 : 0.62 }}>
        <div className="lg:col-span-2">
          <div className="text-[13.5px] font-medium text-ink">Planwochen zählen</div>
          <p className="mt-1 max-w-[78ch] text-[12.5px] leading-relaxed text-ink-3">
            „Jede Kalenderwoche“ zählt Ferienwochen mit. So zählt die Mensa St. Michael: Woche 1 ab 30. März 2026, Woche 6 ab 19. Oktober, Woche 1 ab 26. Oktober (noch mit Sommergerichten), Woche 2 in den Allerheiligenferien und Woche 3 am 9. November, dem ersten Schultag mit Wintergerichten. „Nur Schulwochen“ für eine Mensa, die nach den Ferien dort weitermacht, wo sie aufgehört hat. {onlyInAuto}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {canEdit ? (
              <Segmented<MenuWeekCount>
                label="Planwochen zählen"
                value={schedule.weekCount ?? 'calendar'}
                onChange={(weekCount) => { if (weekCount !== (schedule.weekCount ?? 'calendar')) change({ weekCount }); }}
                options={[{ value: 'calendar', label: 'Jede Kalenderwoche' }, { value: 'school', label: 'Nur Schulwochen' }]}
              />
            ) : (
              <Tag>{schedule.weekCount === 'school' ? 'Nur Schulwochen' : 'Jede Kalenderwoche'}</Tag>
            )}
          </div>
          {auto && corrections.length > 0 && (
            <div className="mt-3">
              <Notice tone="amber" icon={CalendarDays}>
                Von Hand korrigiert: {corrections.map((a) => `ab ${dayMonthYear(a.monday)} Woche ${a.week}`).join(', ')}. POKYH zählt von dort weiter, auch über den Planwechsel hinaus.{' '}
                {canEdit && <button type="button" className="font-medium underline underline-offset-2" disabled={busy} title="Dann zählt POKYH wieder ab Woche 1 in der Woche, in der der laufende Plan begann" onClick={() => change({ resetAnchors: true })}>Korrektur entfernen</button>}
              </Notice>
            </div>
          )}
        </div>
        <div>
          <div className="text-[13.5px] font-medium text-ink">Ferienkalender</div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
            Woher die freien Tage kommen. „Nur WebUntis“ für Schulen außerhalb Südtirols. Ferien einer einzelnen Schule zählen bei einer geteilten Mensa erst, wenn alle Schulen frei haben. {onlyInAuto}
          </p>
          <div className="mt-3">
            {canEdit ? (
              <Segmented<MenuCalendar>
                label="Ferienkalender"
                value={schedule.calendar}
                onChange={(calendar) => { if (calendar !== schedule.calendar) change({ calendar }); }}
                options={[{ value: 'suedtirol', label: 'Südtirol + WebUntis' }, { value: 'webuntis', label: 'Nur WebUntis' }]}
              />
            ) : (
              <Tag>{schedule.calendar === 'suedtirol' ? 'Südtirol + WebUntis' : 'Nur WebUntis'}</Tag>
            )}
          </div>
        </div>
        <div>
          <div className="text-[13.5px] font-medium text-ink">Planwechsel</div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
            Wann Sommer- und Winterplan wechseln, Tag für Tag. „Wie die Mensa“ nimmt die Daten, die oben rechts in ihren PDFs stehen, bei jedem Abruf neu: {ranges.fromPdf ? `Sommerplan ${ranges.summer}, Winterplan ${ranges.winter}, aus den PDFs gelesen.` : `noch aus keinem PDF gelesen, bis dahin Sommerplan ${ranges.summer}, Winterplan ${ranges.winter}.`}
          </p>
          {schedule.seasonDates?.problem && (
            <div className="mt-2">
              <Notice tone="amber" icon={CalendarDays}>Die Daten in den PDFs passen nicht zusammen: {schedule.seasonDates.problem}. Jeder Plan beginnt an dem Tag, den sein eigenes PDF nennt.</Notice>
            </div>
          )}
          <div className="mt-3">
            {canEdit ? (
              <Segmented<'dates' | 'clock'>
                label="Planwechsel"
                value={schedule.season.kind}
                onChange={(seasonRule) => { if (seasonRule !== schedule.season.kind) change({ seasonRule }); }}
                options={[{ value: 'dates', label: 'Wie die Mensa' }, { value: 'clock', label: 'Mit der Zeitumstellung' }]}
              />
            ) : (
              <Tag>{schedule.season.kind === 'dates' ? `Sommer ab ${dayMonth(schedule.season.summerFrom)}, Winter ab ${dayMonth(schedule.season.winterFrom)}` : 'Mit der Zeitumstellung'}</Tag>
            )}
          </div>
        </div>
      </div>

      <div style={{ opacity: auto ? 1 : 0.62 }}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-[13.5px] font-medium text-ink">Pausen der Mensa</div>
          {onlyInAuto && <span className="text-[12.5px] text-ink-4">{onlyInAuto}</span>}
        </div>
        {breaks.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-4">Keine Pausen bekannt.</p>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap gap-2">
              {shown.map((b) => <Tag key={`${b.start}-${b.reason}`} tone={b.reason === 'closed' ? 'amber' : undefined}>{BREAK_NAMES[b.reason]} · {breakRange(b.start, b.end)}</Tag>)}
            </div>
            {breaks.length > 6 && (
              <button type="button" className="mt-2 text-[12.5px] font-medium text-ink-3 underline underline-offset-2" onClick={() => setAllBreaks((v) => !v)}>
                {allBreaks ? 'Weniger anzeigen' : `Alle ${breaks.length} Pausen anzeigen`}
              </button>
            )}
          </>
        )}
        {schedule.schools.length > 0 && (
          <ul className="mt-3 space-y-1 text-[12.5px] text-ink-3">
            {schedule.schools.map((sc) => (
              <li key={sc.id}>
                {sc.name}: {sc.fetchedAt
                  ? `${sc.breaks} ${sc.breaks === 1 ? 'freier Zeitraum' : 'freie Zeiträume'} aus WebUntis, zuletzt ${relative(sc.fetchedAt)} geholt`
                  : 'noch keine Ferien aus WebUntis. Sie kommen, sobald jemand dieser Schule POKYH benutzt.'}
              </li>
            ))}
          </ul>
        )}
        {auto && schedule.calendar === 'webuntis' && schedule.schools.every((sc) => !sc.fetchedAt) && (
          <div className="mt-3"><Notice tone="amber" icon={CalendarDays}>Noch keine Ferien bekannt: Bis welche aus WebUntis kommen, läuft der Plan durch.</Notice></div>
        )}
      </div>

      <div style={{ opacity: auto ? 1 : 0.62 }}>
        <OverridesEditor overrides={schedule.overrides} canEdit={canEdit && auto} busy={busy} onChange={(overrides) => change({ overrides })} />
      </div>

      {schedule.pictures && <PicturesStatus pictures={schedule.pictures} canEdit={canEdit} onTaken={(next) => { onSourceSaved(next); onPulled(); }} />}

      <div className="pt-6" style={{ borderTop: '1px solid var(--line)' }}>
        <SourceEditor schedule={schedule} canEdit={canEdit} onSaved={onSourceSaved} onPulled={onPulled} />
      </div>
      {schedule.pictureBaseMissing && (
        <Notice tone="amber" icon={ImagePlus}>PUBLIC_BASE_URL ist auf dem Server nicht gesetzt: Die Website findet hochgeladene Bilder trotzdem, die Apps erst, wenn die Adresse der API dort eingetragen ist.</Notice>
      )}
    </section>
  );
}

// A change that moves dishes onto other days is shown before it happens.
function ScheduleConfirm({ moved, change, onConfirm, onClose }: { moved: number; change: ScheduleChange; onConfirm: () => void; onClose: () => void }) {
  return (
    <Dialog title="Gerichte neu verteilen?" subtitle={change.mode === 'auto' ? 'Autonomer Ablauf' : 'Manueller Ablauf'} onClose={onClose}>
      <p className="text-[14px] leading-relaxed text-ink-2">
        Mit dieser Änderung legt POKYH <strong className="font-semibold">{moved} {moved === 1 ? 'Gericht' : 'Gerichte'}</strong> auf andere Tage, damit jede Planwoche in der Woche liegt, in der die Mensa sie serviert. Bilder, Bewertungen und Kommentare bleiben bei ihren Gerichten.
      </p>
      <div className="mt-6 flex flex-wrap justify-end gap-2.5">
        <button type="button" className="btn btn-quiet" onClick={onClose}>Abbrechen</button>
        <button type="button" className="btn btn-primary" onClick={onConfirm}>Übernehmen</button>
      </div>
    </Dialog>
  );
}

function MenuPlan({ note, handed }: { note?: ReactNode; handed: Partial<HandedDish> }) {
  const { showToast } = useToast();
  const rights = useContext(MensaRights);
  // The search hands over a dish: its plan, filtered to it, its weeks open.
  const [activePlan, setActivePlan] = useState<DishPlan>(() => (handed.plan === 'summer' || handed.plan === 'winter' ? handed.plan : currentSeason()));
  const [dishes, setDishes] = useState<AdminDishFull[]>([]);
  const [ratingsMap, setRatingsMap] = useState<Map<string, AdminDish>>(new Map());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(handed.search ?? '');
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

  const [schedule, setSchedule] = useState<MenuScheduleInfo | null>(null);
  // The schedule could not be read: said so, with a way to try again.
  const [scheduleFailed, setScheduleFailed] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  // A change that would move dishes, waiting for the admin's yes.
  const [pendingChange, setPendingChange] = useState<{ change: ScheduleChange; moved: number } | null>(null);

  const loadRatings = useCallback(async () => {
    try {
      const ratingData = await adminApi.dishRatings({ summary: true });
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

  const loadSchedule = useCallback(async () => {
    try {
      const next = await adminApi.menuSchedule();
      seasonRule = next.season;
      setSchedule(next);
      setScheduleFailed(false);
    } catch {
      setScheduleFailed(true);
    }
  }, []);

  useEffect(() => { loadRatings(); }, [loadRatings]);
  useEffect(() => { loadSchedule(); }, [loadSchedule]);
  useLive(['ratings'], () => { void loadRatings(); });
  useLive(['dishes'], () => { void loadDishes(activePlan); void loadSchedule(); });

  async function applySchedule(change: ScheduleChange) {
    setScheduleBusy(true);
    try {
      const res = await adminApi.setMenuSchedule(change.mode, change.calendar, change.overrides, change.seasonRule, change.weekCount, change.resetAnchors);
      seasonRule = res.season;
      setSchedule(res);
      const what = change.mode === 'auto' ? 'Autonom' : 'Manuell';
      showToast(res.moved ? `Ablauf: ${what} · ${res.moved} ${res.moved === 1 ? 'Gericht' : 'Gerichte'} neu gelegt` : `Ablauf: ${what} · gespeichert`, 'success');
      await loadDishes(activePlan);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Der Ablauf konnte nicht geändert werden', 'error');
    } finally {
      setScheduleBusy(false);
    }
  }

  // First how many dishes the change would move; with any, the admin confirms.
  async function changeSchedule(change: ScheduleChange) {
    if (scheduleBusy) return;
    setScheduleBusy(true);
    let moved: number | null = null;
    try {
      moved = (await adminApi.previewMenuSchedule(change.mode, change.calendar, change.overrides, change.seasonRule, change.weekCount, change.resetAnchors)).preview.moved;
    } catch {
      moved = null;
    } finally {
      setScheduleBusy(false);
    }
    if (moved && moved > 0) setPendingChange({ change, moved });
    else await applySchedule(change);
  }

  // Load dishes for the active plan. First time we visit a plan this session,
  // also ask the server to rotate any past weeks to the end so the plan stays
  // "rolling" without manual intervention.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (rights.edit && !rotatedPlans.current.has(activePlan)) {
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
  }, [activePlan, loadDishes, showToast, rights.edit]);

  // Poll auto-rotate every 5 min AND whenever the tab regains focus, so a week
  // that expires while the admin is left open loops on its own without needing
  // a manual reload. Silent when there's nothing to rotate; reloads dishes if
  // rows were actually moved.
  useEffect(() => {
    if (!rights.edit) return;
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
  }, [activePlan, loadDishes, showToast, rights.edit]);

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

  // "Anchor" this week to a chosen Monday. The server:
  //   1. Normalises the plan so every week is exactly 7 days apart from the
  //      anchor (fixes any irregular gaps).
  //   2. Rolls past weeks to the end, snapping each into this plan's season.
  //   3. Aligns the OTHER plan so its first week starts right after this one's
  //      last week (snapped into the other plan's season). Result: Sommer and
  //      Winter chain seamlessly in both directions.
  // No early exit even when oldWk === newMonIso: re-running "Diese Woche" is
  // how the user asks for a fresh normalize + handoff pass.
  async function handleWeekMove(oldWk: string, newMonIso: string) {
    setEditingWeekKey(null);

    try {
      const res = await adminApi.anchorWeek(activePlan, oldWk, newMonIso);
      if (res.anchor) {
        // Autonomous: the count was corrected (or already said so).
        const a = res.anchor;
        showToast(a.anchored
          ? `Woche ${a.week} ab ${formatDate(a.monday)}, ab dort wird weitergezählt${a.laidOut > 0 ? ` · ${a.laidOut} Gerichte verschoben` : ''}`
          : `Woche ${a.week} liegt ab ${formatDate(a.monday)} schon so, keine Korrektur nötig`, 'success');
        rotatedPlans.current.clear();
        await Promise.all([loadDishes(activePlan), loadRatings(), loadSchedule()]);
        return;
      }
      const parts: string[] = [];
      if (res.normalized > 0) parts.push(`${res.normalized} normalisiert`);
      if (res.rotated > 0) parts.push(`${res.rotated} weitergerollt`);
      if (res.laidOut > 0) parts.push(`${res.laidOut} auf Schulwochen gelegt`);
      if (res.otherAligned > 0 && res.otherAnchorDate) {
        const otherName = activePlan === 'summer' ? 'Winter' : 'Sommer';
        parts.push(`${otherName}plan → ${formatDate(res.otherAnchorDate)}`);
      }
      if (parts.length === 0) parts.push('bereits synchron');
      showToast(`Plan angepasst · ${parts.join(' · ')}`, 'success');
      // Reload both plans so the badge / other-plan state reflects handoff.
      rotatedPlans.current.clear();
      await Promise.all([loadDishes(activePlan), loadRatings()]);
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

  const openedForHanded = useRef(false);
  useEffect(() => {
    if (!handed.search || openedForHanded.current || dishes.length === 0) return;
    openedForHanded.current = true;
    setExpandedWeeks(new Set(sortedWeeks.map(([wk]) => wk)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dishes]);

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
    ? (ratingsMap.get(dishKeyOf(editDish as AdminDishFull)) ?? null)
    : null;

  const draggingWeekIdx = draggingWeekKey
    ? sortedWeeks.findIndex(([wk]) => wk === draggingWeekKey)
    : -1;

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <div className="">
      <PageHeader
        title="Speiseplan"
        subtitle={`${dishes.length} ${dishes.length === 1 ? 'Gericht' : 'Gerichte'} im ${activePlan === 'summer' ? 'Sommer' : 'Winter'}plan.`}
      >
        {rights.edit && <>
        <button type="button" onClick={() => setShowImport(true)} className="btn btn-quiet">
          <Download size={16} strokeWidth={1.7} />
          Importieren
        </button>
        {confirmingReset ? (
          <>
            <button type="button" onClick={handleReset} disabled={resetting} className="btn btn-danger">
              <RotateCcw size={16} strokeWidth={1.7} />
              {resetting ? 'Reset…' : `Sicher? ${activePlan === 'summer' ? 'Sommer' : 'Winter'} überschreiben`}
            </button>
            <button type="button" onClick={() => setConfirmingReset(false)} disabled={resetting} className="btn btn-quiet">Nein</button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingReset(true)}
            className="btn btn-quiet"
            title="Diesen Plan auf den Stand der Quelle zurücksetzen (das vegetarische Menü bleibt)"
          >
            <RotateCcw size={16} strokeWidth={1.7} />
            Reset auf Quelle
          </button>
        )}
        </>}
        <button
          type="button"
          onClick={expandedWeeks.size === 0 ? expandAll : collapseAll}
          className="btn btn-quiet"
          title={expandedWeeks.size === 0 ? 'Alle ausklappen' : 'Alle einklappen'}
        >
          {expandedWeeks.size === 0 ? <ChevronDown size={16} strokeWidth={1.7} /> : <ChevronUp size={16} strokeWidth={1.7} />}
          {expandedWeeks.size === 0 ? 'Ausklappen' : 'Einklappen'}
        </button>
        {rights.edit && <>
        <button type="button" onClick={addNewWeek} className="btn btn-quiet">
          <CalendarPlus size={16} strokeWidth={1.7} />
          Neue Woche
        </button>
        <button type="button" onClick={() => { setNewDishInitialDate(undefined); setEditDish('new'); }} className="btn btn-primary">
          <Plus size={16} strokeWidth={1.8} />
          Neues Gericht
        </button>
        </>}
      </PageHeader>

      {note && <div className="mt-8">{note}</div>}

      {schedule && <SchedulePanel schedule={schedule} canEdit={rights.edit} busy={scheduleBusy} onChange={(change) => void changeSchedule(change)} onSourceSaved={setSchedule} onPulled={() => void loadDishes(activePlan)} />}
      {!schedule && scheduleFailed && (
        <div className="mt-8">
          <Notice tone="rose" icon={CalendarDays}>
            Der Ablauf des Speiseplans konnte nicht geladen werden.{' '}
            <button type="button" className="font-medium underline underline-offset-2" onClick={() => void loadSchedule()}>Erneut versuchen</button>
          </Notice>
        </div>
      )}
      {pendingChange && (
        <ScheduleConfirm
          moved={pendingChange.moved}
          change={pendingChange.change}
          onClose={() => setPendingChange(null)}
          onConfirm={() => { const { change } = pendingChange; setPendingChange(null); void applySchedule(change); }}
        />
      )}

      <Figures
        className="mt-10"
        items={[
          { label: 'Gerichte', value: dishes.length, icon: UtensilsCrossed },
          { label: 'Vegetarisch', value: dishes.filter((d) => d.isVegetarian).length, icon: Leaf },
          {
            label: 'Aktuelle Saison',
            value: currentSeason() === 'summer' ? 'Sommer' : 'Winter',
            icon: currentSeason() === 'summer' ? Sun : Snowflake,
            note: <Delta tone={activePlan === currentSeason() ? 'mint' : 'amber'}>{activePlan === currentSeason() ? 'wird angezeigt' : 'anderer Plan geöffnet'}</Delta>,
          },
        ]}
      />

      {/* Season tabs and search */}
      <div className="mb-7 mt-10 flex flex-wrap items-center gap-3">
        <Segmented
          label="Plan"
          value={activePlan}
          onChange={setActivePlan}
          options={[
            { value: 'summer', label: <><Sun size={14} /> Sommer <span className="text-[11.5px] opacity-60">{schedule?.season.kind === 'dates' ? `ab ${dayMonth(schedule.season.summerFrom)}` : 'ab Sommerzeit'}</span></> },
            { value: 'winter', label: <><Snowflake size={14} /> Winter <span className="text-[11.5px] opacity-60">{schedule?.season.kind === 'dates' ? `ab ${dayMonth(schedule.season.winterFrom)}` : 'ab Winterzeit'}</span></> },
          ]}
        />
        <SearchField value={search} onChange={setSearch} placeholder="Suche nach Name, Kategorie, Datum" className="min-w-[240px] flex-1" />
      </div>

      {/* In the autonomous mode the server keeps the weeks on school weeks:
          moving dishes by hand only decides which plan week comes when. */}
      {schedule?.mode === 'auto' && rights.edit && (
        <div className="mb-6">
          <Notice tone="sky" icon={CalendarDays}>
            Autonom: POKYH legt jede Planwoche in die Woche, in der die Mensa sie serviert. Serviert die Mensa gerade eine andere Woche, setze deren Datum auf „Diese Woche“: Von dort wird weitergezählt. Ein Gericht in eine andere Woche zu ziehen macht es zu einem Gericht dieser Planwoche.
          </Notice>
        </div>
      )}

      {/* Content */}
      {loading && dishes.length === 0 ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-2 border-sky-deep border-t-transparent rounded-full animate-spin" />
        </div>
      ) : sortedWeeks.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <span className="orb h-14 w-14 text-ink-3"><UtensilsCrossed size={22} strokeWidth={1.5} /></span>
          <p className="text-[14.5px] text-ink-3">
            {search
              ? 'Keine Gerichte gefunden'
              : `Noch keine Gerichte im ${activePlan === 'summer' ? 'Sommer' : 'Winter'}plan`}
          </p>
          {!search && rights.edit && (
            <button type="button" onClick={() => setShowImport(true)} className="btn btn-primary">
              <Download size={16} strokeWidth={1.7} />
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
                      ? '2px solid rgba(60,135,215,0.6)'
                      : isDragTarget ? '2px solid rgba(60,135,215,0.5)' : '2px solid transparent',
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
                    className="week-head flex items-center gap-3 rounded-[16px] px-3 py-3 transition-colors"
                    style={{ background: isDragTarget ? 'var(--sky-wash)' : 'var(--well)' }}
                  >
                    {/* Week drag grip: by hand only, the server orders the weeks in "auto" */}
                    {rights.edit && schedule?.mode !== 'auto' && <div
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/week-key', wk);
                        e.dataTransfer.effectAllowed = 'move';
                        setDraggingWeekKey(wk);
                      }}
                      onDragEnd={() => { setDraggingWeekKey(null); setDragOverInsertIdx(null); }}
                      className="flex-shrink-0 p-0.5 rounded transition-colors"
                      style={{ color: 'rgb(var(--ink-rgb) / 0.42)', cursor: 'grab' }}
                      title="Ganze Woche verschieben"
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--sky-deep)'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgb(var(--ink-rgb) / 0.42)'; }}
                    >
                      <GripVertical size={15} />
                    </div>}

                    {/* Clickable label → collapse; or inline editor when editing */}
                    {editingWeekKey === wk ? (
                      <div className="flex-1 flex items-center gap-1.5 min-w-0 flex-wrap">
                        <input
                          type="date"
                          className="field h-11 px-4 text-[14px]"
                          value={editingWeekDraft}
                          onChange={(e) => setEditingWeekDraft(e.target.value)}
                          autoFocus
                        />
                        <button
                          onClick={() => setEditingWeekDraft(currentMondayIso())}
                          className="px-2 py-1 rounded-full text-[11px] font-semibold transition-colors"
                          style={{ background: 'rgba(40,170,125,0.15)', color: 'var(--mint-deep)', border: '1px solid transparent' }}
                        >
                          Diese Woche
                        </button>
                        <button
                          onClick={() => setEditingWeekDraft(nextWeekKey(currentMondayIso()))}
                          className="px-2 py-1 rounded-full text-[11px] font-semibold transition-colors"
                          style={{ background: 'rgba(60,135,215,0.15)', color: 'var(--sky-deep)', border: '1px solid transparent' }}
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
                          className="px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors"
                          style={{ background: 'var(--sky)', color: 'var(--on-sky)' }}
                        >
                          Speichern
                        </button>
                        <button
                          onClick={() => setEditingWeekKey(null)}
                          className="px-2 py-1 rounded-full text-[11px] transition-colors"
                          style={{ background: 'rgb(var(--ink-rgb) / calc(0.04 * var(--veil)))', color: 'rgb(var(--ink-rgb) / 0.74)' }}
                        >
                          Abbrechen
                        </button>
                      </div>
                    ) : (
                      <button
                        className="flex-1 text-left min-w-0"
                        onClick={() => toggleWeek(wk)}
                      >
                        <span className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-left">
                          <span className="flex items-center gap-3 text-[17px] font-semibold text-ink">
                            Woche {wDishes[0]?.weekOrdinal || (wi + 1)}
                            {wk === currentMondayIso() && <Tag tone="sky">Diese Woche</Tag>}
                          </span>
                          <span className="text-[13.5px] text-ink-3">{formatWeekRange(wk)}&nbsp;&middot;&nbsp;{wDishes.length} {wDishes.length === 1 ? 'Gericht' : 'Gerichte'}</span>
                        </span>
                      </button>
                    )}

                    {/* Set by hand, a week can lie in the holidays. */}
                    {editingWeekKey !== wk && schedule?.mode === 'manual' && weekInBreak(wk, schedule) && (
                      <span className="flex-shrink-0"><Tag tone="amber">In den Ferien</Tag></span>
                    )}

                    {/* Season boundary badge: days of this week lie in the other
                        season, so the public endpoint serves the other plan on
                        them (all week, or the days of a week the plans change in). */}
                    {editingWeekKey !== wk && (() => {
                      const days = otherSeasonDays(wk, activePlan);
                      if (days.length === 0) return null;
                      const other: DishPlan = activePlan === 'summer' ? 'winter' : 'summer';
                      const name = other === 'winter' ? 'Winterplan' : 'Sommerplan';
                      const all = days.length === SHORT_WEEKDAYS.length;
                      return (
                        <span
                          className="flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-[10px] text-[10px] font-bold uppercase tracking-wider"
                          style={{
                            background: other === 'winter' ? 'rgba(60,135,215,0.18)' : 'rgba(236,140,40,0.18)',
                            color: other === 'winter' ? 'var(--sky-deep)' : 'var(--amber-deep)',
                          }}
                          title={all ? `In dieser Woche serviert die Mensa den ${name}` : `${days.join(', ')}: an diesen Tagen serviert die Mensa den ${name}`}
                        >
                          {other === 'winter' ? <Snowflake size={11} /> : <Sun size={11} />}
                          {all ? `${name} aktiv` : `${days[0]}${days.length > 1 ? `–${days[days.length - 1]}` : ''} ${name}`}
                        </span>
                      );
                    })()}

                    {/* Edit week date */}
                    {rights.edit && editingWeekKey !== wk && (
                      <button
                        onClick={() => { setEditingWeekKey(wk); setEditingWeekDraft(wk); }}
                        className="flex-shrink-0 p-1.5 rounded-full transition-colors"
                        style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}
                        title="Wochendatum ändern"
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--sky-deep)'; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgb(var(--ink-rgb) / 0.5)'; }}
                      >
                        <Pencil size={13} />
                      </button>
                    )}

                    {/* Add dish to this week */}
                    {rights.edit && <button
                      onClick={() => { setNewDishInitialDate(wk); setEditDish('new'); }}
                      className="flex-shrink-0 p-1.5 rounded-full transition-colors"
                      style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}
                      title="Gericht zu dieser Woche hinzufügen"
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--sky-deep)'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgb(var(--ink-rgb) / 0.5)'; }}
                    >
                      <Plus size={14} />
                    </button>}

                    {/* Collapse toggle */}
                    <button
                      onClick={() => toggleWeek(wk)}
                      className="flex-shrink-0"
                      style={{ color: 'var(--sky-deep)' }}
                    >
                      {collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
                    </button>

                    {/* Remove empty week */}
                    {wDishes.length === 0 && planEmptyWeeks.has(wk) && (
                      <button
                        onClick={() => removeEmptyWeek(wk)}
                        className="flex-shrink-0 p-1.5 rounded-full transition-colors"
                        style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}
                        title="Leere Woche entfernen"
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--rose-deep)'; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgb(var(--ink-rgb) / 0.5)'; }}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>

                  {/* Week body */}
                  <Collapse open={!collapsed}>
                    <div className="week-body">
                      {wDishes.length === 0 ? (
                        <div
                          className="py-10 rounded-[14px] flex flex-col items-center gap-2"
                          style={{
                            border: `2px dashed ${isDragTarget ? 'rgba(60,135,215,0.55)' : 'rgba(60,135,215,0.15)'}`,
                            background: isDragTarget ? 'rgba(60,135,215,0.06)' : 'transparent',
                            transition: 'all 0.15s',
                          }}
                        >
                          <UtensilsCrossed size={22} style={{ color: isDragTarget ? 'var(--sky-deep)' : 'rgb(var(--ink-rgb) / 0.42)' }} />
                          <p className="text-sm select-none" style={{ color: isDragTarget ? 'var(--sky-deep)' : 'rgb(var(--ink-rgb) / 0.42)' }}>
                            {isDragTarget ? 'Hier loslassen' : 'Gerichte hier reinziehen'}
                          </p>
                        </div>
                      ) : (
                        groupByDay(wDishes).map(([date, dayDishes]) => {
                          const day = dayParts(date);
                          const isToday = date === toLocalIso(new Date());
                          return (
                            <div key={date} className="day-group" title={formatDate(date)}>
                              <div className="day-label">
                                <span className="flex items-center gap-2.5 text-[14.5px] font-medium">
                                  {day.weekday}
                                  {isToday && <Tag tone="mint">Heute</Tag>}
                                </span>
                                <span className="tabular text-[12.5px] text-ink-3">{day.short}</span>
                              </div>
                              <div className="min-w-0">
                                {dayDishes.map((dish) => (
                                  <DishCard
                                    key={dish.id}
                                    dish={dish}
                                    ratingData={ratingsMap.get(dishKeyOf(dish))}
                                    onEdit={setEditDish}
                                    onDelete={handleDeleted}
                                    onDragStart={() => setDraggingDishId(dish.id)}
                                    onDragEnd={() => setDraggingDishId(null)}
                                    isDragging={draggingDishId === dish.id}
                                  />
                                ))}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </Collapse>
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

// ─── DishesPage ───────────────────────────────────────────────────────────────
// A school's view edits the menu assigned to it (and shows nothing when it has
// none — the app then shows no menu either). The global view picks any menu;
// a menu several schools share changes for all of them at once.

// ─── Plans in the global view: which one, and which schools show it ─────────

function MenuBar({ menus, selected, manage, unassigned, onPick, onCreate, onRename, onDelete, onAssign }: {
  menus: MensaMenu[];
  selected: MensaMenu;
  manage: boolean;
  // Active schools without any plan.
  unassigned: Array<{ id: string; name: string }>;
  onPick: (id: string) => void;
  onCreate: () => void;
  onRename: () => void;
  onDelete: () => void;
  onAssign: () => void;
}) {
  const count = (n: number) => (n === 0 ? 'keine Schule' : n === 1 ? '1 Schule' : `${n} Schulen`);
  return (
    <div className="menu-bar">
      <div className="menu-cards" role="tablist" aria-label="Mensapläne">
        {menus.map((m) => (
          <button key={m.id} type="button" role="tab" aria-selected={m.id === selected.id} className="menu-card" onClick={() => onPick(m.id)}>
            <span className="flex min-w-0 items-center gap-2">
              <UtensilsCrossed size={15} strokeWidth={1.7} className="flex-shrink-0" />
              <span className="truncate text-[14.5px] font-medium">{m.name}</span>
            </span>
            <span className="mt-1 block truncate text-[12.5px]" style={{ color: m.schools.length === 0 ? 'var(--amber-deep)' : 'var(--ink-3)' }}>
              {m.dishes} {m.dishes === 1 ? 'Gericht' : 'Gerichte'} · {count(m.schools.length)}
            </span>
          </button>
        ))}
        {manage && (
          <button type="button" className="menu-card menu-card-add" onClick={onCreate}>
            <Plus size={16} strokeWidth={1.8} />
            <span className="text-[14px] font-medium">Neuer Plan</span>
          </button>
        )}
      </div>

      <div className="menu-assign">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-ink-4">„{selected.name}“ gilt für</div>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {selected.schools.length === 0 ? (
              <span className="text-[13.5px]" style={{ color: 'var(--amber-deep)' }}>Keine Schule — dieser Plan wird in keiner App angezeigt.</span>
            ) : selected.schools.map((sc) => (
              <span key={sc.id} className="school-chip"><School size={13} strokeWidth={1.8} /> {sc.name}</span>
            ))}
          </div>
        </div>
        {manage && (
          <div className="flex flex-shrink-0 items-center gap-2">
            <button type="button" className="btn btn-primary btn-sm" onClick={onAssign}>
              <School size={15} strokeWidth={1.8} />
              Schulen zuweisen
            </button>
            <IconButton icon={Pencil} label="Plan umbenennen" onClick={onRename} />
            <IconButton icon={Trash2} tone="rose" label={selected.schools.length > 0 ? 'Löschen geht erst ohne zugewiesene Schulen' : 'Plan löschen'} disabled={selected.schools.length > 0} onClick={onDelete} />
          </div>
        )}
      </div>

      {manage && unassigned.length > 0 && (
        <Notice tone="amber" icon={UtensilsCrossed}>
          {unassigned.length === 1 ? `${unassigned[0]!.name} hat` : `${unassigned.length} aktive Schulen haben`} noch keinen Mensaplan — ihre App zeigt keine Mensa.{' '}
          <button type="button" className="font-medium underline underline-offset-2" onClick={onAssign}>Diesem Plan zuweisen</button>
        </Notice>
      )}
    </div>
  );
}

// ─── DishesPage ───────────────────────────────────────────────────────────────
// A school's view edits the menu assigned to it (and shows nothing when it has
// none — the app then shows no menu either). The global view picks any menu
// and assigns it to schools; a menu several schools share changes for all of
// them at once.

type MenuDialogState =
  | { kind: 'create' }
  | { kind: 'rename' | 'delete' | 'schools'; menu: MensaMenu }
  | null;

export function DishesPage() {
  const { view, me, can, canGlobal, refresh } = useAccess();
  const { switchView } = useSwitchView();
  const isGlobal = view?.kind === 'global';
  const schoolMenu = view?.kind === 'school' ? view.school.menuId : null;
  const rights = useMemo(() => ({ edit: can('mensa.manage'), moderate: can('comments.moderate') }), [can]);
  // Plans and their schools are the installation's: global schools.manage.
  const manage = isGlobal && can('schools.manage');
  const [menus, setMenus] = useState<MensaMenu[] | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<MenuDialogState>(null);
  const handed = useHanded<HandedDish>();
  const handedMenu = handed.menuId;
  const menuIdRef = useRef<string | null>(null);

  const pick = useCallback((id: string) => {
    menuIdRef.current = id;
    setMenuContext(id || null);
    setMenuId(id);
  }, []);

  // The plans; the chosen one stays chosen while it exists. `prefer` selects
  // another (a plan just created).
  const loadMenus = useCallback(async (prefer?: string): Promise<MensaMenu[]> => {
    if (!isGlobal && !schoolMenu) return [];
    try {
      const { menus: list } = await adminApi.menus();
      setMenus(list);
      if (isGlobal) {
        const next = list.find((m) => m.id === prefer)
          ?? list.find((m) => m.id === menuIdRef.current)
          ?? list.find((m) => m.id === handedMenu)
          ?? list.find((m) => m.isDefault)
          ?? list[0];
        pick(next?.id ?? '');
      }
      return list;
    } catch {
      setMenus([]);
      if (isGlobal && menuIdRef.current === null) pick('');
      return [];
    }
  }, [isGlobal, schoolMenu, handedMenu, pick]);

  useEffect(() => {
    setMenus(null);
    menuIdRef.current = null;
    void loadMenus();
    return () => setMenuContext(null);
  }, [loadMenus]);
  // Another admin assigning or editing plans shows up here.
  useLive(['schools'], () => { void loadMenus(); }, 1500);

  async function afterNameSaved(id: string, created: boolean) {
    const list = await loadMenus(id);
    const menu = list.find((m) => m.id === id);
    // A new plan serves nobody yet: choosing its schools is the next step.
    setDialog(created && menu ? { kind: 'schools', menu } : null);
  }

  const dialogs = (
    <>
      {dialog?.kind === 'create' && <MenuNameDialog menu={null} onClose={() => setDialog(null)} onSaved={(id) => void afterNameSaved(id, true)} />}
      {dialog?.kind === 'rename' && <MenuNameDialog menu={dialog.menu} onClose={() => setDialog(null)} onSaved={(id) => void afterNameSaved(id, false)} />}
      {dialog?.kind === 'schools' && <MenuSchoolsDialog menu={dialog.menu} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); void loadMenus(); void refresh(); }} />}
      {dialog?.kind === 'delete' && <MenuDeleteDialog menu={dialog.menu} onClose={() => setDialog(null)} onDeleted={() => { setDialog(null); menuIdRef.current = null; void loadMenus(); void refresh(); }} />}
    </>
  );

  if (view?.kind === 'school' && !schoolMenu) {
    return (
      <div>
        <PageHeader title="Speiseplan" subtitle={view.school.name} />
        <div className="mt-10 flex max-w-[720px] flex-col items-start gap-4">
          <Notice tone="amber" icon={UtensilsCrossed}>
            Dieser Schule ist kein Mensaplan zugewiesen — die App zeigt für ihre Konten deshalb keine Mensa an.
            {canGlobal('schools.manage') ? '' : ' Ein Global-Admin kann ihr in der globalen Ansicht einen Plan zuweisen.'}
          </Notice>
          {canGlobal('schools.manage') && me?.globalView && (
            <button type="button" className="btn btn-primary" onClick={() => switchView({ kind: 'global' }, { path: '/dishes' })}>
              <School size={16} strokeWidth={1.8} />
              In der globalen Ansicht zuweisen
            </button>
          )}
        </div>
      </div>
    );
  }

  if (isGlobal && (menus === null || menuId === null)) return <div className="mt-10"><Spinner /></div>;

  if (isGlobal && menus && menus.length === 0) {
    return (
      <div>
        <PageHeader title="Speiseplan" subtitle="Noch kein Mensaplan." />
        <div className="mt-10 flex max-w-[720px] flex-col items-start gap-4">
          <Notice tone="amber" icon={UtensilsCrossed}>Ohne Mensaplan zeigt keine App eine Mensa. Lege einen Plan an und wähle die Schulen, die ihn zeigen.</Notice>
          {manage && (
            <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: 'create' })}>
              <Plus size={16} strokeWidth={1.8} />
              Ersten Mensaplan anlegen
            </button>
          )}
        </div>
        {dialogs}
      </div>
    );
  }

  const shown = isGlobal ? menus?.find((m) => m.id === menuId) : menus?.find((m) => m.id === schoolMenu);

  let note: ReactNode = null;
  if (isGlobal && menus && shown) {
    const unassigned = (me?.schools ?? []).filter((sc) => sc.active && !sc.menuId).map((sc) => ({ id: sc.id, name: sc.name }));
    note = (
      <MenuBar
        menus={menus}
        selected={shown}
        manage={manage}
        unassigned={unassigned}
        onPick={pick}
        onCreate={() => setDialog({ kind: 'create' })}
        onRename={() => setDialog({ kind: 'rename', menu: shown })}
        onDelete={() => setDialog({ kind: 'delete', menu: shown })}
        onAssign={() => setDialog({ kind: 'schools', menu: shown })}
      />
    );
  } else if (shown && shown.schools.length > 1) {
    note = (
      <p className="text-[13.5px] text-ink-3">
        Dieser Plan gilt auch für: {shown.schools.filter((sc) => sc.id !== (view?.kind === 'school' ? view.school.id : '')).map((sc) => sc.name).join(', ')}
        {rights.edit ? ' — Änderungen wirken dort mit.' : '.'}
      </p>
    );
  }

  return (
    <MensaRights.Provider value={rights}>
      <MenuPlan key={menuId ?? schoolMenu ?? ''} note={note} handed={menuId === null || !handed.menuId || handed.menuId === (menuId ?? schoolMenu) ? handed : {}} />
      {dialogs}
    </MensaRights.Provider>
  );
}
