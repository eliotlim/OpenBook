import {describe, it, expect, afterEach, beforeEach, vi} from 'vitest';
import {render, cleanup, act, fireEvent} from '@testing-library/react';
import * as Y from 'yjs';
import {createDoc, rootBlocks, blockText, blockPlainText, type BlockMap} from '../model';
import {BlockEditor} from '../BlockEditor';
import {setPageLinkBridge, type PageLinkResult} from '@/lib/pageLinks';
import {I18nProvider} from '@/providers';

/**
 * The "[[" wikilink menu, driven end-to-end through the contenteditable's native
 * `beforeinput` path (like the "/", "@", ":" trigger suite): typing "[[" opens
 * the page-link picker, an accepted pick replaces the literal with a chip
 * identical to an "@"-mention, no match offers a Create row that makes the page
 * a CHILD of the current page, Escape leaves the literal, and "[[" in a code
 * block stays literal. Undo of an accept restores the literal typed text.
 */

const PAGES: PageLinkResult[] = [
  {id: 'road-1', label: 'Roadmap', icon: '📄'},
  {id: 'notes-1', label: 'Notes', icon: '📄'},
];

let createPage: ReturnType<typeof vi.fn<(name: string, parentId?: string | null) => Promise<string>>>;

beforeEach(() => {
  createPage = vi.fn<(name: string, parentId?: string | null) => Promise<string>>(async () => 'new-page-1');
  setPageLinkBridge({
    createSubpage: async () => 'x',
    openPage: () => {},
    label: (id) => PAGES.find((p) => p.id === id)?.label ?? 'Untitled',
    icon: () => '📄',
    createPage,
    searchPages: (query) =>
      PAGES.filter((p) => p.label.toLowerCase().includes(query.trim().toLowerCase())),
    searchRows: async () => [],
  });
});
afterEach(() => {
  cleanup();
  setPageLinkBridge(null);
});

function typeText(el: HTMLElement, str: string): void {
  for (const ch of str) {
    act(() => {
      el.dispatchEvent(
        new InputEvent('beforeinput', {inputType: 'insertText', data: ch, bubbles: true, cancelable: true}),
      );
    });
  }
}

function backspace(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(
      new InputEvent('beforeinput', {inputType: 'deleteContentBackward', bubbles: true, cancelable: true}),
    );
  });
}

async function flush(): Promise<void> {
  // Drain the microtask queue (the async create path) + let effects settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mount(pageId = 'host-page') {
  const doc = createDoc([{id: 'p', type: 'paragraph'}]);
  const {container} = render(
    <I18nProvider>
      <BlockEditor doc={doc} pageId={pageId} />
    </I18nProvider>,
  );
  const el = container.querySelector('[data-block-text="p"]') as HTMLElement;
  el.focus();
  return {doc, container, el};
}

/** The inline runs of the first block, as {text, mentionId}. */
function runs(doc: Y.Doc): Array<{t: string; m?: string}> {
  const block = rootBlocks(doc).get(0) as BlockMap;
  const text = blockText(block)!;
  return text.toDelta().map((d: {insert: string; attributes?: {m?: string}}) => ({t: d.insert, m: d.attributes?.m}));
}

describe('wikilink "[[" trigger', () => {
  it('opens the page menu on the second "["', () => {
    const {container, el} = mount();
    typeText(el, '[[');
    expect(container.querySelectorAll('.obe-slash').length).toBe(1);
    // Seeded with no query yet → both pages listed.
    const labels = [...container.querySelectorAll('.obe-slash-label')].map((n) => n.textContent);
    expect(labels).toContain('Roadmap');
    expect(labels).toContain('Notes');
  });

  it('does NOT open inside a code block ("[[" stays literal)', () => {
    const doc = createDoc([{id: 'c', type: 'code'}]);
    const {container} = render(
      <I18nProvider>
        <BlockEditor doc={doc} pageId="host" />
      </I18nProvider>,
    );
    const el = container.querySelector('[data-block-text="c"]') as HTMLElement;
    el.focus();
    typeText(el, '[[');
    expect(container.querySelectorAll('.obe-slash').length).toBe(0);
    expect(blockPlainText(rootBlocks(doc).get(0))).toBe('[[');
  });

  it('does NOT open mid-word ("a[[" stays literal)', () => {
    const {doc, container, el} = mount();
    typeText(el, 'a[[');
    expect(container.querySelectorAll('.obe-slash').length).toBe(0);
    expect(blockPlainText(rootBlocks(doc).get(0))).toBe('a[[');
  });
});

describe('wikilink accept — existing page (happy path)', () => {
  it('replaces "[[Roadmap" with a mention chip identical to an @-mention', () => {
    const {doc, container, el} = mount();
    typeText(el, '[[Roadmap'); // exact name → no Create row, the page leads
    expect(container.querySelector('.obe-slash')).toBeTruthy();
    act(() => {
      fireEvent.keyDown(el, {key: 'Enter'});
    });
    // The literal is gone; a single run carries the mention id.
    const r = runs(doc);
    const mention = r.find((x) => x.m === 'road-1');
    expect(mention).toBeTruthy();
    expect(mention!.t).toContain('Roadmap');
    expect(r.some((x) => x.t.includes('[['))).toBe(false);
    // Renders as a.obe-mention with the target id — the exact @-mention markup.
    const anchor = container.querySelector('a.obe-mention');
    expect(anchor).toBeTruthy();
    expect(anchor!.getAttribute('data-page-id')).toBe('road-1');
    // Menu closed.
    expect(container.querySelector('.obe-slash')).toBeFalsy();
  });
});

