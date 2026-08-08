import {describe, it, expect, afterEach, vi} from 'vitest';
import {render, screen, cleanup, fireEvent} from '@testing-library/react';
import * as Y from 'yjs';
import {createDoc, findBlock, blockText, tableCellOwnColor} from '../model';
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

// ── TBL-6: the range-aware context menu, driven live ─────────────────────────
// The menu variant is decided by the rect the table hands down from the
// CellSelectionContext — so these drive the whole path: native span → range →
// right-click → the range items acting on every selected cell.

describe('range-aware cell context menu (TBL-6)', () => {
  /** A 3×3 keyed table, no header, cells reading "r<row>c<col>". */
  const seed3 = (ragged = false) =>
    createDoc([
      {
        id: 'tbl',
        type: 'table',
        props: {header: false, 'col:c0': 'a0', 'col:c1': 'a1', 'col:c2': 'a2'},
        children: [0, 1, 2].map((r) => ({
          id: `row${r}`,
          type: 'row' as const,
          props: {ord: `a${r}`},
          children: [0, 1, 2]
            .filter((c) => !(ragged && r === 1 && c === 1))
            .map((c) => ({
              id: `r${r}c${c}`,
              type: 'cell' as const,
              props: {col: `c${c}`},
              text: [{t: `r${r}c${c}`}],
            })),
        })),
      },
    ]);

  const build3 = (doc = seed3()) => {
    const {container} = render(<BlockEditor doc={doc} readOnly={false} />);
    const el = (id: string) => container.querySelector(`[data-block-text="${id}"]`) as HTMLElement;
    const tdOf = (id: string) => el(id).closest('td') as HTMLElement;
    /** Lay down a native intra-table span, then let the editor convert it. */
    const selectRange = (fromId: string, toId: string) => {
      const range = document.createRange();
      range.setStart(el(fromId), 0);
      range.setEnd(el(toId), el(toId).childNodes.length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      fireEvent(document, new Event('selectionchange'));
      fireEvent.mouseUp(document);
    };
    const selectedCells = () => container.querySelectorAll('td.obe-cell-selected').length;
    /**
     * A REAL right-click: the secondary mousedown lands first, then contextmenu.
     * Firing only `contextMenu` would hide the two ways a live browser drops the
     * range before the menu even mounts (the root's "any fresh press starts
     * over" reset, and React's portal event propagation) — see the guards in
     * BlockEditor's root onMouseDown / the cell capture handler.
     */
    const rightClick = (td: HTMLElement) => {
      fireEvent.mouseDown(td, {button: 2, buttons: 2});
      fireEvent.contextMenu(td);
    };
    return {doc, container, el, tdOf, selectRange, selectedCells, rightClick};
  };

  it('a 2×3 selection + a right-click INSIDE it opens the range menu', () => {
    const {tdOf, selectRange, selectedCells, rightClick} = build3();
    selectRange('r0c0', 'r1c2'); // rows 0–1 × columns 0–2
    expect(selectedCells()).toBe(6);
    rightClick(tdOf('r1c1'));
    expect(selectedCells()).toBe(6); // the press did NOT collapse the range
    expect(screen.getByText('Selection · 2 × 3')).toBeTruthy();
    expect(screen.getByText('Clear contents')).toBeTruthy();
    expect(screen.getByText('Delete 2 rows')).toBeTruthy();
    expect(screen.getByText('Delete table')).toBeTruthy();
    expect(screen.queryByText('Duplicate row')).toBeNull();
  });

  it('a right-click OUTSIDE the rect collapses it and keeps the single-cell menu', () => {
    const {tdOf, selectRange, selectedCells, rightClick} = build3();
    selectRange('r0c0', 'r1c2');
    rightClick(tdOf('r2c0')); // row 2 — below the rectangle
    expect(screen.getByText('Duplicate row')).toBeTruthy();
    expect(screen.getByText('Toggle header row')).toBeTruthy();
    expect(screen.queryByText(/Selection ·/)).toBeNull();
    expect(screen.queryByText('Clear contents')).toBeNull();
    // A press outside the rectangle is an ordinary fresh press: it starts over.
    expect(selectedCells()).toBe(0);
  });

  it('with NO range live, every cell still opens the single-cell menu', () => {
    const {tdOf, rightClick} = build3();
    rightClick(tdOf('r1c1'));
    expect(screen.getByText('Duplicate row')).toBeTruthy();
    expect(screen.queryByText('Clear contents')).toBeNull();
  });

  it('a 1×1 shift range collapses on right-click and keeps the full single-cell menu', () => {
    const {tdOf, selectRange, selectedCells, rightClick} = build3();
    const td = tdOf('r1c1');
    // Collapse the focus corner back onto the anchor with Shift+ArrowUp. This
    // leaves the same 1×1 rectangle produced by a single shift extension from
    // an out-of-table caret, without coupling the test to block-row capture.
    selectRange('r0c1', 'r1c1');
    fireEvent.keyDown(document, {key: 'ArrowUp', shiftKey: true});
    expect(selectedCells()).toBe(1);
    rightClick(td);
    expect(selectedCells()).toBe(0); // the secondary press was not swallowed
    expect(screen.getByText('Duplicate row')).toBeTruthy();
    expect(screen.getByText('Toggle header row')).toBeTruthy();
    expect(screen.queryByText('Clear contents')).toBeNull();
  });

  it('a selected ragged-row pad cell preserves the range and opens its range menu', () => {
    const {container, selectRange, selectedCells, rightClick} = build3(seed3(true));
    selectRange('r0c0', 'r1c2');
    expect(selectedCells()).toBe(6); // five cell blocks + the highlighted pad td
    const pad = container.querySelectorAll('.obe-table tr')[1].querySelectorAll('td')[1] as HTMLElement;
    expect(pad.querySelector('[data-block-text]')).toBeNull();

    rightClick(pad);
    expect(selectedCells()).toBe(6);
    expect(screen.getByText('Selection · 2 × 3')).toBeTruthy();
    expect(screen.getByText('Clear contents')).toBeTruthy();
    expect(screen.getByText('Cell colour')).toBeTruthy();
    expect(screen.queryByText('Duplicate row')).toBeNull();
  });

  // React events travel the COMPONENT tree, so a press inside the portaled menu
  // (a child of a trigger nested in the editor) reaches the editor root's
  // mousedown. Without the root's "target outside my subtree" guard that reset
  // dropped the range mid-menu, unmounting the submenu before its onSelect ran —
  // the tint silently did nothing in a real browser.
  it('a press inside the portaled menu does not drop the range', () => {
    const {tdOf, selectRange, selectedCells, rightClick} = build3();
    selectRange('r0c0', 'r1c2');
    rightClick(tdOf('r1c1'));
    fireEvent.mouseDown(screen.getByText('Cell colour'), {button: 0});
    expect(selectedCells()).toBe(6);
    expect(screen.getByText('Delete 2 rows')).toBeTruthy(); // still the range variant
  });

  it('Cell colour paints every selected cell, and only those, in the live table', () => {
    const {doc, tdOf, selectRange, rightClick} = build3();
    selectRange('r0c0', 'r1c2');
    rightClick(tdOf('r1c1'));
    fireEvent.mouseDown(screen.getByText('Cell colour'), {button: 0});
    fireEvent.click(screen.getByText('Cell colour'));
    fireEvent.click(screen.getByText('Green'));

    for (const id of ['r0c0', 'r0c1', 'r0c2', 'r1c0', 'r1c1', 'r1c2']) {
      expect(tdOf(id).classList.contains('obe-bg-green'), id).toBe(true);
      // The selection survives the tint (the range stays actionable).
      expect(tdOf(id).classList.contains('obe-cell-selected'), id).toBe(true);
    }
    for (const id of ['r2c0', 'r2c1', 'r2c2']) {
      expect(tdOf(id).classList.contains('obe-bg-green'), id).toBe(false);
    }

    // Survives a reload: round-trip the doc and re-render from scratch.
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(doc));
    expect(tableCellOwnColor(findBlock(reloaded, 'r1c2')!.block)).toBe('green');
    cleanup();
    const {container} = render(<BlockEditor doc={reloaded} readOnly={false} />);
    const reloadedTd = (id: string) =>
      (container.querySelector(`[data-block-text="${id}"]`) as HTMLElement).closest('td') as HTMLElement;
    expect(reloadedTd('r0c0').classList.contains('obe-bg-green')).toBe(true);
    expect(reloadedTd('r2c0').classList.contains('obe-bg-green')).toBe(false);
  });

  it('Delete N rows removes exactly the selected rows and drops the highlight', () => {
    const {doc, container, tdOf, selectRange, rightClick} = build3();
    selectRange('r0c0', 'r1c2');
    rightClick(tdOf('r0c1'));
    fireEvent.click(screen.getByText('Delete 2 rows'));

    expect(findBlock(doc, 'row0')).toBeNull();
    expect(findBlock(doc, 'row1')).toBeNull();
    expect(findBlock(doc, 'row2')).toBeTruthy();
    expect(container.querySelectorAll('tr')).toHaveLength(1);
    // The rectangle addressed slots that no longer exist — it is gone.
    expect(container.querySelectorAll('td.obe-cell-selected')).toHaveLength(0);
  });

  it('Clear contents empties exactly the selected cells', () => {
    const {doc, tdOf, selectRange, rightClick} = build3();
    selectRange('r0c0', 'r1c2');
    rightClick(tdOf('r0c0'));
    fireEvent.click(screen.getByText('Clear contents'));
    const textOf = (id: string) => blockText(findBlock(doc, id)!.block)!.toString();
    expect([textOf('r0c0'), textOf('r0c2'), textOf('r1c1')]).toEqual(['', '', '']);
    expect(textOf('r2c0')).toBe('r2c0'); // outside the range
  });
});

