import {describe, it, expect, afterEach, beforeEach} from 'vitest';
import {render, screen, cleanup, fireEvent} from '@testing-library/react';
import AppearanceSettings from '../AppearanceSettings';
import {PageThemeControl} from '../appearance/PageThemeControl';
import {I18nProvider, ThemeProvider} from '@/providers';
import {readPageTheme} from '@/lib/pageTheme';

function renderWithProviders(node: React.ReactNode) {
  return render(
    <I18nProvider>
      <ThemeProvider defaultColorMode="light">{node}</ThemeProvider>
    </I18nProvider>,
  );
}

describe('AppearanceSettings', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('style');
  });
  afterEach(() => cleanup());

  it('renders every appearance knob', () => {
    renderWithProviders(<AppearanceSettings />);
    expect(screen.getByText('Accent color')).toBeTruthy();
    expect(screen.getByText('Interface')).toBeTruthy();
    expect(screen.getByText('Control intensity')).toBeTruthy();
    expect(screen.getByText('Tinted sidebar')).toBeTruthy();
    // Grouped accent swatches.
    expect(screen.getByText('Forest')).toBeTruthy();
    expect(screen.getByText('Lavender')).toBeTruthy();
  });

  it('applies a picked accent to the document root and persists it', () => {
    renderWithProviders(<AppearanceSettings />);
    fireEvent.click(screen.getByText('Forest'));
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('142 71% 38%');
    expect(JSON.parse(localStorage.getItem('openbook.appearance')!).themeId).toBe('forest');
  });

  it('switching the neutral family retints the surfaces', () => {
    renderWithProviders(<AppearanceSettings />);
    fireEvent.click(screen.getByText('Cool'));
    // muted swings from warm 40 to the cool 220 hue.
    expect(document.documentElement.style.getPropertyValue('--muted').startsWith('220 ')).toBe(true);
  });
});

describe('PageThemeControl', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it('mounts and exposes the page-theme trigger', () => {
    renderWithProviders(<PageThemeControl pageId="page-1" />);
    expect(screen.getByLabelText('Page theme')).toBeTruthy();
    // No override yet.
    expect(readPageTheme('page-1')).toBeNull();
  });
});
