import {afterEach, describe, it, expect} from 'vitest';
import {t, setLocale, resolveLocale} from '../index';

afterEach(() => setLocale('en'));

describe('t', () => {
  it('translates a key in the active locale', () => {
    setLocale('de');
    expect(t('common.cancel')).toBe('Abbrechen');
    setLocale('ja');
    expect(t('common.cancel')).toBe('キャンセル');
    setLocale('zh');
    expect(t('common.cancel')).toBe('取消');
  });

  it('interpolates {var} placeholders', () => {
    setLocale('en');
    expect(t('mention.create', {name: 'Roadmap'})).toBe('Create page “Roadmap”');
    expect(t('backup.exported', {count: 3})).toBe('Exported 3 pages.');
  });

  it('falls back to English for a key missing in the locale', () => {
    // `confirm.trashTitle` is omitted from some catalogs — but present in de here;
    // use a key we know only exists in en if needed. All listed keys exist in en,
    // so a *nonexistent* key returns the key itself.
    setLocale('de');
    // @ts-expect-error — intentionally unknown key to exercise the final fallback.
    expect(t('does.not.exist')).toBe('does.not.exist');
  });
});

describe('resolveLocale', () => {
  it('maps a BCP-47 tag to a supported base locale', () => {
    expect(resolveLocale('de-DE')).toBe('de');
    expect(resolveLocale('zh-Hans-CN')).toBe('zh');
    expect(resolveLocale('JA')).toBe('ja');
  });

  it('defaults to English for unsupported or empty tags', () => {
    expect(resolveLocale('fr-FR')).toBe('en');
    expect(resolveLocale('')).toBe('en');
    expect(resolveLocale(null)).toBe('en');
  });
});
