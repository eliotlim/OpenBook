# Spacing consistency manifest — scale + component recipes (SPC-1, 2026-08)

Status: **canonical standard and measurement baseline**. This document is the
authoritative spacing contract for the SPC-2/3/4 implementation work that follows.
SPC-1 defines tokens, records the current debt, and makes no component or visual
change. File:line references are against `origin/main` at `5c94ee8c`.

The baseline is computed by
[`spc-1-spacing-audit.mjs`](./spc-1-spacing-audit.mjs). Run it from any directory
with `node docs/design/spc-1-spacing-audit.mjs`; its ordered `key=value` output is
stable and it always exits zero because it measures rather than gates.

---

## 1. Standard

### 1.1 Grid and token rules

The **4px grid is the only legal spacing grid for new work**. Prefer named Tailwind
utilities over CSS literals. The named half steps already required by the canonical
dense recipes (`py-1.5` = 6px and `px-2.5` = 10px) are deliberate members of the
Tailwind 4px-base scale, not permission to invent decimal values. New arbitrary
bracket spacing needs an explained, non-recipe layout constraint.

Control heights use the dedicated Tailwind `--height-*` namespace added in SPC-1:

| Tier | Theme token | Utility | Exact value |
|---|---|---|---:|
| xs | `--height-control-xs` | `h-control-xs` | 24px |
| sm | `--height-control-sm` | `h-control-sm` | 28px |
| md | `--height-control-md` | `h-control-md` | 32px |
| lg | `--height-control-lg` | `h-control-lg` | 36px |

These definitions are additive: declaring them does not change rendering until a
follow-up adopts a utility. In control roles, `h-5`, `h-6`, `h-11`, and the editor
toolbar's `1.7rem` are non-canonical even where a raw value happens to coincide with
a token. Icons may retain `h-5`/`h-6`; the prohibition is about control boxes.

### 1.2 Canonical component recipes

| Surface | Canonical recipe | Resolved padding |
|---|---|---:|
| Dense field | `px-2.5 py-1.5` | 10px × 6px |
| Panel field | `px-3 py-2` | 12px × 8px |
| Menu container | `p-1` | 4px |
| Menu item | `px-2 py-1.5` | 8px × 6px |
| Table body cell | `px-2 py-1` | 8px × 4px |
| Table header cell | `px-2 py-1.5` | 8px × 6px |
| Overlay empty state | `py-6` | 24px vertical |
| Panel empty state | `py-8` | 32px vertical |

Icon-only controls must use an `IconButton` size variant. Hand-rolled button classes
such as `rounded p-1` are not a canonical recipe; `IconButton` owns their radius,
focus, hover, disabled, and size behaviour.

### 1.3 Radius rule

Use the shared `rounded-sm` / `rounded-md` / `rounded-lg` token family (resolved by
`--radius-sm`, `--radius-md`, and `--radius-lg`). Zero radius and deliberate
circle/pill geometry remain valid. Literal 4/6/8px values are treated as equivalent
to the current shared scale by the measurement script so SPC-2/3/4 can distinguish
true geometry changes from mechanical token adoption; all other literal radius
values are off-token.

---

## 2. Evidence and baseline

### 2.1 Re-runnable baseline

Measured on this branch after the additive token declaration:

| Audit key | Baseline |
|---|---:|
| `css.spacing.declarations_with_lengths` | 206 |
| `css.spacing.off_grid_declarations` | **161** |
| `css.spacing.off_grid_values` | 206 |
| `css.radius.declarations` | 109 |
| `css.radius.shared_token_declarations` | 12 |
| `css.radius.hardcoded_or_local_declarations` | **97** |
| `css.radius.off_token_declarations` | **25** |
| `tsx.files_scanned` | 256 |
| `tsx.arbitrary.spacing_occurrences` | **2** |
| `tsx.arbitrary.sizing_occurrences` | 82 |
| `tsx.arbitrary.position_occurrences` | 3 |
| `tsx.arbitrary.layout_total_occurrences` | **87** |
| `tsx.arbitrary.layout_unique_utilities` | 58 |

The CSS spacing figure includes `padding*`, `margin*`, `gap`, `row-gap`, and
`column-gap` declarations containing rem/px lengths, including directional
longhands. That explicit coverage explains why the measured 161 is above the rough
manual estimate of about 125. CSS comments are excluded. A declaration is counted
once when any length is outside the named Tailwind spacing scale; 1px/2px hairlines
are not accepted as layout spacing.

