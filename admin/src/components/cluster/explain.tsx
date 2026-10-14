import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Toggle } from '../kit';

// A small "i" next to a heading or setting: tapped or clicked, it explains in
// plain words what the thing is and what it does. Closes on a second tap, a
// tap elsewhere or Escape.
export function InfoTip({ children, label = 'Erklärung' }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement | null>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | TouchEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('touchstart', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <span ref={root} className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen((value) => !value); }}
        className="inline-flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-well hover:text-ink"
      >
        <Info size={15} strokeWidth={1.8} />
      </button>
      {open && (
        <span
          id={id}
          role="note"
          className="absolute left-1/2 top-[calc(100%+8px)] z-50 w-[min(320px,calc(100vw-32px))] -translate-x-1/2 rounded-[14px] bg-tip px-4 py-3 text-left text-[13px] font-normal leading-relaxed text-tip-ink shadow-lg"
        >
          {children}
        </span>
      )}
    </span>
  );
}

// A title followed by its "i".
export function Explained({ children, tip }: { children: ReactNode; tip: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{children}</span>
      <InfoTip>{tip}</InfoTip>
    </span>
  );
}

// A switch with its label written next to it (the kit's Toggle carries the
// label only for screen readers), an optional hint below and an "i".
export function ToggleField({ checked, onChange, label, hint, tip, disabled = false }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: ReactNode;
  tip?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <Toggle checked={checked} onChange={onChange} label={label} disabled={disabled} />
      <div className="min-w-0 pt-[3px]">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={`text-[14px] ${disabled ? 'text-ink-3' : 'cursor-pointer text-ink'}`}
            onClick={() => { if (!disabled) onChange(!checked); }}
          >
            {label}
          </span>
          {tip && <InfoTip label={`Erklärung: ${label}`}>{tip}</InfoTip>}
        </div>
        {hint && <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-3">{hint}</div>}
      </div>
    </div>
  );
}
