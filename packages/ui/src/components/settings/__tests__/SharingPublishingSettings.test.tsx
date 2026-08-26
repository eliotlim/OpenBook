import React from 'react';
import {cleanup, render, screen} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';

const h = vi.hoisted(() => ({
  forwarding: {} as Record<string, unknown>,
}));

vi.mock('@/providers', () => ({
  useForwarding: () => h.forwarding,
  useAccount: () => ({connected: true, remintIdentity: vi.fn()}),
  usePlatformCapabilities: () => ({}),
  useTranslation: () => ({t: (key: string) => ({
    'forwarding.ipcFailed': 'The local service isn\'t running.',
    'forwarding.ipcHint': 'Check the local-service banner, or use Restart in Diagnostics.',
    'forwarding.authFailed': 'Couldn\'t authenticate with the publishing service. Try signing out and back in.',
    'forwarding.networkFailed': 'The publishing service is temporarily unreachable. Publishing will retry automatically.',
    'forwarding.failed': 'generic failure',
    'forwarding.reconnectFailed': 'generic reconnect failure',
    'forwarding.toggle': 'Publish this library',
    'forwarding.status.stalled': 'Connection stalled',
  } as Record<string, string>)[key] ?? key}),
}));
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

const renderFailure = (errorClass: ForwardingErrorClass, enabled = false) => {
  h.forwarding = {
    supported: true,
    enabled,
    status: 'stalled',
    host: null,
    busy: false,
    error: 'raw transport detail',
    errorClass,
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
    ['ipc', 'The local service isn\'t running.'],
    ['auth', 'Couldn\'t authenticate with the publishing service. Try signing out and back in.'],
    ['network', 'The publishing service is temporarily unreachable. Publishing will retry automatically.'],
    ['unknown', 'generic reconnect failure'],
  ] as const)('renders %s guidance', (errorClass, copy) => {
    renderFailure(errorClass);
    expect(screen.getByText(copy)).toBeTruthy();
    expect(screen.getByText('raw transport detail').className).toContain('font-mono');
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
