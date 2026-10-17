// The bottom bar's indicator: the pill behind the active tab's icon that
// stretches towards a new tab and settles there.
//
// The pill is a window onto a full-width layer that holds the ink ground and
// every tab's lit icon. Two nested clips form the window: the outer one cuts
// off everything left of the pill's left edge, the inner one everything right
// of its right edge, and the layer moves against them so it stays put. An
// icon is therefore lit exactly where the pill covers it, in every frame,
// with nothing to cross-fade. All three only move (transform), so the browser
// plays the motion on the compositor: rendering the next page right after the
// tap cannot freeze it. Each edge follows its own spring: the leading edge
// runs ahead and the trailing one follows, so the pill stretches towards the
// new tab and settles there. (No squeeze: a scaled clip leaves a hairline at
// its rounded ends in Chrome.)

export interface Span {
  left: number;
  right: number;
}

export interface IndicatorParts {
  root: HTMLElement;
  clipL: HTMLElement;
  clipR: HTMLElement;
  layer: HTMLElement;
}

interface Spring {
  period: number;
  damping: number;
  delay: number;
}

const LEAD: Spring = { period: 0.36, damping: 0.7, delay: 0 };
const TRAIL: Spring = { period: 0.46, damping: 0.8, delay: 0.035 };
// Coming in where there was none: both edges grow out of the middle.
const GROW: Spring = { period: 0.42, damping: 0.72, delay: 0 };
const STEP = 1 / 120;
// However far the pill goes, it overshoots by at most this much.
const OVERSHOOT_PX = 3.5;
// A longer way takes a little longer (up to half as long again at four tabs),
// so a far jump does not shoot off.
const ONE_TAB = 80;

function paced(s: Spring, distance: number): Spring {
  const stretch = 1 + 0.5 * Math.min(1, Math.max(0, (distance - ONE_TAB) / (3 * ONE_TAB)));
  // The damping that keeps the overshoot (a share of the way) within a few
  // pixels: a far jump would otherwise swing out to the screen edge.
  const share = Math.min(Math.exp((-Math.PI * s.damping) / Math.sqrt(1 - s.damping * s.damping)), OVERSHOOT_PX / Math.max(1, distance));
  const damping = Math.min(0.95, Math.max(s.damping, -Math.log(share) / Math.sqrt(Math.PI ** 2 + Math.log(share) ** 2)));
  return { ...s, period: s.period * stretch, damping };
}

// The position (0 → 1) of a damped spring released from rest.
function spring(t: number, { period, damping, delay }: Spring): number {
  const s = t - delay;
  if (s <= 0) return 0;
  const w = (2 * Math.PI) / period;
  const wd = w * Math.sqrt(1 - damping * damping);
  return 1 - Math.exp(-damping * w * s) * (Math.cos(wd * s) + ((damping * w) / wd) * Math.sin(wd * s));
}

// Until both edges are within 0.2 % of the way from rest.
function settleTime(...springs: Spring[]): number {
  return Math.max(...springs.map((s) => s.delay + Math.log(1 / 0.002) / (s.damping * ((2 * Math.PI) / s.period))));
}

// `width` is the layer's (the row's) width.
function partStyles(span: Span, width: number) {
  return {
    clipL: `translate3d(${span.left}px, 0, 0)`,
    clipR: `translate3d(${span.right - span.left - width}px, 0, 0)`,
    layer: `translate3d(${width - span.right}px, 0, 0)`,
  };
}

function apply(parts: IndicatorParts, span: Span, width: number) {
  const s = partStyles(span, width);
  parts.clipL.style.transform = s.clipL;
  parts.clipR.style.transform = s.clipR;
  parts.layer.style.transform = s.layer;
}

const matrix = (transform: string) => new DOMMatrixReadOnly(transform === 'none' ? undefined : transform);

