import {describe, it, expect, afterEach, vi} from 'vitest';
import {render, screen, cleanup, fireEvent} from '@testing-library/react';
import type {DataClient} from '@book.dev/sdk';
import {guestPrincipal} from '@book.dev/sdk';
import ShareDialog from '../ShareDialog';
import {PeopleSection} from '../settings/MembersSettings';
import SharingPublishingSettings from '../settings/SharingPublishingSettings';
import {DataProvider} from '@/data/DataProvider';
import {ConfirmProvider, I18nProvider, PlatformLibraryProvider, type PlatformLibrary} from '@/providers';

// `ForwardingSection` calls `useAccount()` unconditionally (before its
// `!supported` early-return), and the real AccountProvider drags in the whole
// preferences/workspace stack — stub just that hook, keep everything else real.
vi.mock('@/providers', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/providers')>();
  return {...mod, useAccount: () => ({connected: false, remintIdentity: async () => {}})};
});

// P0-4 (sharing audit 2026-07-03): the standalone web app's workspace is an
// in-browser PGlite store — nothing outside the browser can reach it, yet the
// sharing surfaces used to render as if fully wired. The host now declares
// `browserLocalWorkspace` on the platform library and every surface annotates
// itself honestly (kept functional, not hidden-and-broken). These tests pin
// both sides: the disclosures under the flag, and the unchanged default.

const instanceInfo = {
  guestAccess: 'write' as const,
  ownerSubject: null,
  trustedIssuers: [],
  audience: null,
  requireAudience: false,
  you: guestPrincipal('Riley'),
  youRole: null,
};

const client: Partial<DataClient> = {
  getInstanceInfo: async () => instanceInfo,
  getPageVisibility: async () => null,
  listPageAcl: async () => [],
  listMembers: async () => [],
};

const wrap = (ui: React.ReactElement, platform: PlatformLibrary = {}) =>
  render(
    <I18nProvider>
      <PlatformLibraryProvider value={platform}>
        <ConfirmProvider>
          <DataProvider client={client as DataClient}>{ui}</DataProvider>
        </ConfirmProvider>
      </PlatformLibraryProvider>
    </I18nProvider>,
  );

afterEach(() => cleanup());

describe('ShareDialog on a browser-local workspace', () => {
  it('discloses that no one else can reach the workspace and where the link really goes', async () => {
    wrap(<ShareDialog pageId="p1" />, {browserLocalWorkspace: true});
    fireEvent.click(screen.getByRole('button', {name: 'Share'}));

    expect(await screen.findByText(/This workspace lives only in this browser/)).toBeTruthy();
    // The copy-link hint tells the truth: a recipient opens THEIR workspace.
    expect(await screen.findByText(/opens their own workspace, not this page/)).toBeTruthy();
    // The unclaimed-instance disclosure presupposes reachability — superseded.
    expect(screen.queryByText(/Sharing takes effect once you claim this instance/)).toBeNull();
    // Still functional, not hidden: the scope picker and invite field render.
    expect(screen.getByLabelText('Who can access')).toBeTruthy();
    expect(screen.getByLabelText('Invite people')).toBeTruthy();
  });

  it('keeps the reachable-instance disclosures without the flag', async () => {
    wrap(<ShareDialog pageId="p1" />);
    fireEvent.click(screen.getByRole('button', {name: 'Share'}));

    expect(await screen.findByText(/Sharing takes effect once you claim this instance/)).toBeTruthy();
    expect(screen.queryByText(/This workspace lives only in this browser/)).toBeNull();
  });
});

describe('Sharing & publishing settings on a browser-local workspace', () => {
  it('replaces the publish promise with a desktop-app pointer', async () => {
    wrap(<SharingPublishingSettings />, {browserLocalWorkspace: true});

    expect(await screen.findByText('Publish to the web')).toBeTruthy();
    expect(screen.getByText(/isn’t hosted anywhere/)).toBeTruthy();
    // The intro no longer promises "publish it to the web".
    expect(screen.queryByText(/publish it to the web/)).toBeNull();
    // The guest gate (real: it persists with the data) still renders.
    expect(await screen.findByText('Guests & access')).toBeTruthy();
  });

  it('keeps the standard intro (and no pointer) without the flag', async () => {
    wrap(<SharingPublishingSettings />);

    expect(await screen.findByText(/publish it to the web/)).toBeTruthy();
    expect(screen.queryByText('Publish to the web')).toBeNull();
  });
});

describe('People section (roster) on a browser-local workspace', () => {
  it('discloses that invited people cannot reach the workspace yet', async () => {
    wrap(<PeopleSection />, {browserLocalWorkspace: true});

    expect(await screen.findByText(/people you add here can’t open it yet/)).toBeTruthy();
    // Still functional: the invite form renders for a manager.
    expect(await screen.findByLabelText('Invite a member')).toBeTruthy();
  });

  it('shows no disclosure without the flag', async () => {
    wrap(<PeopleSection />);

    expect(await screen.findByLabelText('Invite a member')).toBeTruthy();
    expect(screen.queryByText(/people you add here can’t open it yet/)).toBeNull();
  });
});
