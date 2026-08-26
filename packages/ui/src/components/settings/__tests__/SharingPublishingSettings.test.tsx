import React from 'react';
import {cleanup, render, screen} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';

const h = vi.hoisted(() => ({
  forwarding: {} as Record<string, unknown>,
}));

vi.mock('@/providers', async () => {
  const {en} = await import('@/i18n/messages/en');
  const translate = (key: string): string => {
    const value = key.split('.').reduce<unknown>(
      (messages, segment) => messages && typeof messages === 'object'
        ? (messages as Record<string, unknown>)[segment]
        : undefined,
      en,
    );
    return typeof value === 'string' ? value : key;
  };

  return {
    useForwarding: () => h.forwarding,
    useAccount: () => ({connected: true, remintIdentity: vi.fn()}),
    usePlatformCapabilities: () => ({}),
    useTranslation: () => ({t: translate}),
  };
});
vi.mock('@/components/settings/primitives', () => ({
  SettingsSection: ({children}: {children: React.ReactNode}) => <section>{children}</section>,
  SettingsToggle: ({label, checked}: {label: React.ReactNode; checked: boolean}) => <div data-checked={checked}>{label}</div>,
  SettingsField: ({children}: {children: React.ReactNode}) => <div>{children}</div>,
  SettingsScreen: ({children}: {children: React.ReactNode}) => <div>{children}</div>,
  SettingsAdvancedSection: ({children}: {children: React.ReactNode}) => <div>{children}</div>,
}));
vi.mock('@/components/settings/SharingSettings', () => ({SharingSection: () => null}));
vi.mock('@/components/settings/MembersSettings', () => ({PeopleSection: () => null}));
vi.mock('@/components/SiteVisibilityControl', () => ({SiteVisibilityControl: () => null}));
vi.mock('@/components/ShareDialog', () => ({useSharingCapability: () => ({canManage: false})}));

import type {ForwardingErrorClass} from '@/providers';
import {ForwardingSection} from '../SharingPublishingSettings';

const renderFailure = (errorClass: ForwardingErrorClass, enabled = false, retryPending = false) => {
  h.forwarding = {
    supported: true,
    enabled,
    status: 'stalled',
    host: null,
    busy: false,
    error: 'raw transport detail',
    errorClass,
    retryPending,
    audienceNotice: null,
    claimRefusal: null,
    signInPending: false,
    enable: vi.fn(),
    disable: vi.fn(),
  };
  return render(<ForwardingSection />);
};

afterEach(cleanup);

describe('ForwardingSection failure copy', () => {
  it.each([
    ['ipc', false, 'The local service isn\'t running.'],
    ['auth', false, 'Couldn\'t authenticate with the publishing service. Try signing out and back in.'],
    ['network', false, 'Couldn\'t connect to the publishing service. Try signing out and back in, or check Diagnostics.'],
    ['network', true, 'The publishing service is temporarily unreachable. Publishing will retry automatically.'],
    ['unknown', false, 'Couldn\'t reconnect to the publishing service. Try signing out and back in, or check Diagnostics.'],
  ] as const)('renders %s guidance with retryPending=%s', (errorClass, retryPending, copy) => {
    renderFailure(errorClass, false, retryPending);
    expect(screen.getByText(copy)).toBeTruthy();
    expect(screen.getByText('raw transport detail').className).toContain('font-mono');
  });

  it('does not promise a retry for a terminal network-string error', () => {
    renderFailure('network', false, false);
    expect(screen.queryByText('The publishing service is temporarily unreachable. Publishing will retry automatically.')).toBeNull();
  });

  it('presents an enabled IPC failure as paused information, not destructive', () => {
    const {container} = renderFailure('ipc', true);
    const notice = screen.getByText('The local service isn\'t running.').parentElement;
    expect(notice?.className).toContain('text-amber');
    expect(notice?.className).not.toContain('text-destructive');
    expect(screen.getByText('Check the local-service banner, or use Restart in Diagnostics.')).toBeTruthy();
    expect(container.querySelector('[data-checked="true"]')).toBeTruthy();
  });
});
