// @vitest-environment happy-dom

import {afterEach, describe, expect, it, vi} from 'vitest';
import {suppressNativeContextMenu} from './nativeContextMenu';

let removeListener: (() => void) | undefined;

afterEach(() => {
  removeListener?.();
  removeListener = undefined;
  document.body.replaceChildren();
});

describe('native context-menu suppression', () => {
  it('leaves the native menu available in development', () => {
    removeListener = suppressNativeContextMenu(false);
    const event = new MouseEvent('contextmenu', {bubbles: true, cancelable: true});

    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('suppresses the native menu in production after a component receives the event', () => {
    removeListener = suppressNativeContextMenu(true);
    const target = document.createElement('div');
    const componentListener = vi.fn((event: MouseEvent) => {
      expect(event.defaultPrevented).toBe(false);
    });
    target.addEventListener('contextmenu', componentListener);
    document.body.append(target);

    const bodyEvent = new MouseEvent('contextmenu', {bubbles: true, cancelable: true});
    document.body.dispatchEvent(bodyEvent);
    expect(bodyEvent.defaultPrevented).toBe(true);

    const componentEvent = new MouseEvent('contextmenu', {bubbles: true, cancelable: true});
    target.dispatchEvent(componentEvent);
    expect(componentListener).toHaveBeenCalledOnce();
    expect(componentEvent.defaultPrevented).toBe(true);
  });
});
