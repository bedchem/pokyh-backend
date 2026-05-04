import { useState, useEffect, useCallback, useRef } from 'react';
import {
  UtensilsCrossed, Plus, Pencil, Trash2, Download, X, ChevronDown, ChevronUp, Leaf, Sprout,
} from 'lucide-react';
import { adminApi } from '../api';
import type { AdminDishFull } from '../types';
import { useToast } from '../components/Toast';

// ─── helpers ────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('de-AT', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
}

function weekKey(iso: string) {
  const d = new Date(iso + 'T00:00:00');
  const day = d.getDay() || 7;
  const mon = new Date(d);
  mon.setDate(d.getDate() - day + 1);
  return mon.toISOString().split('T')[0];
}

function weekLabel(iso: string) {
  const d = new Date(iso + 'T00:00:00');
  const day = d.getDay() || 7;
  const mon = new Date(d);
  mon.setDate(d.getDate() - day + 1);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  const fmt = (x: Date) => x.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' });
  return `KW — ${fmt(mon)} – ${fmt(sun)}`;
}

function emptyDish(): Omit<AdminDishFull, 'id' | 'createdAt' | 'updatedAt'> {
  const today = new Date().toISOString().split('T')[0];
  return {
    nameDe: '', nameIt: '', nameEn: '',
    descDe: '', descIt: '', descEn: '',
    imageUrl: '', category: '',
    tags: [], allergens: [],
    prepTime: 0, calories: 0, price: 0, protein: 0, fat: 0,
    isVegetarian: false, isVegan: false,
    date: today, sortOrder: 0,
  };
}

// ─── DishForm (slide-over panel) ─────────────────────────────────────────────

interface DishFormProps {
  dish: AdminDishFull | null; // null = create mode
  onSaved: (d: AdminDishFull) => void;
  onClose: () => void;
}

