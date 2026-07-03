import {describe, it, expect, afterEach, vi} from 'vitest';
import {render, screen, cleanup} from '@testing-library/react';
import type {DataClient, Member} from '@book.dev/sdk';
import {guestPrincipal} from '@book.dev/sdk';
import MembersSettings from '../settings/MembersSettings';
import {DataProvider} from '@/data/DataProvider';
import {ConfirmProvider, I18nProvider} from '@/providers';

// The forwarded root is only known while the workspace is published — drive it
// per-test so we can assert the delivery-help affordance (P0-2) appears only
// then. Everything else in the barrel stays real.
let mockPublishedHost: string | null = null;
vi.mock('@/providers', async (orig) => {
  const actual = await orig<typeof import('@/providers')>();
  return {
    ...actual,
    useForwarding: () =>
      ({...actual.useForwarding(), publishedHost: mockPublishedHost}) as ReturnType<typeof actual.useForwarding>,
  };
});

const wrap = (client: Partial<DataClient>) =>
  render(
    <I18nProvider>
      <ConfirmProvider>
        <DataProvider client={client as DataClient}>
          <MembersSettings />
        </DataProvider>
      </ConfirmProvider>
    </I18nProvider>,
  );

const member = (over: Partial<Member> = {}): Member => ({
  id: 'm1',
  subject: null,
  email: 'rae@example.com',
  issuer: 'https://account.book.pub',
  role: 'viewer',
  status: 'invited',
  invitedBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

afterEach(() => {
  cleanup();
  mockPublishedHost = null;
});

describe('MembersSettings (roster)', () => {
  it('lists members and shows the invite controls to a manager', async () => {
    const client: Partial<DataClient> = {
      getInstanceInfo: async () => ({
        guestAccess: 'write',
        ownerSubject: null, // unclaimed → the (guest) caller manages
        trustedIssuers: [],
        audience: null,
        you: guestPrincipal('Rae'),
      }),
      listMembers: async () => [member()],
    };
    wrap(client);
    expect(await screen.findByText('rae@example.com')).toBeTruthy();
    expect(await screen.findByText('Invited')).toBeTruthy();
    // The invite affordance is present for a manager.
    expect(await screen.findByText('Invite a member')).toBeTruthy();
  });

  it('shows a read-only notice (no invite) when the roster is forbidden', async () => {
    const client: Partial<DataClient> = {
      getInstanceInfo: async () => ({
        guestAccess: 'read',
        ownerSubject: 'acct#owner',
        trustedIssuers: [],
        audience: null,
        you: guestPrincipal('Dana'),
      }),
      listMembers: async () => {
        throw new Error('OpenBook request failed (403 Forbidden): you do not have write access on this instance');
      },
    };
    wrap(client);
    expect(await screen.findByText('Members are managed by admins')).toBeTruthy();
    expect(screen.queryByText('Invite a member')).toBeNull();
  });

  it('offers the copy-workspace-link delivery help only when published with someone invited', async () => {
    const client: Partial<DataClient> = {
      getInstanceInfo: async () => ({
        guestAccess: 'write',
        ownerSubject: null,
        trustedIssuers: [],
        audience: null,
        you: guestPrincipal('Rae'),
      }),
      listMembers: async () => [member({status: 'invited'})],
    };

    // Not published: the invite writes a roster row but there's no reachable
    // link to hand over, so no delivery affordance (defers to nothing).
    mockPublishedHost = null;
    wrap(client);
    expect(await screen.findByText('rae@example.com')).toBeTruthy();
    expect(screen.queryByText('Copy workspace link')).toBeNull();
    cleanup();

    // Published + an invited member awaiting first sign-in: surface it.
    mockPublishedHost = 'rae.book.cloud';
    wrap(client);
    expect(await screen.findByText('Copy workspace link')).toBeTruthy();
  });

  it('hides the delivery help when published but no one is awaiting sign-in', async () => {
    mockPublishedHost = 'rae.book.cloud';
    const client: Partial<DataClient> = {
      getInstanceInfo: async () => ({
        guestAccess: 'write',
        ownerSubject: null,
        trustedIssuers: [],
        audience: null,
        you: guestPrincipal('Rae'),
      }),
      listMembers: async () => [member({status: 'active'})],
    };
    wrap(client);
    expect(await screen.findByText('rae@example.com')).toBeTruthy();
    expect(screen.queryByText('Copy workspace link')).toBeNull();
  });

  it('degrades to an unavailable note when the server has no instance endpoint', async () => {
    const client: Partial<DataClient> = {
      getInstanceInfo: async () => {
        throw new Error('404');
      },
    };
    wrap(client);
    expect(await screen.findByText(/doesn.t support members yet/)).toBeTruthy();
  });
});
