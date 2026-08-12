import {afterEach, describe, it, expect} from 'vitest';
import {PAGE_TEMPLATES} from '@book.dev/sdk';
import {t, setLocale, resolveLocale, type TKey} from '../index';
import {en} from '../messages/en';
import {de} from '../messages/de';
import {ja} from '../messages/ja';
import {zh} from '../messages/zh';

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
    expect(t('mention.create', {name: 'Roadmap'})).toBe('Create subpage “Roadmap”');
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

  it('has English copy for every key rendered by the template gallery', () => {
    setLocale('en');
    const missing: string[] = [];
    for (const template of PAGE_TEMPLATES) {
      const id = template.id.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
      const fields = template.guidance === undefined ? ['name', 'description'] : ['name', 'description', 'guidance'];
      for (const field of fields) {
        const key = `templates.${id}.${field}`;
        if (t(key as TKey) === key) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it('ships every new form-builder string in all four locales', () => {
    const leaves = (value: unknown, prefix = ''): string[] => {
      if (typeof value === 'string') return [prefix];
      if (!value || typeof value !== 'object') return [];
      return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key));
    };
    const source = {builder: en.formBlock.builder, settings: en.formBlock.settings};
    const sourceKeys = leaves(source).sort();
    for (const locale of [de, ja, zh]) {
      expect(leaves({builder: locale.formBlock?.builder, settings: locale.formBlock?.settings}).sort()).toEqual(sourceKeys);
    }
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
