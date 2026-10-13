import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Search, X, type LucideIcon } from 'lucide-react';
import gsap from 'gsap';
import { prefersReducedMotion } from '../motion';

// The shared vocabulary of every page: a header, a strip of figures between
// two hairlines, titled sections, and rows that sit on the sheet itself.

export type Tone = 'sky' | 'mint' | 'amber' | 'rose' | 'violet' | 'ink';

export const TONES: Record<Tone, { wash: string; deep: string; dot: string }> = {
  sky:    { wash: 'var(--sky-wash)',    deep: 'var(--sky-deep)',    dot: '#6ba6e0' },
  mint:   { wash: 'var(--mint-wash)',   deep: 'var(--mint-deep)',   dot: 'var(--mint)' },
  amber:  { wash: 'var(--amber-wash)',  deep: 'var(--amber-deep)',  dot: 'var(--amber)' },
  rose:   { wash: 'var(--rose-wash)',   deep: 'var(--rose-deep)',   dot: 'var(--rose)' },
  violet: { wash: 'var(--violet-wash)', deep: 'var(--violet-deep)', dot: '#a98be0' },
  ink:    { wash: 'var(--well)',        deep: 'var(--ink-2)',       dot: 'var(--ink-4)' },
};

const AVATAR_ORDER: Tone[] = ['sky', 'amber', 'mint', 'rose', 'violet'];

export function toneFor(name: string): Tone {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_ORDER[Math.abs(hash) % AVATAR_ORDER.length]!;
}

// ─── Numbers ────────────────────────────────────────────────────────────────

// Counts glide to their value instead of snapping, on load and on each refresh.
export function Count({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion()) {
      shown.current = value;
      el.textContent = value.toLocaleString('de-AT');
      return;
    }
    const state = { v: shown.current };
    const tween = gsap.to(state, {
      v: value,
      duration: 1.3,
      ease: 'power3.out',
      onUpdate: () => {
        shown.current = state.v;
        el.textContent = Math.round(state.v).toLocaleString('de-AT');
      },
    });
    return () => { tween.kill(); };
  }, [value]);

  return <span ref={ref} className="tabular">0</span>;
}

type Trend = 'up' | 'down' | 'flat';

export function Delta({ trend = 'flat', tone = 'ink', children }: { trend?: Trend; tone?: Tone; children: ReactNode }) {
  return (
    <span className="flex items-center gap-[7px] text-[12.5px]" style={{ color: tone === 'ink' ? 'var(--ink-3)' : TONES[tone].deep }}>
      {trend !== 'flat' && (
        <svg width="9" height="7" viewBox="0 0 9 7" fill="currentColor" aria-hidden="true">
          {trend === 'up' ? <path d="M4.5 0 9 7H0z" /> : <path d="M4.5 7 0 0h9z" />}
        </svg>
      )}
      {children}
    </span>
  );
}

// ─── Page furniture ─────────────────────────────────────────────────────────

