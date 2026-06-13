import {describe, it, expect, beforeEach, vi} from 'vitest';
import {readPageFullWidth, writePageFullWidth, togglePageFullWidth, subscribePageFullWidth} from '../pageFullWidth';
import {readPageCover, writePageCover, COVER_GRADIENTS} from '../pageCover';
import {readPageFonts, writePageFonts, fontCss, pageFontStyle} from '../pageFont';
import {getPageCustomiseTarget, setPageCustomiseTarget, subscribePageCustomise} from '../pageCustomise';

beforeEach(() => {
  localStorage.clear();
  setPageCustomiseTarget(null);
});

describe('pageFullWidth', () => {
  it('defaults to false and round-trips a true value', () => {
    expect(readPageFullWidth('p1')).toBe(false);
    writePageFullWidth('p1', true);
    expect(readPageFullWidth('p1')).toBe(true);
    expect(localStorage.getItem('openbook.fullwidth.p1')).toBe('1');
  });

  it('clears the key when set back to false', () => {
    writePageFullWidth('p1', true);
    writePageFullWidth('p1', false);
    expect(readPageFullWidth('p1')).toBe(false);
    expect(localStorage.getItem('openbook.fullwidth.p1')).toBeNull();
  });

  it('toggle flips the value and is scoped per page', () => {
    togglePageFullWidth('a');
    expect(readPageFullWidth('a')).toBe(true);
    expect(readPageFullWidth('b')).toBe(false); // independent
    togglePageFullWidth('a');
    expect(readPageFullWidth('a')).toBe(false);
  });

  it('notifies subscribers on write', () => {
    const cb = vi.fn();
    const unsub = subscribePageFullWidth(cb);
    writePageFullWidth('p1', true);
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
    writePageFullWidth('p1', false);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('pageCover', () => {
  it('defaults to null and round-trips a gradient', () => {
    expect(readPageCover('p1')).toBeNull();
    writePageCover('p1', {kind: 'gradient', css: 'linear-gradient(1deg, #000, #fff)'});
    expect(readPageCover('p1')).toEqual({kind: 'gradient', css: 'linear-gradient(1deg, #000, #fff)'});
  });

  it('round-trips an image with a focal position and clears with null', () => {
    writePageCover('p1', {kind: 'image', url: 'https://x/y.png', position: 30});
    expect(readPageCover('p1')).toEqual({kind: 'image', url: 'https://x/y.png', position: 30});
    writePageCover('p1', null);
    expect(readPageCover('p1')).toBeNull();
  });

  it('ignores malformed stored data', () => {
    localStorage.setItem('openbook.cover.p1', '{not json');
    expect(readPageCover('p1')).toBeNull();
    localStorage.setItem('openbook.cover.p2', JSON.stringify({kind: 'nope'}));
    expect(readPageCover('p2')).toBeNull();
  });

  it('ships a non-empty set of gradient presets, each with a css background', () => {
    expect(COVER_GRADIENTS.length).toBeGreaterThan(4);
    for (const g of COVER_GRADIENTS) expect(g.css).toMatch(/gradient/);
  });
});

describe('pageFont', () => {
  it('resolves presets to the app font stacks and passes custom families through', () => {
    expect(fontCss('sans')).toBe('var(--font-sans)');
    expect(fontCss('serif')).toBe('var(--font-serif)');
    expect(fontCss('mono')).toBe('var(--font-mono)');
    expect(fontCss('"Inter", system-ui')).toBe('"Inter", system-ui');
    expect(fontCss(undefined)).toBeUndefined();
  });

  it('round-trips a body/heading override and clears when empty', () => {
    expect(readPageFonts('p1')).toBeNull();
    writePageFonts('p1', {body: 'serif', heading: 'mono'});
    expect(readPageFonts('p1')).toEqual({body: 'serif', heading: 'mono'});
    writePageFonts('p1', {body: undefined, heading: undefined});
    expect(readPageFonts('p1')).toBeNull();
  });

  it('builds scoped CSS variables (or undefined when nothing is set)', () => {
    expect(pageFontStyle(null)).toBeUndefined();
    expect(pageFontStyle({})).toBeUndefined();
    expect(pageFontStyle({body: 'serif'})).toEqual({'--ob-font-body': 'var(--font-serif)'});
    expect(pageFontStyle({heading: '"Inter"'})).toEqual({'--ob-font-heading': '"Inter"'});
  });
});

describe('pageCustomise bridge', () => {
  it('tracks the target page and notifies on change', () => {
    expect(getPageCustomiseTarget()).toBeNull();
    const cb = vi.fn();
    const unsub = subscribePageCustomise(cb);
    setPageCustomiseTarget('p1');
    expect(getPageCustomiseTarget()).toBe('p1');
    expect(cb).toHaveBeenCalledTimes(1);
    setPageCustomiseTarget('p1'); // no-op, same value
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
  });
});
