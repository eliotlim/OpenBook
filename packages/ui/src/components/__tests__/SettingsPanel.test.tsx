import {describe, it, expect, afterEach} from 'vitest';
import {render, screen, cleanup} from '@testing-library/react';
import SettingsPanel from '../SettingsPanel';
import {ConfirmProvider, I18nProvider, PreferencesProvider} from '@/providers';

const noop = () => {};

function renderPanel(tab: Parameters<typeof SettingsPanel>[0]['tab']) {
  return render(
    <I18nProvider>
      <PreferencesProvider>
        {/* The General tab's UpdatesSection consumes useConfirm (its install
            action's restart guard), as sibling settings tabs already do — in
            the app the whole modal is nested in ConfirmProvider. */}
        <ConfirmProvider>
          <SettingsPanel tab={tab} onTabChange={noop} mode="modal" onModeChange={noop} onClose={noop} />
        </ConfirmProvider>
      </PreferencesProvider>
    </I18nProvider>,
  );
}

describe('SettingsPanel', () => {
  afterEach(() => cleanup());

  it('renders the three grouped section headers in the nav', () => {
    renderPanel('general');
    expect(screen.getByText('Preferences')).toBeTruthy();
    expect(screen.getByText('Account')).toBeTruthy();
    expect(screen.getByText('Workspace')).toBeTruthy();
  });

  it('renders the active panel (General) and its sections', () => {
    renderPanel('general');
    // The General screen's behavior section + a wired toggle.
    expect(screen.getByText('Behavior')).toBeTruthy();
    expect(screen.getByText('Confirm before trashing pages')).toBeTruthy();
  });

  it('keeps retired stub tabs (Sign up / Support / Integrations) out of the rail', () => {
    renderPanel('general');
    expect(screen.queryByText('Sign up')).toBeNull();
    expect(screen.queryByText('Support OpenBook')).toBeNull();
    expect(screen.queryByText('Integrations')).toBeNull();
  });
});
