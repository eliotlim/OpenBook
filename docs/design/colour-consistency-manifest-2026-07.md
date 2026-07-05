# Colour consistency manifest — data palette + sidebar accent (OB-375, 2026-07)

Status: **proposal, awaiting owner sign-off on exact values** (the structure below implements
owner decisions already made). This document is the authoritative spec for the three
implementation issues that follow: (1) unified data palette + "Data colours" control,
(2) sidebar full-accent model, (3) export/inline plumbing.

Owner decisions this spec implements:

- **(a)** A new **"Data colours"** appearance control with schemes **Pastel (default) /
  Vivid / Muted** — one unified palette for tags, charts, status lights and exports,
  independent of the accent theme.
- **(b)** The sidebar becomes a **full-intensity accent surface by default** with a
  contrasting light (or ink) foreground; `interfaceIntensity` dials it back toward
  neutral; the desk/book-cover background stays a **neutral canvas**.
- **(c)** Exact values are proposed here from the repo's existing token language
  (design-system on claude.ai/design unreachable); owner signs off after.

Every value in this document was **computed, not eyeballed** — the generator/audit
script is committed next to this file as
[`ob-375-palette-audit.mjs`](./ob-375-palette-audit.mjs) (`node docs/design/ob-375-palette-audit.mjs`
re-emits every table). WCAG 2.1 contrast ratios; the pass bar is **≥ 4.5:1 for text**,
3:1 for non-text graphics.

Note: the task brief said "all 19 themes"; `packages/ui/src/lib/themes.ts:162-269`
defines **17** (default, 3 gray, 7 bold, 6 pastel). All 17 are covered.

---

## 1. Unified data palette

### 1.1 Token set

The canonical token list keeps the **9 `SELECT_COLORS` names unchanged**
(`packages/sdk/src/database.ts:586`): `gray, brown, orange, yellow, green, blue,
purple, pink, red`. These remain the only tokens storable on select options — **no
stored-format change**.

