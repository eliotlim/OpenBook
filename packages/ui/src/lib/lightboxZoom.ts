/**
 * Pure zoom/pan math for the image lightbox (LBX-2).
 *
 * Kept free of React and the DOM so the fiddly bits — scale clamping, the
 * cursor-centred zoom formula and pan clamping — are unit-testable in isolation.
 * The overlay component ({@link components/ImageLightbox}) measures the live
 * `<img>` (its layout size + natural size + the viewport) and feeds those
 * numbers in here.
 *
 * Conventions:
 * - `scale` is expressed **relative to the fit size**, so `scale === 1` is
 *   fit-to-viewport (the resting state). The picture renders at its fit size via
 *   CSS; this module's transform scales on top of that.
 * - `100%` (natural pixels) is therefore `hundredScale = naturalW / renderW`,
 *   which is `≥ 1` — and exactly `1` when the picture is smaller than the
 *   viewport (fit never upscales, so fit already is 100%).
 * - Translation (`tx`, `ty`) is in CSS pixels, applied around the picture's
 *   layout centre (which sits at the viewport centre).
 */

/** The fit-to-viewport scale, in this module's fit-relative units. Always 1. */
export const FIT_SCALE = 1;

/** Zoom floor as a multiple of the fit scale (acceptance: fit-scale × 0.5). */
export const MIN_SCALE_FACTOR = 0.5;

/** Zoom ceiling as a multiple of 100% / natural size (acceptance: 8× natural). */
export const MAX_NATURAL_FACTOR = 8;

/** A pan/zoom transform, fit-relative. */
export interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

/** Live measurements of the rendered picture and its viewport, in CSS pixels. */
export interface Metrics {
  /** Fit-rendered width (`img.offsetWidth`, pre-transform). */
  renderW: number;
  /** Fit-rendered height (`img.offsetHeight`, pre-transform). */
  renderH: number;
  /** The pan/zoom stage's width. */
  viewportW: number;
  /** The pan/zoom stage's height. */
  viewportH: number;
  /** `naturalW / renderW` — the scale at which the picture is 1:1 (≥ 1). */
  hundredScale: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The lowest allowed scale: half the fit size. */
export const minScale = (): number => FIT_SCALE * MIN_SCALE_FACTOR;

/** The highest allowed scale: 8× the natural (100%) size. */
export const maxScale = (m: Pick<Metrics, 'hundredScale'>): number =>
  MAX_NATURAL_FACTOR * Math.max(FIT_SCALE, m.hundredScale);

/** Clamp a raw scale into `[fit×0.5, 8×natural]`. */
export const clampScale = (scale: number, m: Pick<Metrics, 'hundredScale'>): number =>
  clamp(scale, minScale(), maxScale(m));

/**
 * Clamp one axis of the pan so the picture is never fully lost off-screen.
 *
 * `maxOffset = |scaledSize − viewport| / 2`, which does the right thing in both
 * regimes: when the scaled picture is **larger** than the viewport it may pan
 * until an edge meets the viewport edge (no empty gutter revealed); when it's
 * **smaller** it may drift only until it would leave the viewport (so it always
 * stays fully visible). At exactly fit-in-axis the offset pins to 0.
 */
export const clampPanAxis = (t: number, scaledSize: number, viewport: number): number => {
  const maxOffset = Math.abs(scaledSize - viewport) / 2;
  return clamp(t, -maxOffset, maxOffset);
};

/** Clamp both translation axes of a transform against the current metrics. */
export const clampPan = (tr: Transform, m: Metrics): Transform => ({
  scale: tr.scale,
  tx: clampPanAxis(tr.tx, m.renderW * tr.scale, m.viewportW),
  ty: clampPanAxis(tr.ty, m.renderH * tr.scale, m.viewportH),
});

/**
 * Zoom to `nextScaleRaw`, keeping the point under the cursor fixed on screen.
 *
 * `cursorDx/cursorDy` are the cursor's offset from the picture's layout centre
 * (i.e. `clientX − stageCentreX`). Derivation: a screen point `d` maps to the
 * same picture-space point before and after, giving `t' = (1 − k)·d + k·t` per
 * axis, where `k = nextScale / prevScale`. The scale is clamped first (so `k`
 * uses the realised scale) and the result is pan-clamped so the zoom can't
 * strand the picture off-screen.
 */
export const zoomAt = (
  prev: Transform,
  nextScaleRaw: number,
  cursorDx: number,
  cursorDy: number,
  m: Metrics,
): Transform => {
  const scale = clampScale(nextScaleRaw, m);
  const k = prev.scale === 0 ? 1 : scale / prev.scale;
  const tx = (1 - k) * cursorDx + k * prev.tx;
  const ty = (1 - k) * cursorDy + k * prev.ty;
  return clampPan({scale, tx, ty}, m);
};

/** Multiply the current scale by `factor`, centred on the cursor (default: centre). */
export const zoomByFactor = (
  prev: Transform,
  factor: number,
  cursorDx: number,
  cursorDy: number,
  m: Metrics,
): Transform => zoomAt(prev, prev.scale * factor, cursorDx, cursorDy, m);

/** The resting, fit-to-viewport transform. */
export const fitTransform = (): Transform => ({scale: FIT_SCALE, tx: 0, ty: 0});

/** Is this transform (approximately) the fit state — scale at fit and centred? */
export const isFit = (tr: Transform): boolean =>
  Math.abs(tr.scale - FIT_SCALE) < 0.01 && Math.abs(tr.tx) < 0.5 && Math.abs(tr.ty) < 0.5;

/**
 * Toggle fit ↔ 100% (natural). From ~fit, jump to 100% centred on the cursor;
 * from any zoomed/panned state, snap back to fit. Used by double-click and by
 * the reset control (with a centred cursor).
 */
export const toggleFitHundred = (
  prev: Transform,
  cursorDx: number,
  cursorDy: number,
  m: Metrics,
): Transform =>
  isFit(prev) ? zoomAt(prev, m.hundredScale, cursorDx, cursorDy, m) : fitTransform();

/**
 * The zoom percentage to show in the chrome, relative to natural pixels:
 * `round(scale / hundredScale × 100)`. Fit reads as e.g. 63% for a big picture,
 * 100% for one that already fits.
 */
export const zoomPercent = (tr: Transform, m: Pick<Metrics, 'hundredScale'>): number =>
  Math.round((tr.scale / Math.max(m.hundredScale, 1e-6)) * 100);