The radius audit reports both the broad debt and the actionable subset. Of 109
`border-radius` declarations, 97 do not reference the shared `--radius*` family;
only six directly reference base `var(--radius)` (three plain and three calculated).
The 25 truly off-token declarations exclude shared/local variable references,
0, circle/pill geometry, and literal equivalents of the 4/6/8px shared scale.

For TSX, the audit scans all 256 `.tsx` files below `packages/ui/src` and
`packages/web/src`. Strict arbitrary spacing means `p*`, `m*`, `gap*`, and
`space-*`; the two current occurrences are `pl-[1.375rem]` in
`packages/ui/src/components/links/LinksPaneBody.tsx:296,331`. Sizing and positional
arbitraries are reported separately and combined into the 87-occurrence layout
total so later control-height work is visible without mislabelling fixed popover
dimensions as padding debt.

### 2.2 Current inconsistent surfaces

| Evidence | Current state | Conflict with standard |
|---|---|---|
| `packages/ui/src/index.css:2009-2016` | `.obe-slash-item` uses `padding: 0.4rem 0.6rem` and 7px radius. | Menu items must use 8px × 6px and a shared radius. |
| `packages/ui/src/index.css:2089-2110` | `.obe-toolbar` uses 1px gap, 3px container padding, a calculated 9px radius, and 1.7rem controls. | All four values bypass the spacing/control-height contract. |
| `packages/ui/src/index.css:1876` | Block-table text cells use `0.35rem 0.5rem`. | Body/header cells have separate 8px × 4px / 8px × 6px recipes. |
| `packages/ui/src/index.css` | Audit finds 161 off-grid spacing declarations; the raw radius inventory is about 100 hardcoded/local declarations. | CSS decimal scales and radius literals have drifted from shared tokens. |
| TSX bordered-box inventory | 15 distinct bordered-box padding pairs are in use. | Dense/panel fields and empty states now have one recipe each. |
| `packages/ui/src/components/ui/input.tsx:15-16`; `packages/ui/src/components/settings/primitives.tsx:14` | Input default (`px-3 py-1`), input small (`px-2.5 py-1`), and settings (`px-2.5 py-1.5`) form three competing canons. | Choose dense or panel field recipe; do not create a fourth. |
| `packages/ui/src/components/ui/icon-button.tsx:7-25` plus call sites such as `blockeditor/kit/OptionsEditor.tsx:106,166` | `IconButton` exists, while hand-rolled `rounded-md p-1` controls remain. | All icon-only buttons must use `IconButton` variants. |
| `packages/ui/src/components/ArtifactOverlay.tsx:56`; `packages/ui/src/components/TitlebarTabs.tsx:104`; `packages/ui/src/index.css:2103-2104` | Control boxes use `h-11`, `h-6`, and 1.7rem. | Adopt one of the four semantic control-height tiers. |

---

## 3. Migration table

SPC-1 intentionally changes none of these consumers. SPC-2/3/4 should migrate them
in their assigned component scopes and re-run the audit after each mechanical pass.

| Migration area | From | To | Proof |
|---|---|---|---|
| Fields | Per-file `px-* py-*` combinations and three input canons | Dense `px-2.5 py-1.5` or panel `px-3 py-2` | Relevant component tests; no new recipe pair |
| Menus | Decimal CSS padding and locally derived item density | Container `p-1`; item `px-2 py-1.5` | Menu tests; reduced CSS off-grid count |
| Tables | `.obe-text` 0.35rem/0.5rem and competing TSX cells | Body `px-2 py-1`; header `px-2 py-1.5` | Table tests; body/header remain distinct |
| Empty states | Per-surface vertical padding | Overlay `py-6`; panel `py-8` | Existing empty/loading-state tests |
| Icon buttons | Native buttons with `rounded p-1`-style classes | Existing `IconButton` variants only | Focus/label tests; no hand-rolled geometry |
| Control heights | `h-5`, `h-6`, `h-11`, arbitrary/literal heights | `h-control-xs/sm/md/lg` | Token utility visible at the migrated call site |
| Radius literals | 1/2/3/5/7/10px local geometry | Shared radius utilities/tokens; preserve only deliberate pill/circle geometry | Reduced `css.radius.off_token_declarations` |
| Arbitrary TSX layout | Bracket utilities used for token-sized controls or recipe spacing | Named height/spacing utility | Reduced category count; fixed layout constraints may remain with rationale |

Progress is directional, not a zero-debt gate: a remaining fixed width, viewport
calculation, or deliberate circle can be valid. The stable category counts make
that residual explicit instead of conflating it with padding and control-height
migrations.
