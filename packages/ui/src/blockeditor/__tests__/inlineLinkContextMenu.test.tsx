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

  it('opens the prompt-free URL editor from Edit link', async () => {
    const {container} = renderText([{t: 'Example', a: {a: 'https://example.test'}}]);
    await openAnchorMenu(container.querySelector('a.obe-link') as HTMLAnchorElement);

    fireEvent.click(screen.getByText('Edit link…'));
    expect(screen.getByLabelText('Link URL')).toHaveProperty('value', 'https://example.test');
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
