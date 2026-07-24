// Marquee (rubber-band) rectangle selection + shift-click range maths.
//
// Pure, DOM-free helpers so the geometry and the range logic are unit-testable
// away from the editor. `BlockEditor` supplies the live row rects (client
// coords) and the ordered top-level id list; these decide *what* is selected.

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Axis-aligned overlap test (touching edges count as intersecting). */
export const rectsIntersect = (a: Rect, b: Rect): boolean =>
  a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;

/** Normalise two drag corners (any order) into a positive-area rect. */
export const marqueeRect = (x0: number, y0: number, x1: number, y1: number): Rect => ({
  left: Math.min(x0, x1),
  top: Math.min(y0, y1),
  right: Math.max(x0, x1),
  bottom: Math.max(y0, y1),
});

/** Ids of the rows whose bounds intersect the marquee, in the given order. */
export const rowsInMarquee = (rect: Rect, rows: ReadonlyArray<{id: string; rect: Rect}>): string[] =>
  rows.filter((r) => rectsIntersect(rect, r.rect)).map((r) => r.id);

/**
 * Contiguous shift-click extension over an ordered id list.
 *
 * The anchor is the *nearest currently-selected* block to the target; the
 * result is the inclusive slice between them. With nothing selected the anchor
 * falls back to the focused block (caret home) — or the target itself when the
 * document has no focus — so a first shift-click still does something sane.
 */
export const shiftClickRange = (
  order: ReadonlyArray<string>,
  selected: ReadonlySet<string>,
  target: string,
  focused: string | null,
): string[] => {
  const ti = order.indexOf(target);
  if (ti < 0) return [...selected];
  const selectedIdx = order.map((id, i) => (selected.has(id) ? i : -1)).filter((i) => i >= 0);
  let anchor: number;
  if (selectedIdx.length > 0) {
    anchor = selectedIdx.reduce((best, i) => (Math.abs(i - ti) < Math.abs(best - ti) ? i : best), selectedIdx[0]);
  } else {
    const fi = focused != null ? order.indexOf(focused) : -1;
    anchor = fi >= 0 ? fi : ti;
  }
  const [lo, hi] = anchor <= ti ? [anchor, ti] : [ti, anchor];
  return order.slice(lo, hi + 1);
};
