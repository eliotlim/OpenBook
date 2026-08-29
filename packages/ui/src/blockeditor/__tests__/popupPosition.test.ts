import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  INLINE_TOOLBAR_POSITION_OPTIONS,
  observePopupPosition,
  SLASH_MENU_POSITION_OPTIONS,
  type PopupPosition,
} from '../popupPosition';

const viewport = (width: number, height: number): void => {
  Object.defineProperty(window, 'innerWidth', {configurable: true, value: width});
  Object.defineProperty(window, 'innerHeight', {configurable: true, value: height});
};

const popup = (width: number, height: number): HTMLElement => {
  const element = document.createElement('div');
  Object.defineProperties(element, {
    offsetWidth: {configurable: true, value: width},
    offsetHeight: {configurable: true, value: height},
  });
  return element;
};

const boundary = (top: number, bottom: number): HTMLElement => {
  const element = document.createElement('div');
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, top, 800, bottom - top));
  return element;
};

afterEach(() => {
  vi.restoreAllMocks();
  viewport(1024, 768);
});

describe('observePopupPosition', () => {
  it('preserves byte-equivalent legacy placement when the boundary is null', () => {
    viewport(800, 600);
    let position: PopupPosition | undefined;
    const cleanup = observePopupPosition({
      popup: () => popup(272, 200),
      anchor: () => new DOMRect(100, 100, 2, 20),
      boundary: () => null,
      onPosition: (next) => (position = next),
    });

    expect(position).toEqual({left: 100, top: 126, maxHeight: 300, placement: 'below'});
    cleanup();
  });

  it('respects a clipping boundary when choosing and clamping placement', () => {
    viewport(800, 600);
    let position: PopupPosition | undefined;
    const clip = boundary(100, 500);
    const cleanup = observePopupPosition({
      popup: () => popup(200, 100),
      anchor: () => new DOMRect(200, 130, 100, 20),
      boundary: () => clip,
      onPosition: (next) => (position = next),
      options: {...INLINE_TOOLBAR_POSITION_OPTIONS, clampHorizontallyToBoundary: true},
    });

    expect(position).toEqual({left: 150, top: 158, maxHeight: undefined, placement: 'below'});
    cleanup();
  });

  it('places the toolbar below when boundary-relative top space is tight', () => {
    viewport(800, 900);
    let position: PopupPosition | undefined;
    const clip = boundary(55, 850);
    const cleanup = observePopupPosition({
      popup: () => popup(248, 36),
      anchor: () => new DOMRect(200, 70, 100, 20),
      boundary: () => clip,
      onPosition: (next) => (position = next),
      options: INLINE_TOOLBAR_POSITION_OPTIONS,
    });

    expect(position).toEqual({left: 126, top: 98, maxHeight: undefined, placement: 'below'});
    cleanup();
  });

  it('clamps below placement against boundaryBottom', () => {
    viewport(800, 600);
    let position: PopupPosition | undefined;
    const clip = boundary(50, 180);
    const cleanup = observePopupPosition({
      popup: () => popup(100, 60),
      anchor: () => new DOMRect(100, 100, 20, 20),
      boundary: () => clip,
      onPosition: (next) => (position = next),
      options: {preferredPlacement: 'below', maxHeight: null},
    });

    expect(position?.top).toBe(112);
    expect(position!.top + 60).toBe(172);
    cleanup();
  });

  it('preserves the menu below-anchor gap and viewport clamp defaults', () => {
    viewport(800, 600);
    let position: PopupPosition | undefined;
    const cleanup = observePopupPosition({
      popup: () => popup(272, 200),
      anchor: () => new DOMRect(100, 100, 2, 20),
      onPosition: (next) => (position = next),
    });

    expect(position).toEqual({left: 100, top: 126, maxHeight: 300, placement: 'below'});
    cleanup();
  });

  it('flips a measured menu above and retains SlashMenu\'s 304px cap', () => {
    viewport(800, 400);
    let position: PopupPosition | undefined;
    const cleanup = observePopupPosition({
      popup: () => popup(272, 200),
      anchor: () => new DOMRect(100, 330, 2, 20),
      onPosition: (next) => (position = next),
      options: SLASH_MENU_POSITION_OPTIONS,
    });

    expect(position).toEqual({left: 100, top: 124, maxHeight: 304, placement: 'above'});
    cleanup();
  });

  it('centres the measured toolbar above and flips it below near the top', () => {
    viewport(800, 600);
    let anchor = new DOMRect(200, 60, 100, 20);
    let position: PopupPosition | undefined;
    const cleanup = observePopupPosition({
      popup: () => popup(248, 36),
      anchor: () => anchor,
      onPosition: (next) => (position = next),
      options: INLINE_TOOLBAR_POSITION_OPTIONS,
    });

    expect(position).toEqual({left: 126, top: 16, maxHeight: undefined, placement: 'above'});
    anchor = new DOMRect(200, 40, 100, 20);
    window.dispatchEvent(new Event('resize'));
    expect(position).toEqual({left: 126, top: 68, maxHeight: undefined, placement: 'below'});
    cleanup();
  });

  it('clamps the centred toolbar to the shared viewport margin', () => {
    viewport(800, 600);
    let position: PopupPosition | undefined;
    const cleanup = observePopupPosition({
      popup: () => popup(248, 36),
      anchor: () => new DOMRect(0, 60, 2, 20),
      onPosition: (next) => (position = next),
      options: INLINE_TOOLBAR_POSITION_OPTIONS,
    });

    expect(position?.left).toBe(8);
    cleanup();
  });

  it('clamps a centred toolbar inside the horizontal clipping boundary', () => {
    viewport(1000, 600);
    const clip = document.createElement('div');
    vi.spyOn(clip, 'getBoundingClientRect').mockReturnValue(new DOMRect(120, 20, 500, 500));
    let position: PopupPosition | undefined;
    const cleanup = observePopupPosition({
      popup: () => popup(200, 36),
      anchor: () => new DOMRect(80, 100, 40, 40),
      boundary: () => clip,
      onPosition: (next) => (position = next),
      options: {...INLINE_TOOLBAR_POSITION_OPTIONS, clampHorizontallyToBoundary: true},
    });

    expect(position?.left).toBe(128);
    cleanup();
  });

  it('does not horizontally clamp to a clipping boundary unless opted in', () => {
    viewport(1000, 600);
    const clip = document.createElement('div');
    vi.spyOn(clip, 'getBoundingClientRect').mockReturnValue(new DOMRect(120, 20, 500, 500));
    let position: PopupPosition | undefined;
    const cleanup = observePopupPosition({
      popup: () => popup(200, 36),
      anchor: () => new DOMRect(80, 100, 40, 40),
      boundary: () => clip,
      onPosition: (next) => (position = next),
      options: INLINE_TOOLBAR_POSITION_OPTIONS,
    });

    expect(position?.left).toBe(8);
    cleanup();
  });

  it('re-clamps against the new viewport width on resize', () => {
    viewport(500, 600);
    let position: PopupPosition | undefined;
    const cleanup = observePopupPosition({
      popup: () => popup(272, 200),
      anchor: () => new DOMRect(400, 100, 2, 20),
      onPosition: (next) => (position = next),
    });

    expect(position?.left).toBe(220);
    viewport(350, 600);
    window.dispatchEvent(new Event('resize'));
    expect(position?.left).toBe(70);
    cleanup();
  });

  it('remeasures a widened list without its stale max-height cap', () => {
    viewport(800, 628);
    const element = document.createElement('div');
    let naturalHeight = 160;
    Object.defineProperties(element, {
      offsetWidth: {configurable: true, get: () => 272},
      offsetHeight: {
        configurable: true,
        get: () => {
          const cap = Number.parseFloat(element.style.maxHeight);
          return Number.isNaN(cap) ? naturalHeight : Math.min(naturalHeight, cap);
        },
      },
    });
    let position: PopupPosition | undefined;
    const cleanup = observePopupPosition({
      popup: () => element,
      anchor: () => new DOMRect(100, 414, 2, 20),
      onPosition: (next) => {
        position = next;
        element.style.maxHeight = `${next.maxHeight}px`;
      },
    });

    expect(position).toEqual({left: 100, top: 440, maxHeight: 180, placement: 'below'});
    naturalHeight = 350;
    window.dispatchEvent(new Event('resize'));
    expect(position).toEqual({left: 100, top: 108, maxHeight: 300, placement: 'above'});
    cleanup();
  });

  it('stops observing viewport resizes after cleanup', () => {
    viewport(500, 600);
    const onPosition = vi.fn();
    const cleanup = observePopupPosition({
      popup: () => popup(272, 200),
      anchor: () => new DOMRect(400, 100, 2, 20),
      onPosition,
    });

    expect(onPosition).toHaveBeenCalledTimes(1);
    cleanup();
    window.dispatchEvent(new Event('resize'));
    expect(onPosition).toHaveBeenCalledTimes(1);
  });

  it('retries an all-zero anchor rect until its mount frame is measurable', () => {
    viewport(800, 600);
    let frame: FrameRequestCallback | undefined;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    let anchorReady = false;
    let position: PopupPosition | undefined;
    const cleanup = observePopupPosition({
      popup: () => popup(272, 200),
      anchor: () => (anchorReady ? new DOMRect(100, 100, 2, 20) : new DOMRect()),
      onPosition: (next) => (position = next),
    });

    expect(position).toBeUndefined();
    anchorReady = true;
    frame?.(0);
    expect(position?.top).toBe(126);
    cleanup();
  });
});
