import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  closeKitPanel,
  getKitPanel,
  getKitPanelHost,
  openKitPanel,
  registerKitPanelNav,
  setKitPanelHost,
  subscribeKitPanel,
} from '../kitPanel';

afterEach(() => {
  closeKitPanel({keepPane: true});
  setKitPanelHost(null);
});

describe('kitPanel bridge', () => {
  it('opens, switches, and closes the expanded config, notifying subscribers', () => {
    const seen: Array<string | null> = [];
    const unsub = subscribeKitPanel(() => seen.push(getKitPanel()?.blockId ?? null));

    openKitPanel('a', 'Alpha');
    expect(getKitPanel()).toEqual({blockId: 'a', title: 'Alpha'});
    openKitPanel('b', 'Beta');
    expect(getKitPanel()?.blockId).toBe('b');
    closeKitPanel({keepPane: true});
    expect(getKitPanel()).toBeNull();

    expect(seen).toEqual(['a', 'b', null]);
    unsub();
  });

  it('drives the registered side-pane nav: open reveals it, close hides it', () => {
    const open = vi.fn();
    const close = vi.fn();
    const unregister = registerKitPanelNav(open, close);

    openKitPanel('x', 'X');
    expect(open).toHaveBeenCalledWith('x');

    closeKitPanel(); // default: also hide the pane
    expect(close).toHaveBeenCalledTimes(1);

    unregister();
  });

  it('does not re-hide the pane when it is already going away (keepPane)', () => {
    const close = vi.fn();
    const unregister = registerKitPanelNav(() => undefined, close);
    openKitPanel('x', 'X');
    closeKitPanel({keepPane: true});
    expect(close).not.toHaveBeenCalled();
    unregister();
  });

  it('tracks the portal host element', () => {
    expect(getKitPanelHost()).toBeNull();
    const el = {} as HTMLElement;
    setKitPanelHost(el);
    expect(getKitPanelHost()).toBe(el);
  });
});
