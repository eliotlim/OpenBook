import {describe, it, expect, afterEach} from 'vitest';
import {render, cleanup, fireEvent} from '@testing-library/react';
import {createDoc, rootBlocks} from '../model';
import {registerArtifactKit} from '../kit';
import {BlockEditor} from '../BlockEditor';

afterEach(() => cleanup());

registerArtifactKit();

/**
 * Interaction regressions for marquee (rubber-band) select + shift-click block
 * selection. These drive real DOM events through the live editor rather than
 * the pure geometry helpers in marquee.test.ts.
 */
describe('marquee suppressClick recovery (Finding 1)', () => {
  it('does not swallow the next genuine click when a drag ends OUTSIDE the root', () => {
    // A marquee drag whose pointer autoscrolls off the editor releases with no
    // trailing click over the root, so onClick never clears suppressClickRef.
    // The fix resets the flag on the next mousedown — so the following real
    // click still runs (here: the click-below-last-block "append paragraph").
    const doc = createDoc([{id: 'p', type: 'paragraph', text: [{t: 'Hello'}]}]);
    const {container} = render(<BlockEditor doc={doc} />);
    const root = container.querySelector('.obe-root') as HTMLElement;

    // Drag: mousedown on empty chrome, move far enough to engage, then release
    // on window (target = document.body — outside the root, as autoscroll does).
    fireEvent.mouseDown(root, {clientX: 5, clientY: 5, button: 0});
    fireEvent.mouseMove(window, {clientX: 80, clientY: 80});
    fireEvent.mouseUp(document.body, {clientX: 80, clientY: 80});

    // No click reached the root during the drag → suppressClickRef is stuck true.
    // A fresh gesture: its mousedown must clear the flag so the click lands.
    expect(rootBlocks(doc).length).toBe(1);
    fireEvent.mouseDown(root, {clientX: 0, clientY: 0, button: 0});
    fireEvent.click(root, {clientX: 0, clientY: 5});

    // The click was honoured (a trailing paragraph was appended), proving it was
    // NOT swallowed by the stale suppression flag.
    expect(rootBlocks(doc).length).toBe(2);
  });
});

describe('shift-click block selection vs native text extension (Finding 2)', () => {
  const build = () => {
    const doc = createDoc(
      ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => ({id, type: 'paragraph' as const, text: [{t: id}]})),
    );
    const {container} = render(<BlockEditor doc={doc} />);
    const row = (id: string) => container.querySelector(`[data-block-row="${id}"]`) as HTMLElement;
    const text = (id: string) => container.querySelector(`[data-block-text="${id}"]`) as HTMLElement;
    const selectedIds = () =>
      Array.from(container.querySelectorAll('.obe-row-selected')).map((el) => (el as HTMLElement).dataset.blockRow);
    return {doc, container, row, text, selectedIds};
  };

  it('lets native text extension win: shift-click on the FOCUSED row with empty selection selects no block', () => {
    const {row, text, selectedIds} = build();
    fireEvent.focus(text('p2')); // caret in p2
    fireEvent.mouseDown(row('p2'), {shiftKey: true, button: 0});
    // No block selection — the browser is free to extend the intra-block range.
    expect(selectedIds()).toEqual([]);
  });

  it('shift-click on a DIFFERENT row with empty selection selects the range from the focused row', () => {
    const {row, text, selectedIds} = build();
    fireEvent.focus(text('p1')); // caret in p1
    fireEvent.mouseDown(row('p3'), {shiftKey: true, button: 0});
    expect(selectedIds()).toEqual(['p1', 'p2', 'p3']);
  });

  it('shift-click with an existing block selection extends contiguously (existing behavior)', () => {
    const {row, text, selectedIds} = build();
    fireEvent.focus(text('p1'));
    // First shift-click establishes a block selection p1..p2 (different row).
    fireEvent.mouseDown(row('p2'), {shiftKey: true, button: 0});
    expect(selectedIds()).toEqual(['p1', 'p2']);
    // Second shift-click extends from the nearest selected anchor (p2) to p4.
    fireEvent.mouseDown(row('p4'), {shiftKey: true, button: 0});
    expect(selectedIds()).toEqual(['p2', 'p3', 'p4']);
  });
});
