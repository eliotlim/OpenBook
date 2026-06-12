import {describe, expect, it} from 'vitest';
import {greetingKey, readHomeWidgets, writeHomeWidgets, DEFAULT_HOME_WIDGETS} from '../homePage';

describe('greetingKey', () => {
  it('maps hours to the right salutation', () => {
    expect(greetingKey(5)).toBe('morning');
    expect(greetingKey(11)).toBe('morning');
    expect(greetingKey(12)).toBe('afternoon');
    expect(greetingKey(17)).toBe('afternoon');
    expect(greetingKey(18)).toBe('evening');
    expect(greetingKey(23)).toBe('evening');
    expect(greetingKey(0)).toBe('evening');
    expect(greetingKey(4)).toBe('evening');
  });
});

describe('home widgets persistence', () => {
  it('defaults to everything on and round-trips a customization', () => {
    localStorage.removeItem('openbook.home.widgets');
    expect(readHomeWidgets()).toEqual(DEFAULT_HOME_WIDGETS);
    writeHomeWidgets({...DEFAULT_HOME_WIDGETS, actions: false});
    expect(readHomeWidgets()).toEqual({...DEFAULT_HOME_WIDGETS, actions: false});
    localStorage.removeItem('openbook.home.widgets');
  });
});