The palette **extends** them with **3 chart-only tokens**: `teal`, `cyan`, `indigo`
(the kit palette's hues that have no select equivalent). They participate in series
cycling and may be referenced by future features, but are *not* added to
`SELECT_COLORS` (stored enum stays 9; extension later would be additive and safe).

**Canonical series order** (replaces both chart palettes' implicit orders):

```
SERIES_ORDER = [blue, orange, green, red, purple, cyan, yellow, teal, pink, indigo, brown, gray]
```

12 distinguishable series before cycling (today: 8 in kit, 10 in db). Blue-first
follows the db `CHART_PALETTE` precedent (kit started indigo-first — see open
question Q1).

### 1.2 Roles

Each token × scheme resolves to three role values:

| Role | Used by | Mode behaviour |
|---|---|---|
| **fill** | tag dot/swatch, chart series fill, status lamp | **mode-invariant** (one value for light + dark) |
| **chip bg** | select-option chip background | per mode |
| **chip fg** | select-option chip text | per mode |

Fills are deliberately mode-invariant: it matches today's behaviour (`SWATCH_HEX`
and both chart palettes are used verbatim in both modes; the kit palette comment
reads "readable on both themes"), and it means exported documents — which have no
colour-scheme context — inline exactly the values the author saw.

**Status lights** are the `fill` of semantic tokens: `ok → green`, `warn → orange`,
`bad → red`, `off → gray fill at 35 % alpha`. The lamp keeps its ring:
`box-shadow: 0 0 0 3px <fill at 25 % alpha>`.

**Pastel/Muted visibility rule (light mode):** pastel fills sit at 1.3–2.2:1 against
a white page (that is what pastel *is*), so in the **pastel and muted schemes,
light mode only**, chart shapes, swatch dots and status lamps carry a hairline
stroke `--data-stroke: rgba(0, 0, 0, 0.12)` (1 px). Vivid gets no stroke (matches
today); dark mode gets no stroke (all fills ≥ 3:1 on the dark page — see §3.3).

### 1.3 How the legacy lists map onto it

All four hard-coded lists are **deleted** and replaced by the canonical module (§4).

**`SWATCH_HEX`** (`packages/ui/src/components/database/databaseColors.ts:9-19`) →
`fill` of the Vivid scheme, verbatim, with **one intended change**: `orange` moves
`#f59e0b` (amber-500) → `#f97316` (orange-500). Rationale: the orange *chip* has
always been real orange (`bg-orange-200 text-orange-800`), amber-500 collided with
`yellow` (`#eab308`, 7° away), and the kit palette already used `#f97316`.

**Kit chart `PALETTE`** (`packages/ui/src/blockeditor/kit/chartMath.ts:164`, duplicated
as `KIT_PALETTE` in `packages/ui/src/export/kitChart.ts:15` and inside the
`KIT_CHART_JS` string) → tokens:

| Kit hex | Token | Canonical Vivid value |
|---|---|---|
| `#6366f1` | indigo | `#6366f1` (exact) |
| `#f59e0b` | orange | `#f97316` (shifts) |
| `#10b981` | green | `#22c55e` (shifts; emerald → green-500, the tag-dot value) |
| `#ef4444` | red | `#ef4444` (exact) |
| `#8b5cf6` | purple | `#a855f7` (shifts to the tag-dot value) |
| `#06b6d4` | cyan | `#06b6d4` (exact) |
| `#f97316` | orange (duplicate) | slot removed; `SERIES_ORDER` supplies yellow/teal/pink instead |
| `#14b8a6` | teal | `#14b8a6` (exact) |

**db `CHART_PALETTE`** (`databaseColors.ts:22-33`) → tokens, all exact matches
(`#3b82f6` blue, `#22c55e` green, `#f59e0b` → orange `#f97316`, `#a855f7` purple,
`#ec4899` pink, `#ef4444` red, `#14b8a6` teal, `#eab308` yellow, `#6366f1` indigo,
`#f97316` orange-duplicate removed).

**Status trio** (`packages/ui/src/index.css:2480-2489`, duplicated at
`packages/ui/src/export/toHtml.ts:1070-1072`): `ok #10b981 → green`,
`warn #f59e0b → orange`, `bad #ef4444 → red` (exact). In Vivid, ok/warn shift to
`#22c55e` / `#f97316`; in Pastel (the new default) all three take pastel fills.

**`COLOR_CLASSES`** (`packages/ui/src/components/database/databaseCells.tsx:93-105`,
Tailwind `-200`/`-800` light, `-900/40` + `-200` dark) → the **Pastel chip values,
preserved**: light values are the exact Tailwind hexes used today; dark values are
today's translucent classes **flattened over the dark card** (`0 0% 16%` → `#292929`)
so every chip value is a single exact colour (deterministic in exports, auditable).
`brown` (today `bg-amber-200/70`) flattens over white to `#feeead`.

### 1.4 Canonical values — fills (token × scheme, mode-invariant)

Pastel = Tailwind `-300` row (brown derived, no Tailwind family); Vivid = today's
saturated hexes (§1.3); Muted = hue preserved, S compressed to ~30 % (min 10, max 32),
L 58. Both plain hex and the repo's `H S% L%` triple are given — the module stores hex.

| Token | Pastel fill | Vivid fill | Muted fill |
|---|---|---|---|
| gray | `#d4d4d8` (240 4.9% 83.9%) | `#9ca3af` (217.9 10.6% 64.9%) | `#8d929a` (216.9 6% 57.8%) |
| brown | `#bdac9e` (27.1 19% 68%) | `#b08968` (27.5 31.3% 54.9%) | `#9f9389` (27.3 10.3% 58%) |
| orange | `#fdba74` (30.7 97.2% 72.4%) | `#f97316` (24.6 95% 53.1%) | `#b28e75` (24.6 28.4% 57.8%) |
| yellow | `#fde047` (50.4 97.8% 63.5%) | `#eab308` (45.4 93.4% 47.5%) | `#b2a376` (45 28% 58%) |
| green | `#86efac` (141.7 76.6% 73.1%) | `#22c55e` (142.1 70.6% 45.3%) | `#7dab8e` (142.2 21.5% 58%) |
| blue | `#93c5fd` (211.7 96.4% 78.4%) | `#3b82f6` (217.2 91.2% 59.8%) | `#778db1` (217.2 27.1% 58%) |
| purple | `#d8b4fe` (269.2 97.4% 85.1%) | `#a855f7` (270.7 91% 65.1%) | `#9577b1` (271 27.1% 58%) |
| pink | `#f9a8d4` (327.4 87.1% 81.8%) | `#ec4899` (330.4 81.2% 60.4%) | `#ae7a94` (330 24.3% 58%) |
| red | `#fca5a5` (0 93.5% 81.8%) | `#ef4444` (0 84.2% 60.2%) | `#af7979` (0 25.2% 58%) |
| teal | `#5eead4` (170.6 76.9% 64.3%) | `#14b8a6` (173.4 80.4% 40%) | `#7aaea8` (173.1 24.3% 58%) |
| cyan | `#67e8f9` (187 92.4% 69%) | `#06b6d4` (188.7 94.5% 42.7%) | `#76a9b2` (189 28% 58%) |
| indigo | `#a5b4fc` (229.7 93.5% 81.8%) | `#6366f1` (238.7 83.5% 66.7%) | `#797aaf` (238.9 25.2% 58%) |

Status lights by scheme (derived, for convenience): Pastel `ok #86efac / warn #fdba74 /
bad #fca5a5`; Vivid `ok #22c55e / warn #f97316 / bad #ef4444`; Muted `ok #7dab8e /
warn #b28e75 / bad #af7979`. `off` = the scheme's gray fill at 35 % alpha.

### 1.5 Canonical values — chips

Every fg/bg pair below is **≥ 4.5:1** (fg lightness was auto-solved to the bar where a
seed value fell short; ratios in §3.2).

**Pastel chips (default — today's chip look, dark side flattened):**

| Token | Light bg | Light fg | Dark bg | Dark fg |
|---|---|---|---|---|
| gray | `#e4e4e7` | `#3f3f46` | `#36363a` | `#e4e4e7` |
| brown | `#feeead` | `#78350f` | `#492e1f` | `#fde68a` |
| orange | `#fed7aa` | `#9a3412` | `#4a2b20` | `#fed7aa` |
| yellow | `#fef08a` | `#854d0e` | `#463220` | `#fef08a` |
| green | `#bbf7d0` | `#166534` | `#213a2b` | `#bbf7d0` |
| blue | `#bfdbfe` | `#1e40af` | `#253050` | `#bfdbfe` |
| purple | `#e9d5ff` | `#6b21a8` | `#3c244f` | `#e9d5ff` |
| pink | `#fbcfe8` | `#9d174d` | `#4d2233` | `#fbcfe8` |
| red | `#fecaca` | `#991b1b` | `#4b2424` | `#fecaca` |
| teal | `#99f6e4` | `#115e59` | `#203836` | `#99f6e4` |
| cyan | `#a5f3fc` | `#155e75` | `#213840` | `#a5f3fc` |
| indigo | `#c7d2fe` | `#3730a3` | `#2c2b4c` | `#c7d2fe` |

**Vivid chips (bg = pastel fill row, deep same-hue ink; dark = saturated deep bg):**

| Token | Light bg | Light fg | Dark bg | Dark fg |
|---|---|---|---|---|
| gray | `#d4d4d8` | `#32373e` | `#484b51` | `#cdd0d6` |
| brown | `#bdac9e` | `#45372b` | `#534437` | `#d8d1ca` |
| orange | `#fdba74` | `#603110` | `#693e21` | `#e7cdbb` |
| yellow | `#fde047` | `#5f4c11` | `#685721` | `#e7dcbc` |
| green | `#86efac` | `#1a5630` | `#2a603e` | `#c1e1cd` |
| blue | `#93c5fd` | `#122f5e` | `#223d67` | `#bccce6` |
| purple | `#d8b4fe` | `#39125e` | `#462267` | `#d2bce6` |
| pink | `#f9a8d4` | `#5a1638` | `#642644` | `#e4bed1` |
| red | `#fca5a5` | `#5c1515` | `#652525` | `#e4bebe` |
| teal | `#5eead4` | `#165a52` | `#26635d` | `#bfe4df` |
| cyan | `#67e8f9` | `#105460` | `#215e69` | `#bbe0e7` |
| indigo | `#a5b4fc` | `#15165b` | `#252764` | `#bebfe4` |

**Muted chips (greyed washes):**

| Token | Light bg | Light fg | Dark bg | Dark fg |
|---|---|---|---|---|
| gray | `#e4e5e7` | `#4d5056` | `#3b3d40` | `#c4c6ca` |
| brown | `#e8e5e3` | `#59514a` | `#413d3a` | `#cac7c3` |
| orange | `#ebe5e0` | `#694d3a` | `#463c34` | `#d2c5bc` |
| yellow | `#ebe8e0` | `#685d3b` | `#464235` | `#d1ccbc` |
| green | `#e2e9e4` | `#40634d` | `#37443b` | `#bfcfc5` |
| blue | `#e0e4eb` | `#3b4c68` | `#353b46` | `#bdc4d1` |
| purple | `#e6e0eb` | `#523b68` | `#3d3546` | `#c7bdd1` |
| pink | `#eae1e5` | `#653e51` | `#45363d` | `#d0bec7` |
| red | `#eae1e1` | `#663d3d` | `#453535` | `#d0bdbd` |
| teal | `#e1eae9` | `#3e6561` | `#364543` | `#bed0ce` |
| cyan | `#e0e9eb` | `#3a6269` | `#354346` | `#bcced2` |
| indigo | `#e1e1ea` | `#3d3e66` | `#363645` | `#bebed0` |

### 1.6 Editor text/highlight colours: **OUT of scope** (explicit call)

`COLOR_TOKENS` / `COLOR_EXPORT_HEX` (`packages/ui/src/blockeditor/colors.ts:13,35`)
are **not** recoloured by the Data-colours scheme. Rationale:

1. They are **authored content**, not data visualization: `tc`/`hl`/`fg`/`bg` tokens
   are stored in the document itself. A *viewer* preference that re-inks an author's
   deliberate emphasis would make the same document read differently per reader and
   per export — the opposite of the review-layer/export-fidelity guarantees.
2. Their role constraints differ: `fg` values are contrast-tuned *text* colours,
   `hl` values are washes behind arbitrary theme text — neither maps onto
   fill/chip roles, and reusing the fill values would fail contrast as text.
3. They already have their own light/dark adaptation via `obe-fg-*`/`obe-hl-*`
   classes plus pinned export hexes; nothing is duplicated with the lists §1.3 kills.

The token *names* intentionally stay aligned (same 9 hue names) so the mental model
is one palette family. A later cosmetic pass could nudge `hl` washes toward the
pastel chip bgs, but it is not part of this program.

---

## 2. Sidebar full-accent model

### 2.1 Replacement for the sheet derivation (`themes.ts:487-495`)

Today the sheets take only the accent *hue* at fixed lightness 96/16 with low
saturation. Replacement — for `interfaceIntensity` level ≥ 2 (see §2.4), derived
from each theme's `primary`:

**Light scheme**

```
sheet1 = primary, verbatim                      (H S% L% of theme.light.primary)
sheet2 = (H, min(S+4, 100)%, (L−6)%)            (the deeper companion sheet)
sheet1Foreground = sheet2Foreground = theme.light.primaryForeground
```

with two per-theme escape hatches, applied in order, only when
`min(contrast(fg, sheet1), contrast(fg, sheet2)) < 4.5`:

1. **Flip to ink:** fg = `(H, 55%, 15%)` (gray accents `(H, 0%, 15%)`) if that passes
   both sheets — used by warm/pastel hues where white can't win (sunset,
   pastel-lavender, pastel-rose, pastel-peach). This mirrors the amber theme's
   existing dark-ink `primaryForeground`.
2. **Darken the sheet:** reduce L by 1 until white passes (keeps the sidebar
   consistent with the theme's white-on-primary buttons) — used by default (49→44),
   forest (38→31), teal (38→30).

**Dark scheme** — a *deep* accent shade, not the (light-ish) dark primary itself:

```
S' = 0 if S(primaryDark) == 0, else clamp(S(primaryDark) × 0.7, 12, 60)
sheet1 = (H(primaryDark), S', 24%)
sheet2 = (H(primaryDark), S', 28.5%)
sheet1Foreground = sheet2Foreground = 0 0% 93%    (all themes)
```

**"Full intensity" for the 3 gray accents** = the gray accent's own primary surface:
a **charcoal ink panel** (`28 12% 34%` sandstone / `0 0% 34%` graphite /
`220 14% 36%` slate) with white foreground in light mode, and the deep `L 24` shade
in dark mode. Gray accents keep S as authored (no 0.7 clamp-up); the sidebar is
what makes a gray accent visible at all, so it gets the same full treatment
(dial-back to a light panel lives at levels 0/1).

### 2.2 Exact per-theme tokens (level ≥ 2) — this is also the §3 audit table

| Theme | Light `--sheet-1` | Light `--sheet-2` | Light fg | fg/s1 | fg/s2 | Per-theme override | Dark `--sheet-1` | Dark `--sheet-2` | fg/s1 | fg/s2 |
|---|---|---|---|---|---|---|---|---|---|---|
| default | `207 75% 44%` | `207 79% 38%` | `0 0% 100%` | 4.58 | 5.75 | sheet L 49 → 44 | `207 47.6% 24%` | `207 47.6% 28.5%` | 9.23 | 7.70 |
| sandstone | `28 12% 34%` | `28 16% 28%` | `0 0% 100%` | 7.13 | 9.00 | — | `30 12% 24%` | `30 12% 28.5%` | 9.09 | 7.55 |
| graphite | `0 0% 34%` | `0 4% 28%` | `0 0% 100%` | 7.23 | 9.42 | — | `0 0% 24%` | `0 0% 28.5%` | 9.28 | 7.69 |
| slate | `220 14% 36%` | `220 18% 30%` | `0 0% 100%` | 7.16 | 9.19 | — | `218 12% 24%` | `218 12% 28.5%` | 9.60 | 8.11 |
| ocean | `221 83% 53%` | `221 87% 47%` | `0 0% 100%` | 5.17 | 6.35 | — | `217 60% 24%` | `217 60% 28.5%` | 10.40 | 8.90 |
| forest | `142 71% 31%` | `142 75% 25%` | `0 0% 100%` | 4.59 | 6.20 | sheet L 38 → 31 | `142 45.5% 24%` | `142 45.5% 28.5%` | 7.04 | 5.56 |
| violet | `262 83% 58%` | `262 87% 52%` | `0 0% 100%` | 5.67 | 7.04 | — | `263 49% 24%` | `263 49% 28.5%` | 11.93 | 10.56 |
| sunset | `25 95% 53%` | `25 99% 47%` | `25 55% 15%` | 5.25 | 4.53 | fg → ink | `21 60% 24%` | `21 60% 28.5%` | 9.02 | 7.45 |
| rose | `346 77% 50%` | `346 81% 44%` | `0 0% 100%` | 4.66 | 5.64 | — | `346 52.5% 24%` | `346 52.5% 28.5%` | 10.69 | 9.12 |
| teal | `174 72% 30%` | `174 76% 24%` | `0 0% 100%` | 4.56 | 6.28 | sheet L 38 → 30 | `173 49% 24%` | `173 49% 28.5%` | 6.69 | 5.26 |
| amber | `38 92% 48%` | `38 96% 42%` | `30 40% 14%` | 6.45 | 5.15 | — (theme ink) | `41 60% 24%` | `41 60% 28.5%` | 7.06 | 5.62 |
| pastel-sky | `205 74% 70%` | `205 78% 64%` | `205 50% 22%` | 5.54 | 4.76 | — (theme ink) | `205 42% 24%` | `205 42% 28.5%` | 9.13 | 7.52 |
| pastel-mint | `152 48% 66%` | `152 52% 60%` | `152 45% 20%` | 5.63 | 5.22 | — (theme ink) | `152 29.4% 24%` | `152 29.4% 28.5%` | 7.83 | 6.31 |
| pastel-lavender | `258 60% 76%` | `258 64% 70%` | `258 55% 15%` | 7.42 | 5.65 | fg → ink (theme fg L28 failed s2) | `258 33.6% 24%` | `258 33.6% 28.5%` | 11.28 | 9.93 |
| pastel-rose | `344 72% 78%` | `344 76% 72%` | `344 55% 15%` | 8.02 | 6.45 | fg → ink (theme fg L30 failed s2) | `344 39.2% 24%` | `344 39.2% 28.5%` | 10.57 | 9.07 |
| pastel-peach | `24 84% 74%` | `24 88% 68%` | `24 55% 15%` | 8.12 | 7.05 | fg → ink (theme fg L28 failed s2) | `22 49% 24%` | `22 49% 28.5%` | 9.09 | 7.55 |
| pastel-butter | `46 80% 70%` | `46 84% 64%` | `40 55% 24%` | 5.88 | 5.55 | — (theme ink) | `46 46.2% 24%` | `46 46.2% 28.5%` | 7.23 | 5.72 |

Dark foreground is `0 0% 93%` for every theme (both sheets). All 68 fg-on-sheet
pairs (17 themes × 2 sheets × 2 modes) pass ≥ 4.5:1; worst case is sunset light
fg-on-sheet-2 at 4.53.

`--sheet-1-foreground` / `--sheet-2-foreground` (`ThemeTokens`, `themes.ts:28-55`)
stop being constants equal to the app foreground and become the flipped values
above; every sidebar text/icon consumer must read them (not `--foreground`).
**Secondary/muted sidebar text keeps the full foreground colour** (de-emphasis via
size/weight only): an alpha tier does not survive the tightest themes (fg at 85 %
alpha lands at 3.67–4.26 on default/forest/rose/teal/sunset/sky/butter). Non-text
icons/hairlines may use fg at 75 % alpha (≥ 3:1 everywhere, worst 3.2).

### 2.3 Hover / active / press (`packages/ui/src/lib/sidebarStyles.ts:8-19`)

The current `bg-primary/10..25` washes are invisible on a surface that *is* the
primary. Replacement: a **veil overlay** whose pole is chosen so the wash always
*increases* foreground contrast, exposed as a composed token `--sheet-veil`
(an `H S% L%` triple, written by `composeAppearance`):

```
light scheme, level ≥ 2:  veil = 0 0% 0% (black) when fg is light (L ≥ 60)
                          veil = 0 0% 100% (white) when fg is ink
light scheme, level 0–1:  veil = 0 0% 0% (black)
dark scheme (all levels): veil = 0 0% 100% (white)
```

Exact replacement constants:

```ts
export const SIDEBAR_HOVER =
  'hover:bg-[hsl(var(--sheet-veil)/0.10)] hover:text-[hsl(var(--sheet-1-foreground))] dark:hover:bg-[hsl(var(--sheet-veil)/0.08)]';
export const SIDEBAR_ACTIVE =
  'bg-[hsl(var(--sheet-veil)/0.16)] text-[hsl(var(--sheet-1-foreground))] dark:bg-[hsl(var(--sheet-veil)/0.13)]';
export const SIDEBAR_PRESS =
  'active:scale-100 active:bg-[hsl(var(--sheet-veil)/0.24)] dark:active:bg-[hsl(var(--sheet-veil)/0.15)]';
```

(Alphas: light 10 / 16 / 24 %, dark 8 / 13 / 15 %.) Audited effective surfaces —
foreground contrast on the *washed* background, level 2:

**Light scheme** (veil pole per theme as above):

| Theme | veil | hover | fg ratio | active | fg ratio | press | fg ratio |
|---|---|---|---|---|---|---|---|
| default | black | `#196db0` | 5.45 | `#1866a5` | 6.03 | `#155c95` | 7.01 |
| sandstone | black | `#574d44` | 8.23 | `#514840` | 8.93 | `#4a413a` | 9.96 |
| graphite | black | `#4e4e4e` | 8.32 | `#494949` | 9.00 | `#424242` | 10.05 |
| slate | black | `#474f5f` | 8.23 | `#424a58` | 8.93 | `#3c4350` | 9.95 |
| ocean | black | `#2059d4` | 6.10 | `#1e53c5` | 6.78 | `#1b4bb3` | 7.77 |
| forest | black | `#157a3a` | 5.42 | `#137136` | 6.10 | `#116731` | 6.98 |
| violet | black | `#7035d5` | 6.65 | `#6832c7` | 7.32 | `#5e2db4` | 8.37 |
| sunset | white | `#fa822c` | 5.78 | `#fa8a3a` | 6.11 | `#fa954d` | 6.60 |
| rose | black | `#cb1a44` | 5.57 | `#be183f` | 6.19 | `#ac1639` | 7.17 |
| teal | black | `#13776d` | 5.40 | `#126f66` | 6.01 | `#10645c` | 7.00 |
| amber | white | `#eda223` | 7.00 | `#eea831` | 7.35 | `#f0b145` | 7.92 |
| pastel-sky | white | `#87c3ed` | 5.99 | `#8fc7ee` | 6.27 | `#9accf0` | 6.65 |
| pastel-mint | white | `#8cd7b3` | 6.00 | `#93d9b8` | 6.18 | `#9eddbf` | 6.51 |
| pastel-lavender | white | `#bba7e9` | 8.19 | `#bfadeb` | 8.67 | `#c5b5ed` | 9.35 |
| pastel-rose | white | `#f1a9bc` | 8.68 | `#f2aec0` | 9.03 | `#f3b6c6` | 9.60 |
| pastel-peach | white | `#f5ba91` | 8.66 | `#f6be99` | 8.96 | `#f7c4a2` | 9.40 |
| pastel-butter | white | `#f2d783` | 6.10 | `#f2da8b` | 6.24 | `#f4de96` | 6.47 |

**Dark scheme** (white veil, fg `0 0% 93%`):

| Theme | hover | fg ratio | active | fg ratio | press | fg ratio |
|---|---|---|---|---|---|---|
| default | `#324f67` | 7.32 | `#3d596f` | 6.28 | `#415d73` | 5.90 |
| sandstone | `#544d46` | 7.10 | `#5d5650` | 6.16 | `#615a54` | 5.79 |
| graphite | `#4d4d4d` | 7.22 | `#565656` | 6.27 | `#5a5a5a` | 5.89 |
| slate | `#464b54` | 7.49 | `#50545d` | 6.48 | `#545861` | 6.09 |
| ocean | `#2a456f` | 8.23 | `#364f76` | 7.07 | `#3b537a` | 6.63 |
| forest | `#336646` | 5.73 | `#3e6f50` | 4.99 | `#427254` | 4.76 |
| violet | `#463168` | 9.44 | `#503c70` | 8.07 | `#544174` | 7.52 |
| sunset | `#6f422a` | 7.21 | `#764d36` | 6.22 | `#7a513b` | 5.85 |
| rose | `#6a2f3d` | 8.60 | `#723a47` | 7.44 | `#753f4c` | 6.97 |
| teal | `#316862` | 5.46 | `#3c706a` | 4.82 | `#41746e` | 4.54 |
| amber | `#6f592a` | 5.72 | `#766236` | 5.02 | `#7a663b` | 4.73 |
| pastel-sky | `#355064` | 7.22 | `#405a6d` | 6.18 | `#445e70` | 5.82 |
| pastel-mint | `#3c5d4d` | 6.26 | `#476657` | 5.43 | `#4b695b` | 5.17 |
| pastel-lavender | `#453a60` | 8.85 | `#4f4568` | 7.53 | `#53496c` | 7.07 |
| pastel-rose | `#633642` | 8.39 | `#6b414d` | 7.21 | `#6f4651` | 6.72 |
| pastel-peach | `#684531` | 7.22 | `#704f3c` | 6.24 | `#745341` | 5.87 |
| pastel-butter | `#665a33` | 5.83 | `#6f633e` | 5.08 | `#726742` | 4.80 |

Levels 0–1 (neutral/soft sheets, black veil in light / white in dark) also pass:
light hover/active/press = 9.50 / 8.20 / 6.65, dark = 7.45 / 6.28 / 5.90 (and the
tinted level-1 equivalents within 0.1 of those).

### 2.4 `interfaceIntensity` 0–3 mapping (recommendation)

The knob's meaning becomes "how much of the accent the *shell* takes", with the
sidebar reaching **full accent at level 2 — the default** (so
`DEFAULT_APPEARANCE.interfaceIntensity: 2` is untouched and existing users land on
the new look):

| Level | Sidebar sheets | Other neutral surfaces (existing mechanic) |
|---|---|---|
| 0 | flat neutral panel — light `(H 0% 96 / H 0% 90.5)`, dark `(H 0% 16 / H 0% 19.5)`; fg = `--foreground` | `TINT_MUL 0` (desaturated) |
| 1 | soft accent tint = **today's default look** — light `(H 42% 96 / H 50% 90.5)`, dark `(H 34% 16 / H 40% 19.5)`; fg = `--foreground` | `TINT_MUL 0.55` |
| 2 (default) | **full accent** — §2.2 values; fg flips per theme | `TINT_MUL 1` (today's default surfaces) |
| 3 | full accent, same sheets as level 2 | `TINT_MUL 1.5` + tint floors (today's strong tint) |

Level 3 deliberately does **not** push the sheets past level 2: the sidebar is
already at maximum, and darker sheets would break the ink-foreground themes'
contrast (verified: sheet2 at L−12 drops sunset ink to ~4.0). Contrast table for
the level dimension (default theme):

| Level | Light sheet-1 | Light fg | ratio | Dark sheet-1 | Dark fg | ratio |
|---|---|---|---|---|---|---|
| 0 | `207 0% 96%` | `34 9% 19%` | 11.84 | `207 0% 16%` | `0 0% 82%` | 9.53 |
| 1 | `207 42% 96%` | `34 9% 19%` | 11.78 | `207 34% 16%` | `0 0% 82%` | 9.60 |
| 2 | `207 75% 44%` | `0 0% 100%` | 4.58 | `207 47.6% 24%` | `0 0% 93%` | 9.23 |
| 3 | `207 75% 44%` | `0 0% 100%` | 4.58 | `207 47.6% 24%` | `0 0% 93%` | 9.23 |

### 2.5 The desk moves off the sheets

`.ob-desk` (`packages/ui/src/index.css:449`) currently paints the book cover with
`hsl(var(--sheet-1))` — under this spec that would flood the whole desk with accent.
Per owner decision the desk stays a **neutral canvas**: add a `desk` token to
`ThemeTokens` and switch `.ob-desk` to `background-color: hsl(var(--desk))`.

```
desk (light) = 40 11% 93.5%     // the old light sheet-2 neutral — visible cover depth vs white pages
desk (dark)  = 0 0% 11%         // slightly below --background 13% so pages lift off the cover
```

`desk` composes like the other neutrals (hue follows the accent's `NeutralFamily`,
`SURFACE_WEIGHT` 0.85), so warm/cool gray accents keep their temperature on the
cover. Note the titlebar intentionally *keeps* `--sheet-1` (it reads as part of the
sidebar/cover chrome and should carry the accent with it); only `.ob-desk` repoints.

### 2.6 Migration (`normalizeAppearance`, `themes.ts:357-367`)

**No new migration keys.** Existing persisted appearances carry
`interfaceIntensity: 2` (or nothing, merging to the default 2) — they get the
full-accent sidebar automatically. **This is deliberate** (owner decision b): the
new default *is* the new look; users who prefer the old soft panel choose level 1
(exactly today's rendering) or 0. The existing dropped keys (`tint`,
`accentIntensity`, `neutral`, `tintedSidebar`, gray-theme renames) are unchanged.
`normalizeAppearance` gains one validation: drop `dataColors` when it isn't one of
`pastel|vivid|muted` (§4.1).

---

## 3. Contrast audit

Computed with WCAG 2.1 relative-luminance contrast in
[`ob-375-palette-audit.mjs`](./ob-375-palette-audit.mjs). Bar: **≥ 4.5:1** text,
3:1 non-text.

### 3.1 Sidebar foreground-on-sheet-1 (and sheet-2), every theme, light + dark

See the table in §2.2 — it is the audit (values and ratios in one place).
**Result: 68/68 pairs pass.** Per-theme overrides required and given: default /
forest / teal darken sheet lightness (49→44, 38→31, 38→30); sunset,
pastel-lavender, pastel-rose, pastel-peach flip to ink foreground `(H 55% 15%)`.
Hover/active/press washed surfaces: **102/102 pass** (§2.3), worst 4.54
(teal dark press).

### 3.2 Pastel chip fg/bg pairs (the default scheme)

| Token | Light fg/bg | Dark fg/bg |
|---|---|---|
| gray | 8.23 | 9.48 |
| brown | 7.80 | 9.95 |
| orange | 5.40 | 9.36 |
| yellow | 5.89 | 10.39 |
| green | 5.88 | 10.16 |
| blue | 6.14 | 9.14 |
| purple | 6.41 | 9.91 |
| pink | 5.70 | 9.54 |
| red | 5.74 | 9.20 |
| teal | 6.02 | 9.91 |
| cyan | 5.82 | 9.87 |
| indigo | 6.66 | 9.04 |

All pass. (Vivid: light 5.21–8.35, dark 5.08–7.57; Muted: light 5.29–7.77, dark
6.25–6.48 — all pass; full tables re-emitted by the script.)

### 3.3 Fill visibility vs page (non-text, 3:1 reference)

| Token | Pastel / light page | Pastel / dark page | Vivid / light | Vivid / dark | Muted / light | Muted / dark |
|---|---|---|---|---|---|---|
| gray | 1.48 | 10.89 | 2.54 | 6.34 | 3.13 | 5.15 |
| brown | 2.20 | 7.33 | 3.17 | 5.08 | 3.00 | 5.37 |
| orange | 1.69 | 9.55 | 2.80 | 5.74 | 2.99 | 5.38 |
| yellow | 1.32 | 12.21 | 1.92 | 8.40 | 2.50 | 6.44 |
| green | 1.40 | 11.47 | 2.28 | 7.07 | 2.60 | 6.20 |
| blue | 1.80 | 8.93 | 3.68 | 4.38 | 3.37 | 4.78 |
| purple | 1.77 | 9.11 | 3.96 | 4.07 | 3.78 | 4.26 |
| pink | 1.81 | 8.88 | 3.53 | 4.56 | 3.49 | 4.61 |
| red | 1.90 | 8.48 | 3.76 | 4.28 | 3.60 | 4.47 |
| teal | 1.48 | 10.88 | 2.49 | 6.47 | 2.49 | 6.48 |
| cyan | 1.45 | 11.11 | 2.43 | 6.63 | 2.60 | 6.20 |
| indigo | 1.99 | 8.08 | 4.47 | 3.60 | 4.03 | 4.00 |

Fills are large-area shapes, not text; pastel light-mode softness is the scheme's
point and is mitigated by the `--data-stroke` hairline (§1.2). No per-token
override needed.

---

## 4. Storage / API sketch

### 4.1 Appearance model (`packages/ui/src/lib/themes.ts:301-367`)

```ts
export type DataColorScheme = 'pastel' | 'vivid' | 'muted';   // re-exported from sdk

export interface AppearanceOptions {
  themeId: string;
  interfaceIntensity: Level;
  controlIntensity: Level;
  /** Unified data palette for tags, charts, status lights and exports. */
  dataColors: DataColorScheme;                                 // NEW
  blurOverlays?: boolean;
  background?: string;
}

export const DEFAULT_APPEARANCE: AppearanceOptions = {
  themeId: DEFAULT_THEME_ID,
  interfaceIntensity: 2,
  controlIntensity: 2,
  dataColors: 'pastel',                                        // NEW default
  blurOverlays: false,
};

// normalizeAppearance() addition — drop unknown scheme values:
const DATA_COLOR_SCHEMES = new Set(['pastel', 'vivid', 'muted']);
if (out.dataColors !== undefined && !DATA_COLOR_SCHEMES.has(out.dataColors as string))
  delete out.dataColors;
```

Because `AppearanceOverride = Partial<AppearanceOptions>`, per-page overrides of
`dataColors` come for free; the "Data colours" control renders as a third segmented
row in the Appearance settings (and in the per-page `CUSTOMISE_PANE_ID` pane).
Settings sync carries it like every other appearance key — no server change.

### 4.2 Canonical palette module — `packages/sdk/src/dataColors.ts`

The single source, in the **sdk** (sdk already owns `SELECT_COLORS`; ui and the
export pipeline both import `@book.dev/sdk`; nothing new becomes public API of the
server). Plain data, no DOM:

```ts
export type DataColorToken =
  | 'gray' | 'brown' | 'orange' | 'yellow' | 'green' | 'blue'
  | 'purple' | 'pink' | 'red' | 'teal' | 'cyan' | 'indigo';
export type DataColorScheme = 'pastel' | 'vivid' | 'muted';

export interface ChipColors { bg: string; fg: string }
export interface DataColor {
  /** Dot/swatch, chart-series and status-lamp fill (mode-invariant). */
  fill: string;
  chip: { light: ChipColors; dark: ChipColors };
}

export const DATA_PALETTE: Record<DataColorScheme, Record<DataColorToken, DataColor>>;
export const SERIES_ORDER: readonly DataColorToken[];  // §1.1
export const DATA_STROKE = 'rgba(0,0,0,0.12)';         // pastel/muted light-mode hairline

export const seriesColor = (i: number, scheme: DataColorScheme): string =>
  DATA_PALETTE[scheme][SERIES_ORDER[i % SERIES_ORDER.length]].fill;
export const statusColor = (s: 'ok' | 'warn' | 'bad', scheme: DataColorScheme): string =>
  DATA_PALETTE[scheme][({ ok: 'green', warn: 'orange', bad: 'red' } as const)[s]].fill;
```

Deleted once consumers migrate: `SWATCH_HEX`, `CHART_PALETTE`
(`databaseColors.ts` keeps only a thin `chartColor()` that reads the module),
kit `PALETTE` (`chartMath.ts:164`), the `KIT_PALETTE` literal in `kitChart.ts`
(both the const and the copy inside `KIT_CHART_JS`), `COLOR_CLASSES`
(`databaseCells.tsx`), and the status hexes in `index.css` / `toHtml.ts`.

### 4.3 Consumption: CSS variables at runtime, module-inlined at export (**recommendation**)

**Runtime — CSS variables.** `applyAppearance(opts, scheme)` already recomposes on
every theme/mode/override change; it additionally writes, from
`DATA_PALETTE[opts.dataColors]` and the active mode:

```
--data-<token>            fill hex          (12 vars)
--data-<token>-chip-bg    chip bg for the active mode
--data-<token>-chip-fg    chip fg for the active mode
--data-series-1 … -12     SERIES_ORDER fills (aliases, for kit charts)
--data-status-ok|warn|bad status fills (aliases)
--data-stroke             hairline (empty/transparent in vivid + dark)
```

Consumers: chips style `background: var(--data-blue-chip-bg); color: var(--data-blue-chip-fg)`
(replacing Tailwind `COLOR_CLASSES` — inline style or a tiny generated class set);
status lights use `background: var(--data-status-ok)` with
`box-shadow: 0 0 0 3px color-mix(in srgb, var(--data-status-ok) 25%, transparent)`;
SVG charts set fills via `style` (`fill: var(--data-series-1)` — presentation
*attributes* don't resolve `var()`, `style` does).

Why vars over direct imports in components: dark-mode flips and **per-page
appearance overrides** come free (the override pane already re-applies vars on a
page wrapper); direct imports would need scheme+mode prop-drilled into every chip,
dot, board header and chart, including editor-block portals that mount outside
providers ([[editorjs-block-provider-context]] pain).

**Export — direct import, values inlined.** Exports are self-contained HTML/PDF and
must not reference live CSS vars. At export time, resolve the exporting user's
`dataColors` scheme and inline:

- `kitChart.ts`: `KIT_CHART_JS` drops its baked `KIT_PALETTE` line; the export
  prepends `const KIT_PALETTE=${JSON.stringify(SERIES_ORDER.map((t) => DATA_PALETTE[scheme][t].fill))};`
  both when inlining the HTML runtime and when `new Function`-ing for PDF — one
  source, still no drift.
- `toHtml.ts` status CSS interpolates `statusColor('ok'|'warn'|'bad', scheme)` (ring
  = the same hex at 25 % alpha, precomputed rgba).
- Chip/dot renderers in the export document model take `chip.light` values (exports
  are light-styled) and the fill hexes directly.

---

## 5. Open questions (each with recommended answer)

1. **Series starts blue-first** (db `CHART_PALETTE` precedent) rather than
   indigo-first (kit precedent) — existing kit charts' first series changes from
   indigo to blue even in Vivid. *Recommend: yes, blue-first* (conventional, and the
   db charts are the user-visible majority).
2. **Vivid `orange` shifts `#f59e0b` → `#f97316`** (and therefore the `warn` lamp,
   and `ok` `#10b981` → `#22c55e`). *Recommend: accept* — it unifies dot/chip/chart
   hue families; Vivid remains "≈ today", not "bit-identical to today".
3. **Status lamps follow the scheme** (pastel lamps under the default). *Recommend:
   yes* (that is the unified-palette decision), with the ring + light-mode hairline
   keeping them legible; fallback if the owner dislikes pastel lamps: pin the status
   role to Vivid fills — one-line change in the module.
4. **Gray accents get a charcoal full-accent sidebar in light mode** (§2.1).
   *Recommend: yes* — it is the honest meaning of "full intensity" for an ink-gray
   accent, and levels 0/1 keep the light-panel option.
5. **Default theme's sidebar darkens its blue L 49 → 44** so white text passes.
   *Recommend: accept* (alternative — ink fg on the brand blue — reads worse next to
   the white-on-blue primary buttons).
6. **Editor text/highlight colours stay out of scope** (§1.6). *Recommend: out.*
7. **`SELECT_COLORS` stays at 9** — teal/cyan/indigo are not offered as tag colours
   for now. *Recommend: keep 9*; adding them later is a purely additive sdk change.
8. Task brief said 19 accent themes; `themes.ts` has **17**. Assumed brief typo —
   flagging in case two themes were expected to land before implementation.

## 6. Acceptance criteria for the implementation issues

1. **Palette issue:** `packages/sdk/src/dataColors.ts` matches §1 exactly; the five
   legacy lists deleted; `dataColors` control + persistence per §4.1; chips/charts/
   status read the vars of §4.3; screenshots in all three schemes × both modes.
2. **Sidebar issue:** `composeAppearance` implements §2.1–§2.4 including the
   per-theme override table verbatim (encode the table, don't re-derive at runtime);
   `sidebarStyles.ts` replaced per §2.3; `--desk` per §2.5; Chromatic coverage for
   the 7 audited archetypes (default, graphite, ocean, sunset, amber, pastel-butter,
   pastel-lavender) × light/dark × levels 0–3.
3. **Export issue:** exported HTML/PDF colour-identical to the in-app render for a
   doc containing tags + kit chart + db chart + status lights, in each scheme.
