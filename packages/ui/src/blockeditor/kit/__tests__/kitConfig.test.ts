import {describe, it, expect} from 'vitest';
import {registerKitConfig, hasKitConfig, openKitConfig} from '../kitConfig';

describe('kitConfig bridge', () => {
  it('registers, reports, opens, and unregisters an opener', () => {
    expect(hasKitConfig('b1')).toBe(false);
    expect(openKitConfig('b1')).toBe(false);

    let opened = 0;
    const unregister = registerKitConfig('b1', () => (opened += 1));
    expect(hasKitConfig('b1')).toBe(true);
    expect(openKitConfig('b1')).toBe(true);
    expect(opened).toBe(1);

    unregister();
    expect(hasKitConfig('b1')).toBe(false);
    expect(openKitConfig('b1')).toBe(false);
  });
});
