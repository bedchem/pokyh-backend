export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// The elements in `scope` that match `selector`, for an entrance of parts a
// view does not always show (a chart without an area, a hidden tooltip):
// GSAP warns in the console about every target that is not there.
export function present(scope: ParentNode | null | undefined, selector: string): Element[] {
  return scope ? Array.from(scope.querySelectorAll(selector)) : [];
}
