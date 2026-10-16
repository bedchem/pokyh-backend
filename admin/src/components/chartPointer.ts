import { useCallback, useRef, useState } from 'react';

// How a chart answers mouse, touch and keyboard — one implementation for the
// line and the bar charts.
//
//   Mouse      hovering shows a point; a click selects it (and opens what it
//              stands for, via onSelect). Leaving the chart returns to the
//              selection, not to "today".
//   Touch      a tap selects a point (a second tap on it opens it); a
//              sideways drag scrubs through the points, a vertical one scrolls
//              the page as usual (the chart is touch-action: pan-y). Lifting
//              the finger keeps the selection — nothing jumps back. Dragging
//              on past the first or last point and letting go pages to the
//              previous or next period (onPage).
//   Keyboard   ← → move, Home/End jump, Enter opens, Esc returns to the
//              latest point, Page Up/Down page through periods.

export type PageDirection = -1 | 1;

interface Options {
  count: number;
  // The point under a horizontal position on screen.
  indexAt: (clientX: number) => number;
  // The plot's horizontal extent on screen, for paging past its edges.
  bounds: () => { left: number; right: number } | null;
  onSelect?: (index: number) => void;
  onPage?: (direction: PageDirection) => void;
  // The point shown while nothing is hovered or selected (default: the last).
  rest?: number;
}

// How far past an edge a drag must end to page (px).
const OVERSCROLL_PX = 44;
// Movement that turns a touch from a tap into a drag (px).
const SLOP_PX = 8;

export function useChartPointer({ count, indexAt, bounds, onSelect, onPage, rest }: Options) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  // -1 / 1 while a drag is past the left / right edge.
  const [overscroll, setOverscroll] = useState<0 | PageDirection>(0);
  const touch = useRef<{ id: number; x: number; y: number; scrub: boolean } | null>(null);
  const lastPointer = useRef<string>('mouse');

  const clamp = useCallback((i: number) => Math.min(Math.max(i, 0), Math.max(count - 1, 0)), [count]);

  const edgeOf = (clientX: number): 0 | PageDirection => {
    if (!onPage) return 0;
    const b = bounds();
    if (!b) return 0;
    if (clientX < b.left - OVERSCROLL_PX) return -1;
    if (clientX > b.right + OVERSCROLL_PX) return 1;
    return 0;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    lastPointer.current = e.pointerType;
    if (e.pointerType === 'mouse') return;
    touch.current = { id: e.pointerId, x: e.clientX, y: e.clientY, scrub: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') {
      setHovered(indexAt(e.clientX));
      return;
    }
    const t = touch.current;
    if (!t || t.id !== e.pointerId) return;
    const dx = e.clientX - t.x;
    const dy = e.clientY - t.y;
    if (!t.scrub) {
      if (Math.abs(dx) < SLOP_PX || Math.abs(dx) <= Math.abs(dy)) return;
      t.scrub = true;
      // Keep receiving the drag even outside the chart, for paging.
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    }
    setSelected(indexAt(e.clientX));
    setOverscroll(edgeOf(e.clientX));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const t = touch.current;
    if (e.pointerType === 'mouse' || !t || t.id !== e.pointerId) return;
    touch.current = null;
    if (t.scrub) {
      const edge = edgeOf(e.clientX);
      setOverscroll(0);
      if (edge !== 0) onPage?.(edge);
      return;
    }
    // A tap: select; a tap on the selected point opens it.
    const index = indexAt(e.clientX);
    if (selected === index && onSelect) onSelect(index);
    else setSelected(index);
  };

  // The browser took the gesture over (a vertical scroll): keep what was chosen.
  const onPointerCancel = () => {
    touch.current = null;
    setOverscroll(0);
  };

  // Only a mouse leaving clears the hover; a finger lifting must not.
  const onPointerLeave = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') setHovered(null);
  };

  const onClick = (e: React.MouseEvent) => {
    if (lastPointer.current !== 'mouse') return;
    const index = indexAt(e.clientX);
    setSelected(index);
    onSelect?.(index);
  };

  const active = clamp(hovered ?? selected ?? rest ?? count - 1);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (count === 0) return;
    const from = selected ?? rest ?? count - 1;
    if (e.key === 'ArrowLeft') setSelected(clamp(from - 1));
    else if (e.key === 'ArrowRight') setSelected(clamp(from + 1));
    else if (e.key === 'Home') setSelected(0);
    else if (e.key === 'End') setSelected(count - 1);
    else if (e.key === 'Escape') setSelected(null);
    else if (e.key === 'Enter' && onSelect) onSelect(active);
    else if (e.key === 'PageUp' && onPage) onPage(-1);
    else if (e.key === 'PageDown' && onPage) onPage(1);
    else return;
    e.preventDefault();
  };

  return {
    active,
    hovered,
    selected,
    setSelected,
    overscroll,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerLeave, onClick, onKeyDown },
  };
}
