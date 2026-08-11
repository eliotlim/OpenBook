import {afterEach, describe, expect, it} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {BlockEditor} from '../BlockEditor';
import {createDoc, rootBlocks} from '../model';
import {passEditableContextMenuToBrowser, passPageContextMenuToBrowser} from '../nativeContextMenu';
import {PageContextMenu} from '@/components/PageContextMenu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  cleanup();
});

const contextMenu = (target: Element): MouseEvent => {
  const event = new MouseEvent('contextmenu', {bubbles: true, cancelable: true});
  fireEvent(target, event);
  return event;
};

const rightClick = (target: Element): MouseEvent => {
  fireEvent.mouseDown(target, {button: 2, buttons: 2});
  return contextMenu(target);
};

const selectText = (el: HTMLElement, collapsed: boolean): void => {
  const node = el.firstChild!;
  const range = document.createRange();
  range.setStart(node, collapsed ? 2 : 0);
  range.setEnd(node, collapsed ? 2 : Math.min(4, node.textContent?.length ?? 0));
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
};

describe('native editable context-menu passthrough', () => {
  it('leaves a non-collapsed text selection to the browser without cancelling it', () => {
    const doc = createDoc([{id: 'p', type: 'paragraph', text: [{t: 'selected text'}]}]);
    const {container} = render(<BlockEditor doc={doc} />);
    const text = container.querySelector('[data-block-text="p"]') as HTMLElement;
    selectText(text, false);

    const event = contextMenu(text);

    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByText('Duplicate')).toBeNull();
  });

  it('opens the custom block menu for a collapsed caret in regular text', () => {
    const doc = createDoc([{id: 'p', type: 'paragraph', text: [{t: 'caret text'}]}]);
    const {container} = render(<BlockEditor doc={doc} />);
    const text = container.querySelector('[data-block-text="p"]') as HTMLElement;
    selectText(text, true);

    const event = contextMenu(text);

    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByText('Duplicate')).toBeTruthy();
  });

  it('ignores a stale selection in another editable when right-clicking a collapsed caret', () => {
    const doc = createDoc([
      {id: 'a', type: 'paragraph', text: [{t: 'selected in A'}]},
      {id: 'b', type: 'paragraph', text: [{t: 'caret in B'}]},
    ]);
    const {container} = render(<BlockEditor doc={doc} />);
    const textA = container.querySelector('[data-block-text="a"]') as HTMLElement;
    const textB = container.querySelector('[data-block-text="b"]') as HTMLElement;
    selectText(textA, false);

    const event = contextMenu(textB);

    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByText('Duplicate')).toBeTruthy();
  });

  it('always leaves code-block source text to the native menu', () => {
    const doc = createDoc([{id: 'code', type: 'code', text: [{t: 'const answer = 42'}]}]);
    const {container} = render(<BlockEditor doc={doc} />);
    const text = container.querySelector('[data-block-text="code"]') as HTMLElement;

    const event = contextMenu(text);

    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByText('Duplicate')).toBeNull();
  });

  it('always leaves the page-title textarea to the native menu', () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger asChild onContextMenuCapture={passEditableContextMenuToBrowser}>
          <textarea className="ob-page-title" defaultValue="Page title" />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Page action</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    const title = screen.getByRole('textbox');
    (title as HTMLTextAreaElement).setSelectionRange(2, 2);

    const event = contextMenu(title);

    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByText('Page action')).toBeNull();
  });

  it('leaves selected read-only page text to the browser for Copy', () => {
    const doc = createDoc([{id: 'p', type: 'paragraph', text: [{t: 'read-only selection'}]}]);
    const {container} = render(
      <PageContextMenu pageId="page-1">
        <BlockEditor doc={doc} readOnly />
      </PageContextMenu>,
    );
    const text = container.querySelector('[data-block-text="p"]') as HTMLElement;
    selectText(text, false);

    const event = contextMenu(text);

    expect(event.defaultPrevented).toBe(false);
  });

  it('opens the page menu when right-clicking the background outside a read-only text selection', () => {
    const doc = createDoc([{id: 'p', type: 'paragraph', text: [{t: 'read-only selection'}]}]);
    const {container} = render(
      <ContextMenu>
        <ContextMenuTrigger asChild onContextMenuCapture={passPageContextMenuToBrowser}>
          <div data-page-background>
            <BlockEditor doc={doc} readOnly />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Page action</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    const text = container.querySelector('[data-block-text="p"]') as HTMLElement;
    const background = container.querySelector('[data-page-background]') as HTMLElement;
    selectText(text, false);

    const event = contextMenu(background);

    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByText('Page action')).toBeTruthy();
  });
});

