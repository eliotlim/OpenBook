import {describe, expect, it} from 'vitest';
import {normalizeRuns, parseMiniMarkdown, RichTextInputError} from './richTextInput';

describe('parseMiniMarkdown', () => {
  it.each([
    ['**bold**', [{t: 'bold', a: {b: true}}]],
    ['*italic*', [{t: 'italic', a: {i: true}}]],
    ['_italic_', [{t: 'italic', a: {i: true}}]],
    ['`code`', [{t: 'code', a: {c: true}}]],
    ['~~strike~~', [{t: 'strike', a: {s: true}}]],
  ])('parses %s', (input, expected) => expect(parseMiniMarkdown(input)).toEqual(expected));

  it('nests marks', () => expect(parseMiniMarkdown('**bold *italic***')).toEqual([
    {t: 'bold ', a: {b: true}},
    {t: 'italic', a: {i: true, b: true}},
  ]));
  it.each(['snake_case_name', 'C:\\path_to\\file_name.txt', '__bold__'])(
    'keeps intraword underscores literal in %s',
    (input) => expect(parseMiniMarkdown(input)).toEqual([{t: input}]),
  );
  it.each([
    ['`a_b_c`', 'a_b_c'],
    ['`**x**`', '**x**'],
  ])('keeps code span contents literal in %s', (input, text) => expect(parseMiniMarkdown(input)).toEqual([{t: text, a: {c: true}}]));
  it('unescapes supported punctuation', () => expect(parseMiniMarkdown('\\*literal\\*')).toEqual([{t: '*literal*'}]));
  it('keeps unbalanced markers literal', () => expect(parseMiniMarkdown('before **after')).toEqual([{t: 'before **after'}]));
  it('parses safe links', () => expect(parseMiniMarkdown('[site](https://x.test)')).toEqual([{t: 'site', a: {a: 'https://x.test'}}]));
  it.each(['/p/abc', '#x'])('parses internal link %s', (href) => expect(parseMiniMarkdown(`[site](${href})`)).toEqual([{t: 'site', a: {a: href}}]));
  it('strips a trailing link title', () => expect(parseMiniMarkdown('[site](https://x.test "title")')).toEqual([{t: 'site', a: {a: 'https://x.test'}}]));
  it('keeps an unparseable title-bearing link literal', () => expect(parseMiniMarkdown('[site](not a url \'title\')')).toEqual([{t: '[site](not a url \'title\')'}]));
  it('rejects unsafe links with a typed error', () => expect(() => parseMiniMarkdown('[x](javascript:alert(1))')).toThrow(RichTextInputError));
  it('rejects data links with a typed error', () => expect(() => parseMiniMarkdown('[x](data:text/plain,x)')).toThrow(RichTextInputError));
  it('stores empty text as no runs', () => expect(parseMiniMarkdown('')).toEqual([]));
  it('leaves wikilinks literal because titles cannot resolve to page ids headlessly', () => expect(parseMiniMarkdown('[[Page Title]]')).toEqual([{t: '[[Page Title]]'}]));
  it('preserves ordinary strings byte-for-byte', () => expect(parseMiniMarkdown('plain <text> & bytes')).toEqual([{t: 'plain <text> & bytes'}]));
});

describe('normalizeRuns', () => {
  it('merges adjacent identical attrs', () => expect(normalizeRuns([{t: 'a', a: {b: true}}, {t: 'b', a: {b: true}}])).toEqual([{t: 'ab', a: {b: true}}]));
  it('rejects unknown marks', () => expect(() => normalizeRuns([{t: 'x', a: {blink: true}}])).toThrow(RichTextInputError));
  it('rejects unsafe explicit links', () => expect(() => normalizeRuns([{t: 'x', a: {a: 'data:text/html,x'}}])).toThrow(RichTextInputError));
});
