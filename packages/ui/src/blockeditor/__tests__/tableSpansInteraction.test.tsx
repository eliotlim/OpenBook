import {afterEach, describe, expect, it} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {BlockEditor} from '../BlockEditor';
import {blockProp, createDoc, findBlock, tableGrid} from '../model';

afterEach(() => cleanup());

const mergedDoc = () =>
  createDoc([
    {
      id: 'tbl',
      type: 'table',
      props: {header: false, 'col:c0': 'a0', 'col:c1': 'a1', 'col:c2': 'a2'},
      children: [
        {id: 'row0', type: 'row', props: {ord: 'a0'}, children: [
          {id: 'anchor', type: 'cell', props: {col: 'c0', colspan: 2, rowspan: 2}, text: 'merged'},
          {id: 'r0c2', type: 'cell', props: {col: 'c2'}, text: 'r0c2'},
        ]},
        {id: 'row1', type: 'row', props: {ord: 'a1'}, children: [
          {id: 'r1c2', type: 'cell', props: {col: 'c2'}, text: 'r1c2'},
        ]},
        {id: 'row2', type: 'row', props: {ord: 'a2'}, children: [
          {id: 'r2c0', type: 'cell', props: {col: 'c0'}, text: 'r2c0'},
          {id: 'r2c1', type: 'cell', props: {col: 'c1'}, text: 'r2c1'},
          {id: 'r2c2', type: 'cell', props: {col: 'c2'}, text: 'r2c2'},
        ]},
      ],
    },
  ]);

const selectNative = (container: HTMLElement, from: string, to: string): void => {
  const a = container.querySelector(`[data-block-text="${from}"]`)!;
  const b = container.querySelector(`[data-block-text="${to}"]`)!;
  const range = document.createRange();
  range.setStart(a, 0);
  range.setEnd(b, b.childNodes.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent(document, new Event('selectionchange'));
  fireEvent.mouseUp(document);
};

describe('TBL-8 editor spans', () => {
  it('renders native colspan/rowspan and omits every covered td', () => {
    const {container} = render(<BlockEditor doc={mergedDoc()} />);
    const anchor = container.querySelector('[data-block-text="anchor"]')!.closest('td')!;
    expect(anchor.colSpan).toBe(2);
    expect(anchor.rowSpan).toBe(2);
    const rows = container.querySelectorAll('.obe-table tbody > tr');
    expect([...rows].map((row) => row.querySelectorAll('td').length)).toEqual([2, 1, 3]);
  });

  it('snaps a selection touching one row of a merged cell to the whole span', () => {
    const {container} = render(<BlockEditor doc={mergedDoc()} />);
    selectNative(container, 'anchor', 'r0c2');
    const selected = [...container.querySelectorAll('td.obe-cell-selected')].map(
      (td) => td.querySelector('[data-block-text]')?.getAttribute('data-block-text'),
    );
    expect(new Set(selected)).toEqual(new Set(['anchor', 'r0c2', 'r1c2']));
  });

  it('offers Split cell on a merged anchor and restores constituent cells', () => {
    const doc = mergedDoc();
    const {container} = render(<BlockEditor doc={doc} />);
    const anchor = container.querySelector('[data-block-text="anchor"]')!.closest('td')!;
    fireEvent.contextMenu(anchor);
    fireEvent.click(screen.getByText('Split cell'));
    expect(blockProp(findBlock(doc, 'anchor')!.block, 'colspan')).toBeUndefined();
    expect(tableGrid(findBlock(doc, 'tbl')!.block).cells.every((row) => row.every(Boolean))).toBe(true);
  });
});
