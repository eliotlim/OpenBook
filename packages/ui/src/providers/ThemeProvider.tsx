import React from 'react';
import {
  applyAppearance,
  themes,
  DEFAULT_THEME_ID,
  DEFAULT_APPEARANCE,
  type AppearanceOptions,
  type Theme,
} from '@/lib/themes';

export type ColorScheme = 'light' | 'dark';
export type ColorMode = ColorScheme | 'system';

export type ThemeProviderProps = {
  children: React.ReactNode;
  defaultColorMode?: ColorMode;
  storageKey?: string;
}

type ThemeProviderState = {
  colorScheme: ColorScheme;
  mode: ColorMode;
  setMode: (theme: ColorMode) => void;
  /** The full appearance choice (accent + tint + intensity + sidebar). */
  appearance: AppearanceOptions;
  /** Shallow-merge a patch into the appearance and persist it. */
  setAppearance: (patch: Partial<AppearanceOptions>) => void;
  /** The active named color theme (palette). Shorthand for `appearance.themeId`. */
  themeId: string;
  setThemeId: (id: string) => void;
  /** All available color themes. */
  themes: Theme[];
}

const APPEARANCE_KEY = 'openbook.appearance';
// Legacy: the palette id used to live alone under this key (pre-parametric).
const LEGACY_THEME_ID_KEY = 'openbook.theme';

/** Read the persisted appearance, merged over defaults, migrating the legacy
 *  single-theme key when the new shape hasn't been written yet. */
function readStoredAppearance(): AppearanceOptions {
  if (typeof window === 'undefined') return DEFAULT_APPEARANCE;
  try {
    const raw = localStorage.getItem(APPEARANCE_KEY);
    if (raw) return {...DEFAULT_APPEARANCE, ...(JSON.parse(raw) as Partial<AppearanceOptions>)};
  } catch {
    // fall through to the legacy/default path
  }
  const legacy = localStorage.getItem(LEGACY_THEME_ID_KEY);
  return legacy ? {...DEFAULT_APPEARANCE, themeId: legacy} : DEFAULT_APPEARANCE;
}

const initialState: ThemeProviderState = {
  mode: 'system',
  colorScheme: 'light',
  setMode: () => null,
  appearance: DEFAULT_APPEARANCE,
  setAppearance: () => null,
  themeId: DEFAULT_THEME_ID,
  setThemeId: () => null,
  themes,
};

const ThemeProviderContext = React.createContext<ThemeProviderState>(initialState);

export function ThemeProvider({
  children,
  defaultColorMode = 'system',
  storageKey = 'theme',
  ...props
}: ThemeProviderProps) {
  const [mode, setMode] = React.useState<ColorMode>(() => {
    return ((typeof window !== 'undefined' && localStorage.getItem(storageKey)) || defaultColorMode) as ColorScheme;
  });
  const [colorScheme, setColorScheme] = React.useState<ColorScheme>('light');
  const [appearance, setAppearanceState] = React.useState<AppearanceOptions>(readStoredAppearance);

  const resolvedScheme: ColorScheme = mode === 'system' ? colorScheme : (mode as ColorScheme);

  // Apply the composed appearance whenever the choice or resolved scheme changes.
  React.useEffect(() => {
    applyAppearance(appearance, resolvedScheme);
  }, [appearance, resolvedScheme]);

  React.useEffect(() => {
    const onChangeModeListener = (e: MediaQueryListEvent) => {
      if (mode === 'system') {
        setColorScheme(e.matches ? 'dark' : 'light');
      }
    };
    if (typeof window !== 'undefined') {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onChangeModeListener);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', onChangeModeListener);
      }
    };
  }, []);

  React.useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');
    if (mode === 'system') {
      setColorScheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      root.classList.add(colorScheme);
    } else {
      root.classList.add(mode);
    }
  }, [mode, colorScheme]);

  const setAppearance = React.useCallback((patch: Partial<AppearanceOptions>) => {
    setAppearanceState((prev) => {
      const next = {...prev, ...patch};
      try {
        localStorage.setItem(APPEARANCE_KEY, JSON.stringify(next));
      } catch {
        // ignore (private mode / quota)
      }
      return next;
    });
  }, []);

  const value: ThemeProviderState = {
    mode,
    colorScheme: resolvedScheme,
    setMode: (theme: ColorMode) => {
      localStorage.setItem(storageKey, theme);
      setMode(theme);
    },
    appearance,
    setAppearance,
    themeId: appearance.themeId,
    setThemeId: (id: string) => setAppearance({themeId: id}),
    themes,
  };

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = React.useContext(ThemeProviderContext);

  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }

  return context;
};
