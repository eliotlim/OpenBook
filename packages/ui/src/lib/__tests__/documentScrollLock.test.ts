import {describe, expect, it} from 'vitest';
// @ts-expect-error -- Vitest runs in Node; the browser package omits Node ambient types.
import {readFileSync} from 'node:fs';

const CSS = readFileSync('src/index.css', 'utf8');

describe('document scroll lock', () => {
  const documentRules = CSS.match(
    /\n\s*html,\s*\n\s*body\s*\{[^}]+\}\s*\/\* Lock the document scroller[^}]+\}/,
  )?.[0];

  function mountAppRoot(id?: '__next' | 'root') {
    const style = document.createElement('style');
    style.textContent = documentRules!;
    document.head.append(style);

    const root = id ? document.createElement('div') : undefined;
    if (root && id) {
      root.id = id;
      document.body.append(root);
    }

    return {
      sheet: style.sheet!,
      cleanup: () => {
        root?.remove();
        style.remove();
      },
    };
  }

  function expectDocumentToBeLocked(sheet: CSSStyleSheet, locked: boolean) {
    const matches = (element: Element, selector: string) => {
      const relationalSelector = selector.match(/^(html|body):has\(#(__next|root)\)$/);
      if (relationalSelector) {
        return element.localName === relationalSelector[1] && document.getElementById(relationalSelector[2]);
      }
      return element.matches(selector);
    };

    for (const element of [document.documentElement, document.body]) {
      const matchingRules = [...sheet.cssRules]
        .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
        .filter((rule) => rule.selectorText.split(',').some((selector) => matches(element, selector.trim())));
      const property = (name: string) => {
        const values = matchingRules.map((rule) => rule.style.getPropertyValue(name)).filter(Boolean);
        return values[values.length - 1] ?? '';
      };

      expect(property('height')).toBe('100%');
      expect(property('overflow')).toBe(locked ? 'hidden' : '');
      expect(property('overscroll-behavior')).toBe(locked ? 'none' : '');
    }
  }

  it('leaves an embedding document free to scroll without an app mount root', () => {
    const {sheet, cleanup} = mountAppRoot();

    expectDocumentToBeLocked(sheet, false);

    cleanup();
  });

  it.each(['__next', 'root'] as const)('locks the document for the #%s app mount root', (id) => {
    const {sheet, cleanup} = mountAppRoot(id);

    expectDocumentToBeLocked(sheet, true);

    cleanup();
  });
});