describe('multi-block context menu', () => {
  const build = () => {
    const doc = createDoc(
      ['p1', 'p2', 'p3', 'p4'].map((id) => ({id, type: 'paragraph' as const, text: [{t: id}]})),
    );
    const {container} = render(<BlockEditor doc={doc} />);
    const row = (id: string) => container.querySelector(`[data-block-row="${id}"]`) as HTMLElement;
    const text = (id: string) => container.querySelector(`[data-block-text="${id}"]`) as HTMLElement;
    const selectedCount = () => container.querySelectorAll('.obe-row-selected').length;
    const selectFirstThree = () => {
      fireEvent.focus(text('p1'));
      fireEvent.mouseDown(row('p3'), {shiftKey: true, button: 0});
      expect(selectedCount()).toBe(3);
    };
    return {doc, container, row, text, selectedCount, selectFirstThree};
  };

  it('right-click inside the selection opens the bulk menu and preserves all selected rows', () => {
    const {row, selectedCount, selectFirstThree} = build();
    selectFirstThree();

    rightClick(row('p2'));

    expect(selectedCount()).toBe(3);
    expect(screen.getByText('3 blocks selected')).toBeTruthy();
    expect(screen.getByText('Duplicate 3')).toBeTruthy();
    expect(screen.getByText('Turn into')).toBeTruthy();
    expect(screen.getByText('Text colour')).toBeTruthy();
    expect(screen.getByText('Background')).toBeTruthy();
    expect(screen.getByText('Delete 3')).toBeTruthy();
    expect(screen.queryByText('Select block')).toBeNull();
  });

  it('uses the selected top-level columns row for nested targets, but keeps outside targets single', () => {
    const doc = createDoc([
      {id: 'p1', type: 'paragraph', text: [{t: 'first'}]},
      {
        id: 'cols',
        type: 'columns',
        children: [
          {id: 'left-col', type: 'column', children: [{id: 'inside', type: 'paragraph', text: [{t: 'inside columns'}]}]},
          {id: 'right-col', type: 'column', children: [{id: 'peer', type: 'paragraph', text: [{t: 'peer'}]}]},
        ],
      },
      {id: 'p3', type: 'paragraph', text: [{t: 'third'}]},
      {id: 'p4', type: 'paragraph', text: [{t: 'outside'}]},
    ]);
    const {container} = render(<BlockEditor doc={doc} />);
    const row = (id: string) => container.querySelector(`[data-block-row="${id}"]`) as HTMLElement;
    const text = (id: string) => container.querySelector(`[data-block-text="${id}"]`) as HTMLElement;

    fireEvent.focus(text('p1'));
    fireEvent.mouseDown(row('p3'), {shiftKey: true, button: 0});
    expect(container.querySelectorAll('.obe-row-selected')).toHaveLength(3);

    rightClick(text('inside'));
    expect(screen.getByText('3 blocks selected')).toBeTruthy();
    expect(screen.getByText('Turn into (2)')).toBeTruthy();
    expect(screen.queryByText('Select block')).toBeNull();

    fireEvent.keyDown(document, {key: 'Escape'});
    rightClick(row('p4'));
    expect(container.querySelectorAll('.obe-row-selected')).toHaveLength(0);
    expect(screen.queryByText('3 blocks selected')).toBeNull();
    expect(screen.getByText('Turn into')).toBeTruthy();
    expect(screen.getByText('Select block')).toBeTruthy();
  });

  it('bulk delete removes all selected blocks and one undo restores the whole selection', () => {
    const {doc, row, text, selectFirstThree} = build();
    selectFirstThree();
    rightClick(row('p2'));

    fireEvent.click(screen.getByText('Delete 3'));
    expect(rootBlocks(doc).map((block) => block.get('id'))).toEqual(['p4']);

    fireEvent.keyDown(text('p4'), {key: 'z', metaKey: true});
    expect(rootBlocks(doc).map((block) => block.get('id'))).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('bulk duplicate clones every selected block and one undo removes all clones', () => {
    const {doc, row, text, selectFirstThree} = build();
    selectFirstThree();
    rightClick(row('p2'));

    fireEvent.click(screen.getByText('Duplicate 3'));
    expect(rootBlocks(doc)).toHaveLength(7);

    fireEvent.keyDown(text('p4'), {key: 'z', metaKey: true});
    expect(rootBlocks(doc).map((block) => block.get('id'))).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('right-click outside the selection collapses to the target block menu', () => {
    const {row, selectedCount, selectFirstThree} = build();
    selectFirstThree();

    rightClick(row('p4'));

    expect(selectedCount()).toBe(0);
    expect(screen.queryByText('3 blocks selected')).toBeNull();
    expect(screen.getByText('Duplicate')).toBeTruthy();
    expect(screen.getByText('Select block')).toBeTruthy();
  });
});
