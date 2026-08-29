import {act, fireEvent, render} from '@testing-library/react';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import BlockEditor from '../BlockEditor';
import {createDoc, findBlock, makeTable, setTableColumnWidth, tableColumns, tableColumnWidth} from '../model';

const seed = () => {
  const table = makeTable(2, 3);
  table.id = 'tbl';
  return createDoc([table]);
};

let resizeCallback: ResizeObserverCallback;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({width: 500, height: 120} as DOMRect);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
});

describe('table column resize handles (TBL-12)', () => {
  it('renders widths but hides separators in read-only mode', () => {
    const doc = seed();
    const colId = tableColumns(findBlock(doc, 'tbl')!.block)[0].id;
    setTableColumnWidth(doc, 'tbl', colId, 96);
    const {container} = render(<BlockEditor doc={doc} readOnly />);
    expect(container.querySelector('table')?.classList.contains('obe-table-fixed')).toBe(true);
    const cols = container.querySelectorAll('colgroup > col');
    expect(cols).toHaveLength(tableColumns(findBlock(doc, 'tbl')!.block).length);
    expect((cols[0] as HTMLElement).style.width).toBe('96px');
    expect(container.querySelector('[role="separator"]')).toBeNull();
  });

  it('accounts for the editable row-grip host in the colgroup', () => {
    const doc = seed();
    const {container} = render(<BlockEditor doc={doc} />);
    const cols = container.querySelectorAll('colgroup > col');
    expect(cols).toHaveLength(tableColumns(findBlock(doc, 'tbl')!.block).length + 1);
    expect((cols[0] as HTMLElement).classList.contains('obe-table-grip-host-col')).toBe(true);
    expect((cols[0] as HTMLElement).style.width).toBe('0px');
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
    const table = separator.closest('table')!;
    table.getBoundingClientRect = vi.fn(() => ({width: 500, height: 120}) as DOMRect);
    resizeCallback([{contentRect: {height: 120}} as ResizeObserverEntry], {} as ResizeObserver);
    separator.setPointerCapture = vi.fn();
    separator.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(separator, {pointerId: 1, clientX: 100});
    fireEvent.pointerMove(separator, {pointerId: 1, clientX: 140});
    expect(tableColumnWidth(findBlock(doc, 'tbl')!.block, colId)).toBe(80);
    fireEvent.pointerUp(separator, {pointerId: 1, clientX: 140});
    expect(tableColumnWidth(findBlock(doc, 'tbl')!.block, colId)).toBe(120);
  });

  it('does not commit a click and clears a drag preview on cancel', () => {
    const doc = seed();
    const colId = tableColumns(findBlock(doc, 'tbl')!.block)[0].id;
    setTableColumnWidth(doc, 'tbl', colId, 80);
    const {getByRole, container} = render(<BlockEditor doc={doc} />);
    const separator = getByRole('separator', {name: 'Resize column A'}) as HTMLElement;
    separator.closest('table')!.getBoundingClientRect = vi.fn(() => ({width: 500, height: 120}) as DOMRect);
    resizeCallback([{contentRect: {height: 120}} as ResizeObserverEntry], {} as ResizeObserver);
    separator.setPointerCapture = vi.fn();
    separator.releasePointerCapture = vi.fn();
    separator.hasPointerCapture = vi.fn(() => true);

    fireEvent.pointerDown(separator, {pointerId: 1, clientX: 100});
    fireEvent.pointerUp(separator, {pointerId: 1, clientX: 100});
    expect(tableColumnWidth(findBlock(doc, 'tbl')!.block, colId)).toBe(80);

    fireEvent.pointerDown(separator, {pointerId: 2, clientX: 100});
    fireEvent.pointerMove(separator, {pointerId: 2, clientX: 140});
    expect((container.querySelectorAll('colgroup > col')[1] as HTMLElement).style.width).toBe('120px');
    fireEvent.pointerCancel(separator, {pointerId: 2});
    expect((container.querySelectorAll('colgroup > col')[1] as HTMLElement).style.width).toBe('80px');
    expect(tableColumnWidth(findBlock(doc, 'tbl')!.block, colId)).toBe(80);
  });

  it('uses the observed table height for the full-height grab zone', () => {
    const {getByRole} = render(<BlockEditor doc={seed()} />);
    act(() => resizeCallback([{contentRect: {height: 240}} as ResizeObserverEntry], {} as ResizeObserver));
    expect((getByRole('separator', {name: 'Resize column A'}) as HTMLElement).style.height).toBe('240px');
  });
});
