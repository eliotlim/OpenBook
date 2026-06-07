import React from 'react';
import {applyTheme, getTheme, themes, DEFAULT_THEME_ID, type Theme} from '@/lib/themes';

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
  /** The active named color theme (palette). */
  themeId: string;
  setThemeId: (id: string) => void;
  /** All available color themes. */
  themes: Theme[];
}

const THEME_ID_KEY = 'openbook.theme';

const initialState: ThemeProviderState = {
  mode: 'system',
  colorScheme: 'light',
  setMode: () => null,
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
  const [themeId, setThemeIdState] = React.useState<string>(() => {
    return (typeof window !== 'undefined' && localStorage.getItem(THEME_ID_KEY)) || DEFAULT_THEME_ID;
  });

  // Apply the selected palette whenever the theme or resolved scheme changes.
  React.useEffect(() => {
    applyTheme(getTheme(themeId), mode === 'system' ? colorScheme : (mode as ColorScheme));
  }, [themeId, colorScheme, mode]);

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

  const value: ThemeProviderState = {
    mode: mode,
    colorScheme: mode === 'system' ? colorScheme : mode,
    setMode: (theme: ColorMode) => {
      localStorage.setItem(storageKey, theme);
      setMode(theme);
    },
    themeId,
    setThemeId: (id: string) => {
      localStorage.setItem(THEME_ID_KEY, id);
      setThemeIdState(id);
    },
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
