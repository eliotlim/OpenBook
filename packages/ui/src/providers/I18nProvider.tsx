import React, {createContext, useCallback, useContext, useEffect, useMemo, useState} from 'react';
import {LOCALES, getLocale, resolveLocale, setLocale, t, type Locale, type TKey} from '@/i18n';

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TKey, vars?: Record<string, string | number>) => string;
  locales: typeof LOCALES;
}

const I18nContext = createContext<I18nContextValue | null>(null);

const STORAGE_KEY = 'openbook.locale';

// The persisted choice, else the browser's preferred locale, resolved to one we
// support. Only meaningful on the client — the server has no localStorage and
// renders the deterministic default so hydration matches (see below).
function storedLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return resolveLocale(stored);
  } catch {
    // ignore
  }
  return resolveLocale(navigator.language);
}

/**
 * Provides the current display locale + a reactive `t`. Persists the choice and
 * keeps the module-level locale (used by non-React `t` callers) in sync so the
 * whole app — React and not — renders in the same language this render.
 *
 * SSR note: the first render (server and the client's hydration pass) is always
 * `'en'` so the two agree — reading localStorage/navigator during the initial
 * render would make the client diverge from the server-rendered HTML and trip a
 * hydration mismatch. The persisted/browser locale is adopted right after mount;
 * a non-English user briefly sees English (one frame), the standard tradeoff for
 * localStorage-backed i18n under SSR.
 */
export const I18nProvider: React.FC<React.PropsWithChildren<unknown>> = ({children}) => {
  const [locale, setLocaleState] = useState<Locale>('en');

  // Adopt the persisted / browser locale once we're on the client.
  useEffect(() => {
    const next = storedLocale();
    if (next !== 'en') setLocaleState(next);
  }, []);

  // Sync the singleton synchronously (cheap, idempotent) so `t()` called during
  // this render — here or in non-context consumers — uses the right locale.
  if (getLocale() !== locale) setLocale(locale);

  // Reflect the active locale on <html lang> for a11y / the browser.
  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
  }, [locale]);

  const changeLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({locale, setLocale: changeLocale, t, locales: LOCALES}),
    [locale, changeLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export const useTranslation = (): I18nContextValue => {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useTranslation must be used within an <I18nProvider>');
  return ctx;
};