export function PageHeader({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        <h1 className="text-[30px] font-semibold leading-[1.15] tracking-[-0.02em] sm:text-[36px]">{title}</h1>
        {subtitle && <p className="mt-2 max-w-[62ch] text-[15px] text-ink-3">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-shrink-0 flex-wrap items-center gap-2.5">{children}</div>}
    </header>
  );
}

export interface Figure {
  label: string;
  value: number | string;
  icon: LucideIcon;
  note?: ReactNode;
  // Makes the whole figure a link to where it can be acted on.
  to?: string;
  state?: unknown;
}

// A row of figures between two hairlines; it reflows by its own width.
export function Figures({ items, className = '' }: { items: Figure[]; className?: string }) {
  return (
    <div className={className}>
      <div data-rule className="h-px bg-line" />
      <div className="strip py-[27px]">
        <div className="strip-grid" style={{ ['--n' as string]: items.length }}>
          {items.map(({ label, value, icon: Icon, note, to, state }) => {
            const body = (
              <>
                <span className="orb h-12 w-12"><Icon size={20} strokeWidth={1.6} /></span>
                <span className="min-w-0">
                  <span className="block truncate text-[14.5px]">{label}</span>
                  <span className="strip-figure">
                    <span className="text-[19px] font-semibold leading-[1.3]">
                      {typeof value === 'number' ? <Count value={value} /> : value}
                    </span>
                    {note}
                  </span>
                </span>
              </>
            );
            return to
              ? <Link key={label} to={to} state={state} data-cell className="strip-cell strip-link">{body}</Link>
              : <div key={label} data-cell className="strip-cell">{body}</div>;
          })}
        </div>
      </div>
      <div data-rule className="h-px bg-line" />
    </div>
  );
}

interface SectionProps {
  title: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Section({ title, meta, action, children, className = '' }: SectionProps) {
  return (
    <section className={className}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-center">
          <h2 className="sec-title whitespace-nowrap text-[20px] font-semibold">{title}</h2>
          {meta && <span className="ml-6 hidden whitespace-nowrap border-l border-line py-0.5 pl-6 text-[14px] sm:block">{meta}</span>}
        </div>
        {action && <div className="flex flex-wrap items-center gap-2.5">{action}</div>}
      </div>
      {children}
    </section>
  );
}

interface SegmentedProps<T extends string> {
  options: Array<{ value: T; label: ReactNode }>;
  value: T;
  onChange: (next: T) => void;
  label: string;
}

// A switch whose thumb travels to the chosen option.
export function Segmented<T extends string>({ options, value, onChange, label }: SegmentedProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const active = root.querySelector<HTMLElement>('[aria-pressed="true"]');
      setThumb(active ? { left: active.offsetLeft, width: active.offsetWidth } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [value, options.length]);

  return (
    <div ref={rootRef} className="seg" role="group" aria-label={label}>
      {thumb && <span className="seg-thumb" style={{ transform: `translateX(${thumb.left}px)`, width: thumb.width }} />}
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SearchField({ value, onChange, placeholder, className = '' }: { value: string; onChange: (next: string) => void; placeholder: string; className?: string }) {
  return (
    <label className={`relative block ${className}`}>
      <Search size={17} strokeWidth={1.6} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-3" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="field h-11 w-full pl-11 pr-4 text-[14.5px]"
      />
    </label>
  );
}

// ─── Small pieces ───────────────────────────────────────────────────────────

export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const tone = TONES[toneFor(name)];
  return (
    <span
      className="avatar flex flex-shrink-0 items-center justify-center rounded-full font-semibold"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.37), background: tone.wash, color: tone.deep }}
      aria-hidden="true"
    >
      {name[0]?.toUpperCase() ?? '?'}
    </span>
  );
}

export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-[10px] whitespace-nowrap text-[14px]">
      <i className="h-[7px] w-[7px] flex-shrink-0 rounded-full" style={{ background: TONES[tone].dot }} />
      {children}
    </span>
  );
}

