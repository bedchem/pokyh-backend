import { useState, useEffect, useCallback } from 'react';
import { MessageCircle, Trash2, RefreshCw, Bell, UtensilsCrossed, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { adminApi } from '../api';
import type { AdminComment } from '../types';
import { useToast } from '../components/Toast';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h << 5) - h + name.charCodeAt(i);
  return `hsl(${Math.abs(h) % 360}, 50%, 45%)`;
}

function CommentRow({ comment, onDeleted }: { comment: AdminComment; onDeleted: (id: string) => void }) {
  const { showToast } = useToast();
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      if (comment.type === 'reminder') {
        await adminApi.deleteReminderComment(comment.id);
      } else {
        await adminApi.deleteDishComment(comment.id);
      }
      onDeleted(comment.id);
      showToast('Comment deleted', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Delete failed', 'error');
      setDeleting(false);
      setConfirm(false);
    }
  }

  return (
    <div
      className="flex items-start gap-3 px-4 py-3.5 rounded-xl transition-colors"
      style={{ background: 'rgba(14,15,28,0.6)', border: '1px solid rgba(255,255,255,0.05)' }}
    >
      {/* Avatar */}
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0 mt-0.5"
        style={{ background: avatarColor(comment.username) }}
      >
        {comment.username.slice(0, 2).toUpperCase()}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Top row */}
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="text-sm font-semibold" style={{ color: '#e0e0ef' }}>{comment.username}</span>
          <span
            className="flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full flex-shrink-0"
            style={
              comment.type === 'reminder'
                ? { background: 'rgba(251,146,60,0.12)', color: '#fb923c', border: '1px solid rgba(251,146,60,0.2)' }
                : { background: 'rgba(52,211,153,0.12)', color: '#34d399', border: '1px solid rgba(52,211,153,0.2)' }
            }
          >
            {comment.type === 'reminder'
              ? <><Bell size={10} /> Erinnerung</>
              : <><UtensilsCrossed size={10} /> Mensa</>
            }
          </span>
          <span className="text-xs" style={{ color: 'rgba(235,235,245,0.3)' }}>{timeAgo(comment.createdAt)}</span>
          {comment.updatedAt !== comment.createdAt && (
            <span className="text-[11px]" style={{ color: '#3a3a4e' }}>· edited</span>
          )}
        </div>

        {/* Context label */}
        <div className="text-xs mb-1.5 truncate" style={{ color: 'rgba(235,235,245,0.3)' }}>
          on: <span style={{ color: '#6b6b80' }}>{comment.contextTitle}</span>
        </div>

        {/* Body */}
        <p className="text-sm leading-relaxed whitespace-pre-wrap break-words" style={{ color: '#b0b0c4' }}>
          {comment.body}
        </p>
      </div>

      {/* Delete */}
      <div className="flex-shrink-0 flex items-center gap-1.5">
        {confirm ? (
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
              onClick={() => setConfirm(false)}
              className="px-2.5 py-1 rounded-lg text-xs transition-colors"
              style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(235,235,245,0.6)', border: '1px solid rgba(255,255,255,0.08)' }}
            >
              No
            </button>
          </>
        ) : (
          <button
            onClick={() => setConfirm(true)}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: 'rgba(235,235,245,0.3)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#f87171'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(235,235,245,0.3)'; }}
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

const PAGE_SIZE = 25;

export function CommentsPage() {
  const { showToast } = useToast();
  const [comments, setComments] = useState<AdminComment[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [type, setType] = useState<'all' | 'reminder' | 'dish'>('all');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');

  const load = useCallback(async (p: number, t: typeof type, s: string) => {
    setLoading(true);
    try {
      const data = await adminApi.comments({ page: p, limit: PAGE_SIZE, type: t, search: s || undefined });
      setComments(data.comments);
      setTotal(data.total);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load comments', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { load(page, type, search); }, [load, page, type, search]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setSearch(searchInput);
  }

  function handleTypeChange(t: typeof type) {
    setType(t);
    setPage(1);
  }

  function handleDeleted(id: string) {
    setComments((prev) => prev.filter((c) => c.id !== id));
    setTotal((prev) => prev - 1);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="animate-page">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: '#ffffff' }}>Kommentare</h1>
          <p className="text-sm mt-0.5" style={{ color: '#6b6b80' }}>
            {total} Kommentar{total !== 1 ? 'e' : ''} insgesamt
          </p>
        </div>
        <button
          onClick={() => load(page, type, search)}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all"
          style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(235,235,245,0.6)', border: '1px solid rgba(255,255,255,0.08)' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.08)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)'; }}
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        {/* Type tabs */}
        <div className="flex rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
          {(['all', 'reminder', 'dish'] as const).map((t) => (
            <button
              key={t}
              onClick={() => handleTypeChange(t)}
              className="px-4 py-2 text-sm font-medium transition-all flex items-center gap-1.5"
              style={{
                background: type === t ? 'rgba(10,132,255,0.2)' : 'rgba(255,255,255,0.03)',
                color: type === t ? '#0a84ff' : '#6b6b80',
                borderRight: t !== 'dish' ? '1px solid rgba(255,255,255,0.06)' : 'none',
              }}
            >
              {t === 'all' && <MessageCircle size={13} />}
              {t === 'reminder' && <Bell size={13} />}
              {t === 'dish' && <UtensilsCrossed size={13} />}
              {t === 'all' ? 'Alle' : t === 'reminder' ? 'Erinnerungen' : 'Mensa'}
            </button>
          ))}
        </div>

        {/* Search */}
        <form onSubmit={handleSearch} className="flex-1 min-w-[200px] flex gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'rgba(235,235,245,0.3)' }} />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Username oder Text suchen…"
              className="w-full pl-9 pr-4 py-2 rounded-xl text-sm outline-none transition-all"
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: '#c0c0d0',
              }}
              onFocus={(e) => {
                (e.target as HTMLInputElement).style.borderColor = 'rgba(10,132,255,0.4)';
                (e.target as HTMLInputElement).style.boxShadow = '0 0 0 3px rgba(10,132,255,0.08)';
              }}
              onBlur={(e) => {
                (e.target as HTMLInputElement).style.borderColor = 'rgba(255,255,255,0.08)';
                (e.target as HTMLInputElement).style.boxShadow = '';
              }}
            />
          </div>
          <button
            type="submit"
            className="px-4 py-2 rounded-xl text-sm font-medium transition-all"
            style={{ background: 'rgba(10,132,255,0.2)', color: '#0a84ff', border: '1px solid rgba(10,132,255,0.25)' }}
          >
            Suchen
          </button>
        </form>
      </div>

      {/* List */}
      {loading && comments.length === 0 ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-2 border-[#0a84ff] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : comments.length === 0 ? (
        <div
          className="rounded-2xl p-12 text-center"
          style={{ background: 'rgba(14,15,28,0.5)', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          <MessageCircle size={32} className="mx-auto mb-3" style={{ color: '#2a2a3e' }} />
          <p className="text-sm" style={{ color: 'rgba(235,235,245,0.3)' }}>
            {search ? 'Keine Kommentare gefunden' : 'Noch keine Kommentare'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {comments.map((c, i) => (
            <div key={c.id} className="animate-fadeInUp" style={{ animationDelay: `${i * 25}ms` }}>
              <CommentRow comment={c} onDeleted={handleDeleted} />
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-6">
          <p className="text-sm" style={{ color: 'rgba(235,235,245,0.3)' }}>
            Seite {page} von {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1 || loading}
              className="p-2 rounded-xl transition-all disabled:opacity-30"
              style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(235,235,245,0.6)', border: '1px solid rgba(255,255,255,0.08)' }}
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages || loading}
              className="p-2 rounded-xl transition-all disabled:opacity-30"
              style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(235,235,245,0.6)', border: '1px solid rgba(255,255,255,0.08)' }}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
