import {describe, it, expect} from 'vitest';
import {findMentionQuery} from '../pageMention';

// Caret is the offset within `text`; the query runs from just after `@` to it.
describe('findMentionQuery', () => {
  it('detects @ at the start of the text', () => {
    expect(findMentionQuery('@foo', 4)).toEqual({atOffset: 0, query: 'foo'});
  });

  it('detects @ after a space (word boundary)', () => {
    expect(findMentionQuery('hi @bar', 7)).toEqual({atOffset: 3, query: 'bar'});
  });

  it('returns the partial query up to the caret', () => {
    expect(findMentionQuery('see @hello world', 7)).toEqual({atOffset: 4, query: 'he'});
  });

  it('treats an empty query (just typed @) as open', () => {
    expect(findMentionQuery('a @', 3)).toEqual({atOffset: 2, query: ''});
  });

  it('allows spaces inside the query (multi-word page titles)', () => {
    expect(findMentionQuery('@new york', 9)).toEqual({atOffset: 0, query: 'new york'});
  });

  it('ignores a mid-word @ (e.g. an email)', () => {
    expect(findMentionQuery('me@example', 10)).toBeNull();
  });

  it('stops at a newline before the @', () => {
    expect(findMentionQuery('line\n@x', 7)).toEqual({atOffset: 5, query: 'x'});
    expect(findMentionQuery('@x\nmore', 7)).toBeNull(); // caret past the newline
  });

  it('returns null when there is no @ before the caret', () => {
    expect(findMentionQuery('plain text', 10)).toBeNull();
  });

  it('uses the nearest @, rejecting it when mid-word', () => {
    expect(findMentionQuery('@a@b', 4)).toBeNull(); // nearest @ (before 'b') follows 'a'
  });

  it('gives up once the query exceeds the cap', () => {
    const long = '@' + 'x'.repeat(70);
    expect(findMentionQuery(long, long.length)).toBeNull();
  });
});
