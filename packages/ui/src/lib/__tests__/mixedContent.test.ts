import {describe, it, expect} from 'vitest';
import {isMixedContentBlocked} from '@book.dev/sdk';

// `pageProtocol` is passed explicitly so the test doesn't depend on the jsdom
// location. This mirrors the real failure: app.book.pub (https) → http LAN server.
describe('isMixedContentBlocked', () => {
  it('blocks an http LAN server from an https page', () => {
    expect(isMixedContentBlocked('http://192.168.1.224:4319/api/ai/status', 'https:')).toBe(true);
    expect(isMixedContentBlocked('http://my-nas.local:4319', 'https:')).toBe(true);
  });

  it('allows http://localhost (potentially trustworthy) from an https page', () => {
    expect(isMixedContentBlocked('http://localhost:4319', 'https:')).toBe(false);
    expect(isMixedContentBlocked('http://127.0.0.1:4319', 'https:')).toBe(false);
    expect(isMixedContentBlocked('http://dev.localhost:4319', 'https:')).toBe(false);
  });

  it('allows an https remote from an https page', () => {
    expect(isMixedContentBlocked('https://abc.book.pub', 'https:')).toBe(false);
    expect(isMixedContentBlocked('https://192.168.1.224:4319', 'https:')).toBe(false);
  });

  it('does not block anything from an http page (no downgrade)', () => {
    expect(isMixedContentBlocked('http://192.168.1.224:4319', 'http:')).toBe(false);
  });

  it('ignores non-absolute / unparseable values', () => {
    expect(isMixedContentBlocked('', 'https:')).toBe(false);
    expect(isMixedContentBlocked('/api/ai/status', 'https:')).toBe(false);
    expect(isMixedContentBlocked('not a url', 'https:')).toBe(false);
  });
});
