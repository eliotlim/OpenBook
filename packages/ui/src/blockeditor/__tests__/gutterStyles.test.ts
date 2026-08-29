import {describe, expect, it} from 'vitest';
// Test-only filesystem read; the published UI build intentionally omits Node
// ambient types, while Vitest itself runs this file in Node.
// @ts-expect-error -- node:fs is available to Vitest, not the browser package.
import {readFileSync} from 'node:fs';

const CSS = readFileSync('src/index.css', 'utf8');
const DOCUMENT = readFileSync('src/screens/BlockPageDocument.tsx', 'utf8');
const EDITOR_LAB = readFileSync('../web/src/components/EditorLab.tsx', 'utf8');

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
  it('establishes inline-size containment on every editor pane, not its positioned wrapper', () => {
    expect(ruleBody('.obe-editor-pane')).toMatch(/container-name:\s*obe-editor-pane/);
    expect(ruleBody('.obe-editor-pane')).toMatch(/container-type:\s*inline-size/);
    expect(CSS).not.toMatch(/\.obe-editor-wrap\s*{[^}]*container-type/);
    expect(DOCUMENT).toContain('\'obe-editor-pane w-full pb-40\'');
    expect(DOCUMENT).toContain('\'obe-editor-wrap relative pt-2\'');
    expect(EDITOR_LAB).toContain('className="obe-editor-pane"');
  });

  it('uses pane width to collapse the top-level gutter to its grip', () => {
    expect(CSS).toContain('@container obe-editor-pane (max-width: 47.8rem)');
    expect(ruleBody('.obe-root:not(.obe-full) .obe-gutter:not(.obe-gutter-nested)')).toMatch(/left:\s*-1\.5rem/);
    expect(
      ruleBody('.obe-root:not(.obe-full) .obe-gutter:not(.obe-gutter-nested) > button:first-child'),
    ).toMatch(/display:\s*none/);
    expect(CSS).not.toMatch(/@media[^{]*max-width[^{]*{\s*\.obe-gutter/);
  });

  it('reserves the complete gutter on every shared full-width document column', () => {
    expect(ruleBody('.obe-editor-pane')).toMatch(/--obe-gutter-room:\s*3\.4rem/);
    expect(DOCUMENT).toContain(
      'fullWidth ? \'max-w-none pl-[var(--obe-gutter-room)]\' : \'max-w-content\'',
    );
    const fullWidth = ruleBody('.obe-root.obe-full');
    expect(fullWidth).toMatch(/max-width:\s*none/);
    expect(fullWidth).not.toMatch(/padding-left/);
  });

  it('removes the shared reserve when the gutter cannot render', () => {
    expect(ruleBody('.obe-editor-pane.obe-readonly')).toMatch(/--obe-gutter-room:\s*0/);
    expect(DOCUMENT).toContain('!canWrite && \'obe-readonly\'');
    expect(CSS).toMatch(
      /@media \(pointer: coarse\)\s*{\s*\.obe-editor-pane\s*{\s*--obe-gutter-room:\s*0;/,
    );
  });
});

describe('table grip geometry', () => {
  it('does not charge the row grip or add-row control to the table width', () => {
    expect(ruleBody('.obe-table-wrap.obe-has-grips')).not.toMatch(/padding-left/);
    expect(ruleBody('.obe-table-add-row')).toMatch(/left:\s*0/);
    expect(CSS).not.toMatch(/\.obe-has-grips \.obe-table-add-row\s*{[^}]*left/);
  });

  it('keeps the row grip fully outside the cells and aligns the table gutter', () => {
    const grip = ruleBody('.obe-table-row-grip');
    expect(grip).toMatch(/left:\s*-1\.25rem/);
    expect(grip).toMatch(/width:\s*1\.25rem/);
    // The grip yields the column gap to the resize divider by STACKING, never by
    // `pointer-events: none` — an unhittable drag origin kills HTML5 dragstart
    // once the pointer leaves the row and `tr:hover` drops (TABLE-2).
    expect(grip).not.toMatch(/pointer-events/);
    expect(ruleBody('.obe-table-row-grip,\n.obe-table-col-grip')).toMatch(
      /z-index:\s*var\(--z-index-raised\)/,
    );
    const revealedGrip = ruleBody('.obe-table tr:hover .obe-table-row-grip');
    expect(revealedGrip).not.toMatch(/pointer-events/);
    expect(revealedGrip).toMatch(/z-index:\s*var\(--z-index-local-overlay\)/);
    expect(ruleBody('.obe-row[data-block-type=\'table\']:has(.obe-has-grips) > .obe-gutter')).toMatch(
      /top:\s*-0\.25rem/,
    );
  });
});

describe('column resize styles', () => {
  it('uses the editor width, not the window width, to stack columns', () => {
    const root = ruleBody('.obe-root');
    expect(root).toMatch(/container-name:\s*obe-block-editor/);
    expect(root).toMatch(/container-type:\s*inline-size/);
    expect(CSS).toContain('@container obe-block-editor (max-width: 40rem)');
    expect(CSS).not.toMatch(/@media[^{}]*max-width[^{}]*{[^{}]*\.obe-columns/);
  });

  it('keeps a raised, touch-safe one-rem hit zone with a two-pixel hover rule', () => {
    const divider = ruleBody('.obe-col-divider');
    expect(divider).toMatch(/z-index:\s*4/);
    expect(divider).toMatch(/width:\s*1rem/);
    expect(divider).toMatch(/touch-action:\s*none/);
    expect(ruleBody('.obe-col-divider::after')).toMatch(/width:\s*2px/);
    expect(ruleBody('.obe-col-divider-trailing')).toMatch(/right:\s*-1rem/);
  });

  it('lets a revealed nested gutter take pointer ownership above the column divider', () => {
    expect(ruleBody('.obe-gutter-nested')).toMatch(/z-index:\s*var\(--z-index-local-overlay\)/);
    expect(ruleBody('.obe-gutter')).toMatch(/pointer-events:\s*none/);
    expect(
      ruleBody('.obe-row:hover > .obe-gutter,\n.obe-row:focus-within > .obe-gutter,\n.obe-gutter:focus-within'),
    ).toMatch(/pointer-events:\s*auto/);
  });
});
