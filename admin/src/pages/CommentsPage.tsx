import { useState, useEffect, useCallback } from 'react';
import { useHanded } from '../useHanded';
import { MessageCircle, Trash2, RefreshCw, Bell, UtensilsCrossed, ChevronDown, Star, ImageOff, Clock } from 'lucide-react';
import { adminApi, setMenuContext } from '../api';
import { useAccess } from '../access';
import type { AdminComment, DishCommentGroup, DishCommentItem, MensaMenu, ReminderCommentGroup, ReminderCommentItem } from '../types';
import { useToast } from '../components/Toast';
import { useLive } from '../live';
import { Avatar, Collapse, Empty, Figures, IconButton, PageHeader, Pager, SearchField, Section, Segmented, Spinner, Tag } from '../components/kit';
import { dateTime, num, relative } from '../components/format';

// Comments, grouped by what they are about: each dish (by its stable key,
// the id comments and votes reference — never by matching display names)
// with its comment count and rating, opened to read and moderate; each
// reminder likewise; and the newest comments in one stream. A school's view
// holds its own accounts' comments only.

type Tab = 'dishes' | 'reminders' | 'latest';
type DishSort = 'latest' | 'comments' | 'rating' | 'name';

// What the search hands over: the tab, a dish to open, a filter.
interface Handed { tab?: Tab; dishKey?: string | null; menuId?: string | null; search?: string }

function Stars({ value }: { value: number | null }) {
  if (value === null) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[12.5px] text-ink-2" aria-label={`${value} von 5 Sternen`}>
      <Star size={12} strokeWidth={2} fill="currentColor" style={{ color: 'var(--amber)' }} /> {num(value, 1)}
    </span>
  );
}

// One comment with its moderation.
function CommentItem({ author, body, at, stars, edited, onDelete }: {
  author: string;
  body: string;
  at: string;
  stars?: number | null;
  edited?: boolean;
  onDelete?: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <article className="flex items-start gap-3.5 py-4">
      <Avatar name={author} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-[14.5px] font-medium">{author}</span>
          {stars !== undefined && stars !== null && <Stars value={stars} />}
          <time className="text-[12.5px] text-ink-3" dateTime={at} title={dateTime(at)}>{relative(at)}{edited ? ' · bearbeitet' : ''}</time>
        </div>
        <p className="comment-bubble">{body}</p>
      </div>
      {onDelete && (
        <div className="flex flex-shrink-0 items-center gap-2">
          {confirm ? (
            <>
              <button type="button" disabled={busy} className="btn btn-sm btn-danger" onClick={() => { setBusy(true); void onDelete().finally(() => { setBusy(false); setConfirm(false); }); }}>
                {busy ? 'Lösche…' : 'Löschen?'}
              </button>
              <button type="button" disabled={busy} className="btn btn-sm btn-quiet" onClick={() => setConfirm(false)}>Nein</button>
            </>
          ) : (
            <IconButton icon={Trash2} tone="rose" label="Kommentar löschen" onClick={() => setConfirm(true)} />
          )}
        </div>
      )}
    </article>
  );
}

