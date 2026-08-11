import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {BlockEditor} from '../BlockEditor';
import {createDoc, docToJSON, type TextRun} from '../model';
import {pageLinks} from '@/lib/pageLinks';

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  cleanup();
});

const renderText = (runs: TextRun[]) => {
  const doc = createDoc([{id: 'p', type: 'paragraph', text: runs}]);
  const view = render(<BlockEditor doc={doc} />);
  return {doc, ...view};
};

const collapseIn = (element: HTMLElement): void => {
  const range = document.createRange();
  range.setStart(element.firstChild ?? element, 0);
  range.collapse(true);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
};

const openAnchorMenu = async (anchor: HTMLAnchorElement): Promise<void> => {
  collapseIn(anchor);
  fireEvent.contextMenu(anchor, {clientX: 40, clientY: 50});
  await screen.findByText('Open link');
};

describe('inline link context menu', () => {
  it('renders the external-link actions and opens the link in a new tab', async () => {
    const {container} = renderText([{t: 'Example', a: {a: 'https://example.test/path'}}]);
    const anchor = container.querySelector('a.obe-link') as HTMLAnchorElement;
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);

    await openAnchorMenu(anchor);
    expect(screen.getByText('Open link').closest('[role="menu"]')?.classList.contains('w-60')).toBe(true);
    for (const label of ['Open link', 'Open in new window', 'Copy link address', 'Edit link…', 'Remove link']) {
      expect(screen.getByText(label), label).toBeTruthy();
    }
    expect(screen.queryByText('Open in split view')).toBeNull();

    fireEvent.click(screen.getByText('Open link'));
    expect(open).toHaveBeenCalledWith('https://example.test/path', '_blank', 'noopener,noreferrer');
  });

  it('removes only the link formatting and keeps its text', async () => {
    const {doc, container} = renderText([{t: 'Example', a: {a: 'https://example.test'}}]);
    await openAnchorMenu(container.querySelector('a.obe-link') as HTMLAnchorElement);

    fireEvent.click(screen.getByText('Remove link'));
    expect(docToJSON(doc)[0].text).toEqual([{t: 'Example'}]);
  });

  it('removes a mixed-mark logical link across all three rendered anchors without absorbing a different URL', async () => {
    const shared = 'https://example.test/shared';
    const separate = 'https://separate.test';
    const {doc, container} = renderText([
      {t: 'foo', a: {a: shared}},
      {t: 'bar', a: {a: shared, b: true}},
      {t: 'baz', a: {a: shared}},
      {t: 'qux', a: {a: separate}},
    ]);
    const anchors = container.querySelectorAll<HTMLAnchorElement>('a.obe-link');
    expect(anchors).toHaveLength(4);

    await openAnchorMenu(anchors[1]);
    fireEvent.click(screen.getByText('Remove link'));

    expect(docToJSON(doc)[0].text).toEqual([
      {t: 'foo'},
      {t: 'bar', a: {b: true}},
      {t: 'baz'},
      {t: 'qux', a: {a: separate}},
    ]);
  });

  it('edits a mixed-mark logical link across all three rendered anchors without absorbing a different URL', async () => {
    const shared = 'https://example.test/shared';
    const updated = 'https://updated.test';
    const separate = 'https://separate.test';
    const {doc, container} = renderText([
      {t: 'foo', a: {a: shared}},
      {t: 'bar', a: {a: shared, b: true}},
      {t: 'baz', a: {a: shared}},
      {t: 'qux', a: {a: separate}},
    ]);
    const anchors = container.querySelectorAll<HTMLAnchorElement>('a.obe-link');
    expect(anchors).toHaveLength(4);

    await openAnchorMenu(anchors[1]);
    fireEvent.click(screen.getByText('Edit link…'));
    const input = screen.getByLabelText('Link URL');
    fireEvent.change(input, {target: {value: updated}});
    fireEvent.submit(input.closest('form')!);

    expect(docToJSON(doc)[0].text).toEqual([
      {t: 'foo', a: {a: updated}},
      {t: 'bar', a: {a: updated, b: true}},
      {t: 'baz', a: {a: updated}},
      {t: 'qux', a: {a: separate}},
    ]);
  });

  it('opens the prompt-free URL editor from Edit link', async () => {
    const {container} = renderText([{t: 'Example', a: {a: 'https://example.test'}}]);
    await openAnchorMenu(container.querySelector('a.obe-link') as HTMLAnchorElement);

    fireEvent.click(screen.getByText('Edit link…'));
    expect(screen.getByLabelText('Link URL')).toHaveProperty('value', 'https://example.test');
  });

  it('prepends https:// when the edited URL has no scheme', async () => {
    const {doc, container} = renderText([{t: 'Example', a: {a: 'https://example.test'}}]);
    await openAnchorMenu(container.querySelector('a.obe-link') as HTMLAnchorElement);
    fireEvent.click(screen.getByText('Edit link…'));
    const input = screen.getByLabelText('Link URL');

    fireEvent.change(input, {target: {value: 'updated.test/path'}});
    fireEvent.submit(input.closest('form')!);

    expect(docToJSON(doc)[0].text).toEqual([{t: 'Example', a: {a: 'https://updated.test/path'}}]);
  });

  it('rejects javascript: when editing a link', async () => {
    const original = 'https://example.test';
    const {doc, container} = renderText([{t: 'Example', a: {a: original}}]);
    await openAnchorMenu(container.querySelector('a.obe-link') as HTMLAnchorElement);
    fireEvent.click(screen.getByText('Edit link…'));
    const input = screen.getByLabelText('Link URL');

    fireEvent.change(input, {target: {value: 'javascript:alert(1)'}});
    expect(screen.getByText('Save').closest('button')).toHaveProperty('disabled', true);
    fireEvent.submit(input.closest('form')!);

    expect(docToJSON(doc)[0].text).toEqual([{t: 'Example', a: {a: original}}]);
  });

  it('adds the split action for mentions and fires the split-open bridge fallback', async () => {
    const {container} = renderText([{t: 'Roadmap', a: {m: 'page-2'}}]);
    const openPage = vi.spyOn(pageLinks, 'openPage').mockImplementation(() => {});
    await openAnchorMenu(container.querySelector('a.obe-mention') as HTMLAnchorElement);

    expect(screen.getByText('Open in split view')).toBeTruthy();
    fireEvent.click(screen.getByText('Open in split view'));
    expect(openPage).toHaveBeenCalledWith('page-2', 'secondary');
  });

  it('opens the existing page LinkPicker when editing a mention', async () => {
    const {container} = renderText([{t: 'Roadmap', a: {m: 'page-2'}}]);
    await openAnchorMenu(container.querySelector('a.obe-mention') as HTMLAnchorElement);

    fireEvent.click(screen.getByText('Edit link…'));
    expect(document.querySelector('[role="combobox"][aria-label="Link to page"]')).toBeTruthy();
  });

  it('ignores non-anchor targets', () => {
    const {container} = renderText([{t: 'Plain text'}]);
    const text = container.querySelector('[data-block-text="p"]') as HTMLElement;
    collapseIn(text);
    fireEvent.contextMenu(text);

    expect(screen.queryByText('Open link')).toBeNull();
    expect(screen.queryByText('Copy link address')).toBeNull();
  });

  it('leaves a non-collapsed anchor selection to the current behavior for CTX-5', async () => {
    const {container} = renderText([{t: 'Example', a: {a: 'https://example.test'}}]);
    const anchor = container.querySelector('a.obe-link') as HTMLAnchorElement;
    const range = document.createRange();
    range.selectNodeContents(anchor);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.contextMenu(anchor);
    await waitFor(() => expect(screen.queryByText('Open link')).toBeNull());
  });
});
