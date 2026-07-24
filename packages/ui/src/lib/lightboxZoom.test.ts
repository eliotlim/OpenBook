import {describe, expect, it} from 'vitest';
import {
  clampPanAxis,
  clampScale,
  fitTransform,
  isFit,
  maxScale,
  minScale,
  toggleFitHundred,
  zoomAt,
  zoomByFactor,
  zoomPercent,
  type Metrics,
} from './lightboxZoom';

/**
 * Zoom/pan math for the image lightbox (LBX-2): scale clamping, the
 * cursor-centred zoom formula, pan clamping (never fully lost off-screen) and
 * the fit ↔ 100% toggle.
 */

// A wide picture: 1600×900 natural, rendered fit at 800×450 inside a 1000×700
// stage. hundredScale = 1600/800 = 2 (so 100% = scale 2 in fit-relative units).
const M: Metrics = {renderW: 800, renderH: 450, viewportW: 1000, viewportH: 700, hundredScale: 2};

describe('scale clamping', () => {
  it('floors at half the fit scale and ceils at 8× natural', () => {
    expect(minScale()).toBe(0.5);
    expect(maxScale(M)).toBe(16); // 8 × hundredScale(2)
    expect(clampScale(0.1, M)).toBe(0.5);
    expect(clampScale(100, M)).toBe(16);
    expect(clampScale(3, M)).toBe(3);
  });

  it('never lets the ceiling fall below 8× fit for a small (upscale-clamped) picture', () => {
    // A picture smaller than the viewport fits at natural size → hundredScale 1.
    const small: Metrics = {renderW: 200, renderH: 200, viewportW: 1000, viewportH: 700, hundredScale: 1};
    expect(maxScale(small)).toBe(8);
  });
});

describe('cursor-centred zoom', () => {
  it('keeps the cursor point fixed when zooming in (centre cursor stays put)', () => {
    const next = zoomAt(fitTransform(), 2, 0, 0, M);
    expect(next.scale).toBe(2);
    // Cursor at the centre → no translation needed.
    expect(next.tx).toBe(0);
    expect(next.ty).toBe(0);
  });

  it('translates so an off-centre cursor point does not move on screen', () => {
    // Cursor 100px right of centre, zoom fit(1)→2. Formula: t' = (1-k)d + k·t,
    // k=2, d=100, t=0 → t' = -100. Then pan-clamp: scaledW = 800·2 = 1600,
    // viewport 1000 → maxOffset = 300, so -100 is within range and preserved.
    const next = zoomAt(fitTransform(), 2, 100, 0, M);
    expect(next.scale).toBe(2);
    expect(next.tx).toBe(-100);
  });

  it('clamps the resulting pan so a corner-cursor zoom cannot strand the image', () => {
    // Extreme cursor far outside; the raw translation would exceed maxOffset and
    // must be clamped to ±maxOffset (300 on x at scale 2).
    const next = zoomAt(fitTransform(), 2, 100000, 0, M);
    expect(next.scale).toBe(2);
    expect(next.tx).toBe(-300); // clamped to -maxOffset
  });

  it('zoomByFactor multiplies the current scale', () => {
    const a = zoomByFactor(fitTransform(), 1.25, 0, 0, M);
    expect(a.scale).toBeCloseTo(1.25, 5);
    const b = zoomByFactor(a, 0.8, 0, 0, M);
    expect(b.scale).toBeCloseTo(1, 5);
  });
});

describe('pan clamping (never fully lost off-screen)', () => {
  it('larger-than-viewport axis pans until an edge meets the viewport edge', () => {
    // scaledSize 1600 vs viewport 1000 → maxOffset = 300.
    expect(clampPanAxis(500, 1600, 1000)).toBe(300);
    expect(clampPanAxis(-500, 1600, 1000)).toBe(-300);
    expect(clampPanAxis(120, 1600, 1000)).toBe(120);
  });

  it('smaller-than-viewport axis may drift only until it would leave the viewport', () => {
    // scaledSize 400 vs viewport 1000 → maxOffset = 300 (stays fully inside).
    expect(clampPanAxis(9999, 400, 1000)).toBe(300);
    expect(clampPanAxis(-50, 400, 1000)).toBe(-50);
  });

  it('pins to centre when the axis exactly fits', () => {
    expect(clampPanAxis(40, 1000, 1000)).toBe(0);
  });
});

describe('fit ↔ 100% toggle', () => {
  it('fitTransform is the resting state and reads as fit', () => {
    expect(fitTransform()).toEqual({scale: 1, tx: 0, ty: 0});
    expect(isFit(fitTransform())).toBe(true);
  });

  it('from fit, toggles to 100% (natural = hundredScale)', () => {
    const next = toggleFitHundred(fitTransform(), 0, 0, M);
    expect(next.scale).toBe(2); // hundredScale
    expect(isFit(next)).toBe(false);
  });

  it('from a zoomed/panned state, toggles back to fit', () => {
    const zoomed = zoomAt(fitTransform(), 4, 50, 20, M);
    const back = toggleFitHundred(zoomed, 0, 0, M);
    expect(back).toEqual({scale: 1, tx: 0, ty: 0});
    expect(isFit(back)).toBe(true);
  });

  it('a picture that already fits (hundredScale 1) toggles fit→100% as a no-op scale', () => {
    const small: Metrics = {renderW: 200, renderH: 200, viewportW: 1000, viewportH: 700, hundredScale: 1};
    const next = toggleFitHundred(fitTransform(), 0, 0, small);
    expect(next.scale).toBe(1);
  });
});

describe('zoom percentage readout', () => {
  it('reports natural-relative percent: fit reads below 100 for a big picture, 100 at 1:1', () => {
    expect(zoomPercent(fitTransform(), M)).toBe(50); // fit(1) / hundredScale(2)
    expect(zoomPercent({scale: 2, tx: 0, ty: 0}, M)).toBe(100);
    expect(zoomPercent({scale: 4, tx: 0, ty: 0}, M)).toBe(200);
  });
});
