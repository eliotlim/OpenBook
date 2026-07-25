import {describe, expect, it} from 'vitest';
import {filterUnlinkedMentions, type MentionCandidate} from '../linksFilter';

const hit = (pageId: string, title: string, snippet = ''): MentionCandidate => ({pageId, title, snippet});

describe('filterUnlinkedMentions', () => {
  it('excludes the target page itself', () => {
    const out = filterUnlinkedMentions([hit('self', 'Wolfram Beacon mentions wolfram beacon')], {
      selfId: 'self',
      backlinkIds: new Set(),
      needle: 'wolfram beacon',
    });
    expect(out).toEqual([]);
  });

  it('excludes pages that already link here (backlinks)', () => {
    const out = filterUnlinkedMentions([hit('linker', 'Linking Page', 'about wolfram beacon')], {
      selfId: 'self',
      backlinkIds: new Set(['linker']),
      needle: 'wolfram beacon',
    });
    expect(out).toEqual([]);
  });

  it('dedupes multiple hits from the same page to one row', () => {
    const out = filterUnlinkedMentions(
      [hit('p1', 'Wolfram Beacon notes', 'first chunk'), hit('p1', 'Wolfram Beacon notes', 'second chunk')],
      {selfId: 'self', backlinkIds: new Set(), needle: 'wolfram beacon'},
    );
    expect(out.map((r) => r.pageId)).toEqual(['p1']);
  });

  it('drops fuzzy hits whose title/snippet do not contain the name needle', () => {
    const out = filterUnlinkedMentions([hit('p2', 'Unrelated Page', 'nothing relevant here')], {
      selfId: 'self',
      backlinkIds: new Set(),
      needle: 'wolfram beacon',
    });
    expect(out).toEqual([]);
  });

  it('matches the needle case-insensitively in either title or snippet', () => {
    const out = filterUnlinkedMentions(
      [hit('p3', 'A page', 'discusses WOLFRAM BEACON at length'), hit('p4', 'Wolfram Beacon in the title', 'body')],
      {selfId: 'self', backlinkIds: new Set(), needle: 'wolfram beacon'},
    );
    expect(out.map((r) => r.pageId).sort()).toEqual(['p3', 'p4']);
  });

  it('carries blockId through (null when absent) and trims the snippet', () => {
    const long = `wolfram beacon ${'x'.repeat(300)}`;
    const out = filterUnlinkedMentions([{pageId: 'p5', title: 'T', snippet: long, blockId: 'b1'}], {
      selfId: 'self',
      backlinkIds: new Set(),
      needle: 'wolfram beacon',
    });
    expect(out[0]?.blockId).toBe('b1');
    expect(out[0]?.snippet.endsWith('…')).toBe(true);

    const noBlock = filterUnlinkedMentions([hit('p6', 'Wolfram Beacon', 'x')], {
      selfId: 'self',
      backlinkIds: new Set(),
      needle: 'wolfram beacon',
    });
    expect(noBlock[0]?.blockId).toBeNull();
  });
});
