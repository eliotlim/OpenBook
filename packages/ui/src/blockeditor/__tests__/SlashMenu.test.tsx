import {describe, it, expect, afterEach} from 'vitest';
import {render, screen, cleanup} from '@testing-library/react';
import {renderHook} from '@testing-library/react';
import {createDoc} from '../model';
import {useBlockEditor} from '../useBlockEditor';
import {registerReactiveBlocks} from '../reactiveBlocks';
import {SlashMenu} from '../SlashMenu';

afterEach(() => cleanup());

function renderMenu(pageId?: string, onLink?: () => void) {
  registerReactiveBlocks(); // gives the menu an "interactive" item (the slider)
  const doc = createDoc([{id: 'x', type: 'paragraph'}]);
  const {result} = renderHook(() => useBlockEditor(doc));
  return render(
    <SlashMenu
      state={{open: true, blockId: 'x', anchorOffset: 0, query: '', index: 0}}
      editor={result.current}
      anchorEl={null}
      rootEl={null}
      onClose={() => {}}
      pageId={pageId}
      onLink={onLink}
    />,
  );
}

describe('SlashMenu grouping', () => {
  it('renders category headers and the new page/database commands', () => {
    renderMenu('parent-page');
    expect(screen.getByText('Pages')).toBeTruthy();
    expect(screen.getByText('Basic blocks')).toBeTruthy();
    expect(screen.getByText('Interactive blocks')).toBeTruthy();
    // #5: the page/database insert commands.
    expect(screen.getByText('New page')).toBeTruthy();
    expect(screen.getByText('New database')).toBeTruthy();
    // A basic block is still present.
    expect(screen.getByText('Text')).toBeTruthy();
  });

  it('omits the Pages group when there is no host page and no link handler', () => {
    renderMenu(undefined);
    expect(screen.queryByText('Pages')).toBeNull();
    expect(screen.queryByText('New page')).toBeNull();
    expect(screen.getByText('Basic blocks')).toBeTruthy();
  });

  it('offers the link-to-existing commands when a link handler is provided', () => {
    renderMenu(undefined, () => {});
    expect(screen.getByText('Pages')).toBeTruthy();
    expect(screen.getByText('Link to page')).toBeTruthy();
    expect(screen.getByText('Link to database')).toBeTruthy();
  });

  it('renders an icon for each command (#3)', () => {
    const {container} = renderMenu('parent-page');
    const item = container.querySelector('.obe-slash-item');
    expect(item?.querySelector('svg.obe-slash-icon')).toBeTruthy();
  });
});
