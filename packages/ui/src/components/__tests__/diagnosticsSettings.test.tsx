import {describe, it, expect, afterEach, vi} from 'vitest';
import {render, screen, cleanup, fireEvent, waitFor, within} from '@testing-library/react';
import type {DataClient, InstanceConfig, InstanceInfo, Principal} from '@book.dev/sdk';
import {guestPrincipal} from '@book.dev/sdk';
import {DiagnosticsBody} from '../settings/DiagnosticsSettings';
import {DataProvider} from '@/data/DataProvider';
import {ConfirmProvider, I18nProvider, PlatformCapabilitiesProvider, type PlatformCapabilities} from '@/providers';

/**
 * The diagnostics screen over the seams it reads: the data client's
 * `getInstanceInfo`/`setInstancePolicy` (the same `GET/PUT /api/instance` the
 * server gates) plus the default (inert) forwarding context. The ownership
 * repair flow — the reason the screen exists — is exercised end to end through
 * the confirm dialog.
 */

const jwsYou = (subject: string): Principal => ({
  kind: 'user',
  subject,
  issuer: 'https://account.book.pub',
  name: 'me',
  verifiedVia: 'jws',
});

const info = (over: Partial<InstanceInfo> = {}): InstanceInfo => ({
  guestAccess: 'read',
  ownerSubject: null,
  trustedIssuers: [],
  audience: null,
  requireAudience: false,
  you: guestPrincipal(),
  youRole: null,
  localOwner: false,
  ...over,
});

const wrap = (client: Partial<DataClient>, platform?: PlatformCapabilities) =>
  render(
    <I18nProvider>
      <PlatformCapabilitiesProvider value={platform}>
        <ConfirmProvider>
          <DataProvider client={client as DataClient}>
            <DiagnosticsBody />
          </DataProvider>
        </ConfirmProvider>
      </PlatformCapabilitiesProvider>
    </I18nProvider>,
  );

afterEach(() => cleanup());

describe('DiagnosticsBody', () => {
  it('replaces raw transport errors with copyable sidecar diagnostics and Restart', async () => {
    const restart = vi.fn(async () => undefined);
    const writeText = vi.fn(async () => undefined);
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    try {
      Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText}});
      wrap(
        {getInstanceInfo: async () => { throw new Error('ipc connect failed: Connection refused'); }},
        {sidecar: {degraded: true, restart, state: {state: 'dead', attempts: 5, lastExitCode: 61, lastStderrTail: ['panic: socket closed'], socketReady: false}}},
      );
      expect(screen.getByText('Local service unavailable')).toBeTruthy();
      expect(screen.queryByText(/ipc connect failed/)).toBeNull();
      expect(screen.getByRole('button', {name: 'Copy latest error'}).textContent).toBe('Copy latest error');
      expect(screen.getByLabelText('Copy latest error', {selector: 'pre'}).tabIndex).toBe(0);
      fireEvent.click(screen.getByRole('button', {name: /Copy latest error/}));
      expect(writeText).toHaveBeenCalledWith('panic: socket closed');
      fireEvent.click(screen.getByRole('button', {name: 'Restart'}));
      expect(restart).toHaveBeenCalledOnce();
    } finally {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('a failed probe IS the diagnostic — shown with a re-run affordance, never blank', async () => {
    const client: Partial<DataClient> = {
      getInstanceInfo: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    };
    wrap(client);
    expect(await screen.findByText(/connect ECONNREFUSED/)).toBeTruthy();
    expect(screen.getByText('Re-run checks')).toBeTruthy();
  });

  it('renders the machine owner verdict and the claim state', async () => {
    const client: Partial<DataClient> = {
      getInstanceInfo: async () =>
        info({
          ownerSubject: 'https://account.book.pub#owner',
          you: {kind: 'user', subject: 'local:owner', issuer: 'local', name: 'Local', verifiedVia: 'local'},
          localOwner: true,
        }),
    };
    wrap(client);
    expect(await screen.findByText('Machine owner (this device)')).toBeTruthy();
    expect(screen.getByText('Claimed')).toBeTruthy();
    expect(screen.getByText('https://account.book.pub#owner')).toBeTruthy();
    expect(screen.getByText('Machine-owner authority')).toBeTruthy();
    // No drift: the repair affordance stays hidden.
    expect(screen.queryByText('Repair ownership')).toBeNull();
  });

  it('detects ownership drift and repairs it through the confirm dialog', async () => {
    let stored = 'https://account.book.pub#old-owner';
    const you = jwsYou('https://account.book.pub#new-owner');
    const client: Partial<DataClient> = {
      getInstanceInfo: async () => info({ownerSubject: stored, you, localOwner: true}),
      setInstancePolicy: async (patch: Partial<InstanceConfig>) => {
        // Mirrors the server's repair rule: local transport + own verified subject.
        if (patch.ownerSubject === you.subject) stored = you.subject;
        return {guestAccess: 'read', agentEdits: 'suggest', trustedIssuers: [], ownerSubject: stored} as InstanceConfig;
      },
    };
    wrap(client);

    expect(await screen.findByText('Ownership mismatch')).toBeTruthy();
    fireEvent.click(screen.getByText('Repair ownership'));
    // The promise-based confirm dialog (window.confirm is dead in WKWebView). Its
    // confirm button carries the action label, so scope the click to the dialog.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Repair ownership?')).toBeTruthy();
    fireEvent.click(within(dialog).getByText('Repair ownership'));

    await waitFor(() => expect(stored).toBe('https://account.book.pub#new-owner'));
    // The re-probe clears the drift warning and reports success.
    expect(await screen.findByText('Ownership repaired — you are the owner again.')).toBeTruthy();
    expect(screen.queryByText('Ownership mismatch')).toBeNull();
  });

  it('drift WITHOUT machine-owner authority explains why repair is unavailable', async () => {
    const client: Partial<DataClient> = {
      getInstanceInfo: async () =>
        info({
          ownerSubject: 'https://account.book.pub#old-owner',
          you: jwsYou('https://account.book.pub#new-owner'),
          localOwner: false,
        }),
    };
    wrap(client);
    expect(await screen.findByText('Ownership mismatch')).toBeTruthy();
    expect(screen.queryByText('Repair ownership')).toBeNull();
    expect(screen.getByText('Repair is only possible on the library’s own device, from this app.')).toBeTruthy();
  });

  it('cancelling the confirm leaves ownership untouched', async () => {
    let stored = 'https://account.book.pub#old-owner';
    const you = jwsYou('https://account.book.pub#new-owner');
    const client: Partial<DataClient> = {
      getInstanceInfo: async () => info({ownerSubject: stored, you, localOwner: true}),
      setInstancePolicy: async () => {
        stored = you.subject;
        return {guestAccess: 'read', agentEdits: 'suggest', trustedIssuers: [], ownerSubject: stored} as InstanceConfig;
      },
    };
    wrap(client);

    fireEvent.click(await screen.findByText('Repair ownership'));
    expect(await screen.findByText('Repair ownership?')).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => expect(screen.queryByText('Repair ownership?')).toBeNull());
    expect(stored).toBe('https://account.book.pub#old-owner');
    expect(screen.getByText('Ownership mismatch')).toBeTruthy();
  });
});