export function Tag({ tone = 'ink', children, mono = false }: { tone?: Tone; children: ReactNode; mono?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-[3px] text-[12px] ${mono ? 'font-mono' : 'font-medium'}`}
      style={{ background: tone === 'ink' ? 'rgb(var(--ink-rgb) / calc(0.06 * var(--veil)))' : TONES[tone].wash, color: TONES[tone].deep }}
    >
      {children}
    </span>
  );
}

// The pokyh mark as a loading sign for whole areas (buttons keep the spinner).
export function MarkLoader({ size = 34 }: { size?: number }) {
  return (
    <svg className="mark-loader" width={size} height={size} viewBox="0 0 28 28" fill="currentColor" role="status" aria-label="Lädt">
      <rect x="2.2" y="4.6" width="13.4" height="6.8" rx="3.4" transform="rotate(-38 8.9 8)" />
      <circle cx="21" cy="7.2" r="3.4" />
      <circle cx="7" cy="20.8" r="3.4" />
      <rect x="12.4" y="16.6" width="13.4" height="6.8" rx="3.4" transform="rotate(-38 19.1 20)" />
    </svg>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      className="inline-block flex-shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
      style={{ width: size, height: size }}
      role="status"
      aria-label="Lädt"
    />
  );
}

interface IconButtonProps {
  icon: LucideIcon;
  label: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  tone?: Tone;
  // Shows the tone as a filled state (an option that is currently on).
  active?: boolean;
  busy?: boolean;
  disabled?: boolean;
  size?: number;
}

// A round icon action. The label is its tooltip and its accessible name.
export function IconButton({ icon: Icon, label, onClick, tone = 'ink', active = false, busy = false, disabled = false, size = 38 }: IconButtonProps) {
  return (
    <button
      type="button"
      className="orb icon-btn"
      data-tone={tone}
      data-active={active}
      style={{ width: size, height: size }}
      onClick={onClick}
      disabled={disabled || busy}
      aria-label={label}
      data-tip={label}
    >
      {busy ? <Spinner size={14} /> : <Icon size={Math.round(size * 0.44)} strokeWidth={1.7} />}
    </button>
  );
}

export function Empty({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <span className="orb h-14 w-14 text-ink-3"><Icon size={22} strokeWidth={1.5} /></span>
      <p className="max-w-[40ch] text-[14.5px] text-ink-3">{children}</p>
    </div>
  );
}

export function Pager({ page, pages, onChange }: { page: number; pages: number; onChange: (next: number) => void }) {
  if (pages <= 1) return null;
  return (
    <nav className="flex items-center justify-end gap-3 pt-6" aria-label="Seiten">
      <span className="tabular text-[13.5px] text-ink-3">Seite {page} von {pages}</span>
      <IconButton icon={ChevronLeft} label="Vorherige Seite" disabled={page <= 1} onClick={() => onChange(page - 1)} />
      <IconButton icon={ChevronRight} label="Nächste Seite" disabled={page >= pages} onClick={() => onChange(page + 1)} />
    </nav>
  );
}

// ─── Expanding content ──────────────────────────────────────────────────────

// Opens and closes its children by animating to their natural height. The
// children are mounted only while open or closing, so a collapsed row costs
// nothing and its data loads on first open.
export function Collapse({ open, children, className = '' }: { open: boolean; children: ReactNode; className?: string }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!open) {
      setSettled(false);
      setShown(false);
      return;
    }
    setMounted(true);
    // Two frames: the closed state has to be painted once before it can animate open.
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setShown(true)); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      className="collapse-grid"
      data-open={shown}
      data-settled={settled}
      onTransitionEnd={(e) => {
        if (e.target !== e.currentTarget || e.propertyName !== 'grid-template-rows') return;
        if (open) setSettled(true);
        else setMounted(false);
      }}
    >
      <div className={`collapse-inner ${className}`}>{children}</div>
    </div>
  );
}

// ─── Dialog ─────────────────────────────────────────────────────────────────

interface DialogProps {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}

// Rendered into <body>, so no ancestor transform can clip it. Escape and a
// click on the scrim close it.
export function Dialog({ title, subtitle, onClose, children, width = 460 }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>('input, select, textarea, button:not([data-close])')?.focus();
    return () => previous?.focus?.();
  }, []);

  return createPortal(
    <div
      className="animate-fadeIn fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto p-4 pt-[9vh]"
      style={{ background: 'var(--scrim)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="animate-scaleIn w-full rounded-[28px] bg-raise p-7 sm:p-8"
        style={{ maxWidth: width, boxShadow: '0 44px 70px -40px rgb(0 0 0 / 0.45)' }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-[20px] font-semibold">{title}</h2>
            {subtitle && <p className="mt-1 text-[14px] text-ink-3">{subtitle}</p>}
          </div>
          <button type="button" data-close className="orb h-9 w-9" onClick={onClose} aria-label="Schließen">
            <X size={16} strokeWidth={1.7} />
          </button>
        </div>
        <div className="mt-6">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Forms ──────────────────────────────────────────────────────────────────

// A settings block: what it is on the left, its controls on the right.
export function FormSection({ icon: Icon, title, hint, children }: { icon?: LucideIcon; title: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="form-section">
      <div>
        <div className="flex items-center gap-3.5">
          {Icon && <span className="orb h-11 w-11"><Icon size={18} strokeWidth={1.6} /></span>}
          <h2 className="text-[17px] font-semibold leading-snug">{title}</h2>
        </div>
        {hint && <p className="mt-3 max-w-[38ch] text-[13.5px] leading-relaxed text-ink-3">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export function FieldLabel({ label, hint, children, className = '' }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`flex min-w-0 flex-col gap-2 ${className}`}>
      <span className="text-[13px] text-ink-2">{label}</span>
      {children}
      {hint && <span className="text-[12.5px] text-ink-3">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="toggle"
    >
      <span />
    </button>
  );
}

export function Notice({ tone, icon: Icon, children }: { tone: Tone; icon?: LucideIcon; children: ReactNode }) {
  return (
    <div
      className="flex items-start gap-3 rounded-[16px] px-[18px] py-3.5 text-[13.5px] leading-relaxed"
      style={{ background: TONES[tone].wash, color: TONES[tone].deep }}
      role={tone === 'rose' ? 'alert' : 'status'}
    >
      {Icon && <Icon size={16} strokeWidth={1.7} className="mt-[3px] flex-shrink-0" />}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// ─── Images behind the admin API ────────────────────────────────────────────

// An <img> cannot send an Authorization header, and putting the token in the
// URL would leave it in access logs and browser history. So the image is
// fetched with the header and shown from an object URL.
export function AuthedImage({ src, token, alt, className, fallback }: { src: string; token: string | null; alt: string; className?: string; fallback: ReactNode }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    setUrl(null);
    fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then((blob) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => { /* the fallback stays */ });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, token]);

  return url ? <img src={url} alt={alt} className={className} /> : <>{fallback}</>;
}