describe('cell drag-select teardown (leak guard)', () => {
  it('unmount mid drag detaches the gesture window listeners — no stray move on a dead tree', () => {
    // Track live window mousemove/mouseup listeners so we can prove the
    // per-gesture pair armed by startCellDrag is detached when the editor
    // unmounts mid-drag (otherwise the next move runs cellPosition on a
    // detached doc + setCellSel on an unmounted tree).
    const live = new Set<EventListenerOrEventListenerObject>();
    const origAdd = window.addEventListener.bind(window);
    const origRemove = window.removeEventListener.bind(window);
    const addSpy = vi
      .spyOn(window, 'addEventListener')
      .mockImplementation((type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) => {
        if (!fn) return;
        if (type === 'mousemove' || type === 'mouseup') live.add(fn);
        return origAdd(type, fn, opts);
      });
    const removeSpy = vi
      .spyOn(window, 'removeEventListener')
      .mockImplementation((type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) => {
        if (!fn) return;
        if (type === 'mousemove' || type === 'mouseup') live.delete(fn);
        return origRemove(type, fn, opts);
      });

    const doc = seed();
    const {container, unmount} = render(<BlockEditor doc={doc} readOnly={false} />);
    const cell = container.querySelector('[data-block-text="r0c0"]') as HTMLElement;

    // Press inside a cell → arms the coordinate-tracked cell drag (window
    // mousemove + mouseup); the marquee no-ops inside a contenteditable.
    const before = new Set(live);
    fireEvent.mouseDown(cell, {button: 0, clientX: 5, clientY: 5});
    const armed = [...live].filter((h) => !before.has(h));
    expect(armed.length).toBe(2); // mousemove + mouseup are live

    // Unmount mid-drag, then let a stray move + release fire on window.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    unmount();
    expect(armed.every((h) => !live.has(h))).toBe(true); // teardown removed both

    expect(() => {
      fireEvent(window, new MouseEvent('mousemove', {clientX: 40, clientY: 40}));
      fireEvent(window, new MouseEvent('mouseup'));
    }).not.toThrow();
    // No React "setState on unmounted" / "not wrapped in act" warning fired.
    expect(errSpy).not.toHaveBeenCalled();

    errSpy.mockRestore();
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
