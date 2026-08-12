import {describe, it, expect, afterEach, beforeEach, vi} from 'vitest';
import {render, screen, cleanup, fireEvent, waitFor} from '@testing-library/react';
import type {DataClient, InstanceInfo, PageVisibility, SiteVisibility} from '@book.dev/sdk';
import {guestPrincipal} from '@book.dev/sdk';
import ShareDialog from '../ShareDialog';
import {DataProvider} from '@/data/DataProvider';
import {I18nProvider} from '@/providers';
import {closeKitPanel, getKitPanel} from '@/blockeditor/kit/kitPanel';

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
            getPage: async () => null,
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

const formPage = (over: {
  enabled?: boolean;
  submissionKey?: string;
  databaseId?: string | null;
  fields?: Array<Record<string, unknown>>;
} = {}) => {
  const databaseId = over.databaseId === undefined ? 'responses-db' : over.databaseId;
  const fields = over.fields ?? [{id: 'name', kind: 'text', columnId: 'name-column'}];
  return {
    id: 'p1',
    data: {
      editorjs: {blocks: []},
      values: [],
      names: [],
      blockdoc: {
        blocks: [{
          id: 'form-block',
          type: 'form',
          props: {
            enabled: over.enabled ?? true,
            submissionKey: over.submissionKey ?? 'private-capability-never-rendered',
            ...(databaseId ? {databaseId} : {}),
            schema: {
              ...(databaseId ? {databaseId} : {}),
              fields,
            },
          },
        }],
      },
    },
  } as unknown as NonNullable<Awaited<ReturnType<DataClient['getPage']>>>;
};

beforeEach(() => {
  mockHost = 'rae.book.cloud';
  mockSiteVisibility = 'published';
  setSiteVisibility.mockClear();
});
afterEach(() => {
  cleanup();
  closeKitPanel({keepPane: true});
});

describe('ShareDialog — per-page Publish affordance (GATE-6)', () => {
  it('shows a "Published" indicator with the address when the page is public on a serving address', async () => {
    wrap('public');
    open();
    const published = await screen.findByText('Published');
    expect(published.parentElement?.textContent).toContain('open this page at rae.book.cloud');
  });

  it('lets the published address break mid-token so it cannot overflow the panel', async () => {
    mockHost = 'a-very-long-library-slug-for-overflow.book.cloud';
    wrap('public');
    open();
    const published = await screen.findByText('Published');
    const host = Array.from(published.parentElement?.querySelectorAll('span') ?? []).find(
      (span) => span.textContent === mockHost,
    );
    expect(host?.className).toContain('break-all');
    expect(host?.textContent).toBe(mockHost);
  });

  it('lets the unpublished address hint break mid-token so it cannot overflow the panel', async () => {
    mockHost = 'a-very-long-library-slug-for-overflow.book.cloud';
    wrap('restricted');
    open();
    const hint = await screen.findByText(/Publish this page so anyone with the link can open it at/);
    const host = Array.from(hint.querySelectorAll('span')).find((span) => span.textContent === mockHost);
    expect(host?.className).toContain('break-all');
    expect(host?.textContent).toBe(mockHost);
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
    const published = await screen.findByText('Published');
    expect(published.parentElement?.textContent).toContain('open this page at rae.book.cloud');
    expect(screen.queryByText(/Guest access is off/)).toBeNull();
  });

  it('shows "Published" when the guest gate admits signed-out reads (write)', async () => {
    wrap('public', {}, {guestAccess: 'write'});
    open();
    expect(await screen.findByText('Published')).toBeTruthy();
    expect(screen.queryByText(/Guest access is off/)).toBeNull();
  });
});

describe('ShareDialog — enabled form reachability (FORM-8)', () => {
  it('surfaces an enabled form and its effective public address without exposing the key', async () => {
    wrap('public', {getPage: async () => formPage()});
    open();

    const line = await screen.findByText('This page accepts public submissions');
    expect(line.parentElement?.textContent).toContain('Signed-out visitors can submit at rae.book.cloud.');
    expect(screen.getByRole('button', {name: 'Form settings'})).toBeTruthy();
    expect(document.body.textContent).not.toContain('private-capability-never-rendered');
  });

  it('opens the enabled form block settings from the disclosure', async () => {
    wrap('public', {getPage: async () => formPage()});
    open();

    fireEvent.click(await screen.findByRole('button', {name: 'Form settings'}));
    await waitFor(() => expect(getKitPanel()).toEqual({blockId: 'form-block', title: 'Form'}));
  });

  it('reports when page access prevents signed-out visitors from reaching an enabled form', async () => {
    wrap('restricted', {getPage: async () => formPage()});
    open();

    expect(await screen.findByText('This page accepts public submissions')).toBeTruthy();
    expect(screen.getByText(/signed-out visitors cannot reach it until this page is public/)).toBeTruthy();
  });

  it('mirrors the guest-off 404 caveat at an otherwise public form address', async () => {
    wrap('public', {getPage: async () => formPage()}, {guestAccess: 'off'});
    open();

    expect(await screen.findByText('This page accepts public submissions')).toBeTruthy();
    expect(screen.getByText(/signed-out visitors get a "page not found" \(404\) error even at this public address/)).toBeTruthy();
    expect(screen.getByRole('button', {name: 'Manage guest access'})).toBeTruthy();
  });

  it.each([
    ['no database', {databaseId: null}],
    ['no bound field', {fields: [{id: 'name', kind: 'text'}]}],
  ])('shows an amber not-ready state, not an affirmative signal, with %s', async (_name, over) => {
    wrap('public', {getPage: async () => formPage(over)});
    open();

    const message = await screen.findByText('This form isn\'t ready — bind a database to accept responses');
    expect(message.closest('[data-form-not-ready]')?.className).toContain('border-amber-500/40');
    expect(screen.queryByText('This page accepts public submissions')).toBeNull();
    expect(screen.queryByText(/Signed-out visitors can submit at/)).toBeNull();

    fireEvent.click(screen.getByRole('button', {name: 'Form settings'}));
    await waitFor(() => expect(getKitPanel()).toEqual({blockId: 'form-block', title: 'Form'}));
  });

  it.each([
    ['disabled', {enabled: false}],
    ['keyless', {submissionKey: ''}],
  ])('does not surface a %s form', async (_name, over) => {
    wrap('public', {getPage: async () => formPage(over)});
    open();

    expect(await screen.findByText('Published')).toBeTruthy();
    expect(screen.queryByText('This page accepts public submissions')).toBeNull();
  });
});
