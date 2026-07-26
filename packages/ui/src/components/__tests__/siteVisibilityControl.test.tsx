import {describe, it, expect, afterEach, beforeEach, vi} from 'vitest';
import {render, screen, cleanup, fireEvent, waitFor} from '@testing-library/react';
import type {DataClient, GuestAccess, SiteVisibility} from '@book.dev/sdk';
import {guestPrincipal} from '@book.dev/sdk';
import {SiteVisibilityControl} from '../SiteVisibilityControl';
import {DataProvider} from '@/data/DataProvider';
import {I18nProvider} from '@/providers';

// Drive the forwarding state per-test: the control renders only while this device
// is actually publishing (`publishedHost`) and reflects the account's site scope.
type Fw = {
  publishedHost: string | null;
  siteVisibility: SiteVisibility | null;
  siteVisibilityBusy: boolean;
  setSiteVisibility: (v: SiteVisibility) => Promise<void>;
};
let fw: Fw;
vi.mock('@/providers', async (orig) => {
  const actual = await orig<typeof import('@/providers')>();
  return {
    ...actual,
    useForwarding: () => ({...actual.useForwarding(), ...fw}) as ReturnType<typeof actual.useForwarding>,
  };
});

const client = (guestAccess: GuestAccess = 'read'): Partial<DataClient> => ({
  getInstanceInfo: async () => ({
    guestAccess,
    ownerSubject: null,
    trustedIssuers: [],
    audience: null,
    you: guestPrincipal('Ola'),
  }),
});

const wrap = (c: Partial<DataClient> = client()) =>
  render(
    <I18nProvider>
      <DataProvider client={c as DataClient}>
        <SiteVisibilityControl />
      </DataProvider>
    </I18nProvider>,
  );

beforeEach(() => {
  fw = {
    publishedHost: 'ola.book.cloud',
    siteVisibility: 'published',
    siteVisibilityBusy: false,
    setSiteVisibility: vi.fn(async () => undefined),
  };
});
afterEach(() => cleanup());

describe('SiteVisibilityControl — third "Only published pages" option (GATE-5)', () => {
  it('renders nothing until the site is actually publishing', () => {
    fw.publishedHost = null;
    const {container} = wrap();
    expect(container.textContent).toBe('');
  });

  it('offers all three settable scopes with published recommended, and shows its hint', () => {
    wrap();
    // The closed combobox shows the current scope (published, recommended).
    expect(screen.getByText('Only published pages (Recommended)')).toBeTruthy();
    expect(screen.getByText('Anyone with the link can open the pages you publish. Everything else stays private.')).toBeTruthy();
    // The dropdown offers Private + Public too.
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getByRole('option', {name: 'Private'})).toBeTruthy();
    expect(screen.getByRole('option', {name: 'Public'})).toBeTruthy();
  });

  it('picking Public flips the address scope to public', async () => {
    wrap();
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', {name: 'Public'}));
    await waitFor(() => expect(fw.setSiteVisibility).toHaveBeenCalledWith('public'));
  });

  it('re-selecting the already-current scope never writes', async () => {
    wrap();
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', {name: 'Only published pages (Recommended)'}));
    await new Promise((r) => setTimeout(r, 10));
    expect(fw.setSiteVisibility).not.toHaveBeenCalled();
  });
});

describe('SiteVisibilityControl — guest-gate-off caveat (GATE-5)', () => {
  it('warns that published pages still won’t open for signed-out visitors when guest access is off', async () => {
    wrap(client('off'));
    expect(await screen.findByText(/Guest access is off/)).toBeTruthy();
  });

  it('shows no caveat when guests may read', async () => {
    wrap(client('read'));
    // Let the instance probe resolve, then assert the caveat never appeared.
    await screen.findByRole('combobox');
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText(/Guest access is off/)).toBeNull();
  });
});

describe('SiteVisibilityControl — honest read-only row for signed-in scopes', () => {
  it('renders authenticated as a disabled, accurately-labelled control (never "Private")', async () => {
    fw.siteVisibility = 'authenticated';
    wrap();
    // Accurate label, disabled combobox, and NOT collapsed to Private.
    expect(screen.getByText('Anyone signed in')).toBeTruthy();
    expect(screen.getByRole('combobox')).toHaveProperty('disabled', true);
    expect(screen.queryByText('Only published pages (Recommended)')).toBeNull();
  });
});
