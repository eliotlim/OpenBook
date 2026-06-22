import {describe, it, expect} from 'vitest';
import {extractMentionIds} from '@book.dev/sdk';

const para = (html: string) => ({type: 'paragraph', data: {text: html}});
const snap = (...blocks: object[]) => ({editorjs: {blocks}});

describe('extractMentionIds', () => {
  it('extracts a mention id from an inline anchor', () => {
    const ids = extractMentionIds(snap(para('hi <a class="ob-mention" data-page-id="P1">📄 x</a> there')));
    expect(ids).toEqual(['P1']);
  });

  it('dedupes and preserves first-seen order across blocks', () => {
    const ids = extractMentionIds(
      snap(
        para('<a data-page-id="A"></a> and <a data-page-id="B"></a>'),
        para('again <a data-page-id="A"></a>'),
      ),
    );
    expect(ids).toEqual(['A', 'B']);
  });

  it('returns [] when there are no mentions', () => {
    expect(extractMentionIds(snap(para('plain text, no links')))).toEqual([]);
  });

  it('ignores the words "data-page-id" not used as an attribute', () => {
    expect(extractMentionIds(snap(para('the data-page-id concept mentions P9 in prose')))).toEqual([]);
  });

  it('handles an empty / missing document', () => {
    expect(extractMentionIds({editorjs: {blocks: []}})).toEqual([]);
    expect(extractMentionIds({editorjs: undefined as unknown as object})).toEqual([]);
  });
});
