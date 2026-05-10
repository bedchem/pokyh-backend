import { useState, useEffect, useCallback } from 'react';
import { MessageCircle, Trash2, RefreshCw, Bell, UtensilsCrossed, Search, ChevronLeft, ChevronRight, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
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
      if (comment.type === 'reminder') await adminApi.deleteReminderComment(comment.id);
      else await adminApi.deleteDishComment(comment.id);
      onDeleted(comment.id);
      showToast('Kommentar gelöscht', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Fehler beim Löschen', 'error');
      setDeleting(false);
      setConfirm(false);
    }
  }

  return (
    <div
      className="flex items-start gap-3 px-4 py-3.5 rounded-[14px] transition-colors"
      style={{ background: '#1c1c1e', border: '1px solid rgba(255,255,255,0.07)' }}
    >
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold text-white flex-shrink-0 mt-0.5"
        style={{ background: avatarColor(comment.username) }}
      >
        {comment.username.slice(0, 2).toUpperCase()}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="text-[14px] font-semibold text-white">{comment.username}</span>
          <span
            className="flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full flex-shrink-0"
            style={
              comment.type === 'reminder'
                ? { background: 'rgba(255,159,10,0.12)', color: '#ff9f0a' }
                : { background: 'rgba(48,209,88,0.12)', color: '#30d158' }
            }
          >
            {comment.type === 'reminder' ? <><Bell size={10} /> Erinnerung</> : <><UtensilsCrossed size={10} /> Mensa</>}
          </span>
          <span className="text-[12px]" style={{ color: 'rgba(235,235,245,0.3)' }}>{timeAgo(comment.createdAt)}</span>
        </div>

        <div className="text-[12px] mb-1.5 truncate" style={{ color: 'rgba(235,235,245,0.3)' }}>
          zu: <span style={{ color: 'rgba(235,235,245,0.5)' }}>{comment.contextTitle}</span>
        </div>

        <p className="text-[13px] leading-relaxed whitespace-pre-wrap break-words" style={{ color: 'rgba(235,235,245,0.7)' }}>
          {comment.body}
        </p>
      </div>

      <div className="flex-shrink-0 flex items-center gap-1.5">
        {confirm ? (
          <>
            <button onClick={handleDelete} disabled={deleting} className="px-2.5 py-1 rounded-[8px] text-[12px] font-semibold transition-colors" style={{ background: 'rgba(255,69,58,0.14)', color: '#ff453a' }}>
              {deleting ? '…' : 'Löschen?'}
            </button>
            <button onClick={() => setConfirm(false)} className="px-2.5 py-1 rounded-[8px] text-[12px] transition-colors" style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(235,235,245,0.5)' }}>
              Nein
            </button>
          </>
        ) : (
          <button onClick={() => setConfirm(true)} className="p-1.5 rounded-[8px] transition-colors" style={{ color: 'rgba(235,235,245,0.25)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff453a'; (e.currentTarget as HTMLElement).style.background = 'rgba(255,69,58,0.1)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(235,235,245,0.25)'; (e.currentTarget as HTMLElement).style.background = ''; }}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

const PAGE_SIZE = 25;
type SortBy = 'createdAt' | 'username' | 'body';

export function CommentsPage() {
  const { showToast } = useToast();
  const [comments, setComments] = useState<AdminComment[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [type, setType] = useState<'all' | 'reminder' | 'dish'>('all');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('createdAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const load = useCallback(async (p: number, t: typeof type, s: string, sb: SortBy, so: 'asc' | 'desc') => {
    setLoading(true);
    try {
      const data = await adminApi.comments({ page: p, limit: PAGE_SIZE, type: t, search: s || undefined, sortBy: sb, sortOrder: so });
      setComments(data.comments);
      setTotal(data.total);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Fehler beim Laden', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { load(page, type, search, sortBy, sortOrder); }, [load, page, type, search, sortBy, sortOrder]);

  function handleSearch(e: React.FormEvent) { e.preventDefault(); setPage(1); setSearch(searchInput); }
  function handleTypeChange(t: typeof type) { setType(t); setPage(1); }
  function handleSortBy(sb: SortBy) { setSortBy(sb); setPage(1); }
  function toggleSortOrder() { setSortOrder((o) => o === 'asc' ? 'desc' : 'asc'); setPage(1); }
  function handleDeleted(id: string) { setComments((prev) => prev.filter((c) => c.id !== id)); setTotal((prev) => prev - 1); }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const sortLabels: Record<SortBy, string> = { createdAt: 'Datum', username: 'Benutzer', body: 'Inhalt' };

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-[28px] font-bold text-white" style={{ letterSpacing: '-0.03em' }}>Kommentare</h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'rgba(235,235,245,0.4)' }}>
            {total} Kommentar{total !== 1 ? 'e' : ''} insgesamt
          </p>
        </div>
        <button onClick={() => load(page, type, search, sortBy, sortOrder)} disabled={loading} className="apple-btn-ghost flex items-center gap-2 px-3 py-2 rounded-[10px] text-[13px]">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Aktualisieren
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center p-3 rounded-[14px]" style={{ background: '#1c1c1e', border: '1px solid rgba(255,255,255,0.07)' }}>
        {/* Type tabs */}
        <div className="flex rounded-[10px] overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
          {(['all', 'reminder', 'dish'] as const).map((t, idx) => (
            <button key={t} onClick={() => handleTypeChange(t)}
              className="px-3.5 py-1.5 text-[13px] font-medium transition-all flex items-center gap-1.5"
              style={{ background: type === t ? 'rgba(10,132,255,0.18)' : 'transparent', color: type === t ? '#0a84ff' : 'rgba(235,235,245,0.5)', borderRight: idx < 2 ? '1px solid rgba(255,255,255,0.06)' : 'none' }}>
              {t === 'all' && <MessageCircle size={12} />}
              {t === 'reminder' && <Bell size={12} />}
              {t === 'dish' && <UtensilsCrossed size={12} />}
              {t === 'all' ? 'Alle' : t === 'reminder' ? 'Erinnerungen' : 'Mensa'}
            </button>
          ))}
        </div>

        {/* Sort */}
        <div className="flex items-center gap-1.5">
          <span className="text-[12px]" style={{ color: 'rgba(235,235,245,0.35)' }}>Sortieren:</span>
          <div className="flex rounded-[8px] overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
            {(['createdAt', 'username', 'body'] as SortBy[]).map((sb, idx) => (
              <button key={sb} onClick={() => handleSortBy(sb)}
                className="px-3 py-1.5 text-[12px] font-medium transition-all"
                style={{ background: sortBy === sb ? 'rgba(10,132,255,0.18)' : 'transparent', color: sortBy === sb ? '#0a84ff' : 'rgba(235,235,245,0.5)', borderRight: idx < 2 ? '1px solid rgba(255,255,255,0.06)' : 'none' }}>
                {sortLabels[sb]}
              </button>
            ))}
          </div>
          <button onClick={toggleSortOrder} className="p-1.5 rounded-[8px] transition-colors" style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(235,235,245,0.6)' }}
            title={sortOrder === 'asc' ? 'Aufsteigend' : 'Absteigend'}>
            {sortOrder === 'asc' ? <ArrowUp size={13} /> : sortOrder === 'desc' ? <ArrowDown size={13} /> : <ArrowUpDown size={13} />}
          </button>
        </div>

        {/* Search */}
        <form onSubmit={handleSearch} className="flex gap-2 flex-1 min-w-[200px]">
          <div className="relative flex-1">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'rgba(235,235,245,0.3)' }} />
            <input type="text" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Benutzer oder Text suchen…"
              className="apple-input w-full pl-8 py-2 text-[13px]" />
          </div>
          <button type="submit" className="apple-btn px-4 py-2 text-[13px]">Suchen</button>
        </form>
      </div>

      {/* List */}
      {loading && comments.length === 0 ? (
        <div className="flex justify-center py-20">
          <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: 'rgba(255,255,255,0.1)', borderTopColor: '#0a84ff' }} />
        </div>
      ) : comments.length === 0 ? (
        <div className="apple-card p-12 text-center">
          <MessageCircle size={32} className="mx-auto mb-3" style={{ color: 'rgba(235,235,245,0.15)' }} />
          <p className="text-[13px]" style={{ color: 'rgba(235,235,245,0.3)' }}>{search ? 'Keine Kommentare gefunden' : 'Noch keine Kommentare'}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {comments.map((c, i) => (
            <div key={c.id} className="animate-fadeInUp" style={{ animationDelay: `${i * 20}ms` }}>
              <CommentRow comment={c} onDeleted={handleDeleted} />
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-[12px]" style={{ color: 'rgba(235,235,245,0.3)' }}>Seite {page} von {totalPages}</p>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1 || loading} className="p-2 rounded-[10px] transition-all disabled:opacity-30" style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(235,235,245,0.6)' }}>
              <ChevronLeft size={15} />
            </button>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages || loading} className="p-2 rounded-[10px] transition-all disabled:opacity-30" style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(235,235,245,0.6)' }}>
              <ChevronRight size={15} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
