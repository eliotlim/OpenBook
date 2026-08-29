import React, {useRef} from 'react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {createDoc, findBlock, makeTable, blockPlainText, tableGrid, type CellRect} from '../model';
import type {BlockEditorController} from '../useBlockEditor';
import {TableRangeToolbar} from '../TableRangeToolbar';
import {rangeMenuItems} from '../TableRangeMenuItems';
import {setLocale} from '@/i18n';

const rect2x2: CellRect = {top: 0, left: 0, bottom: 1, right: 1};

const seed = (): {doc: ReturnType<typeof createDoc>; editor: BlockEditorController} => {
  const table = makeTable(2, 2);
  table.id = 'tbl';
  table.children = table.children!.map((row, r) => ({
    ...row,
    children: row.children!.map((cell, c) => ({...cell, text: `cell ${r}-${c}`})),
  }));
  const doc = createDoc([table]);
  return {doc, editor: {doc, readOnly: false} as BlockEditorController};
};

const Harness: React.FC<{
  editor: BlockEditorController;
  rect?: CellRect;
  onDismiss?: () => void;
}> = ({editor, rect = rect2x2, onDismiss = () => undefined}) => {
  const tableRef = useRef<HTMLTableElement>(null);
  const cellRect = (index: number): DOMRect => new DOMRect(50 + (index % 2) * 100, 100 + Math.floor(index / 2) * 50, 100, 50);
  return (
    <div
      className="obe-editor-pane"
      ref={(element) => {
        if (element) vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 20, 380, 480));
      }}
    >
      <table ref={tableRef} tabIndex={-1}>
        <tbody><tr>{[0, 1, 2, 3].map((index) => (
          <td
            key={index}
            className="obe-cell-selected"
            ref={(element) => {
              if (element) vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(cellRect(index));
            }}
          />
        ))}</tr></tbody>
      </table>
      <TableRangeToolbar
        rect={rect}
        tableId="tbl"
        editor={editor}
        tableRef={tableRef}
        onDismiss={onDismiss}
      />
    </div>
  );
};

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {configurable: true, get: () => 200});
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {configurable: true, get: () => 32});
  Object.defineProperty(window, 'innerWidth', {configurable: true, value: 800});
  Object.defineProperty(window, 'innerHeight', {configurable: true, value: 600});
});

afterEach(() => {
  cleanup();
  setLocale('en');
  vi.restoreAllMocks();
});

describe('TableRangeToolbar', () => {
  it('shows for a 2×2 range above its union rect and within the editor pane', () => {
    const {editor} = seed();
    render(<Harness editor={editor} />);
    fireEvent(window, new Event('resize'));
    const toolbar = screen.getByRole('toolbar');
    expect(toolbar.style.visibility).not.toBe('hidden');
    expect(Number.parseFloat(toolbar.style.left)).toBeGreaterThanOrEqual(28);
    expect(Number.parseFloat(toolbar.style.left) + 200).toBeLessThanOrEqual(392);
    expect(Number.parseFloat(toolbar.style.top)).toBeLessThan(100);
  });

  it('does not show for an unmerged 1×1 range or in read-only mode', () => {
    const {editor} = seed();
    const view = render(<Harness editor={editor} />);
    expect(screen.getByRole('toolbar')).toBeTruthy();
    view.rerender(<Harness editor={editor} rect={{top: 0, left: 0, bottom: 0, right: 0}} />);
    expect(screen.queryByRole('toolbar')).toBeNull();
    view.rerender(<Harness editor={{...editor, readOnly: true}} />);
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('renders the shared toolbar label set and Clear empties every selected cell', () => {
    const {doc, editor} = seed();
    const labels = rangeMenuItems({editor, tableId: 'tbl', rect: rect2x2})
      .filter((item) => item.toolbar)
      .map((item) => item.kind === 'separator' ? '' : item.label);
    render(<Harness editor={editor} />);
    const rendered = screen.getAllByTestId('range-action').map((button) => button.getAttribute('aria-label'));
    expect(rendered).toEqual(labels);
    fireEvent.click(screen.getByRole('button', {name: 'Clear contents'}));
    const grid = tableGrid(findBlock(doc, 'tbl')!.block);
    expect(grid.cells.flat().map((cell) => blockPlainText(cell!))).toEqual(['', '', '', '']);
  });

  it('uses German aria labels, roves with arrows, and Escape dismisses then refocuses the table', () => {
    setLocale('de');
    const {editor} = seed();
    const dismiss = vi.fn();
    render(<Harness editor={editor} onDismiss={dismiss} />);
    const toolbar = screen.getByRole('toolbar', {name: 'Aktionen für ausgewählte Zellen'});
    const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>('[data-range-toolbar-button]')];
    expect(buttons.filter((button) => button.tabIndex === 0)).toEqual([buttons[0]]);
    buttons[0].focus();
    fireEvent.keyDown(buttons[0], {key: 'ArrowRight'});
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(document, {key: 'Escape'});
    expect(dismiss).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(document.querySelector('table'));
  });
});