// Where the pill is on screen right now, mid-animation included.
function readSpan(parts: IndicatorParts, width: number): { span: Span; opacity: number } {
  const left = matrix(getComputedStyle(parts.clipL).transform).m41;
  const right = left + matrix(getComputedStyle(parts.clipR).transform).m41 + width;
  return { span: { left, right }, opacity: Number(getComputedStyle(parts.root).opacity) };
}

function stop(parts: IndicatorParts) {
  for (const el of [parts.root, parts.clipL, parts.clipR, parts.layer]) el.getAnimations().forEach((a) => a.cancel());
}

export interface Move {
  // When the pill reaches the middle of the new tab, and leaves the old one (s).
  arrive: number;
  leave: number;
}

// Puts the pill on `to` at once (first placement, resize, reduced motion).
export function placeIndicator(parts: IndicatorParts, to: Span | null, width: number) {
  stop(parts);
  if (to) {
    apply(parts, to, width);
    parts.root.style.opacity = '1';
  } else {
    parts.root.style.opacity = '0';
  }
}

// Moves the pill from wherever it is now to `to`, or fades it out for null.
export function moveIndicator(parts: IndicatorParts, to: Span | null, width: number): Move {
  const now = readSpan(parts, width);
  stop(parts);
  const visible = now.opacity > 0.01;

  if (!to) {
    apply(parts, now.span, width);
    parts.root.style.opacity = '0';
    parts.root.animate([{ opacity: now.opacity }, { opacity: 0 }], { duration: 180, easing: 'ease-out' });
    return { arrive: 0, leave: 0 };
  }

  const toMid = (to.left + to.right) / 2;
  // Nothing on screen yet: grow out of the new tab's middle.
  const from: Span = visible ? now.span : { left: toMid, right: toMid };
  const fromMid = (from.left + from.right) / 2;
  const rightwards = toMid >= fromMid;
  const distance = Math.abs(toMid - fromMid);
  const leftSpring = !visible ? GROW : paced(rightwards ? TRAIL : LEAD, distance);
  const rightSpring = !visible ? GROW : paced(rightwards ? LEAD : TRAIL, distance);
  const duration = settleTime(leftSpring, rightSpring);

  const frames: Record<'clipL' | 'clipR' | 'layer', Keyframe[]> = { clipL: [], clipR: [], layer: [] };
  let arrive = 0;
  let leave = 0;
  const count = Math.ceil(duration / STEP);
  for (let i = 0; i <= count; i++) {
    const t = i * STEP;
    const end = i === count;
    // Never past the ends of the row.
    const span = end ? to : {
      left: Math.max(0, from.left + (to.left - from.left) * spring(t, leftSpring)),
      right: Math.min(width, from.right + (to.right - from.right) * spring(t, rightSpring)),
    };
    const s = partStyles(span, width);
    frames.clipL.push({ transform: s.clipL });
    frames.clipR.push({ transform: s.clipR });
    frames.layer.push({ transform: s.layer });
    if (!arrive && (rightwards ? span.right >= toMid : span.left <= toMid)) arrive = t;
    if (!leave && (rightwards ? span.left >= fromMid : span.right <= fromMid)) leave = t;
  }

  apply(parts, to, width);
  const timing: KeyframeAnimationOptions = { duration: count * STEP * 1000, easing: 'linear' };
  parts.clipL.animate(frames.clipL, timing);
  parts.clipR.animate(frames.clipR, timing);
  parts.layer.animate(frames.layer, timing);
  if (!visible) {
    parts.root.style.opacity = '1';
    parts.root.animate([{ opacity: now.opacity }, { opacity: 1 }], { duration: 140, easing: 'ease-out' });
  }
  return { arrive, leave: leave || arrive };
}

// Tapping the tab already shown: the pill gives a short nod around its middle.
export function nudgeIndicator(parts: IndicatorParts, at: Span) {
  parts.root.style.transformOrigin = `${(at.left + at.right) / 2}px 50%`;
  parts.root.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(0.9)', offset: 0.25 }, { transform: 'scale(1.03)', offset: 0.62 }, { transform: 'scale(1)' }],
    { duration: 420, easing: 'ease-out' },
  );
}