export function CommentsPage() {
  const { view, can } = useAccess();
  const { showToast } = useToast();
  const handed = useHanded<Handed>();
  const [tab, setTab] = useState<Tab>(handed.tab === 'reminders' || handed.tab === 'latest' ? handed.tab : 'dishes');
  const [menus, setMenus] = useState<MensaMenu[]>([]);
  const [menuId, setMenuId] = useState<string>('');
  const [figures, setFigures] = useState<{ dish: number; dishes: number; reminder: number } | null>(null);
  const moderate = can('comments.moderate');
  const isGlobal = view?.kind === 'global';

  // The global view picks the menu whose dish comments it shows.
  useEffect(() => {
    if (!isGlobal) return;
    adminApi.menus().then(({ menus: list }) => {
      setMenus(list);
      const preferred = list.find((m) => m.id === handed.menuId) ?? list.find((m) => m.isDefault) ?? list[0];
      if (preferred) { setMenuContext(preferred.id); setMenuId(preferred.id); }
    }).catch(() => undefined);
    return () => setMenuContext(null);
  }, [isGlobal]);

  const loadFigures = useCallback(() => {
    Promise.all([
      adminApi.dishCommentGroups({ limit: 1 }),
      adminApi.comments({ limit: 1, type: 'reminder' }),
    ]).then(([dishes, reminders]) => setFigures({ dish: dishes.totalComments ?? 0, dishes: dishes.total, reminder: reminders.total }))
      .catch(() => undefined);
  }, []);
  useEffect(() => { if (!isGlobal || menuId) loadFigures(); }, [loadFigures, isGlobal, menuId]);
  useLive(['comments', 'ratings'], loadFigures, 3000);

  const ready = !isGlobal || menuId !== '';

  return (
    <div>
      <PageHeader title="Kommentare" subtitle={view?.kind === 'school' ? `Was die Konten von ${view.school.name} zu Gerichten und Erinnerungen schreiben.` : 'Was zu Gerichten und Erinnerungen geschrieben wird — nach Gericht geordnet, zum Lesen und Moderieren.'}>
        {isGlobal && menus.length > 1 && (
          <select className="field h-11 px-4 text-[14px]" value={menuId} onChange={(e) => { setMenuContext(e.target.value); setMenuId(e.target.value); }} aria-label="Mensaplan">
            {menus.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
      </PageHeader>

      <Figures
        className="mt-10"
        items={[
          { label: 'Mensa-Kommentare', value: figures?.dish ?? '–', icon: MessageCircle },
          { label: 'Gerichte mit Kommentaren', value: figures?.dishes ?? '–', icon: UtensilsCrossed },
          { label: 'Zu Erinnerungen', value: figures?.reminder ?? '–', icon: Bell },
        ]}
      />

      <div className="mt-[46px]">
        <Segmented
          label="Ansicht"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'dishes', label: <><UtensilsCrossed size={13} /> Nach Gericht</> },
            { value: 'reminders', label: <><Bell size={13} /> Nach Erinnerung</> },
            { value: 'latest', label: <><Clock size={13} /> Neueste</> },
          ]}
        />
      </div>

      {!ready ? <div className="mt-8"><Spinner /></div> : tab === 'dishes'
        ? <DishGroups key={menuId} moderate={moderate} onError={(m) => showToast(m, 'error')} onChanged={loadFigures} initialSearch={handed.tab === 'dishes' ? handed.search : undefined} initialOpen={handed.dishKey ?? undefined} />
        : tab === 'reminders'
          ? <ReminderGroups moderate={moderate} onError={(m) => showToast(m, 'error')} onChanged={loadFigures} initialSearch={handed.tab === 'reminders' ? handed.search : undefined} />
          : <LatestComments key={menuId} moderate={moderate} onError={(m) => showToast(m, 'error')} onChanged={loadFigures} />}
    </div>
  );
}

interface ListProps {
  moderate: boolean;
  onError: (message: string) => void;
  onChanged: () => void;
  initialSearch?: string;
  initialOpen?: string;
}

