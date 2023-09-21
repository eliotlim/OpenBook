import React from 'react';

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
}

const initialState: ThemeProviderState = {
  mode: 'system',
  colorScheme: 'light',
  setMode: () => null,
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
  const [setColorScheme, setSetColorScheme] = React.useState<ColorScheme>('light');

  React.useEffect(() => {
    const onChangeModeListener = (e: MediaQueryListEvent) => {
      if (mode === 'system') {
        e.matches ? setSetColorScheme('dark') : setSetColorScheme('light');
      }
    }
    if (typeof window !== 'undefined') {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onChangeModeListener);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', onChangeModeListener);
      }
    }
  }, []);

  React.useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');
    if (mode === 'system') {
      setSetColorScheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      root.classList.add(setColorScheme);
    } else {
      root.classList.add(mode);
    }
  }, [mode, setColorScheme]);

  const value: ThemeProviderState = {
    mode: mode,
    colorScheme: mode === 'system' ? setColorScheme : mode,
    setMode: (theme: ColorMode) => {
      localStorage.setItem(storageKey, theme);
      setMode(theme);
    },
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
