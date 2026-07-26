import {describe, it, expect, afterEach, beforeEach, vi} from 'vitest';
import {render, screen, cleanup, fireEvent, waitFor} from '@testing-library/react';
import type {DataClient, InstanceInfo, PageVisibility, SiteVisibility} from '@book.dev/sdk';
import {guestPrincipal} from '@book.dev/sdk';
import ShareDialog from '../ShareDialog';
import {DataProvider} from '@/data/DataProvider';
import {I18nProvider} from '@/providers';

// Drive the published address + its audience scope per-test (GATE-6): the Publish
// affordance and the "Published" indicator only make sense while the library is
// actually reachable at a *.book.cloud address.
let mockHost: string | null = null;
let mockSiteVisibility: SiteVisibility | null = null;
const setSiteVisibility = vi.fn(async () => undefined);
vi.mock('@/providers', async (orig) => {
  const actual = await orig<typeof import('@/providers')>();
  return {
    ...actual,
    useForwarding: () =>
      ({
        ...actual.useForwarding(),
        supported: true,
        publishedHost: mockHost,
        siteVisibility: mockSiteVisibility,
        siteVisibilityBusy: false,
        setSiteVisibility,
      }) as ReturnType<typeof actual.useForwarding>,
  };
});

const info = (over: Partial<InstanceInfo> = {}): InstanceInfo => ({
  guestAccess: 'write',
  ownerSubject: null,
  trustedIssuers: [],
  audience: null,
  you: guestPrincipal('Rae'),
  ...over,
});

const wrap = (visibility: PageVisibility, over: Partial<DataClient> = {}, instance: Partial<InstanceInfo> = {}) =>
  render(
    <I18nProvider>
      <DataProvider
        client={
          {
            getPageVisibility: async () => visibility,
            listPageAcl: async () => [],
            getInstanceInfo: async () => info(instance),
            setPageVisibility: vi.fn(async (_id: string, v: PageVisibility) => v),
            ...over,
          } as unknown as DataClient
        }
      >
        <ShareDialog pageId="p1" />
      </DataProvider>
    </I18nProvider>,
  );

const open = () => fireEvent.click(screen.getByLabelText('Share'));

beforeEach(() => {
  mockHost = 'rae.book.cloud';
  mockSiteVisibility = 'published';
  setSiteVisibility.mockClear();
});
afterEach(() => cleanup());

describe('ShareDialog — per-page Publish affordance (GATE-6)', () => {
  it('shows a "Published" indicator with the address when the page is public on a serving address', async () => {
    wrap('public');
    open();
    expect(await screen.findByText('Published')).toBeTruthy();
    expect(screen.getByText(/open this page at rae\.book\.cloud/)).toBeTruthy();
  });

  it('offers a one-click "Publish page" that sets the page public when it is not yet', async () => {
    const setPageVisibility = vi.fn(async (_id: string, v: PageVisibility) => v);
    wrap('restricted', {setPageVisibility});
    open();
    const btn = await screen.findByRole('button', {name: 'Publish page'});
    fireEvent.click(btn);
    await waitFor(() => expect(setPageVisibility).toHaveBeenCalledWith('p1', 'public'));
  });

  it('does not claim "Published" when the address does not serve public pages — it prompts the address fix instead', async () => {
    mockSiteVisibility = 'restricted';
    wrap('public');
    open();
    // The reworked honesty warning offers the recommended address fix…
    expect(await screen.findByRole('button', {name: 'Serve published pages'})).toBeTruthy();
    // …and the page is NOT advertised as live.
    expect(screen.queryByText('Published')).toBeNull();
  });

  it('clicking the address fix turns on published-pages (not full public)', async () => {
    mockSiteVisibility = 'restricted';
    wrap('public');
    open();
    fireEvent.click(await screen.findByRole('button', {name: 'Serve published pages'}));
    await waitFor(() => expect(setSiteVisibility).toHaveBeenCalledWith('published'));
  });

  it('does NOT claim "Published" when the guest gate is off — it shows the guest-off caveat instead', async () => {
    // Public page + serving address, but signed-out reads are denied by the guest
    // gate: the page isn't actually reachable, so the live indicator must not show.
    wrap('public', {}, {guestAccess: 'off'});
    open();
    // The guest-off caveat explains why the page isn't reachable. It appears in the
    // Publish row (this fix) alongside the SiteVisibilityControl's own copy of the
    // same caveat, so there is at least one — assert on all matches.
    expect((await screen.findAllByText(/Guest access is off/)).length).toBeGreaterThanOrEqual(1);
    // …and the page is NOT advertised as live.
    expect(screen.queryByText('Published')).toBeNull();
  });

  it('shows "Published" when the guest gate admits signed-out reads (read)', async () => {
    wrap('public', {}, {guestAccess: 'read'});
    open();
    expect(await screen.findByText('Published')).toBeTruthy();
    expect(screen.getByText(/open this page at rae\.book\.cloud/)).toBeTruthy();
    expect(screen.queryByText(/Guest access is off/)).toBeNull();
  });

  it('shows "Published" when the guest gate admits signed-out reads (write)', async () => {
    wrap('public', {}, {guestAccess: 'write'});
    open();
    expect(await screen.findByText('Published')).toBeTruthy();
    expect(screen.queryByText(/Guest access is off/)).toBeNull();
  });
});
