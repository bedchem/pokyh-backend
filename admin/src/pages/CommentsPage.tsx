import { useState, useEffect, useCallback, useRef } from 'react';
import { MessageCircle, Trash2, RefreshCw, Bell, UtensilsCrossed } from 'lucide-react';
import { adminApi } from '../api';
import type { AdminComment } from '../types';
import { useToast } from '../components/Toast';
import { useLive } from '../live';
import { Avatar, Empty, Figures, IconButton, PageHeader, Pager, SearchField, Section, Segmented, Tag } from '../components/kit';
import { SplitBar } from '../components/charts';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.floor(min / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'Gestern' : `vor ${d} Tagen`;
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
    <article className="spot flex items-start gap-4 py-6">
      <Avatar name={comment.username} size={44} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[15px] font-medium">{comment.username}</span>
          <time className="text-[12.5px] text-ink-3" dateTime={comment.createdAt}>{timeAgo(comment.createdAt)}</time>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[13.5px] text-ink-3">
          <span className="min-w-0 truncate">Kommentierte <span className="text-sky-deep">{comment.contextTitle || 'einen Beitrag'}</span></span>
          <Tag tone={comment.type === 'reminder' ? 'amber' : 'mint'}>
            {comment.type === 'reminder' ? <><Bell size={11} /> Erinnerung</> : <><UtensilsCrossed size={11} /> Mensa</>}
          </Tag>
        </div>
        <p className="comment-bubble">{comment.body}</p>
      </div>

      <div className="flex flex-shrink-0 items-center gap-2">
        {confirm ? (
          <>
            <button type="button" onClick={() => void handleDelete()} disabled={deleting} className="btn btn-sm btn-danger">
              {deleting ? 'Lösche…' : 'Wirklich löschen?'}
            </button>
            <button type="button" onClick={() => setConfirm(false)} disabled={deleting} className="btn btn-sm btn-quiet">Nein</button>
          </>
        ) : (
          <IconButton icon={Trash2} tone="rose" label="Kommentar löschen" onClick={() => setConfirm(true)} />
        )}
      </div>
    </article>
  );
}

const PAGE_SIZE = 25;

type CommentType = 'all' | 'reminder' | 'dish';
type SortOption = 'createdAt_desc' | 'createdAt_asc' | 'username_asc' | 'username_desc' | 'body_asc' | 'body_desc';

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'createdAt_desc', label: 'Neueste zuerst' },
  { value: 'createdAt_asc',  label: 'Älteste zuerst' },
  { value: 'username_asc',   label: 'Benutzer A–Z' },
  { value: 'username_desc',  label: 'Benutzer Z–A' },
];

function parseSortOption(opt: SortOption): { sortBy: 'createdAt' | 'username' | 'body'; sortOrder: 'asc' | 'desc' } {
  const [sb, so] = opt.split('_') as ['createdAt' | 'username' | 'body', 'asc' | 'desc'];
  return { sortBy: sb, sortOrder: so };
}

