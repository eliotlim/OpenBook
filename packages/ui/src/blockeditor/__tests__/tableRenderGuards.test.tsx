import {describe, it, expect, afterEach} from 'vitest';
import {render, cleanup} from '@testing-library/react';
import {createDoc, findBlock} from '../model';
import {BlockEditor} from '../BlockEditor';

afterEach(() => cleanup());

/**
 * Render-path defense in depth (STAB-2): a legacy / poisoned table doc — a table
 * inserted as a row child (the STAB-1 paste poison), a table missing `children`,
 * a ragged row, or a cell with no text — must render quiet fallbacks, never
 * throw and white-screen the whole page. Well-formed tables are unchanged.
 */
describe('table render guards (malformed docs never throw)', () => {
  it('renders a fallback for a non-cell block mis-placed as a row child', () => {
    // The exact poison shape: a `table` block sitting where a `cell` should, as
    // a sibling of the real cell inside a `row`.
    const doc = createDoc([
      {
        id: 'tbl',
        type: 'table',
        children: [
          {
            id: 'r',
            type: 'row',
            children: [
              {id: 'c', type: 'cell', text: [{t: 'good'}]},
              {id: 'poison', type: 'table', children: [{type: 'row', children: [{type: 'cell', text: [{t: 'x'}]}]}]},
            ],
          },
        ],
      },
    ]);

    const {container} = render(<BlockEditor doc={doc} />);
    // The good cell still renders as editable text…
    const good = container.querySelector('[data-block-text="c"]');
    expect(good).not.toBeNull();
    expect(good!.textContent).toBe('good');
    // …and the poison renders a quiet fallback rather than throwing.
    const fallback = container.querySelector('.obe-unknown');
    expect(fallback).not.toBeNull();
    expect(fallback!.textContent).toContain('Unsupported cell');
  });

  it('renders a table that is missing its children array without throwing', () => {
    const doc = createDoc([{id: 'tbl', type: 'table', children: [{type: 'row', children: [{type: 'cell', text: [{t: 'a'}]}]}]}]);
    // Simulate a malformed/legacy doc: strip the `children` key entirely.
    const found = findBlock(doc, 'tbl')!;
    doc.transact(() => found.block.delete('children'));

    const {container} = render(<BlockEditor doc={doc} />);
    // The table shell still renders (no rows, no crash).
    expect(container.querySelector('.obe-table')).not.toBeNull();
    expect(container.querySelector('[data-block-text]')).toBeNull();
  });

  it('renders a cell that has no text as an empty editable, never throwing', () => {
    const doc = createDoc([
      {id: 'tbl', type: 'table', children: [{id: 'r', type: 'row', children: [{id: 'c', type: 'cell', text: [{t: 'seed'}]}]}]},
    ]);
    // Strip the cell's `text` — a legacy malformed cell.
    const cell = findBlock(doc, 'c')!;
    doc.transact(() => cell.block.delete('text'));

    const {container} = render(<BlockEditor doc={doc} />);
    const el = container.querySelector('[data-block-text="c"]') as HTMLElement | null;
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe(''); // fell back to an empty Y.Text
  });

  it('pads a ragged table to a rectangle at render', () => {
    const doc = createDoc([
      {
        id: 'tbl',
        type: 'table',
        children: [
          {id: 'r0', type: 'row', children: [{id: 'a', type: 'cell', text: [{t: 'a'}]}, {id: 'b', type: 'cell', text: [{t: 'b'}]}]},
          {id: 'r1', type: 'row', children: [{id: 'c', type: 'cell', text: [{t: 'c'}]}]},
        ],
      },
    ]);
    const {container} = render(<BlockEditor doc={doc} />);
    const trs = container.querySelectorAll('.obe-table tbody > tr');
    expect(trs).toHaveLength(2);
    // Every row has the same number of <td> (widest row wins) — padded cell added.
    expect(trs[0].querySelectorAll('td')).toHaveLength(2);
    expect(trs[1].querySelectorAll('td')).toHaveLength(2);
  });

  it('leaves a well-formed table unchanged', () => {
    const doc = createDoc([
      {
        id: 'tbl',
        type: 'table',
        children: [
          {id: 'r0', type: 'row', children: [{id: 'a', type: 'cell', text: [{t: 'A'}]}, {id: 'b', type: 'cell', text: [{t: 'B'}]}]},
          {id: 'r1', type: 'row', children: [{id: 'c', type: 'cell', text: [{t: 'C'}]}, {id: 'd', type: 'cell', text: [{t: 'D'}]}]},
        ],
      },
    ]);
    const {container} = render(<BlockEditor doc={doc} />);
    expect(container.querySelectorAll('[data-block-text]')).toHaveLength(4);
    expect(container.querySelector('.obe-unknown')).toBeNull();
    expect(container.querySelector('[data-block-text="a"]')!.textContent).toBe('A');
    expect(container.querySelector('[data-block-text="d"]')!.textContent).toBe('D');
  });
});
