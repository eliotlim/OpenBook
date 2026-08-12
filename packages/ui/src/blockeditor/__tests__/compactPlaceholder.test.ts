// Test-only filesystem read; the published UI build intentionally omits Node
// ambient types, while Vitest itself runs this file in Node.
// @ts-expect-error -- node:fs is available to Vitest, not the browser package.
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

const CSS = readFileSync('src/index.css', 'utf8');

function ruleBody(selector: string): string {
  const at = CSS.indexOf(`\n${selector} {`);
  expect(at, `rule not found: ${selector}`).toBeGreaterThan(-1);
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

describe('compact editor placeholder metrics', () => {
  it('hides an unfocused placeholder without removing its line box', () => {
    expect(ruleBody('.obe-text:empty::before')).toMatch(/content:\s*attr\(data-placeholder\)/);

    const compact = ruleBody('.obe-compact [data-placeholder]:empty:not(:focus)::before');
    expect(compact).toMatch(/color:\s*transparent/);
    expect(compact).not.toMatch(/\bcontent\s*:/);
    expect(compact).not.toMatch(/\b(?:display|font|height|line-height|position|width)\s*:/);
  });
});
