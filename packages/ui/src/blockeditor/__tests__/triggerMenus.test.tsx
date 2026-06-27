import {describe, it, expect, afterEach} from 'vitest';
import {render, cleanup, act} from '@testing-library/react';
import {createDoc, rootBlocks, blockPlainText} from '../model';
import {BlockEditor} from '../BlockEditor';
import {registerReactiveBlocks} from '../reactiveBlocks';
import {searchEmojis} from '@/lib/emoji';
import {I18nProvider} from '@/providers';

afterEach(() => cleanup());

/**
 * The "/", "@" and ":" trigger menus and the ":smile:" muscle-memory insert,
 * driven end-to-end through the contenteditable's native `beforeinput` path
 * (the custom editor binds beforeinput natively, so synthetic React events
 * won't do — these dispatch real InputEvents like the browser).
 */
function typeText(el: HTMLElement, str: string): void {
  for (const ch of str) {
    act(() => {
      el.dispatchEvent(
        new InputEvent('beforeinput', {inputType: 'insertText', data: ch, bubbles: true, cancelable: true}),
      );
    });
  }
}

function mountEditor() {
  const doc = createDoc([{id: 'p', type: 'paragraph'}]);
  const {container} = render(
    <I18nProvider>
      <BlockEditor doc={doc} />
    </I18nProvider>,
  );
  const el = container.querySelector('[data-block-text="p"]') as HTMLElement;
  el.focus();
  return {doc, container, el};
}

describe('mutually-exclusive trigger menus', () => {
  it('opening the emoji menu closes an open slash menu (never two popovers)', () => {
    registerReactiveBlocks(); // gives the slash menu real items to render
    const {container, el} = mountEditor();
    typeText(el, '/'); // the slash menu opens
    expect(container.querySelectorAll('.obe-slash').length).toBe(1);
    // A space then ":" (after whitespace) opens the emoji menu — the slash menu
    // must close so the two never stack (the pre-existing "/ @" / "/ :" bug).
    typeText(el, ' :');
    expect(container.querySelectorAll('.obe-slash').length).toBe(1);
  });
});

describe('colon-terminated emoji insert', () => {
  it('typing ":smile:" inserts the top match in place of the shortcode', () => {
    const {doc, el} = mountEditor();
    typeText(el, ':smile:');
    expect(blockPlainText(rootBlocks(doc).get(0))).toBe(searchEmojis('smile')[0].emoji);
  });

  it('a closing ":" with no matching query stays a literal ":"', () => {
    const {doc, el} = mountEditor();
    // The picker closes on a non-matching query, so the closing ":" is literal.
    typeText(el, ':zzzznope:');
    expect(blockPlainText(rootBlocks(doc).get(0))).toBe(':zzzznope:');
  });
});
