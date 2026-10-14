import { ReactNode, useLayoutEffect, useRef, useState } from 'react';

// Small diagrams that share the dashboard chart's manners: soft sky and amber,
// no gridlines, and the inverted tooltip card for the value under the pointer.

function compact(value: number): string {
  if (value >= 1000) return `${(value / 1000).toLocaleString('de-AT', { maximumFractionDigits: 1 })}k`;
  return value.toLocaleString('de-AT');
}

interface BarsProps {
  values: number[];
  // Short axis label and tooltip heading per bar.
  labels: string[];
  titles?: string[];
  unit: string;
  height?: number;
  color?: string;
  tickEvery?: number;
  format?: (value: number) => string;
  ariaLabel: string;
  // Makes the bars clickable, e.g. to list who is behind one.
  onSelect?: (index: number) => void;
}

// Least distance between two axis labels, centre to centre.
const MIN_LABEL_GAP = 64;

// The width an axis label's pill takes (see .chart-x), estimated from its text.
export function axisLabelWidth(text: string): number {
  return Math.max(30, Math.round(text.length * 7.2) + 14);
}

// Whether two labels `apart` pixels apart, centre to centre, clear each other.
export function labelsClear(a: string, b: string, apart: number): boolean {
  return Math.abs(apart) >= (axisLabelWidth(a) + axisLabelWidth(b)) / 2 + 4;
}

// Whether the hovered point's own label fits between the regular ones without
// touching any. The regular labels never move aside for it: if it does not
// fit, the tooltip alone names the point.
export function activeLabelFits(active: number, ticks: number[], labels: string[], positionOf: (i: number) => number): boolean {
  if (ticks.includes(active)) return false;
  return ticks.every((i) => labelsClear(labels[i] ?? '', labels[active] ?? '', positionOf(i) - positionOf(active)));
}

