# TMPL-RECIPES-1 report

## Built

- Added `recipe-scaler` as the first gallery template, with icon 🍳, page name “Recipe scaler”, and `interactive` / `slides` tags.
- Chose a 25-minute mushroom weeknight ramen recipe. A 1–12 servings slider defaults to four servings and scales noodles, broth, mushrooms, spinach, soy sauce, eggs, total prep weight, and pot count. The document also includes an ingredient table, bar chart, batch status, maximum-batch progress, speaker notes, and a five-step cooking checklist. It contains no prices or currency.
- Moved `savings-planner`, `compound-growth`, and `simple-budget` to the final three registry positions, preserving their relative order. Every other pre-existing template retains its relative order.
- Added English, German, Japanese, and Simplified Chinese gallery name, description, and guidance copy.
- Added focused unit coverage for registration, default computations, slide-deck invariants, and all four locale keys. Added (but did not run) the requested Playwright case using `[data-template="recipe-scaler"]` through the shared `pick` helper.

## GROCERY_BLOCKS mechanisms reused

- The same named `slider` input shape (`props.name`, `label`, `value`, `min`, `max`, `step`).
- Collapsed live JavaScript `code` blocks (`live: true`, `language: 'js'`, `collapsed: true`) publishing named values into the shared reactive scope.
- Consumer-after-engine ordering for `kitchart`, `statuslight`, and `progressbar` blocks, with each consumer reading a `props.source` expression over those named values.
- The same `columns` / `column` layout, rich-text `table` → `row` → `cell` hierarchy, top-level slide `divider`s, `notes`, and callouts. The table API supports rich-text cells rather than expression cells, so the amount column labels the adjacent named live outputs; the computed values themselves are visible in the collapsed code readouts and feed the chart/status/progress blocks. No new block type or block API was introduced.

## Files touched

- `packages/sdk/src/templates.ts`
- `packages/ui/src/i18n/messages/en.ts`
- `packages/ui/src/i18n/messages/de.ts`
- `packages/ui/src/i18n/messages/ja.ts`
- `packages/ui/src/i18n/messages/zh.ts`
- `packages/ui/src/lib/__tests__/templates.test.ts`
- `packages/web/e2e/templates.spec.ts`
- `TMPL-RECIPES-1-report.md`

## Verification

- `pnpm --filter @book.dev/sdk build`: passed.
- `pnpm --filter @book.dev/ui build`: passed.
- `pnpm --filter @book.dev/sdk test`: passed (29 files, 494 tests).
- `pnpm --filter @book.dev/ui exec vitest run src/lib/__tests__/templates.test.ts`: 39 passed, 1 failed. The sole failure is the pre-existing `expect(PAGE_TEMPLATES).toHaveLength(14)` assertion, which now receives the correct registry length of 15. The task's hard rule expressly says not to modify an existing assertion and to leave it failing if a change is necessary, so it remains untouched.
- `pnpm --filter @book.dev/sdk run typecheck`: passed.
- `pnpm --filter @book.dev/ui run typecheck`: passed.
- `pnpm --filter @book.dev/ui run check:i18n`: passed with no extra keys or placeholder mismatches; the repository's pre-existing optional untranslated keys remain reported.
- Browser e2e: not run, as requested.
- No server tests were run; no EMFILE issue was encountered.

## Pre-existing tests or assertions modified

None. The slide-deck ID fixture was extended to register the new deck, and new recipe-specific unit/e2e cases were added. The stale 14-template assertion was deliberately not changed.
