import {describe, expect, it, vi} from 'vitest';
import {checkForUpdateViaAccount, compareSemver, mapUpdateCheckResponse} from '../updateCheck';

/** A minimal fetch mock: resolves `body` (string = raw text, object = JSON). */
const fetchResolving = (body: unknown, status = 200): typeof fetch =>
  vi.fn(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: {'content-type': 'application/json'},
    }),
  ) as unknown as typeof fetch;

const CHECK_OK = {
  latestVersion: '1.70.2',
  latestMajor: '2.1.0',
  latestForCurrentMajor: '1.70.2',
  security: {updateAvailable: false, fixedIn: null},
};

describe('compareSemver', () => {
  it('orders plain triples', () => {
    expect(compareSemver('1.69.1', '1.70.0')).toBe(-1);
    expect(compareSemver('1.70.0', '1.69.1')).toBe(1);
    expect(compareSemver('1.70.0', '1.70.0')).toBe(0);
    expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
  });

  it('treats unparseable versions as equal (no phantom update)', () => {
    expect(compareSemver('garbage', '1.70.0')).toBe(0);
    expect(compareSemver('1.70.0', '')).toBe(0);
  });
});

describe('mapUpdateCheckResponse', () => {
  it('maps a newer same-major version to update-available', () => {
    const r = mapUpdateCheckResponse('1.69.1', CHECK_OK);
    expect(r.status).toBe('update-available');
    expect(r.latestVersion).toBe('1.70.2');
    expect(r.latestMajor).toBe('2.1.0');
    expect(r.latestForCurrentMajor).toBe('1.70.2');
    // fixedIn: null on the wire normalizes to absent.
    expect(r.security).toEqual({updateAvailable: false, fixedIn: undefined});
  });

  it('maps the current version to up-to-date', () => {
    const r = mapUpdateCheckResponse('1.70.2', CHECK_OK);
    expect(r.status).toBe('up-to-date');
  });

  it('a newer major alone is NOT update-available (no auto major jump)', () => {
    const r = mapUpdateCheckResponse('1.70.2', {...CHECK_OK, latestMajor: '2.1.0'});
    expect(r.status).toBe('up-to-date');
    expect(r.latestMajor).toBe('2.1.0'); // still surfaced for an explicit action
  });

  it('surfaces a security fix', () => {
    const r = mapUpdateCheckResponse('1.69.1', {
      ...CHECK_OK,
      security: {updateAvailable: true, fixedIn: '1.70.0'},
    });
    expect(r.status).toBe('update-available');
    expect(r.security).toEqual({updateAvailable: true, fixedIn: '1.70.0'});
  });

  it('falls back to latestVersion when latestForCurrentMajor is missing', () => {
    const r = mapUpdateCheckResponse('1.69.1', {latestVersion: '1.70.0'});
    expect(r.status).toBe('update-available');
  });

  it('maps an unrecognized shape to error', () => {
    expect(mapUpdateCheckResponse('1.69.1', {}).status).toBe('error');
    expect(mapUpdateCheckResponse('1.69.1', null).status).toBe('error');
    expect(mapUpdateCheckResponse('1.69.1', [1, 2]).status).toBe('error');
    expect(mapUpdateCheckResponse('1.69.1', {latestVersion: 42}).status).toBe('error');
  });
});

describe('checkForUpdateViaAccount', () => {
  const params = {version: '1.69.1', target: 'darwin', arch: 'aarch64'};

  it('requests the contract URL with encoded query params', async () => {
    const fetchImpl = fetchResolving(CHECK_OK);
    await checkForUpdateViaAccount(params, {fetchImpl, baseUrl: 'https://account.example'});
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://account.example/api/updates/check?version=1.69.1&target=darwin&arch=aarch64',
      expect.objectContaining({headers: {accept: 'application/json'}}),
    );
  });

  it('resolves update-available from a live-shaped response', async () => {
    const r = await checkForUpdateViaAccount(params, {
      fetchImpl: fetchResolving(CHECK_OK),
      baseUrl: 'https://account.example',
    });
    expect(r.status).toBe('update-available');
    expect(r.latestForCurrentMajor).toBe('1.70.2');
  });

  it('resolves up-to-date when already on the latest same-major', async () => {
    const r = await checkForUpdateViaAccount(
      {...params, version: '1.70.2'},
      {fetchImpl: fetchResolving(CHECK_OK), baseUrl: 'https://account.example'},
    );
    expect(r.status).toBe('up-to-date');
  });

  it('resolves error (never rejects) on HTTP failure', async () => {
    const r = await checkForUpdateViaAccount(params, {
      fetchImpl: fetchResolving({message: 'nope'}, 500),
      baseUrl: 'https://account.example',
    });
    expect(r).toEqual({status: 'error', error: 'update check failed (HTTP 500)'});
  });

  it('resolves error (never rejects) when fetch itself rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const r = await checkForUpdateViaAccount(params, {fetchImpl, baseUrl: 'https://account.example'});
    expect(r.status).toBe('error');
    expect(r.error).toBe('network down');
  });

  it('resolves error on malformed JSON', async () => {
    const r = await checkForUpdateViaAccount(params, {
      fetchImpl: fetchResolving('not-json{{{'),
      baseUrl: 'https://account.example',
    });
    expect(r).toEqual({status: 'error', error: 'update check returned malformed JSON'});
  });
});
