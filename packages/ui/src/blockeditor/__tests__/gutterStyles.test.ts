import {describe, expect, it} from 'vitest';
// Test-only filesystem read; the published UI build intentionally omits Node
// ambient types, while Vitest itself runs this file in Node.
// @ts-expect-error -- node:fs is available to Vitest, not the browser package.
import {readFileSync} from 'node:fs';

const CSS = readFileSync('src/index.css', 'utf8');
const DOCUMENT = readFileSync('src/screens/BlockPageDocument.tsx', 'utf8');

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

describe('block gutter pane geometry', () => {
  it('establishes inline-size containment on the editor pane and positioned wrapper', () => {
    expect(ruleBody('.obe-editor-pane')).toMatch(/container-name:\s*obe-editor-pane/);
    expect(ruleBody('.obe-editor-pane')).toMatch(/container-type:\s*inline-size/);
    expect(ruleBody('.obe-editor-wrap')).toMatch(/container-type:\s*inline-size/);
    expect(DOCUMENT).toContain('className="obe-editor-pane px-6 md:px-10"');
    expect(DOCUMENT).toContain('\'obe-editor-wrap relative pt-2\'');
  });

  it('uses pane width to collapse the top-level gutter to its grip', () => {
    expect(CSS).toContain('@container obe-editor-pane (max-width: 47.8rem)');
    expect(ruleBody('.obe-root:not(.obe-full) .obe-gutter:not(.obe-gutter-nested)')).toMatch(/left:\s*-1\.5rem/);
    expect(
      ruleBody('.obe-root:not(.obe-full) .obe-gutter:not(.obe-gutter-nested) > button:first-child'),
    ).toMatch(/display:\s*none/);
    expect(CSS).not.toMatch(/@media[^{]*max-width[^{]*{\s*\.obe-gutter/);
  });

  it('reserves the complete gutter inside full-width roots', () => {
    expect(ruleBody('.obe-root')).toMatch(/--obe-gutter-room:\s*3\.4rem/);
    const fullWidth = ruleBody('.obe-root.obe-full');
    expect(fullWidth).toMatch(/max-width:\s*none/);
    expect(fullWidth).toMatch(/padding-left:\s*var\(--obe-gutter-room\)/);
  });
});
