import {describe, it, expect, afterEach} from 'vitest';
import {render, screen, cleanup} from '@testing-library/react';
import SettingsPanel from '../SettingsPanel';
import {I18nProvider, PreferencesProvider} from '@/providers';

const noop = () => {};

function renderPanel(tab: Parameters<typeof SettingsPanel>[0]['tab']) {
  return render(
    <I18nProvider>
      <PreferencesProvider>
        <SettingsPanel tab={tab} onTabChange={noop} mode="modal" onModeChange={noop} onClose={noop} />
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

  it('shows a stub screen for a backend-less tab', () => {
    renderPanel('signup');
    expect(screen.getByText('Create an account')).toBeTruthy();
  });
});
