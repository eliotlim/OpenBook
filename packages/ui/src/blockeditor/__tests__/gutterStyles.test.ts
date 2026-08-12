import {describe, expect, it} from 'vitest';
// Test-only filesystem read; the published UI build intentionally omits Node
// ambient types, while Vitest itself runs this file in Node.
// @ts-expect-error -- node:fs is available to Vitest, not the browser package.
import {readFileSync} from 'node:fs';

const CSS = readFileSync('src/index.css', 'utf8');

function ruleBody(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  expect(start, `rule not found: ${selector}`).toBeGreaterThanOrEqual(0);
  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

describe('block gutter visibility', () => {
  it('does not hit-test while hidden', () => {
    expect(ruleBody('.obe-gutter')).toMatch(/pointer-events:\s*none/);
  });

  it('restores hit testing with row hover or focus', () => {
    const visibleGutter = ruleBody(
      '.obe-row:hover > .obe-gutter,\n.obe-row:focus-within > .obe-gutter,\n.obe-gutter:focus-within',
    );
    expect(visibleGutter).toMatch(/opacity:\s*1/);
    expect(visibleGutter).toMatch(/pointer-events:\s*auto/);
  });
});
