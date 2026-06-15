import {describe, it, expect, afterEach, beforeEach} from 'vitest';
import {render, screen, cleanup, fireEvent} from '@testing-library/react';
import AppearanceSettings from '../AppearanceSettings';
import {PageAppearanceControls} from '../appearance/PageCustomiseBody';
import {I18nProvider, ThemeProvider} from '@/providers';
import {readPageTheme} from '@/lib/pageTheme';
import {readPageFonts} from '@/lib/pageFont';
import {readPageCover} from '@/lib/pageCover';

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
    // Grouped accent swatches: gray, bold, pastel.
    expect(screen.getByText('Warm')).toBeTruthy(); // a gray accent
    expect(screen.getByText('Forest')).toBeTruthy();
    expect(screen.getByText('Lavender')).toBeTruthy();
  });

  it('applies a picked accent to the document root and persists it', () => {
    renderWithProviders(<AppearanceSettings />);
    fireEvent.click(screen.getByText('Forest'));
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('142 71% 38%');
    expect(JSON.parse(localStorage.getItem('openbook.appearance')!).themeId).toBe('forest');
  });

  it('picking the Cool gray accent retints the surfaces cool', () => {
    renderWithProviders(<AppearanceSettings />);
    fireEvent.click(screen.getByText('Cool'));
    // The gray accent carries the neutral temperature: muted swings warm 40 → cool 220.
    expect(document.documentElement.style.getPropertyValue('--muted').startsWith('220 ')).toBe(true);
    expect(JSON.parse(localStorage.getItem('openbook.appearance')!).themeId).toBe('cool');
  });
});

describe('PageAppearanceControls', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it('renders the appearance + typeface controls without creating an override', () => {
    renderWithProviders(<PageAppearanceControls pageId="page-1" />);
    expect(screen.getByText('Body font')).toBeTruthy();
    expect(screen.getByText('Heading font')).toBeTruthy();
    expect(screen.getByText('Control colour')).toBeTruthy();
    expect(screen.getByText('Editorial')).toBeTruthy(); // a page-theme preset
    expect(screen.getByText('Forest')).toBeTruthy(); // an accent swatch
    // Just mounting writes nothing.
    expect(readPageTheme('page-1')).toBeNull();
    expect(readPageFonts('page-1')).toBeNull();
  });

  it('writes a per-page font override when a typeface is picked', () => {
    renderWithProviders(<PageAppearanceControls pageId="page-2" />);
    // Two "Serif" buttons (body + heading pickers); the first is the body font.
    fireEvent.click(screen.getAllByText('Serif')[0]);
    expect(readPageFonts('page-2')?.body).toBe('serif');
  });

  it('a page-theme preset sets the accent, font, and cover in one click (#4)', () => {
    renderWithProviders(<PageAppearanceControls pageId="page-3" />);
    fireEvent.click(screen.getByText('Editorial'));
    expect(readPageTheme('page-3')).toMatchObject({themeId: 'warm', background: 'orange'});
    expect(readPageFonts('page-3')).toMatchObject({body: 'serif', heading: 'serif'});
    expect(readPageCover('page-3')?.kind).toBe('gradient');
  });

  it('the Clean preset resets a page back to following the app', () => {
    renderWithProviders(<PageAppearanceControls pageId="page-4" />);
    fireEvent.click(screen.getByText('Editorial'));
    fireEvent.click(screen.getByText('Clean'));
    expect(readPageTheme('page-4')).toBeNull();
    expect(readPageFonts('page-4')).toBeNull();
    expect(readPageCover('page-4')).toBeNull();
  });
});
