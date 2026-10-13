import { prefersReducedMotion } from './motion';

// Browsers do not animate an SVG favicon reliably, so the tab icon is driven
// from pre-rendered frames: every so often the mark turns half a revolution
// (it is point-symmetric, so it lands exactly where it started) and then the
// crisp static SVG is put back until the next turn.
//
// It must never cost the page a frame. The frames are drawn once, a few at a
// time while the browser is idle, on a software canvas; a turn afterwards only
// swaps cached strings, and it is skipped while someone is scrolling or typing.

const SIZE = 64;
const FRAMES = 22;
const FRAME_MS = 48;
const REST_MS = 11000;
const QUIET_MS = 2500;
const TILT = (-38 * Math.PI) / 180;

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

function tiltedPill(ctx: CanvasRenderingContext2D, x: number, y: number, cx: number, cy: number) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(TILT);
  ctx.translate(-cx, -cy);
  roundedRect(ctx, x, y, 13.4, 6.8, 3.4);
  ctx.restore();
}

function dot(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
  ctx.beginPath();
  ctx.arc(cx, cy, 3.4, 0, Math.PI * 2);
  ctx.fill();
}

// Same geometry as <Mark /> and public/favicon.svg, on a 28-unit grid.
function draw(ctx: CanvasRenderingContext2D, turn: number) {
  const breathe = 1 - 0.2 * Math.sin(turn * Math.PI);
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = '#a9cff3';
  roundedRect(ctx, 0, 0, SIZE, SIZE, 20);

  ctx.save();
  ctx.translate(SIZE / 2, SIZE / 2);
  ctx.rotate(turn * Math.PI);
  ctx.scale(1.5 * breathe, 1.5 * breathe);
  ctx.translate(-14, -14);
  ctx.fillStyle = '#111113';
  tiltedPill(ctx, 2.2, 4.6, 8.9, 8);
  dot(ctx, 21, 7.2);
  dot(ctx, 7, 20.8);
  tiltedPill(ctx, 12.4, 16.6, 19.1, 20);
  ctx.restore();
}

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

type IdleWindow = Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };

export function startFavicon(): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link || prefersReducedMotion()) return;

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  // willReadFrequently keeps the canvas in software, so reading a frame back
  // never waits on the GPU.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;

  const restHref = link.href;
  const restType = link.type;
  const frames: string[] = [];
  const whenIdle = (cb: () => void) => {
    const idle = (window as IdleWindow).requestIdleCallback;
    if (idle) idle(cb, { timeout: 2000 });
    else window.setTimeout(cb, 200);
  };

  // Two frames per idle slot until the set is complete.
  function prepare() {
    for (let n = 0; n < 2 && frames.length < FRAMES; n++) {
      draw(ctx!, easeInOut((frames.length + 1) / (FRAMES + 1)));
      frames.push(canvas.toDataURL('image/png'));
    }
    if (frames.length < FRAMES) whenIdle(prepare);
  }
  whenIdle(prepare);

  let lastInput = 0;
  const touch = () => { lastInput = performance.now(); };
  for (const type of ['scroll', 'wheel', 'pointerdown', 'keydown', 'touchmove']) {
    window.addEventListener(type, touch, { passive: true, capture: true });
  }

  let playing = false;
  function turn() {
    if (playing || document.hidden || frames.length < FRAMES) return;
    if (performance.now() - lastInput < QUIET_MS) return;
    playing = true;
    let i = 0;
    const timer = window.setInterval(() => {
      // Give way at once if the page becomes busy mid-turn.
      if (i >= FRAMES || performance.now() - lastInput < 250) {
        window.clearInterval(timer);
        link!.type = restType;
        link!.href = restHref;
        playing = false;
        return;
      }
      link!.type = 'image/png';
      link!.href = frames[i]!;
      i++;
    }, FRAME_MS);
  }

  window.setTimeout(turn, 2500);
  window.setInterval(turn, REST_MS);
}
