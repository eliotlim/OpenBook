import {describe, it, expect} from 'vitest';
import {findEmojiQuery} from '../emojiSuggest';
import {searchEmojis} from '@/lib/emoji';

describe('findEmojiQuery', () => {
  it('detects a `:shortcode` at a word boundary', () => {
    expect(findEmojiQuery('see :hea', 8)).toEqual({colonOffset: 4, query: 'hea'});
    expect(findEmojiQuery(':hea', 4)).toEqual({colonOffset: 0, query: 'hea'}); // start of text
  });

  it('returns an empty query right after a lone `:`', () => {
    expect(findEmojiQuery('hi :', 4)).toEqual({colonOffset: 3, query: ''});
  });

  it('does not trigger on a mid-word colon (time / ratio / url)', () => {
    expect(findEmojiQuery('10:30', 5)).toBeNull();
    expect(findEmojiQuery('a:b', 3)).toBeNull();
    expect(findEmojiQuery('http://x', 7)).toBeNull();
  });

  it('stops at a space between the colon and the caret', () => {
    expect(findEmojiQuery(':he llo', 7)).toBeNull();
  });
});

describe('searchEmojis', () => {
  it('finds emoji by shortcode/name', () => {
    const results = searchEmojis('heart');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => typeof r.emoji === 'string' && r.emoji.length > 0)).toBe(true);
    expect(results.some((r) => r.name.includes('heart'))).toBe(true);
  });

  it('returns nothing for an empty query and respects the limit', () => {
    expect(searchEmojis('')).toEqual([]);
    expect(searchEmojis('a', 3).length).toBeLessThanOrEqual(3);
  });
});
