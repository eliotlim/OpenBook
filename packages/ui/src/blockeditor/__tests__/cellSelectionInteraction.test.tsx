import {describe, it, expect, afterEach} from 'vitest';
import {render, cleanup, fireEvent} from '@testing-library/react';
import {createDoc, findBlock, blockText} from '../model';
import {registerArtifactKit} from '../kit';
import {BlockEditor} from '../BlockEditor';

afterEach(() => cleanup());
registerArtifactKit();

// TBL-5 — interaction regressions for multi-cell selection driven through the
// live editor (the native-selection converter, highlight, and clear keyboard),
// complementing the pure maths in cellRange.test.ts.

/** A page: a leading paragraph, a 2×2 keyed table, a trailing paragraph. */
const seed = () =>
  createDoc([
    {id: 'lead', type: 'paragraph', text: [{t: 'lead'}]},
    {
      id: 'tbl',
      type: 'table',
      props: {header: false, 'col:c0': 'a0', 'col:c1': 'a1'},
      children: [
        {id: 'row0', type: 'row', props: {ord: 'a0'}, children: [
          {id: 'r0c0', type: 'cell', props: {col: 'c0'}, text: [{t: 'A1'}]},
          {id: 'r0c1', type: 'cell', props: {col: 'c1'}, text: [{t: 'B1'}]},
        ]},
        {id: 'row1', type: 'row', props: {ord: 'a1'}, children: [
          {id: 'r1c0', type: 'cell', props: {col: 'c0'}, text: [{t: 'A2'}]},
          {id: 'r1c1', type: 'cell', props: {col: 'c1'}, text: [{t: 'B2'}]},
        ]},
      ],
    },
    {id: 'tail', type: 'paragraph', text: [{t: 'tail'}]},
  ]);

const build = (readOnly = false) => {
  const doc = seed();
  const {container} = render(<BlockEditor doc={doc} readOnly={readOnly} />);
  const el = (id: string) => container.querySelector(`[data-block-text="${id}"]`) as HTMLElement;
  const selectedCells = () =>
    Array.from(container.querySelectorAll('td.obe-cell-selected')).map(
      (td) => (td.querySelector('[data-block-text]') as HTMLElement | null)?.dataset.blockText,
    );
  const selectedRows = () =>
    Array.from(container.querySelectorAll('.obe-row-selected')).map((r) => (r as HTMLElement).dataset.blockRow);
  // Drive a native DOM selection between two block-text elements, then fire the
  // selectionchange the editor listens on.
  const nativeSelect = (fromId: string, toId: string) => {
    const range = document.createRange();
    range.setStart(el(fromId), 0);
    range.setEnd(el(toId), el(toId).childNodes.length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent(document, new Event('selectionchange'));
  };
  return {doc, container, el, selectedCells, selectedRows, nativeSelect};
};

describe('native span → cell-range selection (acceptance #5)', () => {
  it('a span WITHIN one table highlights the rectangle, not a block', () => {
    const {selectedCells, selectedRows, nativeSelect} = build();
    nativeSelect('r0c0', 'r1c1');
    expect(new Set(selectedCells())).toEqual(new Set(['r0c0', 'r0c1', 'r1c0', 'r1c1']));
    expect(selectedRows()).toEqual([]); // NOT a block selection
  });

  it('a span crossing the table boundary becomes a BLOCK selection, no cell highlight', () => {
    const {selectedCells, selectedRows, nativeSelect} = build();
    nativeSelect('r0c0', 'tail'); // cell → trailing paragraph
    expect(selectedCells()).toEqual([]);
    expect(selectedRows().length).toBeGreaterThan(1);
  });

  it('a span within a SINGLE cell stays native text (no cell selection)', () => {
    const {selectedCells, nativeSelect} = build();
    nativeSelect('r0c0', 'r0c0');
    expect(selectedCells()).toEqual([]);
  });
});

describe('cell-range keyboard', () => {
  it('Backspace clears every selected cell in one undo step; Escape clears the selection', () => {
    const {doc, selectedCells, nativeSelect} = build();
    nativeSelect('r0c0', 'r1c1');
    fireEvent.mouseUp(document);
    const textOf = (id: string) => blockText(findBlock(doc, id)!.block)!.toString();

    fireEvent.keyDown(document, {key: 'Backspace'});
    expect([textOf('r0c0'), textOf('r0c1'), textOf('r1c0'), textOf('r1c1')]).toEqual(['', '', '', '']);

    // One undo (routed through the range keyboard) restores every cleared cell.
    fireEvent.keyDown(document, {key: 'z', metaKey: true});
    expect([textOf('r0c0'), textOf('r0c1'), textOf('r1c0'), textOf('r1c1')]).toEqual(['A1', 'B1', 'A2', 'B2']);

    // Highlight persists after a clear; Escape drops it.
    expect(selectedCells().length).toBe(4);
    fireEvent.keyDown(document, {key: 'Escape'});
    expect(selectedCells()).toEqual([]);
  });

  it('read-only: selection is allowed but Backspace never clears (acceptance #4)', () => {
    const {doc, selectedCells, nativeSelect} = build(true);
    nativeSelect('r0c0', 'r1c1');
    expect(selectedCells().length).toBe(4); // selection works read-only
    fireEvent.mouseUp(document);
    fireEvent.keyDown(document, {key: 'Backspace'});
    const textOf = (id: string) => blockText(findBlock(doc, id)!.block)!.toString();
    expect([textOf('r0c0'), textOf('r1c1')]).toEqual(['A1', 'B2']); // unchanged
  });
});
