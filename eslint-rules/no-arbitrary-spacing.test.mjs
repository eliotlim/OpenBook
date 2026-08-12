import assert from 'node:assert/strict';
import test from 'node:test';
import {Linter} from 'eslint';
import noArbitrarySpacing from './no-arbitrary-spacing.mjs';

const linter = new Linter({configType: 'flat'});
const config = {
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: {ecmaFeatures: {jsx: true}},
  },
  plugins: {tailwind: noArbitrarySpacing},
  rules: {'tailwind/no-arbitrary-spacing': 'error'},
};

const lint = (code) => linter.verify(code, config);

test('allows spacing-scale utilities and non-spacing arbitrary values', () => {
  const fixtures = [
    '<div className="p-4 -mt-2 gap-x-1.5 w-[calc(100%-1rem)] text-[11px]" />;',
    "<div className={enabled ? 'pl-5' : 'gap-y-2'} />;",
    '<div className={`mx-auto max-w-[16rem] ${tone}`} />;',
    '<div className="pb-[env(safe-area-inset-bottom)] pt-[max(1rem,env(safe-area-inset-top))]" />;',
    '<div data-layout="p-[3px]" />;',
  ];
  for (const fixture of fixtures) assert.deepEqual(lint(fixture), []);
});

test('flags arbitrary padding, margin, and gap values in className', () => {
  const utilities = [
    'p-[3px]',
    'px-[--gutter]',
    'sm:pt-[calc(1rem+2px)]',
    '-mb-[0.3rem]',
    'md:-ms-[1ch]!',
    'p-(--gutter)',
    'group-hover:gap-[5px]',
    '[&>li]:gap-x-[0.3rem]',
    'supports-[display:grid]:gap-y-[var(--space)]',
    'space-x-[3px]',
    'space-y-[0.375rem]',
    '-space-x-[2px]',
    'scroll-p-[3px]',
    'scroll-mx-[0.375rem]',
  ];

  for (const utility of utilities) {
    const messages = lint(`<div className="base ${utility}" />;`);
    assert.equal(messages.length, 1, utility);
    assert.equal(messages[0].messageId, 'arbitrary', utility);
    assert.match(messages[0].message, new RegExp(utility.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('checks nested, template, and conventionally named hoisted class strings', () => {
  const fixtures = [
    "<div className={cn('rounded', active && 'hover:mx-[7px]')} />;",
    '<div className={`base gap-[${size}px] ${tone}`} />;',
    "const styles = 'gap-[3px]'; <div className={styles} />;",
    "const config = {className: 'scroll-px-[7px]'};",
  ];

  for (const fixture of fixtures) {
    const messages = lint(fixture);
    assert.equal(messages.length, 1, fixture);
    assert.equal(messages[0].messageId, 'arbitrary', fixture);
  }
});
