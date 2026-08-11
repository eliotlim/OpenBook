import assert from 'node:assert/strict';
import test from 'node:test';
import {Linter} from 'eslint';
import noHoverGeometry from './no-hover-geometry.mjs';

const linter = new Linter({configType: 'flat'});
const config = {
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: {ecmaFeatures: {jsx: true}},
  },
  plugins: {'layout-shift': noHoverGeometry},
  rules: {'layout-shift/no-hover-geometry': 'error'},
};

const lint = (code) => linter.verify(code, config);

test('allows paint-only hover changes and non-hover geometry', () => {
  const fixtures = [
    '<div className="flex gap-2 hover:bg-muted group-hover:opacity-100" />;',
    "<div className={enabled ? 'font-medium' : 'hover:text-foreground'} />;",
    '<div className={`opacity-0 group-hover/card:opacity-100 ${tone}`} />;',
  ];
  for (const fixture of fixtures) assert.deepEqual(lint(fixture), []);
});

test('flags every guarded hover-geometry utility family', () => {
  const utilities = [
    'hover:hidden',
    'group-hover:block',
    'hover:inline-flex',
    'hover:p-2',
    'group-hover/card:-mt-1',
    'hover:w-4',
    'hover:h-full',
    'hover:size-6',
    'group-hover:gap-2',
    'hover:font-bold',
    'hover:font-semibold',
    'hover:font-medium',
    'hover:text-xs',
    'hover:text-sm',
    'hover:text-base',
    'hover:text-lg',
    'hover:text-xl',
    'hover:border-2',
    'hover:scale-105',
    'group-hover/item:-translate-x-1',
  ];

  for (const utility of utilities) {
    const messages = lint(`<div className="base ${utility}" />;`);
    assert.equal(messages.length, 1, utility);
    assert.equal(messages[0].messageId, 'geometry', utility);
    assert.match(messages[0].message, new RegExp(utility.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('flags display swaps in either class ordering and nested class strings', () => {
  const fixtures = [
    '<div className="hidden group-hover:flex" />;',
    '<div className="group-hover:flex hidden" />;',
    "<div className={cn('opacity-0', active && 'md:group-hover/card:w-8')} />;",
    '<div className={`hidden hover:grid ${tone}`} />;',
  ];

  for (const fixture of fixtures) {
    const messages = lint(fixture);
    assert.equal(messages.length, 1, fixture);
    assert.equal(messages[0].messageId, 'geometry', fixture);
  }
});
