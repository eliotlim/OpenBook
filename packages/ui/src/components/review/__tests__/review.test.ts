import {describe, it, expect} from 'vitest';
import type {StoredSuggestion} from '@book.dev/sdk';
import {suggestionToProposal} from '@/lib/aiBridge';
import {domToRuns, runsToHtml, runsHaveText} from '@/blockeditor/RichTextEditor';

/**
 * The load-bearing conversions for the review layer:
 *  - a persisted suggestion → the proposal shape the editor bridge replays
 *    (so AI and human suggestions apply through identical code), and
 *  - the comment composer's runs ↔ HTML round-trip (rich text persistence).
 */

const baseSuggestion = (over: Partial<StoredSuggestion>): StoredSuggestion => ({
  id: 's1',
  pageId: 'page-1',
  authorKind: 'human',
  authorName: 'You',
  kind: 'replace-text',
  target: {blockId: 'b1'},
  before: 'old',
  after: 'new',
  status: 'open',
  payload: {applyKind: 'update_block', pageId: 'page-1', blockId: 'b1', text: 'new', summary: 'Suggested edit'},
  createdAt: '2026-06-14T00:00:00.000Z',
  updatedAt: '2026-06-14T00:00:00.000Z',
  ...over,
});

describe('suggestionToProposal', () => {
  it('reconstructs the proposal kind from payload.applyKind', () => {
    const p = suggestionToProposal(baseSuggestion({}));
    expect(p.kind).toBe('update_block');
    expect(p.pageId).toBe('page-1');
    expect(p.payload).toMatchObject({blockId: 'b1', text: 'new'});
    expect(p.summary).toBe('Suggested edit');
    expect(p.before).toBe('old');
    expect(p.after).toBe('new');
  });

  it('maps an append (insert) suggestion back to append_blocks', () => {
    const s = baseSuggestion({
      kind: 'insert',
      target: {},
      payload: {applyKind: 'append_blocks', pageId: 'page-1', blocks: [{type: 'paragraph', text: 'hi'}], summary: 'Append'},
    });
    const p = suggestionToProposal(s);
    expect(p.kind).toBe('append_blocks');
    expect(p.payload.blocks).toEqual([{type: 'paragraph', text: 'hi'}]);
  });

  it('maps a set-cell suggestion back to set_db_cell', () => {
    const s = baseSuggestion({
      kind: 'set-cell',
      target: {databaseId: 'db1', rowId: 'r1', propertyId: 'p1'},
      payload: {applyKind: 'set_db_cell', databaseId: 'db1', rowId: 'r1', propertyId: 'p1', value: 5, summary: 'Set cell'},
    });
    const p = suggestionToProposal(s);
    expect(p.kind).toBe('set_db_cell');
    expect(p.payload).toMatchObject({databaseId: 'db1', rowId: 'r1', propertyId: 'p1', value: 5});
  });

  it('falls back to update_block when applyKind is missing', () => {
    const s = baseSuggestion({payload: {pageId: 'page-1', blockId: 'b1', text: 'x'}});
    expect(suggestionToProposal(s).kind).toBe('update_block');
  });
});

describe('rich-text comment round-trip', () => {
  it('renders runs to inline HTML with formatting + links', () => {
    const html = runsToHtml([
      {t: 'plain '},
      {t: 'bold', a: {b: true}},
      {t: ' '},
      {t: 'link', a: {a: 'https://x.test'}},
    ]);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<a href="https://x.test">link</a>');
  });

  it('escapes HTML-significant characters', () => {
    expect(runsToHtml([{t: 'a < b & "c"'}])).toContain('a &lt; b &amp; "c"');
  });

  it('reads a contentEditable surface back into runs (b/i/u/links survive)', () => {
    const root = document.createElement('div');
    root.innerHTML = 'hi <strong>bold</strong> <em>it</em> <a href="https://x.test">l</a>';
    const runs = domToRuns(root);
    const bold = runs.find((r) => r.a?.b);
    const ital = runs.find((r) => r.a?.i);
    const link = runs.find((r) => r.a?.a);
    expect(bold?.t).toBe('bold');
    expect(ital?.t).toBe('it');
    expect(link?.a?.a).toBe('https://x.test');
  });

  it('runsHaveText reflects whether there is visible text', () => {
    expect(runsHaveText([])).toBe(false);
    expect(runsHaveText([{t: '   '}])).toBe(false);
    expect(runsHaveText([{t: 'hello'}])).toBe(true);
  });
});