describe('wikilink accept — create path (child of current page)', () => {
  it('offers a Create row for an unmatched name and nests the new page under the host', async () => {
    const {doc, container, el} = mount('host-page');
    typeText(el, '[[New name]]'); // typed closing "]]" commits the top row
    await flush();
    // Created as a CHILD of the host page, with the typed name.
    expect(createPage).toHaveBeenCalledTimes(1);
    expect(createPage).toHaveBeenCalledWith('New name', 'host-page');
    // The literal (incl. the "]]") is gone; the chip points at the new page.
    const r = runs(doc);
    expect(r.some((x) => x.m === 'new-page-1')).toBe(true);
    expect(r.some((x) => x.t.includes('[') || x.t.includes(']'))).toBe(false);
    const anchor = container.querySelector('a.obe-mention');
    expect(anchor!.getAttribute('data-page-id')).toBe('new-page-1');
  });

  it('renders the Create row LAST with matches, FIRST + selected with none, and suppresses it on an exact match', () => {
    // (a) Partial name WITH a match → Create goes LAST and the first real match is
    // the auto-highlighted row, so Enter links the near-match instead of spawning
    // a duplicate child page.
    {
      const {container, el} = mount();
      typeText(el, '[[Ro'); // partial → Roadmap + Create (last)
      const labels = [...container.querySelectorAll('.obe-slash-label')].map((n) => n.textContent);
      expect(labels[0]).toBe('Roadmap');
      expect(labels[labels.length - 1]).toMatch(/Create/);
      const options = [...container.querySelectorAll('[role="option"]')];
      expect(options[0].getAttribute('aria-selected')).toBe('true');
      expect(options[0].querySelector('.obe-slash-label')?.textContent).toBe('Roadmap');
      cleanup();
    }
    // (b) Name with NO matches → Create leads and is the auto-selected row.
    {
      const {container, el} = mount();
      typeText(el, '[[Zzz'); // matches nothing → Create only
      const labels = [...container.querySelectorAll('.obe-slash-label')].map((n) => n.textContent);
      expect(labels[0]).toMatch(/Create/);
      expect(labels.every((l) => !/Roadmap|Notes/.test(l ?? ''))).toBe(true);
      const options = [...container.querySelectorAll('[role="option"]')];
      expect(options[0].getAttribute('aria-selected')).toBe('true');
      expect(options[0].querySelector('.obe-slash-label')?.textContent).toMatch(/Create/);
      cleanup();
    }
    // (c) Exact match → the Create row is suppressed entirely.
    {
      const {container, el} = mount();
      typeText(el, '[[Roadmap');
      const labels = [...container.querySelectorAll('.obe-slash-label')].map((n) => n.textContent);
      expect(labels.some((l) => /Create/.test(l ?? ''))).toBe(false);
      expect(labels).toContain('Roadmap');
    }
  });
});

describe('wikilink empty brackets "[[]]"', () => {
  it('typing "[[]]" inserts NO chip and leaves the literal text', () => {
    const {doc, container, el} = mount();
    typeText(el, '[[]]'); // the closing "]]" must NOT commit the top-ranked page
    // No mention chip was inserted…
    expect(container.querySelector('a.obe-mention')).toBeFalsy();
    expect(runs(doc).some((x) => x.m)).toBe(false);
    // …and the literal "[[]]" survives verbatim.
    expect(blockPlainText(rootBlocks(doc).get(0))).toBe('[[]]');
  });
});

describe('wikilink escape + backspace', () => {
  it('Escape leaves the literal "[[foo" untouched (no chip)', () => {
    const {doc, container, el} = mount();
    typeText(el, '[[foo');
    act(() => {
      fireEvent.keyDown(el, {key: 'Escape'});
    });
    expect(container.querySelector('.obe-slash')).toBeFalsy();
    expect(blockPlainText(rootBlocks(doc).get(0))).toBe('[[foo');
    expect(container.querySelector('a.obe-mention')).toBeFalsy();
  });

  it('backspacing the second "[" closes the menu (trigger gone)', () => {
    const {container, el} = mount();
    typeText(el, '[[');
    expect(container.querySelector('.obe-slash')).toBeTruthy();
    backspace(el);
    expect(container.querySelector('.obe-slash')).toBeFalsy();
  });
});

describe('wikilink undo', () => {
  it('a single undo after an accept restores the literal typed text', () => {
    const {doc, el} = mount();
    typeText(el, '[[Roadmap');
    act(() => {
      fireEvent.keyDown(el, {key: 'Enter'});
    });
    expect(runs(doc).some((x) => x.m === 'road-1')).toBe(true);
    // One undo reverts the accept (chip → literal), not the typing.
    act(() => {
      el.dispatchEvent(new InputEvent('beforeinput', {inputType: 'historyUndo', bubbles: true, cancelable: true}));
    });
    expect(blockPlainText(rootBlocks(doc).get(0))).toBe('[[Roadmap');
    expect(runs(doc).some((x) => x.m === 'road-1')).toBe(false);
  });
});