export function CommentsPage() {
  const { showToast } = useToast();
  const [comments, setComments] = useState<AdminComment[]>([]);
  const [total, setTotal] = useState(0);
  // Totals per kind for the figures; fetched on their own so the list never waits on them.
  const [split, setSplit] = useState<{ dish: number; reminder: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [type, setType] = useState<CommentType>('all');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [sortOption, setSortOption] = useState<SortOption>('createdAt_desc');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { sortBy, sortOrder } = parseSortOption(sortOption);

  const load = useCallback(async (p: number, t: CommentType, s: string, sb: 'createdAt' | 'username' | 'body', so: 'asc' | 'desc') => {
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

  const loadSplit = useCallback(() => {
    Promise.all([
      adminApi.comments({ limit: 1, type: 'dish' }),
      adminApi.comments({ limit: 1, type: 'reminder' }),
    ]).then(([dish, reminder]) => setSplit({ dish: dish.total, reminder: reminder.total }))
      .catch(() => { /* the figures stay empty; the list is unaffected */ });
  }, []);

  useEffect(() => { void load(page, type, search, sortBy, sortOrder); }, [load, page, type, search, sortBy, sortOrder]);
  useEffect(() => { loadSplit(); }, [loadSplit]);
  useLive(['comments'], () => { loadSplit(); void load(page, type, search, sortBy, sortOrder); });

  // Search as you type, a moment after the last keystroke.
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => { setPage(1); setSearch(searchInput.trim()); }, 300);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [searchInput]);

  function handleTypeChange(t: CommentType) { setType(t); setPage(1); }
  function handleSortChange(opt: SortOption) { setSortOption(opt); setPage(1); }
  function handleDeleted(id: string) {
    setComments((prev) => prev.filter((c) => c.id !== id));
    setTotal((prev) => prev - 1);
    loadSplit();
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const allComments = split ? split.dish + split.reminder : null;

  return (
    <div>
      <PageHeader title="Kommentare" subtitle="Was Nutzer:innen zu Gerichten und Erinnerungen schreiben — hier moderieren.">
        <IconButton
          icon={RefreshCw}
          label="Aktualisieren"
          size={42}
          busy={loading}
          onClick={() => { loadSplit(); void load(page, type, search, sortBy, sortOrder); }}
        />
      </PageHeader>

      <Figures
        className="mt-10"
        items={[
          { label: 'Kommentare',   value: allComments ?? '–',     icon: MessageCircle },
          { label: 'Mensa',        value: split?.dish ?? '–',     icon: UtensilsCrossed },
          { label: 'Erinnerungen', value: split?.reminder ?? '–', icon: Bell },
        ]}
      />

      <Section className="mt-[46px]" title="Verteilung">
        <div className="mt-8 max-w-[720px]">
          <SplitBar
            ariaLabel="Kommentare nach Art"
            parts={[
              { label: 'Mensa',        value: split?.dish ?? 0,     color: 'var(--mint)' },
              { label: 'Erinnerungen', value: split?.reminder ?? 0, color: 'var(--amber)' },
            ]}
          />
        </div>
      </Section>

      <Section
        className="mt-[52px]"
        title="Alle Kommentare"
        meta={`${total.toLocaleString('de-AT')} ${search ? 'Treffer' : 'gesamt'}`}
        action={(
          <>
            <SearchField value={searchInput} onChange={setSearchInput} placeholder="Benutzer oder Text suchen" className="w-full sm:w-[250px]" />
            <select
              value={sortOption}
              onChange={(e) => handleSortChange(e.target.value as SortOption)}
              aria-label="Sortierung"
              className="field h-11 px-4 text-[14px]"
            >
              {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <Segmented
              label="Art der Kommentare"
              value={type}
              onChange={handleTypeChange}
              options={[
                { value: 'all', label: 'Alle' },
                { value: 'dish', label: <><UtensilsCrossed size={13} /> Mensa</> },
                { value: 'reminder', label: <><Bell size={13} /> Erinnerungen</> },
              ]}
            />
          </>
        )}
      >
        {loading && comments.length === 0 ? (
          <div className="mt-7 flex flex-col gap-7">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-start gap-4">
                <div className="shimmer h-11 w-11 flex-shrink-0 rounded-full" />
                <div className="flex-1">
                  <div className="shimmer h-4 w-40 rounded-full" />
                  <div className="shimmer mt-4 h-14 w-full max-w-[520px] rounded-[18px]" />
                </div>
              </div>
            ))}
          </div>
        ) : comments.length === 0 ? (
          <Empty icon={MessageCircle}>{search ? 'Keine Kommentare gefunden.' : 'Noch keine Kommentare.'}</Empty>
        ) : (
          <div className="stack mt-2">
            {comments.map((c) => <CommentRow key={c.id} comment={c} onDeleted={handleDeleted} />)}
          </div>
        )}

        <Pager page={page} pages={totalPages} onChange={setPage} />
      </Section>
    </div>
  );
}
