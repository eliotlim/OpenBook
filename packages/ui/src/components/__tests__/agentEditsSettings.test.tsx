import {describe, it, expect, afterEach, vi} from 'vitest';
import {render, screen, cleanup, fireEvent, waitFor} from '@testing-library/react';
import type {AgentEditsMode, DataClient, InstanceInfo} from '@book.dev/sdk';
import {guestPrincipal, localPrincipal} from '@book.dev/sdk';
import AgentEditsSettings from '../settings/AgentEditsSettings';
import {PageAgentEditsField} from '../appearance/PageCustomiseBody';
import {DataProvider} from '@/data/DataProvider';
import {I18nProvider} from '@/providers';

afterEach(() => cleanup());

// ── Library-wide default (Settings → Agents tab) ─────────────────────────────

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

const wrapLibrary = (client: Partial<DataClient>) =>
  render(
    <I18nProvider>
      <DataProvider client={client as DataClient}>
        <AgentEditsSettings />
      </DataProvider>
    </I18nProvider>,
  );

describe('AgentEditsSettings (library-wide agent-edits mode)', () => {
  it('shows the current mode and round-trips a change to Direct', async () => {
    const setInstancePolicy = vi.fn(async () => ({})) as unknown as DataClient['setInstancePolicy'];
    wrapLibrary({
      getInstanceInfo: async () => info({agentEdits: 'suggest', ownerSubject: null}),
      setInstancePolicy,
    });
    // The closed control shows the current mode label.
    expect(await screen.findByText('Suggest edits for review')).toBeTruthy();
    fireEvent.click(await screen.findByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', {name: 'Edit pages directly'}));
    await waitFor(() => expect(setInstancePolicy).toHaveBeenCalledWith({agentEdits: 'direct'}));
  });

  it('re-selecting the displayed mode is a no-op (never writes)', async () => {
    const setInstancePolicy = vi.fn(async () => ({})) as unknown as DataClient['setInstancePolicy'];
    wrapLibrary({
      getInstanceInfo: async () => info({agentEdits: 'direct', ownerSubject: null}),
      setInstancePolicy,
    });
    fireEvent.click(await screen.findByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', {name: 'Edit pages directly'}));
    await new Promise((r) => setTimeout(r, 10));
    expect(setInstancePolicy).not.toHaveBeenCalled();
  });

  it('locks the control for a non-owner of a claimed instance', async () => {
    wrapLibrary({
      getInstanceInfo: async () =>
        info({agentEdits: 'suggest', ownerSubject: 'acct#owner', you: guestPrincipal('Dana'), youRole: null}),
    });
    expect(await screen.findByText('Only the library owner can change how agents edit.')).toBeTruthy();
    expect((await screen.findByRole('combobox')).hasAttribute('disabled')).toBe(true);
  });

  it('renders nothing when the server exposes no instance endpoint', async () => {
    const {container} = wrapLibrary({
      getInstanceInfo: async () => {
        throw new Error('404');
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toBe('');
  });
});

// ── Per-page override (Customise pane) ───────────────────────────────────────

const wrapPage = (client: Partial<DataClient>) =>
  render(
    <I18nProvider>
      <DataProvider client={client as DataClient}>
        <PageAgentEditsField pageId="p1" />
      </DataProvider>
    </I18nProvider>,
  );

/** A writer client: loopback owner + a page policy the test picks. */
const pageWriter = (
  policy: 'inherit' | 'suggest' | 'direct',
  instanceMode: AgentEditsMode,
  setPageAgentEdits?: DataClient['setPageAgentEdits'],
): Partial<DataClient> => ({
  getInstanceInfo: async () => info({agentEdits: instanceMode, ownerSubject: null, youRole: 'owner'}),
  getPageAgentEdits: async () => policy,
  setPageAgentEdits: setPageAgentEdits ?? (async (_id, p) => p),
});

describe('PageAgentEditsField (per-page tri-state)', () => {
  it('round-trips a per-page change to Direct', async () => {
    const setPageAgentEdits = vi.fn(async (_id: string, p) => p) as unknown as DataClient['setPageAgentEdits'];
    wrapPage(pageWriter('inherit', 'suggest', setPageAgentEdits));
    expect(await screen.findByText('Library default')).toBeTruthy();
    fireEvent.click(await screen.findByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', {name: 'Edit page directly'}));
    await waitFor(() => expect(setPageAgentEdits).toHaveBeenCalledWith('p1', 'direct'));
  });

  it('when inheriting, spells out the effective mode (instance = direct)', async () => {
    wrapPage(pageWriter('inherit', 'direct'));
    expect(
      await screen.findByText('Following the library default — agents edit this page directly.'),
    ).toBeTruthy();
  });

  it('when inheriting, spells out the effective mode (instance = suggest)', async () => {
    wrapPage(pageWriter('inherit', 'suggest'));
    expect(
      await screen.findByText('Following the library default — agents suggest edits for review.'),
    ).toBeTruthy();
  });

  it('an explicit page policy shows no inherit hint', async () => {
    wrapPage(pageWriter('direct', 'suggest'));
    await screen.findByRole('combobox');
    expect(screen.queryByText(/Following the library default/)).toBeNull();
  });

  it('hides entirely for a non-writer (a claimed-instance viewer)', async () => {
    const {container} = wrapPage({
      getInstanceInfo: async () =>
        info({agentEdits: 'suggest', ownerSubject: 'acct#owner', you: guestPrincipal('Vic'), youRole: 'viewer'}),
      getPageAgentEdits: async () => 'inherit',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toBe('');
  });
});
