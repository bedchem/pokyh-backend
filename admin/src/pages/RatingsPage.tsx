import { useState, useEffect, useCallback } from 'react';
import { Star, Trash2, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { adminApi } from '../api';
import type { AdminDish, AdminDishRatingEntry } from '../types';
import { useToast } from '../components/Toast';

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
            fill={(hovered || value) >= s ? '#f59e0b' : 'transparent'}
            stroke={(hovered || value) >= s ? '#f59e0b' : '#4a4a5e'}
            strokeWidth={1.5}
          />
        </button>
      ))}
    </div>
  );
}

function StarsDisplay({ value, size = 14 }: { value: number; size?: number }) {
  return (
    <div className="flex gap-0.5 items-center">
      {[1, 2, 3, 4, 5].map((s) => (
        <Star
          key={s}
          size={size}
          fill={value >= s ? '#f59e0b' : 'transparent'}
          stroke={value >= s ? '#f59e0b' : '#4a4a5e'}
          strokeWidth={1.5}
        />
      ))}
    </div>
  );
}

function RatingRow({
  dish,
  entry,
  onUpdated,
  onDeleted,
}: {
  dish: AdminDish;
  entry: AdminDishRatingEntry;
  onUpdated: (dishId: string, stableUid: string, stars: number) => void;
  onDeleted: (dishId: string, stableUid: string) => void;
}) {
  const { showToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [editStars, setEditStars] = useState(entry.stars);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await adminApi.updateDishRating(dish.dishId, entry.stableUid, editStars);
      onUpdated(dish.dishId, entry.stableUid, editStars);
      setEditing(false);
      showToast('Rating updated', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Update failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await adminApi.deleteDishRating(dish.dishId, entry.stableUid);
      onDeleted(dish.dishId, entry.stableUid);
      showToast('Rating deleted', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Delete failed', 'error');
      setDeleting(false);
    }
  }

  return (
    <div
      className="flex items-center gap-3 px-4 py-2.5 rounded-xl transition-colors"
      style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}
    >
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium" style={{ color: '#c0c0d0' }}>{entry.username}</span>
      </div>

      {editing ? (
        <div className="flex items-center gap-2 flex-shrink-0">
          <StarSelector value={editStars} onChange={setEditStars} />
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1 rounded-lg text-xs font-semibold transition-colors"
            style={{ background: 'rgba(99,102,241,0.2)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)' }}
          >
            {saving ? '...' : 'Save'}
          </button>
          <button
            onClick={() => { setEditing(false); setEditStars(entry.stars); }}
            className="px-3 py-1 rounded-lg text-xs transition-colors"
            style={{ background: 'rgba(255,255,255,0.05)', color: '#8b8b9b', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-shrink-0">
          <StarsDisplay value={entry.stars} />
          <span className="text-xs w-3" style={{ color: '#6b6b80' }}>{entry.stars}</span>
          <button
            onClick={() => setEditing(true)}
            className="px-2.5 py-1 rounded-lg text-xs transition-colors"
            style={{ background: 'rgba(255,255,255,0.05)', color: '#8b8b9b', border: '1px solid rgba(255,255,255,0.07)' }}
          >
            Edit
          </button>
          {confirmDelete ? (
            <>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors"
                style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171', border: '1px solid rgba(239,68,68,0.25)' }}
              >
                {deleting ? '...' : 'Sure?'}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-2.5 py-1 rounded-lg text-xs transition-colors"
                style={{ background: 'rgba(255,255,255,0.05)', color: '#8b8b9b', border: '1px solid rgba(255,255,255,0.07)' }}
              >
                No
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="p-1.5 rounded-lg transition-colors"
              style={{ color: '#4a4a5e' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#f87171'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a4a5e'; }}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DishCard({
  dish,
  onUpdated,
  onDeleted,
}: {
  dish: AdminDish;
  onUpdated: (dishId: string, stableUid: string, stars: number) => void;
  onDeleted: (dishId: string, stableUid: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="rounded-xl overflow-hidden card-hover animate-fadeInUp"
      style={{ background: 'rgba(14,15,28,0.7)', border: '1px solid rgba(99,102,241,0.1)' }}
    >
      <button
        className="w-full flex items-center gap-4 px-5 py-4 text-left transition-colors"
        onClick={() => setExpanded(!expanded)}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.02)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; }}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono px-2 py-0.5 rounded-md" style={{ background: 'rgba(99,102,241,0.12)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.2)' }}>
              {dish.dishId}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-4 flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <StarsDisplay value={Math.round(dish.avgStars)} size={15} />
            <span className="text-sm font-semibold" style={{ color: '#f59e0b' }}>{dish.avgStars.toFixed(1)}</span>
          </div>
          <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(255,255,255,0.06)', color: '#8b8b9b' }}>
            {dish.count} {dish.count === 1 ? 'vote' : 'votes'}
          </span>
          <span style={{ color: '#4a4a5e' }}>
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 flex flex-col gap-2 animate-fadeInUp">
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.05)', marginBottom: '4px' }} />
          {dish.ratings.length === 0 ? (
            <p className="text-sm text-center py-4" style={{ color: '#4a4a5e' }}>No ratings</p>
          ) : (
            dish.ratings.map((entry) => (
              <RatingRow
                key={entry.stableUid}
                dish={dish}
                entry={entry}
                onUpdated={onUpdated}
                onDeleted={onDeleted}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function RatingsPage() {
  const { showToast } = useToast();
  const [dishes, setDishes] = useState<AdminDish[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminApi.dishRatings();
      setDishes(data);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load ratings', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  function handleUpdated(dishId: string, stableUid: string, stars: number) {
    setDishes((prev) =>
      prev.map((d) =>
        d.dishId !== dishId
          ? d
          : {
              ...d,
              ratings: d.ratings.map((r) => r.stableUid === stableUid ? { ...r, stars } : r),
              avgStars: Math.round(
                (d.ratings.reduce((s, r) => s + (r.stableUid === stableUid ? stars : r.stars), 0) / d.ratings.length) * 10
              ) / 10,
            }
      )
    );
  }

  function handleDeleted(dishId: string, stableUid: string) {
    setDishes((prev) =>
      prev
        .map((d) => {
          if (d.dishId !== dishId) return d;
          const newRatings = d.ratings.filter((r) => r.stableUid !== stableUid);
          if (newRatings.length === 0) return null;
          const avg = newRatings.reduce((s, r) => s + r.stars, 0) / newRatings.length;
          return { ...d, ratings: newRatings, count: newRatings.length, avgStars: Math.round(avg * 10) / 10 };
        })
        .filter(Boolean) as AdminDish[]
    );
  }

  const filtered = search.trim()
    ? dishes.filter(
        (d) =>
          d.dishId.toLowerCase().includes(search.toLowerCase()) ||
          d.ratings.some((r) => r.username.toLowerCase().includes(search.toLowerCase()))
      )
    : dishes;

  return (
    <div className="animate-page">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: '#f0f0f5' }}>Dish Ratings</h1>
          <p className="text-sm mt-0.5" style={{ color: '#6b6b80' }}>
            {dishes.length} {dishes.length === 1 ? 'dish' : 'dishes'} &middot;{' '}
            {dishes.reduce((s, d) => s + d.count, 0)} total votes
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all"
          style={{ background: 'rgba(255,255,255,0.05)', color: '#8b8b9b', border: '1px solid rgba(255,255,255,0.08)' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.08)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)'; }}
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Search */}
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by dish ID or username..."
        className="w-full px-4 py-2.5 rounded-xl text-sm mb-5 outline-none transition-all"
        style={{
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          color: '#c0c0d0',
        }}
        onFocus={(e) => {
          (e.target as HTMLInputElement).style.borderColor = 'rgba(99,102,241,0.4)';
          (e.target as HTMLInputElement).style.boxShadow = '0 0 0 3px rgba(99,102,241,0.08)';
        }}
        onBlur={(e) => {
          (e.target as HTMLInputElement).style.borderColor = 'rgba(255,255,255,0.08)';
          (e.target as HTMLInputElement).style.boxShadow = '';
        }}
      />

      {loading && dishes.length === 0 ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div
          className="rounded-2xl p-12 text-center"
          style={{ background: 'rgba(14,15,28,0.5)', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          <Star size={32} className="mx-auto mb-3" style={{ color: '#2a2a3e' }} />
          <p className="text-sm" style={{ color: '#4a4a5e' }}>
            {search ? 'No dishes match your search' : 'No dish ratings yet'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((dish, i) => (
            <div key={dish.dishId} style={{ animationDelay: `${i * 40}ms` }}>
              <DishCard dish={dish} onUpdated={handleUpdated} onDeleted={handleDeleted} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
