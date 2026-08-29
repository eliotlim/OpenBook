import {fireEvent, render} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import BlockEditor from '../BlockEditor';
import {createDoc, findBlock, makeTable, setTableColumnWidth, tableColumns, tableColumnWidth} from '../model';

const seed = () => {
  const table = makeTable(2, 3);
  table.id = 'tbl';
  return createDoc([table]);
};

describe('table column resize handles (TBL-12)', () => {
  it('renders widths but hides separators in read-only mode', () => {
    const doc = seed();
    const colId = tableColumns(findBlock(doc, 'tbl')!.block)[0].id;
    setTableColumnWidth(doc, 'tbl', colId, 96);
    const {container} = render(<BlockEditor doc={doc} readOnly />);
    expect(container.querySelector('table')?.classList.contains('obe-table-fixed')).toBe(true);
    expect((container.querySelector('col') as HTMLElement).style.width).toBe('96px');
    expect(container.querySelector('[role="separator"]')).toBeNull();
  });

  it('exposes aria and commits keyboard increments', () => {
    const doc = seed();
    const colId = tableColumns(findBlock(doc, 'tbl')!.block)[0].id;
    setTableColumnWidth(doc, 'tbl', colId, 80);
    const {getByRole} = render(<BlockEditor doc={doc} />);
    const separator = getByRole('separator', {name: 'Resize column A'});
    expect(separator.getAttribute('aria-orientation')).toBe('vertical');
    expect(separator.getAttribute('aria-valuenow')).toBe('80');
    fireEvent.keyDown(separator, {key: 'ArrowRight'});
    expect(tableColumnWidth(findBlock(doc, 'tbl')!.block, colId)).toBe(88);
    fireEvent.keyDown(separator, {key: 'ArrowRight', shiftKey: true});
    expect(tableColumnWidth(findBlock(doc, 'tbl')!.block, colId)).toBe(120);
  });

  it('previews a pointer drag and commits only on pointerup', () => {
    const doc = seed();
    const colId = tableColumns(findBlock(doc, 'tbl')!.block)[0].id;
    setTableColumnWidth(doc, 'tbl', colId, 80);
    const {getByRole} = render(<BlockEditor doc={doc} />);
    const separator = getByRole('separator', {name: 'Resize column A'}) as HTMLElement;
    separator.setPointerCapture = vi.fn();
    separator.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(separator, {pointerId: 1, clientX: 100});
    fireEvent.pointerMove(separator, {pointerId: 1, clientX: 140});
    expect(tableColumnWidth(findBlock(doc, 'tbl')!.block, colId)).toBe(80);
    fireEvent.pointerUp(separator, {pointerId: 1, clientX: 140});
    expect(tableColumnWidth(findBlock(doc, 'tbl')!.block, colId)).toBe(120);
  });
});
