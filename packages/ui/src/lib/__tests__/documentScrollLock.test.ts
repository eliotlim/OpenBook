import {describe, expect, it} from 'vitest';
// @ts-expect-error -- Vitest runs in Node; the browser package omits Node ambient types.
import {readFileSync} from 'node:fs';

const CSS = readFileSync('src/index.css', 'utf8');

describe('document scroll lock', () => {
  it('locks both platform mount chains in the shared base layer', () => {
    const sourceRule = CSS.match(/\n\s*html,\s*\n\s*body,\s*\n\s*#__next,\s*\n\s*#root\s*\{[^}]+\}/)?.[0];
    expect(sourceRule, 'shared html/body/mount rule').toBeTruthy();

    const style = document.createElement('style');
    style.textContent = sourceRule!;
    document.head.append(style);

    const rule = style.sheet?.cssRules[0] as CSSStyleRule | undefined;
    expect(rule?.selectorText.split(',').map((selector) => selector.trim())).toEqual([
      'html',
      'body',
      '#__next',
      '#root',
    ]);
    expect(rule?.style.getPropertyValue('height')).toBe('100%');
    expect(rule?.style.getPropertyValue('overflow')).toBe('hidden');
    expect(rule?.style.getPropertyValue('overscroll-behavior')).toBe('none');

    style.remove();
  });
});
