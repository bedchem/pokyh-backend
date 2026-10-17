import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import gsap from 'gsap';
import { present, prefersReducedMotion } from '../motion';
import { activeLabelFits, labelsClear } from './charts';
import { useChartPointer, type PageDirection } from './chartPointer';

export interface TrendSeries {
  key: string;
  label: string;
  color: string;
  // Fill the space under the line with a wash that fades to paper.
  area?: boolean;
  values: number[];
}

interface TrendChartProps {
  // One short axis label and one tooltip heading per point.
  labels: string[];
  titles: string[];
  series: TrendSeries[];
  tickEvery?: number;
  // The point the tooltip rests on while nothing is hovered.
  restIndex?: number;
  // Changing this replays the draw-in (a new range, not a data refresh).
  drawKey: string;
  ariaLabel: string;
  // Makes a point clickable (pointer or Enter), e.g. to list who is behind it.
  onSelect?: (index: number) => void;
  // Paging to the previous (-1) or next (1) period: drag past an edge,
  // Page Up/Down. Absent: the chart shows one fixed period.
  onPage?: (direction: PageDirection) => void;
  // Whether there is a later period to page to.
  canPageForward?: boolean;
  canPageBack?: boolean;
}

const GUTTER = 46;
const PAD_RIGHT = 10;
const PAD_TOP = 14;
const PLOT_HEIGHT = 178;
const TIP_WIDTH = 164;
// Least distance between two axis labels, centre to centre.
const MIN_LABEL_GAP = 76;

function niceStep(raw: number): number {
  if (raw <= 1) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 && pow >= 10 ? 2.5 : n <= 5 ? 5 : 10;
  return mult * pow;
}

function compact(value: number): string {
  if (value >= 1000) return `${(value / 1000).toLocaleString('de-AT', { maximumFractionDigits: 1 })}k`;
  return value.toLocaleString('de-AT');
}

