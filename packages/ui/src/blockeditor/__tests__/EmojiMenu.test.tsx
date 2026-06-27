import {describe, it, expect, vi, afterEach} from 'vitest';
import {render, screen, cleanup, fireEvent, renderHook} from '@testing-library/react';
import {createDoc, rootBlocks, blockPlainText} from '../model';
import {useBlockEditor} from '../useBlockEditor';
import {searchEmojis} from '@/lib/emoji';
import {EmojiMenu} from '../EmojiMenu';
import type {SlashState} from '../SlashMenu';

afterEach(() => cleanup());

/**
 * The ":" emoji picker. The trigger wiring (a ':' at block start / after
 * whitespace) is exercised in the app like the slash + mention menus; here we
 * test the menu itself — that it surfaces `searchEmojis` matches and that a
 * pick removes the typed ":query" and reports the chosen glyph.
 */
function renderMenu(query: string, onInsertText = vi.fn()) {
  const doc = createDoc([{id: 'x', type: 'paragraph', text: `:${query}`}]);
  const {result} = renderHook(() => useBlockEditor(doc));
  const state: SlashState = {open: true, blockId: 'x', anchorOffset: 0, query, index: 0};
  const utils = render(
    <EmojiMenu state={state} editor={result.current} anchorEl={null} onClose={() => {}} onInsertText={onInsertText} />,
  );
  return {doc, onInsertText, state, editor: result.current, ...utils};
}

describe('EmojiMenu', () => {
  it('shows the top matches (glyph + name) for the query', () => {
    const {container} = renderMenu('smile');
    const top = searchEmojis('smile')[0];
    expect(top).toBeTruthy();
    // The name label and its glyph both render.
    expect(screen.getByText(top.name)).toBeTruthy();
    expect(screen.getByText(top.emoji)).toBeTruthy();
    expect(container.querySelectorAll('.obe-slash-item').length).toBe(searchEmojis('smile').length);
  });

  it('inserts the glyph and removes the typed ":query" on click', () => {
    const {doc, onInsertText, container} = renderMenu('smile');
    const top = searchEmojis('smile')[0];
    fireEvent.mouseDown(container.querySelectorAll('.obe-slash-item')[0]);
    // The ":smile" run is gone from the block…
    expect(blockPlainText(rootBlocks(doc).get(0))).toBe('');
    // …and the glyph is reported back to the host for insertion at the anchor.
    expect(onInsertText).toHaveBeenCalledWith('x', 0, top.emoji);
  });

  it('picks the active item when Enter is forwarded from the block', () => {
    const onInsertText = vi.fn();
    const doc = createDoc([{id: 'x', type: 'paragraph', text: ':smile'}]);
    const {result} = renderHook(() => useBlockEditor(doc));
    const base: SlashState = {open: true, blockId: 'x', anchorOffset: 0, query: 'smile', index: 0};
    const {rerender} = render(
      <EmojiMenu state={base} editor={result.current} anchorEl={null} onClose={() => {}} onInsertText={onInsertText} />,
    );
    // A forwarded Enter (the menu owns the key, not the block) picks item 0.
    rerender(
      <EmojiMenu
        state={{...base, keyEvent: {key: 'Enter', n: 1}}}
        editor={result.current}
        anchorEl={null}
        onClose={() => {}}
        onInsertText={onInsertText}
      />,
    );
    expect(onInsertText).toHaveBeenCalledWith('x', 0, searchEmojis('smile')[0].emoji);
  });

  it('keeps the bare ":" open with a prompt instead of closing', () => {
    const onClose = vi.fn();
    const doc = createDoc([{id: 'x', type: 'paragraph', text: ':'}]);
    const {result} = renderHook(() => useBlockEditor(doc));
    render(
      <EmojiMenu
        state={{open: true, blockId: 'x', anchorOffset: 0, query: '', index: 0}}
        editor={result.current}
        anchorEl={null}
        onClose={onClose}
        onInsertText={vi.fn()}
      />,
    );
    expect(screen.getByText(/search emoji/i)).toBeTruthy();
    expect(screen.queryByRole('option')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes when a non-empty query matches nothing', () => {
    const onClose = vi.fn();
    const doc = createDoc([{id: 'x', type: 'paragraph', text: ':zzzzznotanemoji'}]);
    const {result} = renderHook(() => useBlockEditor(doc));
    render(
      <EmojiMenu
        state={{open: true, blockId: 'x', anchorOffset: 0, query: 'zzzzznotanemoji', index: 0}}
        editor={result.current}
        anchorEl={null}
        onClose={onClose}
        onInsertText={vi.fn()}
      />,
    );
    expect(onClose).toHaveBeenCalled();
  });
});
