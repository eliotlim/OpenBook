import {describe, it, expect, afterEach, vi} from 'vitest';
import {render, screen, cleanup, fireEvent, waitFor} from '@testing-library/react';
import type {DataClient} from '@book.dev/sdk';
import {DEFAULT_INSTANCE_CONFIG, guestPrincipal, localPrincipal} from '@book.dev/sdk';
import type {EffectiveVisibility, GuestAccess} from '@book.dev/sdk';
import {
  SharingSection,
  accessStateDescription,
  accessStateFromConfig,
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

  it('locks a guest when the claimed owner identity is redacted', async () => {
    const client: Partial<DataClient> = {
      getInstanceInfo: async () => ({
        guestAccess: 'read',
        claimed: true,
        ownerSubject: null,
        trustedIssuers: [],
        audience: null,
        requireAudience: false,
        you: guestPrincipal(),
        youRole: null,
      }),
    };
    wrap(client);
    expect((await screen.findByRole('combobox', {name: 'Default access'})).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Only the library owner can change this.')).toBeTruthy();
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

  // PUB-1: the freshly-claimed bootstrap `(members, read)` is the state per-page
  // publishing runs in, and it now has an HONEST rendering of its own — before,
  // detection keyed on the guest gate alone and mislabelled it "Anyone can view".
  const bootstrapClaimed = (setInstancePolicy: DataClient['setInstancePolicy']): Partial<DataClient> => ({
    getInstanceInfo: async () => ({
      guestAccess: 'read', // freshly-claimed bootstrap …
      defaultVisibility: 'members', // … → renders "Only published pages"
      claimed: true, // …and per-page publishing really is in force (no caveat)
      ownerSubject: null, // local-owner authority keeps the control enabled
      trustedIssuers: [],
      audience: null,
      requireAudience: false,
      you: localPrincipal(),
      youRole: 'owner',
    }),
    setInstancePolicy,
  });

  it('renders the freshly-claimed (members, read) pair as "Only published pages"', async () => {
    wrap(bootstrapClaimed(vi.fn() as unknown as DataClient['setInstancePolicy']));
    expect(await screen.findByText('Only published pages')).toBeTruthy();
    // …and the honest one-liner for it, not the "anyone can view" claim.
    expect(
      await screen.findByText(/Visitors can open only the pages you explicitly publish/),
    ).toBeTruthy();
    // A claimed library really does enforce it — no caveat.
    expect(screen.queryByText(/Until this library is claimed/)).toBeNull();
  });

  // A11y: the live hint must be the picker's DESCRIPTION so it is announced on
  // focus, not only when it changes.
  it('wires the hint to the picker via aria-describedby + a live region', async () => {
    wrap(bootstrapClaimed(vi.fn() as unknown as DataClient['setInstancePolicy']));
    const picker = await screen.findByRole('combobox');
    expect(picker.getAttribute('aria-describedby')).toBe('default-access-hint');
    const hint = document.getElementById('default-access-hint');
    expect(hint?.getAttribute('aria-live')).toBe('polite');
    expect(hint?.textContent).toMatch(/Visitors can open only the pages you explicitly publish/);
  });

  it('re-selecting the already-displayed state does NOT write', async () => {
    const setInstancePolicy = vi.fn(async () => ({guestAccess: 'read', trustedIssuers: []})) as unknown as DataClient['setInstancePolicy'];
    wrap(bootstrapClaimed(setInstancePolicy));
    fireEvent.click(await screen.findByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', {name: 'Only published pages'}));
    await new Promise((r) => setTimeout(r, 10));
    expect(setInstancePolicy).not.toHaveBeenCalled();
  });

  // THE PUB-1 UNLOCK: "Anyone can view" is now reachable FROM the bootstrap state.
  // Before, `(members, read)` displayed as "Anyone can view", so selecting it was
  // a no-op re-selection and genuine whole-library viewing could not be turned on
  // through this control at all.
  it('a deliberate widening to "Anyone can view" now writes the full pair', async () => {
    const setInstancePolicy = vi.fn(async () => ({guestAccess: 'read', trustedIssuers: []})) as unknown as DataClient['setInstancePolicy'];
    wrap(bootstrapClaimed(setInstancePolicy));
    fireEvent.click(await screen.findByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', {name: 'Anyone can view'}));
    await waitFor(() =>
      expect(setInstancePolicy).toHaveBeenCalledWith({defaultVisibility: 'public', guestAccess: 'read'}),
    );
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

  it('shows only the server detail when saving fails', async () => {
    const setInstancePolicy = vi.fn(async () => {
      throw new Error('OpenBook request failed (403 Forbidden): only the instance owner can change multi-user policy');
    }) as unknown as DataClient['setInstancePolicy'];
    wrap(bootstrapClaimed(setInstancePolicy));
    fireEvent.click(await screen.findByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', {name: 'Anyone can view'}));
    expect(await screen.findByText(/only the instance owner can change multi-user policy/)).toBeTruthy();
    expect(screen.queryByText(/OpenBook request failed/)).toBeNull();
  });

  it('offers all four states', async () => {
    wrap(bootstrapClaimed(vi.fn() as unknown as DataClient['setInstancePolicy']));
    fireEvent.click(await screen.findByRole('combobox'));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual([
      'Private (members only)',
      'Only published pages',
      'Anyone can view',
      'Anyone can edit',
    ]);
  });
});

/** Every `defaultVisibility` the client can observe, including "not reported". */
type EffectiveVisibilityOrAbsent = EffectiveVisibility | undefined | null;

describe('Default-access state ↔ config-pair mapping (SHR-7 / PUB-1)', () => {
  const states: DefaultAccess[] = ['private', 'published', 'view', 'edit'];

  it('each state writes the expected (defaultVisibility, guestAccess) pair', () => {
    expect(accessStatePolicy('private')).toEqual({defaultVisibility: 'members', guestAccess: 'off'});
    expect(accessStatePolicy('published')).toEqual({defaultVisibility: 'members', guestAccess: 'read'});
    expect(accessStatePolicy('view')).toEqual({defaultVisibility: 'public', guestAccess: 'read'});
    expect(accessStatePolicy('edit')).toEqual({defaultVisibility: 'public', guestAccess: 'write'});
  });

  // The pairs must be DISTINCT, or two states would be the same config wearing two
  // names and the control would lie about at least one of them.
  it('the four states write four distinct pairs', () => {
    const pairs = states.map((s) => JSON.stringify(accessStatePolicy(s)));
    expect(new Set(pairs).size).toBe(states.length);
  });

  // THE ROUND-TRIP TABLE: every writable state survives state → pair → state
  // EXACTLY. This is what `published` existing at all buys — detection reading only
  // `guestAccess` collapsed `published` and `view` onto the same rendering.
  it('every writable state round-trips exactly: state → pair → state', () => {
    for (const state of states) {
      expect(accessStateFromConfig(accessStatePolicy(state))).toBe(state);
    }
  });

  // Detection is TOTAL over both fields: every (defaultVisibility, guestAccess)
  // combination the server can hold renders exactly one state, including the pairs
  // this control never writes itself.
  it('every (defaultVisibility, guestAccess) combination renders exactly one state', () => {
    const table: Array<[EffectiveVisibilityOrAbsent, GuestAccess, DefaultAccess]> = [
      // The guest gate is a hard floor: `off` ⇒ nothing is anonymously readable,
      // whatever `inherit` resolves to.
      ['members', 'off', 'private'],
      ['public', 'off', 'private'],
      ['authenticated', 'off', 'private'],
      ['restricted', 'off', 'private'],
      // Guests may read ⇒ the whole library only when `inherit` is `public`.
      ['members', 'read', 'published'],
      ['public', 'read', 'view'],
      ['authenticated', 'read', 'published'],
      ['restricted', 'read', 'published'],
      // Guests may write ⇒ the widest honest reading (see `accessStateFromConfig`:
      // an unclaimed instance short-circuits with `defaultVisibility` dormant).
      ['members', 'write', 'edit'],
      ['public', 'write', 'edit'],
      ['authenticated', 'write', 'edit'],
      ['restricted', 'write', 'edit'],
      // A pre-SHR-6 server / test fixture reports no `defaultVisibility` at all;
      // that server resolves `inherit` with its own `?? 'members'` fallback, so
      // reading it as `published` is the behaviour-faithful answer.
      [undefined, 'off', 'private'],
      [undefined, 'read', 'published'],
      [undefined, 'write', 'edit'],
      [null, 'read', 'published'],
    ];
    for (const [defaultVisibility, guestAccess, expected] of table) {
      expect(accessStateFromConfig({defaultVisibility, guestAccess})).toBe(expected);
    }
  });

  // THE LOAD-BEARING INVARIANT: a fresh (unclaimed) instance ships
  // guestAccess:'write' (DEFAULT_INSTANCE_CONFIG), which must render as "Anyone
  // can edit" and never move the default. On an unclaimed instance only the guest
  // gate is consulted (authorize rule 0), so defaultVisibility is dormant — the
  // control renders today's default without writing anything.
  it('the shipped default config renders as "edit" (behaviour unchanged)', () => {
    expect(DEFAULT_INSTANCE_CONFIG.guestAccess).toBe('write');
    expect(DEFAULT_INSTANCE_CONFIG.defaultVisibility).toBe('members');
    expect(accessStateFromConfig(DEFAULT_INSTANCE_CONFIG)).toBe('edit');
  });

  // The three cases where the state's plain hint would MIS-state reality. See
  // `accessStateDescription`; each maps to a review finding.
  it('describes each state honestly, with a caveat only where one is owed', () => {
    const d = accessStateDescription;
    // M-1: unclaimed + published — authorize rule 0 means per-page publishing is
    // NOT yet in force, so the "only published pages" promise needs disclosing.
    expect(d('published', {claimed: false, defaultVisibility: 'members'})).toEqual({
      hint: 'sharing.accessPublishedHint',
      caveat: 'sharing.accessUnclaimedCaveat',
    });
    // Claimed ⇒ the promise holds ⇒ no caveat.
    expect(d('published', {claimed: true, defaultVisibility: 'members'}).caveat).toBeNull();
    // L-1: `authenticated` reads as published for a signed-out visitor, but any
    // signed-in stranger also reads the unpublished pages.
    expect(d('published', {claimed: true, defaultVisibility: 'authenticated'}).caveat).toBe(
      'sharing.accessAuthenticatedCaveat',
    );
    // L-2: post-claim `canWrite` ignores `guestAccess`, so the edit line is swapped
    // (not caveated — a caveat would contradict its own first sentence).
    expect(d('edit', {claimed: true, defaultVisibility: 'public'})).toEqual({
      hint: 'sharing.accessEditHintClaimed',
      caveat: null,
    });
    expect(d('edit', {claimed: false, defaultVisibility: 'members'}).hint).toBe('sharing.accessEditHint');
    // An unknown claim state (pre-PUB-1 server) must stay SILENT, never guess.
    expect(d('published', {defaultVisibility: 'members'}).caveat).toBeNull();
    expect(d('edit', {defaultVisibility: 'public'}).hint).toBe('sharing.accessEditHint');
    // The quiet states are never caveated.
    expect(d('private', {claimed: true}).caveat).toBeNull();
    expect(d('view', {claimed: true, defaultVisibility: 'public'}).caveat).toBeNull();
  });

  // The claim bootstrap (store.claimOwnership: defaultVisibility='members',
  // guestAccess 'write'→'read') lands EXACTLY on `published` — the state per-page
  // publishing needs, and the pair this control could not name before PUB-1.
  it('the freshly-claimed bootstrap pair renders as "published"', () => {
    expect(accessStateFromConfig({defaultVisibility: 'members', guestAccess: 'read'})).toBe('published');
    expect(accessStatePolicy('published')).toEqual({defaultVisibility: 'members', guestAccess: 'read'});
  });
});
