import {describe, it, expect, afterEach} from 'vitest';
import {render, screen, cleanup} from '@testing-library/react';
import type {DataClient} from '@book.dev/sdk';
import {guestPrincipal} from '@book.dev/sdk';
import {SharingSection} from '../settings/SharingSettings';
import {DataProvider} from '@/data/DataProvider';
import {I18nProvider} from '@/providers';

const wrap = (client: Partial<DataClient>) =>
  render(
    <I18nProvider>
      <DataProvider client={client as DataClient}>
        <SharingSection />
      </DataProvider>
    </I18nProvider>,
  );

afterEach(() => cleanup());

describe('SharingSection (guest access)', () => {
  it('renders the guest gate and identifies the current guest', async () => {
    const client: Partial<DataClient> = {
      getInstanceInfo: async () => ({
        guestAccess: 'write',
        ownerSubject: null,
        trustedIssuers: [],
        audience: null,
        you: guestPrincipal('Caryl'),
      }),
      setInstancePolicy: async () => ({guestAccess: 'write', trustedIssuers: []}),
    };
    wrap(client);
    expect(await screen.findByText('Guests & access')).toBeTruthy();
    expect(await screen.findByText(/Caryl/)).toBeTruthy();
  });

  it('hides itself when the server exposes no multi-user endpoint', async () => {
    const client: Partial<DataClient> = {
      getInstanceInfo: async () => {
        throw new Error('404');
      },
    };
    const {container} = wrap(client);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toBe('');
  });

  it('locks the control for a non-owner', async () => {
    const client: Partial<DataClient> = {
      getInstanceInfo: async () => ({
        guestAccess: 'read',
        ownerSubject: 'acct#owner',
        trustedIssuers: [],
        audience: null,
        you: guestPrincipal('Dana'),
      }),
      setInstancePolicy: async () => ({guestAccess: 'read', trustedIssuers: []}),
    };
    wrap(client);
    expect(await screen.findByText('Only the workspace owner can change this.')).toBeTruthy();
  });
});
