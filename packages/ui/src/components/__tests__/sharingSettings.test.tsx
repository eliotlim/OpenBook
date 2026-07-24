import {describe, it, expect, afterEach, vi} from 'vitest';
import {render, screen, cleanup, fireEvent, waitFor} from '@testing-library/react';
import type {DataClient} from '@book.dev/sdk';
import {DEFAULT_INSTANCE_CONFIG, guestPrincipal} from '@book.dev/sdk';
import {
  SharingSection,
  accessStateFromGuest,
  accessStatePolicy,
  type DefaultAccess,
} from '../settings/SharingSettings';
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
        requireAudience: false,
        you: guestPrincipal('Caryl'),
        youRole: null,
      }),
      setInstancePolicy: async () => ({guestAccess: 'write', agentEdits: 'suggest', trustedIssuers: []}),
    };
    wrap(client);
    expect(await screen.findByText('Guests & access')).toBeTruthy();
    expect(await screen.findByText(/Caryl/)).toBeTruthy();
    // The consolidated Default-access control surfaces the guest gate `write` as
    // "Anyone can edit" (the selected label on the closed control).
    expect(await screen.findByText('Anyone can edit')).toBeTruthy();
    expect(await screen.findByText('Default access')).toBeTruthy();
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
        requireAudience: false,
        you: guestPrincipal('Dana'),
        youRole: null,
      }),
      setInstancePolicy: async () => ({guestAccess: 'read', agentEdits: 'suggest', trustedIssuers: []}),
    };
    wrap(client);
    expect(await screen.findByText('Only the library owner can change this.')).toBeTruthy();
  });

  // Security fix: the config→state mapping is lossy, so re-selecting the state
  // that's already displayed must NEVER write — otherwise the freshly-claimed
  // bootstrap `(members, read)` (shown as "Anyone can view") would flip
  // defaultVisibility members→public on a visually no-op click, silently making
  // every inherit-visibility page world-readable.
  const bootstrapClaimed = (setInstancePolicy: DataClient['setInstancePolicy']): Partial<DataClient> => ({
    getInstanceInfo: async () => ({
      guestAccess: 'read', // freshly-claimed bootstrap → renders "Anyone can view"
      defaultVisibility: 'members',
      ownerSubject: null, // control enabled (unclaimed-owner path)
      trustedIssuers: [],
      audience: null,
      requireAudience: false,
      you: guestPrincipal('Ola'),
      youRole: null,
    }),
    setInstancePolicy,
  });

  it('re-selecting the already-displayed state does NOT write (no silent widening)', async () => {
    const setInstancePolicy = vi.fn(async () => ({guestAccess: 'read', trustedIssuers: []})) as unknown as DataClient['setInstancePolicy'];
    wrap(bootstrapClaimed(setInstancePolicy));
    fireEvent.click(await screen.findByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', {name: 'Anyone can view'}));
    await new Promise((r) => setTimeout(r, 10));
    expect(setInstancePolicy).not.toHaveBeenCalled();
  });

  it('a deliberate change from that same state still writes the full pair', async () => {
    const setInstancePolicy = vi.fn(async () => ({guestAccess: 'write', trustedIssuers: []})) as unknown as DataClient['setInstancePolicy'];
    wrap(bootstrapClaimed(setInstancePolicy));
    fireEvent.click(await screen.findByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', {name: 'Anyone can edit'}));
    await waitFor(() =>
      expect(setInstancePolicy).toHaveBeenCalledWith({defaultVisibility: 'public', guestAccess: 'write'}),
    );
  });
});

describe('Default-access state ↔ config-pair mapping (SHR-7)', () => {
  const states: DefaultAccess[] = ['private', 'view', 'edit'];

  it('each state writes the expected (defaultVisibility, guestAccess) pair', () => {
    expect(accessStatePolicy('private')).toEqual({defaultVisibility: 'members', guestAccess: 'off'});
    expect(accessStatePolicy('view')).toEqual({defaultVisibility: 'public', guestAccess: 'read'});
    expect(accessStatePolicy('edit')).toEqual({defaultVisibility: 'public', guestAccess: 'write'});
  });

  it('each state round-trips: state → pair → state', () => {
    for (const state of states) {
      expect(accessStateFromGuest(accessStatePolicy(state).guestAccess)).toBe(state);
    }
  });

  it('every guest-gate value renders exactly one state', () => {
    expect(accessStateFromGuest('off')).toBe('private');
    expect(accessStateFromGuest('read')).toBe('view');
    expect(accessStateFromGuest('write')).toBe('edit');
  });

  // THE LOAD-BEARING INVARIANT: a fresh (unclaimed) instance ships
  // guestAccess:'write' (DEFAULT_INSTANCE_CONFIG), which must render as "Anyone
  // can edit" and never move the default. On an unclaimed instance only the guest
  // gate is consulted (authorize rule 0), so defaultVisibility is dormant — the
  // control renders today's default without writing anything.
  it('the shipped default guest gate renders as "edit" (behaviour unchanged)', () => {
    expect(DEFAULT_INSTANCE_CONFIG.guestAccess).toBe('write');
    expect(accessStateFromGuest(DEFAULT_INSTANCE_CONFIG.guestAccess)).toBe('edit');
  });
});
