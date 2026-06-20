import {describe, it, expect} from 'vitest';
import {extractToken} from '../AccountProvider';

describe('extractToken (manual sign-in code paste)', () => {
  it('accepts a bare token', () => {
    expect(extractToken('abc123DEF')).toBe('abc123DEF');
    expect(extractToken('  abc123DEF  ')).toBe('abc123DEF'); // trims
  });

  it('pulls the token from the full openbook:// deep-link URL', () => {
    expect(extractToken('openbook://auth-callback#token=abc123&state=nonce')).toBe('abc123');
  });

  it('pulls the token from a web callback URL', () => {
    expect(extractToken('https://app.book.pub/account/callback#token=tok_XYZ&state=s')).toBe('tok_XYZ');
  });

  it('pulls the token from a bare fragment or query', () => {
    expect(extractToken('#token=frag_tok&state=s')).toBe('frag_tok');
    expect(extractToken('token=query_tok')).toBe('query_tok');
  });

  it('keeps tokens that contain "=" (opaque values)', () => {
    expect(extractToken('openbook://auth-callback#token=a=b=c&state=s')).toBe('a=b=c');
  });

  it('url-decodes a percent-encoded token', () => {
    expect(extractToken('openbook://auth-callback#token=a%2Bb')).toBe('a+b');
  });

  it('rejects empty, whitespace-laden, or URL-without-token input', () => {
    expect(extractToken('')).toBeNull();
    expect(extractToken('   ')).toBeNull();
    expect(extractToken('two words')).toBeNull();
    expect(extractToken('https://example.com/no-token-here')).toBeNull();
  });
});
