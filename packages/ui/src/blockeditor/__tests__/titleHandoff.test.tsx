import React from 'react';
import {describe, it, expect, vi, afterEach} from 'vitest';
import {render, cleanup, fireEvent, act} from '@testing-library/react';
import * as Y from 'yjs';
import {createDoc, rootBlocks, blockId, blockType} from '../model';
import {BlockEditor, type BlockEditorHandle} from '../BlockEditor';
import {PageHeader} from '../../screens/pageChrome';
import {I18nProvider} from '@/providers';

afterEach(() => cleanup());

/**
 * Title ⇄ editor caret hand-off (Notion muscle memory): the page title and the
 * block editor act as one continuous caret surface. Enter / ↓ in the title drop
 * into the first block; ↑ / Backspace at the editor's top return to the title.
 * The DOM-caret edges (↓ last visual line, ↑ first line) are measured against a
 * mirror / caret rect that happy-dom can't lay out, so those lean on the offset
 * fallbacks — the hand-off CALLBACKS are what we assert here.
 */

describe('title → editor', () => {
  it('Enter in the title hands off to the editor', () => {
    const onLeaveToEditor = vi.fn();
    const {container} = render(
      <I18nProvider>
        <PageHeader title="Hello" icon="📄" onLeaveToEditor={onLeaveToEditor} />
      </I18nProvider>,
    );
    const title = container.querySelector('.ob-page-title') as HTMLTextAreaElement;
    fireEvent.keyDown(title, {key: 'Enter'});
    expect(onLeaveToEditor).toHaveBeenCalledTimes(1);
  });

  it('↓ at the end of the title hands off to the editor', () => {
    const onLeaveToEditor = vi.fn();
    const {container} = render(
      <I18nProvider>
        <PageHeader title="Hello" icon="📄" onLeaveToEditor={onLeaveToEditor} />
      </I18nProvider>,
    );
    const title = container.querySelector('.ob-page-title') as HTMLTextAreaElement;
    title.setSelectionRange(title.value.length, title.value.length);
    fireEvent.keyDown(title, {key: 'ArrowDown'});
    expect(onLeaveToEditor).toHaveBeenCalledTimes(1);
  });

  it('focusStart() focuses the first text block at its start', () => {
    const doc = createDoc([
      {id: 'a', type: 'paragraph', text: 'one'},
      {id: 'b', type: 'paragraph', text: 'two'},
    ]);
    const ref = React.createRef<BlockEditorHandle>();
    render(<BlockEditor doc={doc} focusRef={ref} />);
    act(() => ref.current!.focusStart());
    expect(document.activeElement?.getAttribute('data-block-text')).toBe('a');
  });

  it('focusStart() creates and focuses a paragraph when the doc is empty', () => {
    const doc = new Y.Doc(); // no blocks at all
    const ref = React.createRef<BlockEditorHandle>();
    render(<BlockEditor doc={doc} focusRef={ref} />);
    act(() => ref.current!.focusStart());
    const roots = rootBlocks(doc);
    expect(roots.length).toBe(1);
    expect(blockType(roots.get(0))).toBe('paragraph');
    expect(document.activeElement?.getAttribute('data-block-text')).toBe(blockId(roots.get(0)));
  });

  it('focusStart() does NOTHING on a read-only, text-less doc (viewer cannot seed a paragraph)', () => {
    const doc = new Y.Doc(); // no blocks at all
    const ref = React.createRef<BlockEditorHandle>();
    render(<BlockEditor doc={doc} readOnly focusRef={ref} />);
    act(() => ref.current!.focusStart());
    expect(rootBlocks(doc).length).toBe(0); // no mutation — the handoff is a no-op
  });
});

describe('editor → title', () => {
  it('Backspace at the start of an empty first block returns to the title (keeps the line)', () => {
    const onLeaveToTitle = vi.fn();
    const doc = createDoc([{id: 'p', type: 'paragraph'}]);
    const {container} = render(<BlockEditor doc={doc} onLeaveToTitle={onLeaveToTitle} />);
    const el = container.querySelector('[data-block-text="p"]') as HTMLElement;
    fireEvent.keyDown(el, {key: 'Backspace'});
    expect(onLeaveToTitle).toHaveBeenCalledTimes(1);
    expect(rootBlocks(doc).length).toBe(1); // the block is preserved, not deleted
  });

  it('↑ on the first line of the first block returns to the title', () => {
    const onLeaveToTitle = vi.fn();
    const doc = createDoc([{id: 'p', type: 'paragraph', text: 'hello'}]);
    const {container} = render(<BlockEditor doc={doc} onLeaveToTitle={onLeaveToTitle} />);
    const el = container.querySelector('[data-block-text="p"]') as HTMLElement;
    el.focus();
    const range = document.createRange();
    range.setStart(el.firstChild ?? el, 0);
    range.collapse(true);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.keyDown(el, {key: 'ArrowUp'});
    expect(onLeaveToTitle).toHaveBeenCalledTimes(1);
  });

  it('Backspace on an empty NON-first block still merges up (no title jump)', () => {
    const onLeaveToTitle = vi.fn();
    const doc = createDoc([
      {id: 'a', type: 'paragraph', text: 'hello'},
      {id: 'b', type: 'paragraph'},
    ]);
    const {container} = render(<BlockEditor doc={doc} onLeaveToTitle={onLeaveToTitle} />);
    const el = container.querySelector('[data-block-text="b"]') as HTMLElement;
    fireEvent.keyDown(el, {key: 'Backspace'});
    expect(onLeaveToTitle).not.toHaveBeenCalled();
    expect(rootBlocks(doc).length).toBe(1); // 'b' merged into 'a'
  });
});
