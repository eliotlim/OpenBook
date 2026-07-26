import {describe, it, expect, afterEach, vi} from 'vitest';
import {render, screen, cleanup} from '@testing-library/react';
import OnboardingNudge from '../OnboardingNudge';
import ProfileMenu from '../ProfileMenu';
import LibrarySelectMenu from '../LibrarySelectMenu';
import {I18nProvider, PlatformCapabilitiesProvider, type PlatformCapabilities} from '@/providers';

// STAB-9: the sidecar-served LAN web UI (STAB-7) renders the standard web chrome
// for a *network guest*, not the owner on their own device. Account sign-in can't
// complete over a plain-LAN origin (insecure context → identity JWS won't bind),
// so the host declares `servedSameOrigin` on the platform and the UI:
//   • hides the publish-upsell card (OnboardingNudge),
//   • hides the account footer (ProfileMenu),
//   • relabels the shared library's connection "This device" → "Local network".
// These tests pin both branches for each surface off that single flag.

// Stub the identity/theme/hud hooks (each drags in the full preferences /
// account stack) but keep `usePlatformCapabilities`, `PlatformCapabilitiesProvider`
// and `useTranslation` real — the flag under test must flow through untouched.
vi.mock('@/providers', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/providers')>();
  return {
    ...mod,
    useAccount: () => ({connected: false, accounts: []}),
    useHud: () => ({hud: {}, setHud: () => {}}),
    useTheme: () => ({appearance: {sidebar: 'default'}, mode: 'system', setMode: () => {}}),
    useSelfIdentity: () => ({
      name: 'Guest',
      profile: {name: 'Guest', displayName: '', avatar: '', avatarImage: '', bio: ''},
    }),
  };
});

const wrap = (ui: React.ReactElement, platform: PlatformCapabilities = {}) =>
  render(
    <I18nProvider>
      <PlatformCapabilitiesProvider value={platform}>{ui}</PlatformCapabilitiesProvider>
    </I18nProvider>,
  );

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('Publish upsell (OnboardingNudge) on the LAN-served UI', () => {
  it('is hidden in served same-origin mode', () => {
    wrap(<OnboardingNudge />, {servedSameOrigin: true});
    expect(screen.queryByText('Sync and publish')).toBeNull();
    expect(screen.queryByText('Get started free')).toBeNull();
  });

  it('still nudges an unauthenticated user without the flag', () => {
    wrap(<OnboardingNudge />);
    // Effect flips `dismissed` off (nothing persisted) → the card renders.
    expect(screen.getByText('Sync and publish')).toBeTruthy();
    expect(screen.getByText('Get started free')).toBeTruthy();
  });
});

describe('Account footer (ProfileMenu) on the LAN-served UI', () => {
  it('is hidden in served same-origin mode', () => {
    const {container} = wrap(<ProfileMenu />, {servedSameOrigin: true});
    expect(container.querySelector('[data-profile-menu]')).toBeNull();
    expect(screen.queryByText('Guest')).toBeNull();
  });

  it('renders the profile footer without the flag', () => {
    const {container} = wrap(<ProfileMenu />);
    expect(container.querySelector('[data-profile-menu]')).toBeTruthy();
    expect(screen.getByText('Guest')).toBeTruthy();
  });
});

describe('Library connection label on the LAN-served UI', () => {
  it('labels the shared library "Local network" in served mode', () => {
    wrap(<LibrarySelectMenu />, {servedSameOrigin: true});
    // The default local library ("My Library", no server URL) is the host's,
    // reached over the network — so its "This device" connection label is wrong.
    expect(screen.getByText('Local network')).toBeTruthy();
    expect(screen.queryByText('This device')).toBeNull();
  });

  it('keeps the "This device" label without the flag', () => {
    wrap(<LibrarySelectMenu />);
    expect(screen.getByText('This device')).toBeTruthy();
    expect(screen.queryByText('Local network')).toBeNull();
  });
});
