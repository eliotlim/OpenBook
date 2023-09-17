import React from 'react';

export type ColorScheme = 'light' | 'dark' | 'system';
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
  const [mode, setMode] = React.useState<ColorScheme>(() => {
    return ((typeof window !== 'undefined' && localStorage.getItem(storageKey)) || defaultColorMode) as ColorScheme;
  });
  const [mediaMode, setMediaMode] = React.useState<ColorScheme>('light');

  if (typeof window !== 'undefined') {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      console.log('changed');
      e.matches ? setMediaMode('dark') : setMediaMode('light');
    });
  }

  React.useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');
    console.log(mode);
    if (mode === 'system') {
      const systemTheme = mediaMode;
      root.classList.add(systemTheme);
    } else {
      root.classList.add(mode);
    }
  }, [mode, mediaMode]);

  const value: ThemeProviderState = {
    mode: mode,
    colorScheme: mode === 'system' ? mediaMode : mode,
    setMode: (theme: ColorScheme) => {
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
