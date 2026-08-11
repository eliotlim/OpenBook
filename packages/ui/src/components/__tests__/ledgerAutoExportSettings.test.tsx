import {describe, it, expect, afterEach, vi} from 'vitest';
import {render, screen, cleanup, fireEvent, waitFor} from '@testing-library/react';
import type {DataClient, InstanceInfo} from '@book.dev/sdk';
import {guestPrincipal, localPrincipal} from '@book.dev/sdk';
import LedgerAutoExportSettings from '../settings/LedgerAutoExportSettings';
import {DataProvider} from '@/data/DataProvider';
import {I18nProvider} from '@/providers';

afterEach(() => cleanup());

/**
 * LX-4 — the LGR-7 ledger auto-export insurance, surfaced as a settings
 * toggle: enabling writes the path, disabling writes null, the section is
 * owner-gated on a claimed instance, and it hides entirely on a server that
 * does not surface the field (identity-gated / pre-LGR-7).
 */

const info = (over: Partial<InstanceInfo>): InstanceInfo => ({
  guestAccess: 'write',
  ownerSubject: null,
  trustedIssuers: [],
  audience: null,
  requireAudience: false,
  you: localPrincipal(),
  youRole: 'owner',
  ...over,
});

const wrap = (client: Partial<DataClient>) =>
  render(
    <I18nProvider>
      <DataProvider client={client as DataClient}>
        <LedgerAutoExportSettings />
      </DataProvider>
    </I18nProvider>,
  );

describe('LedgerAutoExportSettings (LGR-7 insurance toggle)', () => {
  it('enables with the entered path, disables to null', async () => {
    const setInstancePolicy = vi.fn(async () => ({})) as unknown as DataClient['setInstancePolicy'];
    wrap({
      getInstanceInfo: async () => info({ledgerAutoExportPath: null}),
      setInstancePolicy,
    });
    const path = await screen.findByRole('textbox', {name: 'Export file path'});
    fireEvent.change(path, {target: {value: '/data/exports/ledger.csv'}});
    fireEvent.click(await screen.findByRole('switch'));
    await waitFor(() => expect(setInstancePolicy).toHaveBeenCalledWith({ledgerAutoExportPath: '/data/exports/ledger.csv'}));

    cleanup();
    const disable = vi.fn(async () => ({})) as unknown as DataClient['setInstancePolicy'];
    wrap({
      getInstanceInfo: async () => info({ledgerAutoExportPath: '/data/exports/ledger.csv'}),
      setInstancePolicy: disable,
    });
    fireEvent.click(await screen.findByRole('switch'));
    await waitFor(() => expect(disable).toHaveBeenCalledWith({ledgerAutoExportPath: null}));
  });

  it('the switch stays off-limits while no path is entered', async () => {
    const setInstancePolicy = vi.fn(async () => ({})) as unknown as DataClient['setInstancePolicy'];
    wrap({getInstanceInfo: async () => info({ledgerAutoExportPath: null}), setInstancePolicy});
    const toggle = await screen.findByRole('switch');
    expect(toggle.hasAttribute('disabled')).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(setInstancePolicy).not.toHaveBeenCalled();
  });

  it('locks the controls for a non-owner of a claimed instance', async () => {
    wrap({
      getInstanceInfo: async () =>
        info({
          ledgerAutoExportPath: '/data/exports/ledger.csv',
          claimed: true,
          ownerSubject: 'acct#owner',
          you: {
            kind: 'user',
            subject: 'acct#admin',
            issuer: 'https://accounts.book.pub',
            name: 'Dana',
            verifiedVia: 'jws',
          },
          youRole: 'admin',
        }),
    });
    expect(await screen.findByText('Only the library owner can change the auto-export target.')).toBeTruthy();
    expect((await screen.findByRole('switch')).hasAttribute('disabled')).toBe(true);
    expect((await screen.findByRole('textbox', {name: 'Export file path'})).hasAttribute('disabled')).toBe(true);
  });

  it('locks both controls for a guest when the claimed owner identity is redacted', async () => {
    wrap({
      getInstanceInfo: async () =>
        info({
          ledgerAutoExportPath: null,
          claimed: true,
          ownerSubject: null,
          you: guestPrincipal(),
          youRole: null,
        }),
    });
    const note = await screen.findByText('Only the library owner can change the auto-export target.');
    const toggle = screen.getByRole('switch');
    const path = screen.getByRole('textbox', {name: 'Export file path'});
    expect(toggle.hasAttribute('disabled')).toBe(true);
    expect(path.hasAttribute('disabled')).toBe(true);
    expect(note.id).toBe('ledger-auto-export-owner-locked');
    expect(toggle.getAttribute('aria-describedby')).toBe(note.id);
    expect(path.getAttribute('aria-describedby')).toBe(note.id);
  });

  it('surfaces a server refusal (a path outside the export fence)', async () => {
    wrap({
      getInstanceInfo: async () => info({ledgerAutoExportPath: null}),
      setInstancePolicy: (async () => {
        throw new Error('ledgerAutoExportPath /etc/passwd is outside the allowed export roots');
      }) as unknown as DataClient['setInstancePolicy'],
    });
    const path = await screen.findByRole('textbox', {name: 'Export file path'});
    fireEvent.change(path, {target: {value: '/etc/passwd'}});
    fireEvent.click(await screen.findByRole('switch'));
    expect(await screen.findByText(/outside the allowed export roots/)).toBeTruthy();
  });

  it('strips the SDK wire wrapper from a save refusal', async () => {
    wrap({
      getInstanceInfo: async () => info({ledgerAutoExportPath: null}),
      setInstancePolicy: (async () => {
        throw new Error(
          'OpenBook request failed (403 Forbidden): only the instance owner can set the ledger auto-export path',
        );
      }) as unknown as DataClient['setInstancePolicy'],
    });
    const path = await screen.findByRole('textbox', {name: 'Export file path'});
    fireEvent.change(path, {target: {value: '/data/exports/ledger.csv'}});
    fireEvent.click(await screen.findByRole('switch'));
    expect(await screen.findByText(/only the instance owner can set the ledger auto-export path/)).toBeTruthy();
    expect(screen.queryByText(/OpenBook request failed/)).toBeNull();
  });

  it('renders nothing when the server does not surface the field', async () => {
    const hidden = wrap({getInstanceInfo: async () => info({})});
    await new Promise((r) => setTimeout(r, 10));
    expect(hidden.container.textContent).toBe('');

    cleanup();
    const noEndpoint = wrap({
      getInstanceInfo: async () => {
        throw new Error('404');
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(noEndpoint.container.textContent).toBe('');
  });
});
