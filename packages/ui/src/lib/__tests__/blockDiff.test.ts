import {describe, it, expect} from 'vitest';
import type {BlockJSON} from '@/blockeditor/model';
import {diffBlocks, wordDiff, type WordRun} from '../blockDiff';

/**
 * PVH-6 diff engine. Blocks align by id (stable across a page's CRDT lineage):
 * an aligned pair is unchanged or changed, an old-only block is removed, a
 * new-only block is added. Changed text blocks carry a word-level run diff;
 * non-text blocks are reported opaquely at block granularity.
 */

/** A minimal text block. */
const p = (id: string, text: string, type = 'paragraph'): BlockJSON => ({
  id,
  type,
  text: text ? [{t: text}] : [],
});

/** Compact "kept/added/removed" view of word runs for concise assertions. */
const flat = (runs: WordRun[] | undefined): string =>
  (runs ?? [])
    .map((r) => (r.status === 'kept' ? r.value : r.status === 'added' ? `+${r.value}+` : `-${r.value}-`))
    .join('');

describe('diffBlocks', () => {
  it('identical docs produce no changes', () => {
    const doc = [p('a', 'Hello'), p('b', 'World')];
    const diff = diffBlocks(doc, doc.map((b) => ({...b})));
    expect(diff.changed).toBe(false);
    expect(diff.entries.every((e) => e.status === 'unchanged')).toBe(true);
    expect(diff.entries).toHaveLength(2);
  });

  it('detects an added block', () => {
    const oldB = [p('a', 'Hello')];
    const newB = [p('a', 'Hello'), p('b', 'New line')];
    const diff = diffBlocks(oldB, newB);
    expect(diff.changed).toBe(true);
    expect(diff.entries.map((e) => e.status)).toEqual(['unchanged', 'added']);
    expect(diff.entries[1].block.id).toBe('b');
  });

  it('detects a removed block', () => {
    const oldB = [p('a', 'Hello'), p('b', 'Bye')];
    const newB = [p('a', 'Hello')];
    const diff = diffBlocks(oldB, newB);
    expect(diff.entries.map((e) => e.status)).toEqual(['unchanged', 'removed']);
    // A removed entry renders the OLD block.
    expect(diff.entries[1].block.id).toBe('b');
  });

  it('keeps insert/delete ordering around a stable anchor', () => {
    const oldB = [p('a', 'A'), p('c', 'C')];
    const newB = [p('a', 'A'), p('b', 'B'), p('c', 'C')];
    const diff = diffBlocks(oldB, newB);
    expect(diff.entries.map((e) => `${e.status}:${e.block.id}`)).toEqual([
      'unchanged:a',
      'added:b',
      'unchanged:c',
    ]);
  });

  it('reports a changed text block with word-level runs', () => {
    const oldB = [p('a', 'the quick brown fox')];
    const newB = [p('a', 'the slow brown fox')];
    const diff = diffBlocks(oldB, newB);
    expect(diff.entries).toHaveLength(1);
    const entry = diff.entries[0];
    expect(entry.status).toBe('changed');
    expect(entry.opaque).toBeUndefined();
    expect(entry.oldBlock?.id).toBe('a');
    // "quick" removed, "slow" added, the rest kept.
    expect(flat(entry.wordRuns)).toBe('the -quick-+slow+ brown fox');
  });

  it('marks a props-only change (e.g. todo checked) as changed', () => {
    const oldB: BlockJSON[] = [{id: 'a', type: 'todo', text: [{t: 'Ship it'}]}];
    const newB: BlockJSON[] = [{id: 'a', type: 'todo', text: [{t: 'Ship it'}], props: {checked: true}}];
    const diff = diffBlocks(oldB, newB);
    expect(diff.entries[0].status).toBe('changed');
    // Text is identical → the word runs are all kept.
    expect((diff.entries[0].wordRuns ?? []).every((r) => r.status === 'kept')).toBe(true);
  });

  it('handles a non-text (image) block change opaquely — no word diff', () => {
    const oldB: BlockJSON[] = [{id: 'img', type: 'image', props: {src: 'a.png'}}];
    const newB: BlockJSON[] = [{id: 'img', type: 'image', props: {src: 'b.png'}}];
    const diff = diffBlocks(oldB, newB);
    const entry = diff.entries[0];
    expect(entry.status).toBe('changed');
    expect(entry.opaque).toBe(true);
    expect(entry.wordRuns).toBeUndefined();
    expect(entry.oldBlock?.props?.src).toBe('a.png');
    expect(entry.block.props?.src).toBe('b.png');
  });

  it('treats an added and a removed non-text block at block granularity', () => {
    const oldB: BlockJSON[] = [{id: 'chart', type: 'chart', props: {kind: 'bar'}}];
    const newB: BlockJSON[] = [{id: 'table', type: 'table', children: []}];
    const diff = diffBlocks(oldB, newB);
    const statuses = diff.entries.map((e) => `${e.status}:${e.block.id}`);
    expect(statuses).toContain('removed:chart');
    expect(statuses).toContain('added:table');
    expect(diff.entries.every((e) => e.wordRuns === undefined)).toBe(true);
  });

  it('diffs a mix of unchanged / changed / added / removed together', () => {
    const oldB = [p('a', 'keep me'), p('b', 'old text'), p('c', 'delete me')];
    const newB = [p('a', 'keep me'), p('b', 'new text'), p('d', 'fresh')];
    const diff = diffBlocks(oldB, newB);
    expect(diff.entries.map((e) => `${e.status}:${e.block.id}`)).toEqual([
      'unchanged:a',
      'changed:b',
      'removed:c',
      'added:d',
    ]);
  });

  it('empty word diff when text is identical', () => {
    expect(wordDiff('same', 'same')).toEqual([{value: 'same', status: 'kept'}]);
    expect(wordDiff('', '')).toEqual([]);
  });

  it('word diff at the ends (prefix add, suffix remove)', () => {
    expect(flat(wordDiff('world', 'hello world'))).toBe('+hello +world');
    expect(flat(wordDiff('hello world', 'hello'))).toBe('hello- world-');
  });
});
