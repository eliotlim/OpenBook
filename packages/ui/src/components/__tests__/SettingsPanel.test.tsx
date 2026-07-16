import {describe, it, expect, afterEach, vi} from 'vitest';
import {render, screen, cleanup, fireEvent} from '@testing-library/react';
import SettingsPanel from '../SettingsPanel';
import {ConfirmProvider, HudProvider, I18nProvider, PreferencesProvider} from '@/providers';

const noop = () => {};

function renderPanel(
  tab: Parameters<typeof SettingsPanel>[0]['tab'],
  onTabChange: (tab: Parameters<typeof SettingsPanel>[0]['tab']) => void = noop,
) {
  return render(
    <I18nProvider>
      <HudProvider>
        <PreferencesProvider>
          {/* The General tab's UpdatesSection consumes useConfirm (its install
              action's restart guard), as sibling settings tabs already do — in
              the app the whole modal is nested in ConfirmProvider. */}
          <ConfirmProvider>
            <SettingsPanel tab={tab} onTabChange={onTabChange} mode="modal" onModeChange={noop} onClose={noop} />
          </ConfirmProvider>
        </PreferencesProvider>
      </HudProvider>
    </I18nProvider>,
  );
}

describe('SettingsPanel', () => {
  afterEach(() => cleanup());

  it('renders the four grouped section headers in the nav', () => {
    renderPanel('general');
    expect(screen.getByText('Preferences')).toBeTruthy();
    expect(screen.getByText('Account')).toBeTruthy();
    expect(screen.getByText('Library')).toBeTruthy();
    expect(screen.getByText('Advanced')).toBeTruthy();
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

  it('replaces the rail with matching setting rows while searching', () => {
    renderPanel('general');
    const search = screen.getByPlaceholderText('Search settings…');
    // The group headers show in the normal rail…
    expect(screen.getByText('Preferences')).toBeTruthy();
    fireEvent.change(search, {target: {value: 'sharing'}});
    // …and are replaced by result rows once a query is typed.
    expect(screen.queryByText('Preferences')).toBeNull();
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
  });

  it('shows a no-results message for a non-matching query', () => {
    renderPanel('general');
    const search = screen.getByPlaceholderText('Search settings…');
    fireEvent.change(search, {target: {value: 'zzzznomatch'}});
    expect(screen.getByText('No settings match your search.')).toBeTruthy();
  });

  it('activates a result → switches tab (onTabChange)', () => {
    const onTabChange = vi.fn();
    renderPanel('general', onTabChange);
    const search = screen.getByPlaceholderText('Search settings…');
    fireEvent.change(search, {target: {value: 'diagnostics'}});
    fireEvent.click(screen.getAllByRole('option')[0]);
    expect(onTabChange).toHaveBeenCalledWith('diagnostics');
  });
});
