import {describe, it, expect} from 'vitest';
// Test-only filesystem read; the published UI build intentionally omits Node
// ambient types, while Vitest itself runs this file in Node.
// @ts-expect-error -- node:fs is available to Vitest, not the browser package.
import {readFileSync} from 'node:fs';

/**
 * TBL-6 paint guard — the *stylesheet* half of per-cell tint.
 *
 * The class-composition test in cellSelectionInteraction ("carries BOTH
 * obe-bg-green and obe-cell-selected") passed for the whole of TBL-4/TBL-5 while
 * the actual paint disagreed: `.obe-table td.obe-cell-selected` used the
 * `background` SHORTHAND, which (a) out-specifies `.obe-bg-*` — (0,2,1) beats
 * (0,1,0) — and (b) resets background-color as a shorthand does. Both classes
 * were present and the tint still painted nothing.
 *
 * That was invisible until TBL-6, where the range deliberately KEEPS its
 * highlight after "Cell colour" applies — making the selected-and-tinted state
 * the primary path rather than a transient one.
 *
 * So this test reads the real stylesheet and asserts the cascade directly: the
 * selection rules must declare no background of any kind, and must carry the
 * wash as a second inset box-shadow layer instead. It fails on the old CSS.
 */

const CSS = readFileSync('src/index.css', 'utf8');

/** The declaration body of a rule, by its exact selector text. */
function ruleBody(selector: string): string {
  const at = CSS.indexOf(`\n${selector} {`);
  expect(at, `rule not found: ${selector}`).toBeGreaterThan(-1);
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

const SELECTION_RULES = ['.obe-table td.obe-cell-selected', '.obe-table-header td.obe-cell-selected'];

describe('cell-selection highlight never resets the cell tint', () => {
  it.each([false, true])('keeps the computed tint paint under the selection shadows (header: %s)', (header) => {
    // happy-dom does not yet parse CSS Color 4's space-separated hsl(), so use
    // a sentinel colour for the palette declaration while preserving the REAL
    // selectors and REAL selection declarations from index.css. This exercises
    // the cascade that regressed: with the old high-specificity `background:`
    // shorthand, the computed colour becomes the selection wash instead.
    const style = document.createElement('style');
    style.textContent = `
      .obe-bg-blue { background-color: rgba(1, 2, 3, 0.13); }
      .obe-table td.obe-cell-selected { ${ruleBody('.obe-table td.obe-cell-selected')} }
      .obe-table-header td.obe-cell-selected { ${ruleBody('.obe-table-header td.obe-cell-selected')} }
    `;
    document.head.append(style);

    const table = document.createElement('table');
    table.className = 'obe-table';
    const tr = document.createElement('tr');
    if (header) tr.className = 'obe-table-header';
    const td = document.createElement('td');
    td.className = 'obe-bg-blue obe-cell-selected';
    tr.append(td);
    table.append(tr);
    document.body.append(table);

    const paint = getComputedStyle(td);
    expect(paint.backgroundColor).toBe('rgba(1, 2, 3, 0.13)');
    expect(paint.boxShadow).toContain('inset 0 0 0 2px');
    expect(paint.boxShadow).toContain('inset 0 0 0 999px');

    table.remove();
    style.remove();
  });

  it.each(SELECTION_RULES)('%s declares no background property', (selector) => {
    const body = ruleBody(selector);
    // `background`, `background-color`, `background-image`, … — any of them
    // either overwrites or (as a shorthand) resets the `.obe-bg-*` tint.
    expect(body).not.toMatch(/(^|[;\s])background(-[a-z]+)?\s*:/);
  });

  it.each(SELECTION_RULES)('%s paints the ring AND the wash as inset shadows', (selector) => {
    const body = ruleBody(selector);
    const shadow = /box-shadow\s*:([^;]+)/.exec(body);
    expect(shadow, 'box-shadow declaration').toBeTruthy();
    const layers = shadow![1].split(',').map((s) => s.trim());
    expect(layers).toHaveLength(2);
    expect(layers[0]).toMatch(/^inset 0 0 0 2px /); // the 2px ring
    expect(layers[1]).toMatch(/^inset 0 0 0 \d{3,}px /); // the flood-fill wash
    // Both layers are --ring tokens, so the highlight stays theme-aware.
    expect(layers.every((l) => l.includes('var(--ring)'))).toBe(true);
  });

  // The tint classes must stay plain background-color (no shorthand), so a
  // shadow-based selection composes over them rather than replacing them.
  it('every obe-bg-* token sets background-color only', () => {
    const rules = [...CSS.matchAll(/\.(?:dark )?\.?obe-bg-[a-z]+\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(rules.length).toBeGreaterThanOrEqual(9); // the 9 palette tokens
    for (const body of rules) {
      expect(body).toMatch(/background-color\s*:/);
      expect(body).not.toMatch(/(^|[;\s])background\s*:/);
    }
  });
});
