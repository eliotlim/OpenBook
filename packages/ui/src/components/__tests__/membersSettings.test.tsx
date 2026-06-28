import {describe, it, expect, afterEach} from 'vitest';
import {render, screen, cleanup} from '@testing-library/react';
import type {DataClient, Member} from '@book.dev/sdk';
import {guestPrincipal} from '@book.dev/sdk';
import MembersSettings from '../settings/MembersSettings';
import {DataProvider} from '@/data/DataProvider';
import {ConfirmProvider, I18nProvider} from '@/providers';

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

afterEach(() => cleanup());

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
