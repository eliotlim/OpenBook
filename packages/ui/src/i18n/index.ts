/**
 * Lightweight i18n runtime (no library). `t(key, vars?)` looks the dotted key up
 * in the current locale, falling back to English, and interpolates `{var}`
 * placeholders. The current locale is a module singleton so non-React callers
 * (EditorJS tool classes, exporters) can use the same `t`; React code reads it
 * reactively through {@link providers/I18nProvider}.
 */
import {en, type Messages} from './messages/en';
import {de} from './messages/de';
import {ja} from './messages/ja';
import {zh} from './messages/zh';

export type Locale = 'en' | 'de' | 'ja' | 'zh';

export const LOCALES: ReadonlyArray<{code: Locale; name: string}> = [
  {code: 'en', name: 'English'},
  {code: 'de', name: 'Deutsch'},
  {code: 'ja', name: '日本語'},
  {code: 'zh', name: '中文'},
];

// Dotted-key union derived from the English source, so `t()` keys are typed.
type Dot<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Dot<T[K], `${P}${K}.`>;
}[keyof T & string];
export type TKey = Dot<Messages>;

type Tree = Record<string, unknown>;

function flatten(obj: Tree, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else if (v && typeof v === 'object') flatten(v as Tree, key, out);
  }
  return out;
}

const FLAT: Record<Locale, Record<string, string>> = {
  en: flatten(en as Tree),
  de: flatten(de as Tree),
  ja: flatten(ja as Tree),
  zh: flatten(zh as Tree),
};

function interpolate(str: string, vars: Record<string, string | number>): string {
  return str.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

// ── Current-locale singleton ─────────────────────────────────────────────────
let currentLocale: Locale = 'en';
export const getLocale = (): Locale => currentLocale;
export const setLocale = (locale: Locale): void => {
  currentLocale = locale;
};

const SUPPORTED = new Set<Locale>(['en', 'de', 'ja', 'zh']);

/** Map a `navigator.language`-style tag to a supported locale (default `en`). */
export function resolveLocale(tag: string | undefined | null): Locale {
  const base = (tag ?? '').toLowerCase().split('-')[0] as Locale;
  return SUPPORTED.has(base) ? base : 'en';
}

/** Translate a key in the current locale (→ English → the key itself), with `{var}` interpolation. */
export function t(key: TKey, vars?: Record<string, string | number>): string {
  const k = key as string;
  const msg = FLAT[currentLocale][k] ?? FLAT.en[k] ?? k;
  return vars ? interpolate(msg, vars) : msg;
}