// Vertical bars that grow from the baseline; the latest one is in full colour.
export function Bars({ values, labels, titles, unit, height = 132, color = '#4f96dc', tickEvery = 1, format, ariaLabel, onSelect }: BarsProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const peak = Math.max(1, ...values);
  const active = hovered ?? values.length - 1;
  const show = format ?? ((v: number) => v.toLocaleString('de-AT'));

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(Math.round(entry.contentRect.width)); });
    observer.observe(el);
    return () => observer.disconnect();
  }, [values.length === 0]);

  if (values.length === 0) return <p className="py-6 text-[14px] text-ink-3">Noch keine Daten.</p>;

  // On a narrow screen only every so many bars keeps its label, so the
  // labels never run into each other.
  const slotPx = width > 0 ? width / values.length : MIN_LABEL_GAP;
  const every = tickEvery * Math.max(1, Math.ceil(MIN_LABEL_GAP / Math.max(slotPx * tickEvery, 1)));
  // The regular labels never change while hovering. A hovered bar that has one
  // highlights it; any other bar gets its own label only where it fits.
  const lastIndex = values.length - 1;
  const lastTick = lastIndex - (lastIndex % every);
  // The latest bar keeps a label of its own whenever it clears the one before.
  const showLast = lastIndex !== lastTick && labelsClear(labels[lastIndex] ?? '', labels[lastTick] ?? '', (lastIndex - lastTick) * slotPx);
  const labelShown = (i: number) => i % every === 0 || (i === lastIndex && showLast);
  const ticks = labels.map((_, i) => i).filter(labelShown);
  const extraLabel = activeLabelFits(active, ticks, labels, (i) => (i + 0.5) * slotPx);

  return (
    <div ref={rootRef} className="bars" role="img" aria-label={ariaLabel} data-selectable={Boolean(onSelect)} onPointerLeave={() => setHovered(null)}>
      <div className="bars-plot" style={{ height }}>
        {values.map((value, i) => (
          <div
            key={i}
            className="bars-slot"
            onPointerEnter={() => setHovered(i)}
            onPointerDown={() => setHovered(i)}
            onClick={onSelect ? () => onSelect(i) : undefined}
          >
            {i === active && (
              <div className="bars-tip chart-tip" aria-hidden="true">
                <div className="whitespace-nowrap text-[12.5px] text-tip-dim">{titles?.[i] ?? labels[i]}</div>
                <div className="tabular mt-1 whitespace-nowrap text-[14px] font-medium">{show(value)} {unit}</div>
              </div>
            )}
            <div
              className="bars-bar"
              style={{
                height: `${Math.max((value / peak) * 100, value > 0 ? 3 : 1.5)}%`,
                background: color,
                opacity: i === active ? 1 : 0.32,
                animationDelay: `${i * 28}ms`,
              }}
            />
          </div>
        ))}
      </div>
      <div className="bars-axis" aria-hidden="true">
        {labels.map((label, i) => (
          <span key={i} className="bars-slot">
            {(labelShown(i) || (i === active && extraLabel)) && (
              <span
                className="chart-x"
                data-on={i === active}
                style={{ animation: labelShown(i) ? undefined : 'fade 0.18s ease backwards' }}
              >
                {label}
              </span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

export interface Part {
  label: string;
  value: number;
  color: string;
}

// One bar divided by share, with its legend underneath.
export function SplitBar({ parts, unit = '', ariaLabel }: { parts: Part[]; unit?: string; ariaLabel: string }) {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  // Pointing at a segment or its legend entry steps the others back.
  const [focus, setFocus] = useState<string | null>(null);
  return (
    <div role="img" aria-label={ariaLabel} onPointerLeave={() => setFocus(null)}>
      <div className="split">
        {total === 0
          ? <span className="split-part" style={{ flexGrow: 1, background: 'var(--well-2)' }} />
          : parts.filter((p) => p.value > 0).map((p, i) => (
            <span
              key={p.label}
              className="split-part"
              data-dim={focus !== null && focus !== p.label}
              onPointerEnter={() => setFocus(p.label)}
              style={{ flexGrow: p.value, background: p.color, animationDelay: `${i * 90}ms` }}
              title={`${p.label}: ${p.value.toLocaleString('de-AT')}`}
            />
          ))}
      </div>
      <dl className="mt-5 flex flex-wrap gap-x-9 gap-y-4">
        {parts.map((p) => (
          <div key={p.label} className="legend-item min-w-0" data-dim={focus !== null && focus !== p.label} onPointerEnter={() => setFocus(p.label)}>
            <dt className="flex items-center gap-[10px] text-[13.5px] text-ink-3">
              <i className="h-[7px] w-[7px] flex-shrink-0 rounded-full" style={{ background: p.color }} />
              {p.label}
            </dt>
            <dd className="mt-1 flex items-baseline gap-2.5 pl-[17px]">
              <span className="tabular text-[17px] font-semibold">{p.value.toLocaleString('de-AT')}{unit}</span>
              <span className="tabular text-[12.5px] text-ink-3">
                {total > 0 ? `${((p.value / total) * 100).toLocaleString('de-AT', { maximumFractionDigits: 1 })} %` : '–'}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

interface RingProps {
  // Share of the ring that is filled, 0 to 1.
  share: number;
  color?: string;
  size?: number;
  children: ReactNode;
  ariaLabel: string;
}

export function Ring({ share, color = '#4f96dc', size = 132, children, ariaLabel }: RingProps) {
  const stroke = 10;
  const radius = (size - stroke) / 2;
  const length = 2 * Math.PI * radius;
  const filled = Math.min(1, Math.max(0, share)) * length;
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }} role="img" aria-label={ariaLabel}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--well-2)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${length}`}
          style={{ transition: 'stroke-dasharray 1.2s var(--glide)' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  );
}

export interface Rank {
  label: string;
  value: number;
  note?: string;
}

// A ranked list where each row carries its own bar.
// With `onSelect` every row is a button, e.g. to list who is behind it.
export function RankBars({ items, color = '#4f96dc', unit = '', empty = 'Noch keine Daten.', onSelect }: { items: Rank[]; color?: string; unit?: string; empty?: string; onSelect?: (item: Rank) => void }) {
  const peak = Math.max(1, ...items.map((item) => item.value));
  const [focus, setFocus] = useState<string | null>(null);
  if (items.length === 0) return <p className="py-6 text-[14px] text-ink-3">{empty}</p>;
  return (
    <ul className="flex flex-col gap-[18px]" onPointerLeave={() => setFocus(null)}>
      {items.map((item, i) => {
        const body = (
          <>
            <div className="flex items-baseline justify-between gap-4">
              <span className="rank-label min-w-0 truncate text-[14.5px]" title={item.label}>{item.label}</span>
              <span className="tabular flex-shrink-0 text-[14px] font-medium">
                {compact(item.value)}{unit}
                {item.note && <span className="ml-2 font-normal text-ink-3">{item.note}</span>}
              </span>
            </div>
            <div className="rank-track mt-2">
              <span className="rank-fill" style={{ width: `${Math.max((item.value / peak) * 100, 2)}%`, background: color, animationDelay: `${i * 70}ms` }} />
            </div>
          </>
        );
        return (
          <li key={item.label} className="rank-row" data-dim={focus !== null && focus !== item.label} onPointerEnter={() => setFocus(item.label)}>
            {onSelect
              ? <button type="button" className="rank-link block w-full text-left" onClick={() => onSelect(item)}>{body}</button>
              : body}
          </li>
        );
      })}
    </ul>
  );
}

// A trend without axes, for the corner of a figure.
export function Spark({ values, color = '#4f96dc', width = 92, height = 30 }: { values: number[]; color?: string; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const peak = Math.max(1, ...values);
  const step = width / (values.length - 1);
  const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - 2 - (v / peak) * (height - 4)).toFixed(1)}`).join('');
  return (
    <svg width={width} height={height} aria-hidden="true" className="flex-shrink-0">
      <path d={d} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
