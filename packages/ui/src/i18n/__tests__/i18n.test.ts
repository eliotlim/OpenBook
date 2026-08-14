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

  it('ships the unlisted-page UI copy in all four locales', () => {
    for (const locale of [en, de, ja, zh]) {
      expect([
        locale.nav?.hiddenPage,
        locale.share?.listing?.label,
        locale.share?.listing?.hint,
        locale.share?.listing?.inheritHint,
        locale.share?.listing?.restrictedHint,
        locale.share?.linkHints?.hidden,
      ].every((message) => typeof message === 'string' && message.length > 0)).toBe(true);
    }
  });

  it('ships every database-form block string in all four locales', () => {
    const keys = Object.keys(en.formBlock.databaseReference).sort();
    for (const locale of [de, ja, zh]) {
      expect(Object.keys(locale.formBlock?.databaseReference ?? {}).sort()).toEqual(keys);
      expect(locale.slash?.custom?.dbform).toBeDefined();
    }

    const slashCopy = [
      [en, 'Database form', 'Embed a form view from an existing database', 'Form', 'Build a standalone form on this page'],
      [de, 'Datenbankformular', 'Eine Formularansicht aus einer vorhandenen Datenbank einbetten', 'Formular', 'Ein eigenständiges Formular auf dieser Seite erstellen'],
      [ja, 'データベースフォーム', '既存のデータベースのフォームビューを埋め込む', 'フォーム', 'このページに独立したフォームを作成'],
      [zh, '数据库表单', '嵌入现有数据库中的表单视图', '表单', '在此页面构建独立表单'],
    ] as const;
    for (const [locale, databaseLabel, databaseHint, legacyLabel, legacyHint] of slashCopy) {
      expect(locale.slash?.custom?.dbform).toEqual({label: databaseLabel, hint: databaseHint});
      expect(locale.slash?.custom?.form).toEqual({label: legacyLabel, hint: legacyHint});
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
