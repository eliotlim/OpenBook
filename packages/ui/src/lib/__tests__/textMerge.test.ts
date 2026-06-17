import {describe, it, expect} from 'vitest';
import {merge3} from '../textMerge';

/**
 * The 3-way merge is what stops a second accepted suggestion from clobbering
 * the first when both edit the same block. Disjoint edits must both survive;
 * a genuine overlap resolves to `theirs` (the change being accepted).
 */
describe('merge3', () => {
  it('takes theirs when ours is unchanged from base', () => {
    expect(merge3('Hello', 'Hello', 'Hello world')).toBe('Hello world');
  });

  it('keeps ours when theirs is a no-op', () => {
    expect(merge3('Hello', 'Hello world', 'Hello')).toBe('Hello world');
  });

  it('combines disjoint word edits from both sides', () => {
    // ours changes "quick"→"slow"; theirs changes "fox"→"dog".
    const merged = merge3('the quick brown fox', 'the slow brown fox', 'the quick brown dog');
    expect(merged).toBe('the slow brown dog');
  });

  it('combines edits at opposite ends', () => {
    const merged = merge3('one two three', 'ONE two three', 'one two THREE');
    expect(merged).toBe('ONE two THREE');
  });

  it('resolves a true overlap in favour of theirs', () => {
    // Both rewrite the word after "Hello" differently — a real conflict.
    expect(merge3('Hello', 'Hello world', 'Hello there')).toBe('Hello there');
  });

  it('preserves an insertion from ours while applying theirs elsewhere', () => {
    const merged = merge3('a b c', 'a b c d', 'a X c');
    expect(merged).toBe('a X c d');
  });

  it('is idempotent when ours already equals theirs', () => {
    expect(merge3('base', 'same', 'same')).toBe('same');
  });
});
