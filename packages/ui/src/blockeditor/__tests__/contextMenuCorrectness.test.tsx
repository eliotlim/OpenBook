import {afterEach, describe, expect, it} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {BlockEditor} from '../BlockEditor';
import {createDoc} from '../model';
import {passEditableContextMenuToBrowser} from '../nativeContextMenu';
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
});
