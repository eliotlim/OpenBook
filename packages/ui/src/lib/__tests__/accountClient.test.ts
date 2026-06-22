import {describe, it, expect} from 'vitest';
import {AccountClient, DEFAULT_ACCOUNT_URL} from '@book.dev/sdk';

describe('AccountClient', () => {
  it('defaults to the production account service', () => {
    expect(new AccountClient().origin).toBe('https://account.book.pub');
    expect(DEFAULT_ACCOUNT_URL).toBe('https://account.book.pub');
  });

  it('trims a trailing slash from the base URL', () => {
    expect(new AccountClient('https://account.book.pub/').origin).toBe('https://account.book.pub');
  });

  it('builds the deep-link connect URL with redirect_uri / state / name', () => {
    const c = new AccountClient('https://account.book.pub');
    const url = new URL(c.connectUrl({redirectUri: 'openbook://auth-callback', state: 'abc123', name: 'OpenBook Desktop · ab12'}));
    expect(`${url.origin}${url.pathname}`).toBe('https://account.book.pub/api/connect');
    expect(url.searchParams.get('redirect_uri')).toBe('openbook://auth-callback');
    expect(url.searchParams.get('state')).toBe('abc123');
    expect(url.searchParams.get('name')).toBe('OpenBook Desktop · ab12');
  });

  it('omits the name when not provided', () => {
    const url = new URL(new AccountClient().connectUrl({redirectUri: 'https://app.book.pub/account/callback', state: 's'}));
    expect(url.searchParams.has('name')).toBe(false);
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.book.pub/account/callback');
  });
});