// Monotone cubic interpolation (Fritsch–Carlson): smooth like the reference's
// curves, but it never overshoots below zero between two points.
function monotonePath(points: Array<[number, number]>): string {
  const n = points.length;
  if (n === 0) return '';
  if (n === 1) return `M${points[0]![0]},${points[0]![1]}`;

  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1]![0] - points[i]![0]);
    slope.push((points[i + 1]![1] - points[i]![1]) / dx[i]!);
  }
  const tangent: number[] = [slope[0]!];
  for (let i = 1; i < n - 1; i++) {
    const a = slope[i - 1]!;
    const b = slope[i]!;
    if (a * b <= 0) tangent.push(0);
    else {
      const w1 = 2 * dx[i]! + dx[i - 1]!;
      const w2 = dx[i]! + 2 * dx[i - 1]!;
      tangent.push((w1 + w2) / (w1 / a + w2 / b));
    }
  }
  tangent.push(slope[n - 2]!);

  let d = `M${points[0]![0].toFixed(2)},${points[0]![1].toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    const h = dx[i]! / 3;
    d += `C${(x0 + h).toFixed(2)},${(y0 + tangent[i]! * h).toFixed(2)} ${(x1 - h).toFixed(2)},${(y1 - tangent[i + 1]! * h).toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}`;
  }
  return d;
}

export function TrendChart({ labels, titles, series, tickEvery = 1, restIndex, drawKey, ariaLabel, onSelect, onPage, canPageForward = true, canPageBack = true }: TrendChartProps) {
  const gradientId = useId().replace(/:/g, '');
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const count = labels.length;
  const plotWidth = Math.max(0, width - GUTTER - PAD_RIGHT);
  const baseline = PAD_TOP + PLOT_HEIGHT;

  const geometry = useMemo(() => {
    const peak = Math.max(0, ...series.flatMap((s) => s.values));
    const top = niceStep(peak / 4) * 4;
    const xAt = (i: number) => GUTTER + (count <= 1 ? plotWidth / 2 : (plotWidth * i) / (count - 1));
    const yAt = (v: number) => baseline - (v / top) * PLOT_HEIGHT;
    const ticks = [4, 3, 2, 1, 0].map((k) => (top / 4) * k);
    const paths = series.map((s) => {
      const line = monotonePath(s.values.map((v, i) => [xAt(i), yAt(v)]));
      const area = s.area && count > 1
        ? `${line}L${xAt(count - 1).toFixed(2)},${baseline}L${xAt(0).toFixed(2)},${baseline}Z`
        : null;
      return { key: s.key, color: s.color, line, area };
    });
    return { xAt, yAt, ticks, paths };
  }, [series, count, plotWidth, baseline]);

  const ready = width > 0 && count > 0;

  function indexFromPointer(clientX: number): number {
    const rect = rootRef.current!.getBoundingClientRect();
    if (count <= 1) return 0;
    const ratio = (clientX - rect.left - GUTTER) / plotWidth;
    return Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));
  }

  const pager = onPage
    ? (direction: PageDirection) => { if (direction === 1 ? canPageForward : canPageBack) onPage(direction); }
    : undefined;
  const pointer = useChartPointer({
    count,
    indexAt: indexFromPointer,
    bounds: () => {
      const rect = rootRef.current?.getBoundingClientRect();
      return rect ? { left: rect.left + GUTTER, right: rect.left + GUTTER + plotWidth } : null;
    },
    onSelect,
    onPage: pager,
    rest: restIndex,
  });
  const active = pointer.active;
  const { setSelected } = pointer;
  // A new period starts without a chosen point.
  useEffect(() => { setSelected(null); }, [drawKey, setSelected]);

  // Draw the lines in from the left whenever the range changes.
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!ready || !svg || prefersReducedMotion()) return;
    // Only what this chart shows: lines without an area, no tooltip yet.
    const lines = present(svg, '[data-line]');
    const areas = present(svg, '[data-area]');
    const probes = present(svg, '[data-probe]');
    const tip = tipRef.current;
    const ctx = gsap.context(() => {
      if (lines.length > 0) {
        gsap.fromTo(lines,
          { strokeDasharray: 1, strokeDashoffset: 1 },
          { strokeDashoffset: 0, duration: 1.05, ease: 'power2.inOut', stagger: 0.1, clearProps: 'strokeDasharray,strokeDashoffset' });
      }
      if (areas.length > 0) gsap.fromTo(areas, { opacity: 0 }, { opacity: 1, duration: 0.8, delay: 0.35, ease: 'power1.out' });
      if (probes.length > 0) gsap.fromTo(probes, { opacity: 0 }, { opacity: 1, duration: 0.4, delay: 0.75, ease: 'power1.out' });
      if (tip) {
        gsap.fromTo(tip,
          { opacity: 0, scale: 0.97 },
          { opacity: 1, scale: 1, duration: 0.4, delay: 0.75, ease: 'power2.out', transformOrigin: '0% 50%', clearProps: 'transform' });
      }
    }, rootRef);
    return () => ctx.revert();
    // The draw-in belongs to the range, not to each refresh of its numbers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawKey, ready]);

  if (count === 0) {
    return (
      <div ref={rootRef} className="flex items-center text-[14px] text-ink-3" style={{ height: baseline + 40 }}>
        Noch keine Daten.
      </div>
    );
  }

  const activeX = ready ? geometry.xAt(active) : 0;
  const activeYs = series.map((s) => geometry.yAt(s.values[active] ?? 0));
  const tipHeight = 44 + series.length * 25;
  const tipOnLeft = activeX + 16 + TIP_WIDTH > width;
  const tipX = tipOnLeft ? activeX - 16 - TIP_WIDTH : activeX + 16;
  const tipY = Math.min(Math.max(Math.min(...activeYs) - 30, 0), baseline - tipHeight + 6);
  // Thin the axis out on narrow charts: a phone shows about four labels, with
  // clear air between them, instead of a row of numbers that touch.
  const stepPx = count > 1 ? plotWidth / (count - 1) : plotWidth;
  const every = tickEvery * Math.max(1, Math.ceil(MIN_LABEL_GAP / Math.max(stepPx * tickEvery, 1)));
  // The regular labels never change while hovering. A hovered point that has
  // one highlights it; any other point gets its own label only where it fits.
  const lastIndex = count - 1;
  const lastTick = lastIndex - (lastIndex % every);
  // The latest point keeps a label of its own whenever it clears the one before.
  const showLast = lastIndex !== lastTick && labelsClear(labels[lastIndex] ?? '', labels[lastTick] ?? '', (lastIndex - lastTick) * stepPx);
  const ticks = labels.map((_, i) => i).filter((i) => i % every === 0 || (i === lastIndex && showLast));
  const extraLabel = activeLabelFits(active, ticks, labels, (i) => geometry.xAt(i));

  const latest = restIndex ?? count - 1;
  const away = pointer.selected !== null && pointer.selected !== latest;
  const status = `${titles[active] ?? ''}: ${series.map((s) => `${s.label} ${(s.values[active] ?? 0).toLocaleString('de-AT')}`).join(', ')}`;
  return (
    <div
      ref={rootRef}
      className="chart"
      style={{ height: baseline + 44, cursor: onSelect ? 'pointer' : undefined }}
      role="group"
      aria-roledescription="Diagramm"
      aria-label={`${ariaLabel}. Pfeiltasten wählen einen Punkt${onPage ? ', Bild auf/ab blättert den Zeitraum' : ''}.`}
      tabIndex={0}
      {...pointer.handlers}
    >
      {/* The chosen point, read out to screen readers as it changes. */}
      <span className="sr-only" aria-live="polite">{status}</span>
      {away && (
        <button
          type="button"
          className="chart-latest"
          onClick={(e) => { e.stopPropagation(); setSelected(null); }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
        >
          <RotateCcw size={13} strokeWidth={1.9} /> Aktuell
        </button>
      )}
      {pointer.overscroll !== 0 && (
        <span className="chart-page-hint" data-side={pointer.overscroll === -1 ? 'left' : 'right'} aria-hidden="true">
          {pointer.overscroll === -1 ? <><ChevronLeft size={15} strokeWidth={2} /> früher</> : <>später <ChevronRight size={15} strokeWidth={2} /></>}
        </span>
      )}
      {ready && (
        <>
          <svg ref={svgRef} width={width} height={baseline + 8} aria-hidden="true">
            <defs>
              {geometry.paths.filter((p) => p.area).map((p) => (
                <linearGradient key={p.key} id={`${gradientId}-${p.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={p.color} stopOpacity="0.2" />
                  <stop offset="100%" stopColor={p.color} stopOpacity="0" />
                </linearGradient>
              ))}
            </defs>

            {geometry.ticks.map((tick) => (
              <text
                key={tick}
                x={0}
                y={geometry.yAt(tick)}
                dominantBaseline="middle"
                fontSize="12.5"
                fill="var(--ink-3)"
              >
                {compact(tick)}
              </text>
            ))}

            {geometry.paths.map((p) => p.area && (
              <path key={`${p.key}-area`} data-area d={p.area} fill={`url(#${gradientId}-${p.key})`} />
            ))}
            {geometry.paths.map((p) => (
              <path
                key={p.key}
                data-line
                d={p.line}
                pathLength={1}
                fill="none"
                stroke={p.color}
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}

            <g data-probe>
              <line
                x1={0}
                x2={0}
                y1={PAD_TOP - 6}
                y2={baseline + 8}
                stroke="var(--ink-4)"
                strokeWidth={1}
                strokeDasharray="3 4"
                style={{ transform: `translateX(${activeX}px)`, transition: 'transform 0.35s var(--glide)' }}
              />
              {series.map((s, i) => (
                <circle
                  key={s.key}
                  r={4}
                  fill={s.color}
                  stroke="var(--sheet)"
                  strokeWidth={2}
                  style={{
                    transform: `translate(${activeX}px, ${activeYs[i]}px)`,
                    transition: 'transform 0.35s var(--glide)',
                  }}
                />
              ))}
            </g>
          </svg>

          <div className="absolute inset-x-0" style={{ top: baseline + 14 }} aria-hidden="true">
            {ticks.map((i) => (
              <span
                key={i}
                className="chart-x absolute top-0 -translate-x-1/2 whitespace-nowrap"
                data-on={i === active}
                style={{ left: geometry.xAt(i) }}
              >
                {labels[i]}
              </span>
            ))}
            {extraLabel && (
              <span
                key={`active-${active}`}
                className="chart-x absolute top-0 -translate-x-1/2 whitespace-nowrap"
                data-on="true"
                style={{ left: activeX, animation: 'fade 0.18s ease backwards' }}
              >
                {labels[active]}
              </span>
            )}
          </div>

          {/* The anchor follows the pointer; the card inside it is what fades in. */}
          <div
            className="chart-tip-anchor"
            style={{
              width: TIP_WIDTH,
              transform: `translate3d(${tipX}px, ${tipY}px, 0)`,
              transition: 'transform 0.4s var(--glide)',
            }}
            aria-hidden="true"
          >
            <div ref={tipRef} className="chart-tip">
              <div className="text-[13.5px] font-medium leading-none">{titles[active]}</div>
              <div className="mt-[12px] flex flex-col gap-[9px]">
                {series.map((s) => (
                  <div key={s.key} className="flex items-center gap-[10px] text-[13px] leading-none">
                    <span className="h-4 w-[2px] rounded-full" style={{ background: s.color }} />
                    <span className="flex-1 text-tip-dim">{s.label}</span>
                    <span className="tabular font-medium">{(s.values[active] ?? 0).toLocaleString('de-AT')}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
