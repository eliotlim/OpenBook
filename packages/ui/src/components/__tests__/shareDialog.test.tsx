import {describe, it, expect, afterEach, vi} from 'vitest';
import {render, screen, cleanup, fireEvent} from '@testing-library/react';
import type {DataClient, InstanceInfo, PageAcl} from '@book.dev/sdk';
import {guestPrincipal} from '@book.dev/sdk';
import ShareDialog from '../ShareDialog';
import {DataProvider} from '@/data/DataProvider';
import {I18nProvider} from '@/providers';

// The forwarded page link is only known while the workspace is published —
// drive it per-test so we can assert the delivery-help affordance (P0-2)
// appears only then. The rest of the providers barrel stays real.
let mockPublishedHost: string | null = null;
vi.mock('@/providers', async (orig) => {
  const actual = await orig<typeof import('@/providers')>();
  return {
    ...actual,
    useForwarding: () =>
      ({...actual.useForwarding(), supported: true, publishedHost: mockPublishedHost, siteVisibility: mockPublishedHost ? 'published' : null, canPublish: false}) as ReturnType<
        typeof actual.useForwarding
      >,
  };
});

const acl = (over: Partial<PageAcl> = {}): PageAcl => ({
  pageId: 'p1',
  subject: null,
  email: 'rae@example.com',
  issuer: 'https://account.book.pub',
  level: 'read',
  invitedBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const info = (over: Partial<InstanceInfo> = {}): InstanceInfo => ({
  guestAccess: 'write',
  ownerSubject: null,
  trustedIssuers: [],
  audience: null,
  you: guestPrincipal('Rae'),
  ...over,
});

const formPage = (ready: boolean) => ({
  id: 'p1',
  data: {blockdoc: {blocks: [{
    id: 'form-block',
    type: 'form',
    props: {
      enabled: true,
      submissionKey: 'private-capability',
      ...(ready ? {databaseId: 'responses-db'} : {}),
      schema: {fields: ready ? [{id: 'name', columnId: 'name-column'}] : []},
    },
  }]}},
}) as unknown as NonNullable<Awaited<ReturnType<DataClient['getPage']>>>;

const wrap = (client: Partial<DataClient>) =>
  render(
    <I18nProvider>
      <DataProvider client={{getPage: async () => null, ...client} as DataClient}>
        <ShareDialog pageId="p1" />
      </DataProvider>
    </I18nProvider>,
  );

// Open the dialog by clicking its trigger (aria-label "Share").
const open = () => fireEvent.click(screen.getByLabelText('Share'));

afterEach(() => {
  cleanup();
  mockPublishedHost = null;
});

describe('ShareDialog delivery help (P0-2)', () => {
  it('shows the effective guest-access fallback while the library is unclaimed', async () => {
    wrap({
      getPageVisibility: async () => ({visibility: 'inherit', listed: true}),
      listPageAcl: async () => [],
      getInstanceInfo: async () => info({guestAccess: 'read'}),
    });
    open();
    expect(await screen.findByText('Right now the library default lets anyone who can reach it view.')).toBeTruthy();
  });

  it.each([
    ['unclaimed', () => ({getPage: async () => null, getInstanceInfo: async () => info()}), 'p.rounded-md'],
    ['form', () => ({getPage: async () => formPage(false), getInstanceInfo: async () => info()}), '[data-form-not-ready]'],
    ['guest-off', () => ({getPage: async () => formPage(true), getInstanceInfo: async () => info({guestAccess: 'off'})}), '[data-form-public-submissions]'],
  ] as const)('keeps the %s compact row to one block-level text child', async (_state, client, selector) => {
    mockPublishedHost = 'rae.book.cloud';
    wrap({
      getPageVisibility: async () => ({visibility: 'inherit', listed: true}),
      listPageAcl: async () => [],
      ...client(),
    });
    open();
    const body = await screen.findByTestId('share-dialog-body');
    const row = await vi.waitFor(() => {
      const found = body.querySelector(selector);
      expect(found).toBeTruthy();
      return found!;
    });
    expect(row.querySelectorAll(':scope > p, :scope > span:not(.sr-only)').length).toBeLessThan(2);
  });
  it('offers copy-link + sign-in guidance when published with a pending email grant', async () => {
    mockPublishedHost = 'rae.book.cloud';
    wrap({
      getPageVisibility: async () => ({visibility: 'restricted', listed: true}),
      listPageAcl: async () => [acl({email: 'rae@example.com', subject: null})],
      getInstanceInfo: async () => info(),
    });
    open();
    expect(await screen.findByText('Copy link to send')).toBeTruthy();
  });

  it('hides the delivery help when every grant is subject-only (already signed in)', async () => {
    mockPublishedHost = 'rae.book.cloud';
    wrap({
      getPageVisibility: async () => ({visibility: 'restricted', listed: true}),
      // A subject-only grant: claimMemberships re-keyed email→subject on first
      // sign-in, so there's no pending email to hand a link to.
      listPageAcl: async () => [acl({email: null, subject: 'acct#rae'})],
      getInstanceInfo: async () => info(),
    });
    open();
    // The roster renders (the grant's subject shows) but no delivery affordance.
    expect(await screen.findByText('acct#rae')).toBeTruthy();
    expect(screen.queryByText('Copy link to send')).toBeNull();
  });

  it('hides the delivery help when not published, even with a pending email grant', async () => {
    mockPublishedHost = null;
    wrap({
      getPageVisibility: async () => ({visibility: 'restricted', listed: true}),
      listPageAcl: async () => [acl({email: 'rae@example.com', subject: null})],
      getInstanceInfo: async () => info(),
    });
    open();
    expect(await screen.findByText('rae@example.com')).toBeTruthy();
    expect(screen.queryByText('Copy link to send')).toBeNull();
  });
});