function DishForm({ dish, onSaved, onClose }: DishFormProps) {
  const { showToast } = useToast();
  const isEdit = dish !== null;

  const [form, setForm] = useState(() =>
    dish
      ? { ...dish, tagsText: dish.tags.join('\n'), allergensText: dish.allergens.join('\n') }
      : { ...emptyDish(), tagsText: '', allergensText: '' }
  );
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'basic' | 'localize' | 'nutrition'>('basic');

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
        isVegetarian: form.isVegetarian,
        isVegan: form.isVegan,
        date: form.date,
        sortOrder: Number(form.sortOrder) || 0,
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

  const inp = 'w-full px-3 py-2 rounded-lg text-sm outline-none transition-all';
  const inpStyle = {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.09)',
    color: '#c0c0d0',
  };
  const focusStyle = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    (e.target as HTMLElement).style.borderColor = 'rgba(99,102,241,0.45)';
    (e.target as HTMLElement).style.boxShadow = '0 0 0 3px rgba(99,102,241,0.08)';
  };
  const blurStyle = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    (e.target as HTMLElement).style.borderColor = 'rgba(255,255,255,0.09)';
    (e.target as HTMLElement).style.boxShadow = '';
  };
  const lbl = 'block text-xs font-medium mb-1 uppercase tracking-wide';
  const lblStyle = { color: '#6b6b80' };

  const tabs = [
    { key: 'basic' as const, label: 'Allgemein' },
    { key: 'localize' as const, label: 'Sprachen' },
    { key: 'nutrition' as const, label: 'Nährwerte' },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="h-full flex flex-col w-full max-w-lg animate-scaleIn overflow-hidden"
        style={{
          background: '#111116',
          borderLeft: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '-20px 0 60px rgba(0,0,0,0.5)',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 flex-shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <h2 className="font-semibold" style={{ color: '#e0e0ef' }}>
            {isEdit ? 'Gericht bearbeiten' : 'Neues Gericht'}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg transition-colors" style={{ color: '#4a4a5e' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#f0f0f5'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a4a5e'; }}>
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
                color: tab === t.key ? '#818cf8' : '#6b6b80',
                borderBottom: tab === t.key ? '2px solid #6366f1' : '2px solid transparent',
                background: tab === t.key ? 'rgba(99,102,241,0.06)' : 'transparent',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-4 scroll-touch">

          {tab === 'basic' && (
            <>
              {/* Image preview */}
              {form.imageUrl && (
                <div className="w-full h-36 rounded-xl overflow-hidden flex-shrink-0"
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

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={lblStyle} className={lbl}>Datum *</label>
                  <input type="date" className={inp} style={inpStyle} value={form.date}
                    onChange={(e) => set('date', e.target.value)}
                    onFocus={focusStyle} onBlur={blurStyle} />
                </div>
                <div>
                  <label style={lblStyle} className={lbl}>Reihenfolge</label>
                  <input type="number" className={inp} style={inpStyle} value={form.sortOrder}
                    onChange={(e) => set('sortOrder', Number(e.target.value))}
                    onFocus={focusStyle} onBlur={blurStyle} min={0} />
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

              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={form.isVegetarian}
                    onChange={(e) => set('isVegetarian', e.target.checked)} className="accent-indigo-500" />
                  <Leaf size={14} style={{ color: '#22c55e' }} />
                  <span className="text-sm" style={{ color: '#8b8b9b' }}>Vegetarisch</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={form.isVegan}
                    onChange={(e) => set('isVegan', e.target.checked)} className="accent-indigo-500" />
                  <Sprout size={14} style={{ color: '#86efac' }} />
                  <span className="text-sm" style={{ color: '#8b8b9b' }}>Vegan</span>
                </label>
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

          {tab === 'localize' && (
            <>
              {(['De', 'It', 'En'] as const).map((lang) => (
                <div key={lang} className="flex flex-col gap-3 pb-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <p className="text-xs font-bold uppercase tracking-widest" style={{ color: '#4a4a5e' }}>
                    {lang === 'De' ? 'Deutsch' : lang === 'It' ? 'Italiano' : 'English'}
                  </p>
                  <div>
                    <label style={lblStyle} className={lbl}>Name</label>
                    <input className={inp} style={inpStyle}
                      value={form[`name${lang}` as 'nameDe' | 'nameIt' | 'nameEn']}
                      onChange={(e) => set(`name${lang}` as 'nameDe', e.target.value)}
                      onFocus={focusStyle} onBlur={blurStyle} />
                  </div>
                  <div>
                    <label style={lblStyle} className={lbl}>Beschreibung</label>
                    <textarea className={`${inp} resize-none`} style={{ ...inpStyle, minHeight: '80px' }}
                      value={form[`desc${lang}` as 'descDe' | 'descIt' | 'descEn']}
                      onChange={(e) => set(`desc${lang}` as 'descDe', e.target.value)}
                      onFocus={focusStyle} onBlur={blurStyle} />
                  </div>
                </div>
              ))}
            </>
          )}

          {tab === 'nutrition' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                {([
                  ['calories', 'Kalorien (kcal)'],
                  ['price', 'Preis (€)'],
                  ['protein', 'Protein (g)'],
                  ['fat', 'Fett (g)'],
                  ['prepTime', 'Zubereitungszeit (min)'],
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
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 flex-shrink-0" style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm transition-colors"
            style={{ background: 'rgba(255,255,255,0.05)', color: '#8b8b9b', border: '1px solid rgba(255,255,255,0.08)' }}>
            Abbrechen
          </button>
          <button onClick={handleSave} disabled={saving}
            className="px-5 py-2 rounded-xl text-sm font-semibold transition-all"
            style={{
              background: saving ? 'rgba(99,102,241,0.4)' : 'linear-gradient(135deg,#6366f1,#818cf8)',
              color: '#fff',
              boxShadow: saving ? 'none' : '0 4px 16px rgba(99,102,241,0.3)',
            }}>
            {saving ? 'Speichern...' : isEdit ? 'Speichern' : 'Erstellen'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── DishCard ────────────────────────────────────────────────────────────────

function DishCard({ dish, onEdit, onDelete }: {
  dish: AdminDishFull;
  onEdit: (d: AdminDishFull) => void;
  onDelete: (id: string) => void;
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
      className="flex items-center gap-3 px-4 py-3 rounded-xl card-hover transition-all"
      style={{ background: 'rgba(14,15,28,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      {/* Image */}
      <div className="w-12 h-12 rounded-lg flex-shrink-0 overflow-hidden flex items-center justify-center"
        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
        {dish.imageUrl && !imgError ? (
          <img src={dish.imageUrl} alt={dish.nameDe} className="w-full h-full object-cover"
            onError={() => setImgError(true)} />
        ) : (
          <UtensilsCrossed size={18} style={{ color: '#2a2a3e' }} />
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium truncate" style={{ color: '#d0d0e0' }}>{dish.nameDe}</span>
          {dish.isVegan && <Sprout size={13} style={{ color: '#86efac' }} />}
          {dish.isVegetarian && !dish.isVegan && <Leaf size={13} style={{ color: '#22c55e' }} />}
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {dish.category && (
            <span className="text-xs px-1.5 py-0.5 rounded-md" style={{ background: 'rgba(99,102,241,0.1)', color: '#818cf8' }}>
              {dish.category}
            </span>
          )}
          {dish.calories > 0 && (
            <span className="text-xs" style={{ color: '#4a4a5e' }}>{dish.calories} kcal</span>
          )}
          {dish.price > 0 && (
            <span className="text-xs" style={{ color: '#4a4a5e' }}>€{dish.price.toFixed(2)}</span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <button onClick={() => onEdit(dish)}
          className="p-2 rounded-lg transition-colors"
          style={{ color: '#4a4a5e' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#818cf8'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a4a5e'; }}>
          <Pencil size={15} />
        </button>
        {confirmDel ? (
          <div className="flex items-center gap-1">
            <button onClick={handleDelete} disabled={deleting}
              className="px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors"
              style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171', border: '1px solid rgba(239,68,68,0.2)' }}>
              {deleting ? '...' : 'Löschen?'}
            </button>
            <button onClick={() => setConfirmDel(false)}
              className="px-2 py-1 rounded-lg text-xs transition-colors"
              style={{ background: 'rgba(255,255,255,0.05)', color: '#8b8b9b' }}>
              Nein
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirmDel(true)}
            className="p-2 rounded-lg transition-colors"
            style={{ color: '#4a4a5e' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#f87171'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a4a5e'; }}>
            <Trash2 size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── ImportDialog ────────────────────────────────────────────────────────────

function ImportDialog({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const { showToast } = useToast();
  const [url, setUrl] = useState('https://mensa.plattnericus.dev/mensa.json');
  const [loading, setLoading] = useState(false);

  async function handleImport() {
    setLoading(true);
    try {
      const result = await adminApi.importDishesFromUrl(url.trim() || undefined);
      showToast(`Importiert: ${result.imported} neu, ${result.updated} aktualisiert`, 'success');
      onDone();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Import fehlgeschlagen', 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-2xl p-6 animate-scaleIn"
        style={{ background: '#111116', border: '1px solid rgba(99,102,241,0.2)' }}>
        <h3 className="font-bold mb-1" style={{ color: '#e0e0ef' }}>Gerichte importieren</h3>
        <p className="text-xs mb-4" style={{ color: '#6b6b80' }}>
          Lädt alle Gerichte von der externen URL und speichert sie lokal. Vorhandene werden aktualisiert.
        </p>
        <input
          className="w-full px-3 py-2 rounded-lg text-sm outline-none mb-4 transition-all"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)', color: '#c0c0d0' }}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://..."
        />
        <div className="flex items-center justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm"
            style={{ background: 'rgba(255,255,255,0.05)', color: '#8b8b9b' }}>
            Abbrechen
          </button>
          <button onClick={handleImport} disabled={loading}
            className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold transition-all"
            style={{
              background: loading ? 'rgba(99,102,241,0.4)' : 'linear-gradient(135deg,#6366f1,#818cf8)',
              color: '#fff', boxShadow: loading ? 'none' : '0 4px 16px rgba(99,102,241,0.25)',
            }}>
            <Download size={15} />
            {loading ? 'Importiere...' : 'Importieren'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── DishesPage ───────────────────────────────────────────────────────────────

export function DishesPage() {
  const { showToast } = useToast();
  const [dishes, setDishes] = useState<AdminDishFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [editDish, setEditDish] = useState<AdminDishFull | null | 'new'>(null);
  const [showImport, setShowImport] = useState(false);
  const [collapsedWeeks, setCollapsedWeeks] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDishes(await adminApi.dishes());
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Fehler beim Laden', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  function handleSaved(d: AdminDishFull) {
    setDishes((prev) => {
      const idx = prev.findIndex((x) => x.id === d.id);
      return idx >= 0 ? prev.map((x) => x.id === d.id ? d : x) : [d, ...prev];
    });
    setEditDish(null);
  }

  function handleDeleted(id: string) {
    setDishes((prev) => prev.filter((d) => d.id !== id));
  }

  // Filter
  const filtered = search.trim()
    ? dishes.filter((d) =>
        d.nameDe.toLowerCase().includes(search.toLowerCase()) ||
        d.nameIt.toLowerCase().includes(search.toLowerCase()) ||
        d.nameEn.toLowerCase().includes(search.toLowerCase()) ||
        d.category.toLowerCase().includes(search.toLowerCase()) ||
        d.date.includes(search)
      )
    : dishes;

  // Group by week
  const weeks = new Map<string, AdminDishFull[]>();
  for (const d of filtered) {
    const k = weekKey(d.date);
    const arr = weeks.get(k) ?? [];
    arr.push(d);
    weeks.set(k, arr);
  }
  const sortedWeeks = [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b));

  function toggleWeek(k: string) {
    setCollapsedWeeks((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  }

  return (
    <div className="animate-page">
      {/* Header */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: '#f0f0f5' }}>Speiseplan</h1>
          <p className="text-sm mt-0.5" style={{ color: '#6b6b80' }}>
            {dishes.length} {dishes.length === 1 ? 'Gericht' : 'Gerichte'} &middot; zentral gespeichert
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all"
            style={{ background: 'rgba(255,255,255,0.05)', color: '#8b8b9b', border: '1px solid rgba(255,255,255,0.08)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.09)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)'; }}>
            <Download size={15} />
            Importieren
          </button>
          <button
            onClick={() => setEditDish('new')}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all"
            style={{
              background: 'linear-gradient(135deg,#6366f1,#818cf8)',
              color: '#fff',
              boxShadow: '0 4px 16px rgba(99,102,241,0.3)',
            }}>
            <Plus size={15} />
            Neues Gericht
          </button>
        </div>
      </div>

      {/* Search */}
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Suche nach Name, Kategorie, Datum..."
        className="w-full px-4 py-2.5 rounded-xl text-sm mb-5 outline-none transition-all"
        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#c0c0d0' }}
        onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = 'rgba(99,102,241,0.4)'; (e.target as HTMLInputElement).style.boxShadow = '0 0 0 3px rgba(99,102,241,0.08)'; }}
        onBlur={(e) => { (e.target as HTMLInputElement).style.borderColor = 'rgba(255,255,255,0.08)'; (e.target as HTMLInputElement).style.boxShadow = ''; }}
      />

      {/* Content */}
      {loading && dishes.length === 0 ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : sortedWeeks.length === 0 ? (
        <div className="rounded-2xl p-12 text-center" style={{ background: 'rgba(14,15,28,0.5)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <UtensilsCrossed size={32} className="mx-auto mb-3" style={{ color: '#2a2a3e' }} />
          <p className="text-sm mb-3" style={{ color: '#4a4a5e' }}>
            {search ? 'Keine Gerichte gefunden' : 'Noch keine Gerichte gespeichert'}
          </p>
          {!search && (
            <button onClick={() => setShowImport(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium mx-auto transition-all"
              style={{ background: 'rgba(99,102,241,0.15)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.2)' }}>
              <Download size={15} />
              Aus externer URL importieren
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {sortedWeeks.map(([wk, wDishes], wi) => {
            const collapsed = collapsedWeeks.has(wk);
            return (
              <div key={wk} className="animate-fadeInUp" style={{ animationDelay: `${wi * 40}ms` }}>
                {/* Week header */}
                <button
                  className="w-full flex items-center justify-between px-4 py-2.5 rounded-xl mb-2 transition-colors"
                  style={{ background: 'rgba(99,102,241,0.07)', border: '1px solid rgba(99,102,241,0.1)' }}
                  onClick={() => toggleWeek(wk)}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(99,102,241,0.12)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(99,102,241,0.07)'; }}
                >
                  <span className="text-xs font-bold uppercase tracking-widest" style={{ color: '#6366f1' }}>
                    {weekLabel(wk)} &middot; {wDishes.length} {wDishes.length === 1 ? 'Gericht' : 'Gerichte'}
                  </span>
                  {collapsed ? <ChevronDown size={15} style={{ color: '#6366f1' }} /> : <ChevronUp size={15} style={{ color: '#6366f1' }} />}
                </button>

                {!collapsed && (
                  <div className="flex flex-col gap-2">
                    {wDishes.map((dish) => (
                      <div key={dish.id} className="ml-0">
                        {/* Day label */}
                        <div className="flex items-center gap-2 mb-1 mt-2 first:mt-0">
                          <span className="text-xs font-medium" style={{ color: '#4a4a5e' }}>
                            {formatDate(dish.date)}
                          </span>
                          <div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.04)' }} />
                        </div>
                        <DishCard dish={dish} onEdit={setEditDish} onDelete={handleDeleted} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Edit/Create panel */}
      {editDish !== null && (
        <DishForm
          dish={editDish === 'new' ? null : editDish}
          onSaved={handleSaved}
          onClose={() => setEditDish(null)}
        />
      )}

      {/* Import dialog */}
      {showImport && (
        <ImportDialog
          onDone={() => { setShowImport(false); load(); }}
          onClose={() => setShowImport(false)}
        />
      )}
    </div>
  );
}
