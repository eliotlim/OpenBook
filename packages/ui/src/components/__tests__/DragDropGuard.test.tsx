import {describe, it, expect, afterEach} from 'vitest';
import {render, cleanup} from '@testing-library/react';
import DragDropGuard from '../DragDropGuard';

// STAB-4: a file dropped outside the editor root must not navigate the document
// (WKWebView / the browser would open the file). The guard preventDefaults such
// drops in the window capture phase, but leaves in-editor drops (the editor owns
// them) and internal block-move drags (no `Files` type) completely alone.

afterEach(cleanup);

/** Dispatch a drag event carrying (or not) a `Files` payload from `target`. */
function fireDrag(type: 'dragover' | 'drop', target: Element, types: string[]): Event {
  const e = new Event(type, {bubbles: true, cancelable: true});
  Object.defineProperty(e, 'dataTransfer', {
    configurable: true,
    value: {types, dropEffect: 'none'},
  });
  target.dispatchEvent(e);
  return e;
}

describe('DragDropGuard', () => {
  it('swallows a file drop landing outside an editor root', () => {
    render(<DragDropGuard />);
    const sidebar = document.createElement('div');
    document.body.appendChild(sidebar);
    const e = fireDrag('drop', sidebar, ['Files']);
    expect(e.defaultPrevented).toBe(true);
  });

  it('leaves a file drop inside the editor root for the editor to handle', () => {
    render(<DragDropGuard />);
    const editor = document.createElement('div');
    editor.className = 'obe-root';
    const row = document.createElement('div');
    editor.appendChild(row);
    document.body.appendChild(editor);
    const e = fireDrag('drop', row, ['Files']);
    // The guard must NOT preventDefault here — the editor's own drop handler does.
    expect(e.defaultPrevented).toBe(false);
  });

  it('ignores an internal block-move drag (no Files payload)', () => {
    render(<DragDropGuard />);
    const sidebar = document.createElement('div');
    document.body.appendChild(sidebar);
    const e = fireDrag('drop', sidebar, ['text/plain', 'application/x-openbook-block']);
    expect(e.defaultPrevented).toBe(false);
  });

  it('preventDefaults dragover for a file drag so the drop event fires', () => {
    render(<DragDropGuard />);
    const sidebar = document.createElement('div');
    document.body.appendChild(sidebar);
    const e = fireDrag('dragover', sidebar, ['Files']);
    expect(e.defaultPrevented).toBe(true);
    expect((e as unknown as {dataTransfer: {dropEffect: string}}).dataTransfer.dropEffect).toBe('copy');
  });
});
