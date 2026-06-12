import {describe, expect, it} from 'vitest';
import {initialsOf, monogramHue} from '../ProfileAvatar';

describe('initialsOf', () => {
  it('takes the first letter of the first two words, uppercased', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('ada')).toBe('A');
    expect(initialsOf('  grace  brewster  hopper ')).toBe('GB');
  });

  it('handles non-Latin and astral-plane names without splitting surrogates', () => {
    expect(initialsOf('张 伟')).toBe('张伟');
    expect(initialsOf('𝔄da 𝔏ovelace')).toBe('𝔄𝔏');
  });

  it('is empty for an empty name (callers pass a fallback name instead)', () => {
    expect(initialsOf('')).toBe('');
  });
});

describe('monogramHue', () => {
  it('is deterministic and varies across names', () => {
    expect(monogramHue('Ada Lovelace')).toBe(monogramHue('Ada Lovelace'));
    const hues = new Set(['Ada', 'Grace', 'Alan', 'Edsger', 'Barbara', 'Donald'].map(monogramHue));
    expect(hues.size).toBeGreaterThan(1);
  });
});
