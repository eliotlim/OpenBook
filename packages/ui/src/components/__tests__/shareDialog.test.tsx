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
      ({...actual.useForwarding(), supported: true, publishedHost: mockPublishedHost}) as ReturnType<
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

const info = (): InstanceInfo => ({
  guestAccess: 'write',
  ownerSubject: null,
  trustedIssuers: [],
  audience: null,
  you: guestPrincipal('Rae'),
});

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
  it('offers copy-link + sign-in guidance when published with a pending email grant', async () => {
    mockPublishedHost = 'rae.book.cloud';
    wrap({
      getPageVisibility: async () => 'restricted',
      listPageAcl: async () => [acl({email: 'rae@example.com', subject: null})],
      getInstanceInfo: async () => info(),
    });
    open();
    expect(await screen.findByText('Copy link to send')).toBeTruthy();
  });

  it('hides the delivery help when every grant is subject-only (already signed in)', async () => {
    mockPublishedHost = 'rae.book.cloud';
    wrap({
      getPageVisibility: async () => 'restricted',
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
      getPageVisibility: async () => 'restricted',
      listPageAcl: async () => [acl({email: 'rae@example.com', subject: null})],
      getInstanceInfo: async () => info(),
    });
    open();
    expect(await screen.findByText('rae@example.com')).toBeTruthy();
    expect(screen.queryByText('Copy link to send')).toBeNull();
  });
});
