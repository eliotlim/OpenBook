import {afterEach, describe, expect, it} from 'vitest';
import {getShareLinkOrigin, pageLinkUrl, setShareLinkOrigin} from '../pageActions';

// The registry is a module singleton — always leave it clean for other suites.
afterEach(() => setShareLinkOrigin(null));

describe('pageLinkUrl (no share origin registered)', () => {
  it('builds from window.location with ?page=<id>', () => {
    window.history.replaceState(null, '', '/?x=1');
    const url = new URL(pageLinkUrl('p1'));
    expect(url.origin).toBe(window.location.origin);
    expect(url.searchParams.get('page')).toBe('p1');
    expect(url.searchParams.get('x')).toBe('1'); // unrelated params survive
  });

  it('drops the split param', () => {
    window.history.replaceState(null, '', '/?split=abc&page=old');
    const url = new URL(pageLinkUrl('p2'));
    expect(url.searchParams.get('split')).toBeNull();
    expect(url.searchParams.get('page')).toBe('p2'); // replaced, not doubled
  });
});

describe('pageLinkUrl (share origin registered — published workspace)', () => {
  it('emits the published address instead of window.location', () => {
    setShareLinkOrigin('prefix.book.cloud');
    expect(pageLinkUrl('p1')).toBe('https://prefix.book.cloud/?page=p1');
  });

  it('never carries the local path/params (incl. split) onto the published link', () => {
    window.history.replaceState(null, '', '/some/path?split=s&page=old&x=1');
    setShareLinkOrigin('prefix.book.cloud');
    expect(pageLinkUrl('new')).toBe('https://prefix.book.cloud/?page=new');
  });

  it('normalizes everything to a bare https origin', () => {
    setShareLinkOrigin('https://prefix.book.cloud');
    expect(getShareLinkOrigin()).toBe('https://prefix.book.cloud');
    setShareLinkOrigin('bare.book.cloud');
    expect(getShareLinkOrigin()).toBe('https://bare.book.cloud');
    // Other schemes are upgraded — published sites are https-only.
    setShareLinkOrigin('http://prefix.book.cloud');
    expect(getShareLinkOrigin()).toBe('https://prefix.book.cloud');
    // Accidental path/query cruft is stripped; a port survives.
    setShareLinkOrigin('https://prefix.book.cloud/some/path?x=1');
    expect(getShareLinkOrigin()).toBe('https://prefix.book.cloud');
    setShareLinkOrigin('prefix.book.cloud:8443');
    expect(getShareLinkOrigin()).toBe('https://prefix.book.cloud:8443');
  });

  it('clears (rather than stores) an unusable value, so pageLinkUrl never throws', () => {
    setShareLinkOrigin('prefix.book.cloud');
    setShareLinkOrigin('http://'); // unparseable → registry cleared
    expect(getShareLinkOrigin()).toBeNull();
    setShareLinkOrigin('file:///etc/hosts'); // parseable but hostless → cleared
    expect(getShareLinkOrigin()).toBeNull();
    expect(new URL(pageLinkUrl('p9')).origin).toBe(window.location.origin); // falls back, no throw
  });

  it('clears with null and falls back to window.location', () => {
    setShareLinkOrigin('prefix.book.cloud');
    setShareLinkOrigin(null);
    expect(getShareLinkOrigin()).toBeNull();
    expect(new URL(pageLinkUrl('p3')).origin).toBe(window.location.origin);
  });
});