function DishGroups({ moderate, onError, onChanged, initialSearch, initialOpen }: ListProps) {
  const [groups, setGroups] = useState<DishCommentGroup[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<DishSort>('latest');
  const [search, setSearch] = useState(initialSearch ?? '');
  const [debounced, setDebounced] = useState(initialSearch?.trim() ?? '');
  const [open, setOpen] = useState<string | null>(initialOpen ?? null);
  const limit = 20;

  useEffect(() => {
    const t = window.setTimeout(() => { setDebounced(search.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    try {
      const res = await adminApi.dishCommentGroups({ page, limit, sort, search: debounced || undefined });
      setGroups(res.dishes);
      setTotal(res.total);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Kommentare konnten nicht geladen werden');
    }
  }, [page, sort, debounced, onError]);

  useEffect(() => { void load(); }, [load]);
  useLive(['comments', 'ratings'], () => { void load(); }, 3000);

  return (
    <Section
      className="mt-8"
      title="Gerichte"
      meta={`${num(total)} mit Kommentaren`}
      action={(
        <>
          <SearchField value={search} onChange={setSearch} placeholder="Gericht, Text oder Konto" className="w-full sm:w-[240px]" />
          <select className="field h-11 px-4 text-[14px]" value={sort} onChange={(e) => { setSort(e.target.value as DishSort); setPage(1); }} aria-label="Sortierung">
            <option value="latest">Neueste Kommentare</option>
            <option value="comments">Meiste Kommentare</option>
            <option value="rating">Beste Bewertung</option>
            <option value="name">Name A–Z</option>
          </select>
        </>
      )}
    >
      {!groups ? (
        <div className="mt-8"><Spinner /></div>
      ) : groups.length === 0 ? (
        <Empty icon={UtensilsCrossed}>{debounced ? 'Nichts gefunden.' : 'Noch keine Kommentare zu Gerichten.'}</Empty>
      ) : (
        <ul className="mt-4 flex flex-col">
          {groups.map((g) => (
            <li key={g.dishId} className="border-t border-line first:border-t-0">
              <button type="button" className="group-row" aria-expanded={open === g.dishId} onClick={() => setOpen(open === g.dishId ? null : g.dishId)}>
                {g.imageUrl ? (
                  <img src={g.imageUrl} alt="" className="h-12 w-12 flex-shrink-0 rounded-[14px] object-cover" loading="lazy" />
                ) : (
                  <span className="orb h-12 w-12">{g.deleted ? <ImageOff size={18} strokeWidth={1.6} /> : <UtensilsCrossed size={18} strokeWidth={1.6} />}</span>
                )}
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[15px] font-medium">
                    {g.name ?? 'Gericht nicht mehr im Plan'}
                    {g.deleted && <span className="ml-2 align-middle"><Tag>gelöscht</Tag></span>}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
                    <span>{num(g.comments)} {g.comments === 1 ? 'Kommentar' : 'Kommentare'}</span>
                    {g.avgStars !== null && <span className="flex items-center gap-1"><Stars value={g.avgStars} /> ({num(g.ratingCount)})</span>}
                    <span>zuletzt {relative(g.latestAt)}</span>
                    {g.deleted && <span className="font-mono">{g.dishId}</span>}
                  </span>
                </span>
                <ChevronDown size={18} strokeWidth={1.7} className="group-chevron" data-open={open === g.dishId} />
              </button>
              <Collapse open={open === g.dishId}>
                {open === g.dishId && <DishThread dishId={g.dishId} moderate={moderate} onError={onError} onChanged={() => { void load(); onChanged(); }} />}
              </Collapse>
            </li>
          ))}
        </ul>
      )}
      <Pager page={page} pages={Math.ceil(total / limit)} onChange={setPage} />
    </Section>
  );
}

function DishThread({ dishId, moderate, onError, onChanged }: { dishId: string } & ListProps) {
  const [items, setItems] = useState<DishCommentItem[] | null>(null);
  const [sort, setSort] = useState<'newest' | 'oldest' | 'rating-low' | 'rating-high'>('newest');

  const load = useCallback(async () => {
    try {
      setItems((await adminApi.dishComments(dishId, sort)).comments);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Kommentare konnten nicht geladen werden');
    }
  }, [dishId, sort, onError]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="thread">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-1">
        <span className="text-[12.5px] text-ink-3">Sterne: wie der Autor das Gericht bewertet hat</span>
        <select className="field h-9 px-3 text-[13px]" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Kommentare sortieren">
          <option value="newest">Neueste zuerst</option>
          <option value="oldest">Älteste zuerst</option>
          <option value="rating-low">Schlechteste Bewertung</option>
          <option value="rating-high">Beste Bewertung</option>
        </select>
      </div>
      {!items ? <Spinner /> : items.map((c) => (
        <CommentItem
          key={c.id}
          author={c.username}
          body={c.body}
          at={c.createdAt}
          stars={c.stars}
          edited={c.edited}
          onDelete={moderate ? async () => {
            try {
              await adminApi.deleteDishComment(c.id);
              setItems((prev) => prev?.filter((x) => x.id !== c.id) ?? null);
              onChanged();
            } catch (err) {
              onError(err instanceof Error ? err.message : 'Löschen fehlgeschlagen');
            }
          } : undefined}
        />
      ))}
    </div>
  );
}

function ReminderGroups({ moderate, onError, onChanged, initialSearch }: ListProps) {
  const [groups, setGroups] = useState<ReminderCommentGroup[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState(initialSearch ?? '');
  const [debounced, setDebounced] = useState(initialSearch?.trim() ?? '');
  const [open, setOpen] = useState<string | null>(null);
  const limit = 20;

  useEffect(() => {
    const t = window.setTimeout(() => { setDebounced(search.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    try {
      const res = await adminApi.reminderCommentGroups({ page, limit, search: debounced || undefined });
      setGroups(res.reminders);
      setTotal(res.total);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Kommentare konnten nicht geladen werden');
    }
  }, [page, debounced, onError]);

  useEffect(() => { void load(); }, [load]);
  useLive(['comments'], () => { void load(); }, 3000);

  return (
    <Section className="mt-8" title="Erinnerungen" meta={`${num(total)} mit Kommentaren`} action={<SearchField value={search} onChange={setSearch} placeholder="Erinnerung, Text oder Konto" className="w-full sm:w-[240px]" />}>
      {!groups ? (
        <div className="mt-8"><Spinner /></div>
      ) : groups.length === 0 ? (
        <Empty icon={Bell}>{debounced ? 'Nichts gefunden.' : 'Noch keine Kommentare zu Erinnerungen.'}</Empty>
      ) : (
        <ul className="mt-4 flex flex-col">
          {groups.map((g) => (
            <li key={g.reminderId} className="border-t border-line first:border-t-0">
              <button type="button" className="group-row" aria-expanded={open === g.reminderId} onClick={() => setOpen(open === g.reminderId ? null : g.reminderId)}>
                <span className="orb h-12 w-12"><Bell size={18} strokeWidth={1.6} /></span>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[15px] font-medium">{g.title ?? 'Erinnerung gelöscht'}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-3 text-[12.5px] text-ink-3">
                    {g.className && <span>{g.className}</span>}
                    <span>{num(g.comments)} {g.comments === 1 ? 'Kommentar' : 'Kommentare'}</span>
                    <span>zuletzt {relative(g.latestAt)}</span>
                  </span>
                </span>
                <ChevronDown size={18} strokeWidth={1.7} className="group-chevron" data-open={open === g.reminderId} />
              </button>
              <Collapse open={open === g.reminderId}>
                {open === g.reminderId && <ReminderThread reminderId={g.reminderId} moderate={moderate} onError={onError} onChanged={() => { void load(); onChanged(); }} />}
              </Collapse>
            </li>
          ))}
        </ul>
      )}
      <Pager page={page} pages={Math.ceil(total / limit)} onChange={setPage} />
    </Section>
  );
}

function ReminderThread({ reminderId, moderate, onError, onChanged }: { reminderId: string } & ListProps) {
  const [items, setItems] = useState<ReminderCommentItem[] | null>(null);
  useEffect(() => {
    adminApi.reminderComments(reminderId)
      .then((res) => setItems(res.comments))
      .catch((err) => onError(err instanceof Error ? err.message : 'Kommentare konnten nicht geladen werden'));
  }, [reminderId, onError]);
  return (
    <div className="thread">
      {!items ? <Spinner /> : items.map((c) => (
        <CommentItem
          key={c.id}
          author={c.username}
          body={c.body}
          at={c.createdAt}
          onDelete={moderate ? async () => {
            try {
              await adminApi.deleteReminderComment(c.id);
              setItems((prev) => prev?.filter((x) => x.id !== c.id) ?? null);
              onChanged();
            } catch (err) {
              onError(err instanceof Error ? err.message : 'Löschen fehlgeschlagen');
            }
          } : undefined}
        />
      ))}
    </div>
  );
}

// The newest comments of both kinds in one stream, for daily moderation.
function LatestComments({ moderate, onError, onChanged }: ListProps) {
  const [comments, setComments] = useState<AdminComment[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const limit = 25;

  useEffect(() => {
    const t = window.setTimeout(() => { setDebounced(search.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    try {
      const res = await adminApi.comments({ page, limit, type: 'all', search: debounced || undefined, sortBy: 'createdAt', sortOrder: 'desc' });
      setComments(res.comments);
      setTotal(res.total);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Kommentare konnten nicht geladen werden');
    }
  }, [page, debounced, onError]);

  useEffect(() => { void load(); }, [load]);
  useLive(['comments'], () => { void load(); }, 3000);

  return (
    <Section
      className="mt-8"
      title="Neueste"
      meta={`${num(total)} gesamt`}
      action={(
        <>
          <SearchField value={search} onChange={setSearch} placeholder="Konto oder Text" className="w-full sm:w-[240px]" />
          <IconButton icon={RefreshCw} label="Aktualisieren" onClick={() => void load()} />
        </>
      )}
    >
      {!comments ? <div className="mt-8"><Spinner /></div> : comments.length === 0 ? (
        <Empty icon={MessageCircle}>Keine Kommentare.</Empty>
      ) : (
        <div className="mt-2">
          {comments.map((c) => (
            <div key={c.id} className="border-t border-line first:border-t-0">
              <div className="flex items-center gap-2 pt-4 text-[12.5px] text-ink-3">
                <Tag tone={c.type === 'reminder' ? 'amber' : 'mint'}>{c.type === 'reminder' ? <><Bell size={11} /> Erinnerung</> : <><UtensilsCrossed size={11} /> Mensa</>}</Tag>
                <span className="min-w-0 truncate">{c.contextTitle}</span>
              </div>
              <CommentItem
                author={c.username}
                body={c.body}
                at={c.createdAt}
                onDelete={moderate ? async () => {
                  try {
                    if (c.type === 'reminder') await adminApi.deleteReminderComment(c.id);
                    else await adminApi.deleteDishComment(c.id);
                    setComments((prev) => prev?.filter((x) => x.id !== c.id) ?? null);
                    setTotal((t) => t - 1);
                    onChanged();
                  } catch (err) {
                    onError(err instanceof Error ? err.message : 'Löschen fehlgeschlagen');
                  }
                } : undefined}
              />
            </div>
          ))}
        </div>
      )}
      <Pager page={page} pages={Math.ceil(total / limit)} onChange={setPage} />
    </Section>
  );
}
