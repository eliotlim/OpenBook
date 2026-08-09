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

const popup = (width: number, height: number): HTMLElement =>
  ({offsetWidth: width, offsetHeight: height}) as HTMLElement;

afterEach(() => {
  vi.restoreAllMocks();
  viewport(1024, 768);
});

describe('observePopupPosition', () => {
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
