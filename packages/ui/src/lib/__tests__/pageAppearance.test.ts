import {afterEach, describe, it, expect, vi} from 'vitest';
import {COVER_PROPERTY_ID, FONTS_PROPERTY_ID, THEME_PROPERTY_ID} from '@open-book/sdk';
import {hydratePageAppearance, readAppearanceFacet, setAppearanceBackend, writeAppearanceFacet} from '../pageAppearance';

afterEach(() => {
  setAppearanceBackend(null);
  localStorage.clear();
});

/**
 * Per-page theme/cover/fonts moved from localStorage to the page document
 * (`page.properties`). The store hydrates from a page record and writes through a
 * registered backend that persists to the server; a one-time migration lifts any
 * legacy localStorage value into the document. (Unique page ids per test keep the
 * module-level cache from leaking across cases.)
 */
describe('pageAppearance store', () => {
  it('hydrates facets from page.properties', () => {
    hydratePageAppearance('h1', {
      [THEME_PROPERTY_ID]: {themeId: 'ocean'},
      [COVER_PROPERTY_ID]: {kind: 'gradient', css: 'linear-gradient(x)'},
      [FONTS_PROPERTY_ID]: {body: 'serif'},
    });
    expect(readAppearanceFacet('h1', 'theme')).toEqual({themeId: 'ocean'});
    expect(readAppearanceFacet('h1', 'cover')).toEqual({kind: 'gradient', css: 'linear-gradient(x)'});
    expect(readAppearanceFacet('h1', 'fonts')).toEqual({body: 'serif'});
  });

  it('writes through to the document and clears with null', () => {
    const persist = vi.fn();
    setAppearanceBackend({persist, load: () => undefined});
    writeAppearanceFacet('w1', 'cover', {kind: 'gradient', css: 'g'});
    expect(persist).toHaveBeenCalledWith('w1', COVER_PROPERTY_ID, {kind: 'gradient', css: 'g'});
    writeAppearanceFacet('w1', 'cover', null);
    expect(persist).toHaveBeenLastCalledWith('w1', COVER_PROPERTY_ID, null);
    expect(readAppearanceFacet('w1', 'cover')).toBeNull();
  });

  it('keeps a stable reference when re-hydrated with unchanged data', () => {
    hydratePageAppearance('s1', {[THEME_PROPERTY_ID]: {themeId: 'rose'}});
    const a = readAppearanceFacet('s1', 'theme');
    hydratePageAppearance('s1', {[THEME_PROPERTY_ID]: {themeId: 'rose'}});
    // Same object back → useSyncExternalStore won't loop on equal data.
    expect(readAppearanceFacet('s1', 'theme')).toBe(a);
  });

  it('migrates a legacy localStorage cover into the document on first load', () => {
    const persist = vi.fn();
    setAppearanceBackend({persist, load: () => undefined});
    localStorage.setItem('openbook.cover.m1', JSON.stringify({kind: 'gradient', css: 'legacy'}));
    hydratePageAppearance('m1', {}); // no stored appearance → migrate from legacy
    expect(persist).toHaveBeenCalledWith('m1', COVER_PROPERTY_ID, {kind: 'gradient', css: 'legacy'});
    expect(readAppearanceFacet('m1', 'cover')).toEqual({kind: 'gradient', css: 'legacy'});
    expect(localStorage.getItem('openbook.cover.m1')).toBeNull(); // legacy key dropped
  });
});
