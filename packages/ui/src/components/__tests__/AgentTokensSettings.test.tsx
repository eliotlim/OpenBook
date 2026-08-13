import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import type {DataClient} from '@book.dev/sdk';
import AgentTokensSettings from '../settings/AgentTokensSettings';
import {DataProvider} from '@/data/DataProvider';
import {
  ConfirmProvider,
  I18nProvider,
  PlatformCapabilitiesProvider,
  type PlatformCapabilities,
} from '@/providers';

const {copyTextMock} = vi.hoisted(() => ({copyTextMock: vi.fn(async () => true)}));

vi.mock('@/lib/pageActions', () => ({copyText: copyTextMock}));
vi.mock('@/components/settings/adminGate', () => ({
  isForbidden: () => false,
  useIsSettingsAdmin: () => true,
}));
vi.mock('@/components/settings/McpSettings', () => ({default: () => null}));
vi.mock('@/components/settings/AiUsageSettings', () => ({default: () => null}));
vi.mock('@/components/settings/AgentEditsSettings', () => ({default: () => null}));

const platform = {
  serverControls: {setAgentLocalTcp: vi.fn(async () => {})},
} as unknown as PlatformCapabilities;

const wrap = (enabled: boolean) =>
  render(
    <I18nProvider>
      <ConfirmProvider>
        <PlatformCapabilitiesProvider value={platform}>
          <DataProvider
            client={
              {
                listAgentTokens: async () => ({enabled, remote: false, tokens: []}),
              } as unknown as DataClient
            }
          >
            <AgentTokensSettings />
          </DataProvider>
        </PlatformCapabilitiesProvider>
      </ConfirmProvider>
    </I18nProvider>,
  );

afterEach(() => {
  cleanup();
  copyTextMock.mockClear();
});

describe('AgentTokensSettings local MCP connector', () => {
  it('renders and copies the authenticated HTTP transport command', async () => {
    wrap(true);

    const title = await screen.findByText('Local MCP connector');
    const card = title.closest('section');
    const command = card?.querySelector('code')?.textContent;
    expect(command).toBe(
      'claude mcp add --transport http openbook http://127.0.0.1:4319/api/mcp --header "Authorization: Bearer <token>"',
    );
    expect(command).not.toContain('/path/to/');
    expect(command).not.toContain('OPENBOOK_URL');
    expect(command).not.toContain('OPENBOOK_INSTANCE_ID');
    expect(card?.textContent).toContain(
      'Register this only while OpenBook is running — the token goes to whatever is answering on 127.0.0.1:4319.',
    );

    fireEvent.click(screen.getByRole('button', {name: 'Copy command'}));
    await waitFor(() => expect(copyTextMock).toHaveBeenCalledWith(command));
  });

  it('shows enablement guidance instead of a command while the agent API is off', async () => {
    wrap(false);

    const title = await screen.findByText('Local MCP connector');
    const card = title.closest('section');
    expect(card?.textContent).toContain('Enable the agent API to use the connector.');
    expect(card?.querySelector('code')).toBeNull();
    expect(screen.queryByRole('button', {name: 'Copy command'})).toBeNull();
  });
});
