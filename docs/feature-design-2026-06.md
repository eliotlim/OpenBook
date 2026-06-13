# Feature design — June 2026 slate

Design + decisions for four feature areas requested 2026-06-13, captured here for
future implementation. Decisions were made interactively with the owner; this doc
is the source of truth and `TODOS.md` T8–T11 point at the relevant sections.

Areas:

1. [Database map view](#1-database-map-view) — `T8`
2. [Sub-grouping (swimlanes) for board & timeline](#2-sub-grouping-for-board--timeline) — `T9`
3. [New interactive kit components](#3-new-interactive-kit-components) — `T10`
4. [AI harness v2 — tools, thinking, effort, skills](#4-ai-harness-v2) — `T11`

All file paths are relative to the repo root. Line numbers are approximate
(captured 2026-06-13) — treat them as "look near here," not exact.

---

## 1. Database map view

### Decisions

| Question | Decision |
|----------|----------|
| Map engine | **Leaflet + OpenStreetMap raster tiles.** No API key, works out of the box. Accepts network fetch of tiles at view time. |
| Coordinate source | **Both:** a new first-class `location` property type (lat/lng + optional label/address) **and** optional geocoding of an existing text/address property to populate it. |
| Marker styling | **Color markers by a group-by property** (select/status) with a legend, **plus clustering** at low zoom for dense datasets. Click a marker → row card preview. |

### Data model

- Add `'location'` to `DatabasePropertyType` in `packages/sdk/src/database.ts` (~line 44).
  Stored cell shape: `{lat: number, lng: number, label?: string, address?: string}`.
  Reuse the same value shape as the existing `location` **kit input** (see
  `kit/scope.ts` `inputValue()`) for consistency.
- Add view config fields to the `DatabaseView` interface (`database.ts` ~line 331):
  - `geoPropertyId?: string` — which location property places markers.
  - `addressPropertyId?: string` — optional text property to geocode into coords.
  - Reuse existing `groupByPropertyId` for marker color/legend.
- Geocoding: server-side endpoint (`packages/server`) that proxies a geocoder and
  **caches results** (address → coords) so repeated views don't re-hit the network.
  Keep it optional and behind explicit user action (the local-first ethos — no
  silent network calls). Cache in the `settings`/a dedicated table.

### View registration (5 touch points)

1. `packages/sdk/src/database.ts` ~199 — add `'map'` to `DatabaseViewType`.
2. `packages/ui/src/components/database/databaseMenus.tsx` ~211 — add to `VIEW_TYPES`
   (icon: `MapPin` from lucide).
3. New file `packages/ui/src/components/database/databaseMap.tsx` — `MapView`
   component with the standard signature `{db, view, properties, cardProperties}`.
   Reads `db.visibleRows`; calls `groupRowsBy(db.visibleRows, view.groupByPropertyId, schema)`
   for marker coloring/legend.
4. `packages/ui/src/components/database/DatabaseView.tsx` `ViewBody` switch (~950) —
   import + `case 'map'`.
5. `databaseMenus.tsx` `viewTypePatch()` (~1789) — on switch to `map`, auto-pick the
   first `location` property as `geoPropertyId`. Add map-specific options to
   `ViewOptionsMenu` (~1441): geo property picker, optional address-geocode picker,
   group-by (reuse), clustering toggle.

### Implementation notes

- Leaflet is not React-aware; wrap in an effect-driven component (or `react-leaflet`).
  Lazy-load Leaflet + CSS so non-map views don't pay the bundle cost. Watch the
  EditorJS CSS-clobber trap (see memory `editorjs-css-clobber-traps`) — Leaflet
  injects its own stylesheet; scope it so it doesn't fight app styles.
- Marker color comes from the group option swatch (`databaseColors.ts` `SWATCH_HEX`).
- Clustering: `leaflet.markercluster` or a lightweight grid cluster. Color clusters
  by dominant group; expand on zoom.
- Marker click opens the existing row card/preview (same affordance other views use).
- Rows with no resolvable coordinates: list them in an "unplaced (N)" affordance
  rather than dropping silently.

---

## 2. Sub-grouping for board & timeline

### Decisions

| Question | Decision |
|----------|----------|
| Board layout | **Swimlanes (horizontal lanes).** Columns = primary group, each lane = a sub-group value spanning all columns (Notion model). Lanes collapsible, remember collapsed state. |
| Timeline layout | **Swimlanes (Gantt rows).** Each group is a labeled horizontal band; bars placed by date within their band. Bands collapsible. |

Today: board does single-level `groupByPropertyId`; timeline has **no** grouping.
Only bar/pie charts have a second dimension (`breakdownPropertyId`).

### Data model

- Add `subGroupByPropertyId?: string` to `DatabaseView` (`database.ts` ~331).
  Do **not** overload `breakdownPropertyId` — keep chart breakdown and board/timeline
  sub-grouping as distinct fields (different semantics, avoid confusing the menus).
- For timeline grouping, reuse `groupByPropertyId` (it's currently unused by timeline).

### Board (`databaseLayouts.tsx` `BoardView` ~288)

- Primary `groupRowsBy(db.visibleRows, view.groupByPropertyId, properties)` → columns.
- When `subGroupByPropertyId` set: within the rows, compute sub-groups and render
  one horizontal lane per sub-group value. Each lane shows the same column set,
  filtered to that lane's rows. Lane header on the left with collapse chevron + count.
- Empty-lane handling honors `hideEmptyGroups`.
- DnD: dropping a card into a (column, lane) cell sets **both** the primary and the
  sub-group property values. Reuse existing card-move logic; extend to write two
  property values in one transaction.

### Timeline (`databaseTimeline.tsx` `TimelineView` ~269)

- After the existing date layout, group the laid-out bars by `groupByPropertyId`.
- Render a labeled band per group (collapsible); bars positioned by date within band.
- Add a "Group by" picker to `ViewOptionsMenu` gated on `view.type === 'timeline'`.

### Menu UI (`databaseMenus.tsx` `ViewOptionsMenu` ~1441)

- Show "Sub-group by" for `board` (only once `groupByPropertyId` is set).
- Show "Group by" for `timeline`.
- Reuse the existing group-property picker component.

---

## 3. New interactive kit components

Eight new components in `packages/ui/src/blockeditor/kit/`. All follow the existing
kit anatomy: CRDT-backed `blockProp`/`setBlockProp`, `KitFrame` chrome, `KitSettings`
gear → popover → side-pane, `KitInlineText` for inline labels, slash registration via
`CustomBlockDef` under `group: 'interactive'`.

### Cross-cutting decisions

- **Reactivity:** All new **inputs** are full reactive citizens — publish `name→value`
  into `inputScope`, support variable-name override + group namespacing
  (`group.field.value`), and work in charts/formulas/exports. Wire each new input
  type into `kit/scope.ts`:
  - add the type to `INPUT_TYPES`,
  - add a case in `inputValue()` returning its value,
  - rely on `publishedName()` / `varNameFromLabel()` for the symbol.
- **Containers vs widgets:** Tabs and accordion are **true container blocks** (hold
  arbitrary child blocks, like the existing `group` block). Reuse the group container
  infrastructure (child block storage, DnD, lock context). See memory
  `blockeditor-groups` and `blockeditor-artifact-kit`.

### 3.1 Choice cards

Radio cards with an image cover; **multi-select capable**.

- Props: `name`, `label`, `description`, `opts: {label, value, image?, icon?, color?}[]`,
  `value` (single) or `selected: string[]` (multi), `multi: boolean`, `compact`.
- Image source decision: **URL or upload per option.** Each option image is a pasted
  URL **or** an uploaded/attached file (reuse the `files` mechanism). Fallback to a
  chosen icon/emoji or color block when no image.
- Publishes `string` (single) or `string[]` (multi) — mirror radio/checklist value rules.
- Settings: extend `OptionsEditor` (`kit/`) to add per-option image/icon/color fields
  and a multi-select toggle.

### 3.2 Accordion checklist sections (container)

Collapsible sections that group child blocks and **hide components through stages**.

- Container block: each section = `{label, children[]}`; sections collapsible.
- **Completion decision: auto-computed from contents + optional gating.** A section's
  completion derives from its contained inputs/checklist (e.g. all required filled).
  A per-container **gating toggle** locks later sections until prior ones complete
  (wizard flow). When ungated, sections are freely expandable and just show progress.
- Exposes a read-only completion signal per section and overall (for progress bars /
  formulas) — see §3.4 + §3 reactivity.

### 3.3 Tabs with completion (container)

- Container block: tabs = `{label, children[]}[]`; each tab holds arbitrary blocks.
- Per-tab **auto-computed completion** (checkmark/▸ N/M on the tab) from contained
  inputs. Optional **gating**: later tabs locked until earlier complete (wizard).
- Exposes completion reads like the accordion.

### 3.4 Progress bar

- **Display, computed from an expression** (like charts/status) — reads an expression
  over `inputScope` and renders a percentage. Does **not** publish a value.
- Common binding: a tab/accordion completion signal, or any `evalExpr` result.
- Props: `label`, `source` (expression), `max` (default 100), `format` (%/fraction).

### 3.5 Long text — **two components**

Owner chose to build both:

- **`longtext`** — plain auto-growing textarea; publishes a plain `string`. Keeps
  expressions/export simple and predictable.
- **`richtext`** — bold/italic/lists/links via the block editor's inline formatting;
  publishes markup (and a plain-text projection for `evalExpr`/export). More authoring
  power; export tokenizer must handle the markup.

### 3.6 Searchable select / multi-select dropdown

- Search box over options; single or multi-select (toggle). Multi publishes `string[]`,
  single publishes `string`.
- **Options source: static + dynamic binding.** Author-defined static list **or**
  options pulled from another input's value / a comma-expression over `inputScope`.
- Build on `components/ui/command.tsx` (Radix Command) for the searchable surface.

### 3.7 Tag field

- **Free entry + suggestions, toggleable.** A setting decides whether free entry is
  allowed; suggested/previously-used tags autocomplete. Publishes `string[]`.
- When free entry is off it degrades to a searchable multi-select over a fixed list
  (shares machinery with §3.6).

### Registration per component

For each: add to the relevant `*_BLOCKS` array (`inputs.tsx` / new file), give it a
`render`, a `slash` entry (label/hint/keywords/make) under `group: 'interactive'`, a
`TYPE_ICONS` entry in `SlashMenu.tsx` (~97), and (for inputs) the `kit/scope.ts` wiring
above. Slash e2e must match `.obe-slash-label` exactly (memory `blockeditor-artifact-kit`).

---

## 4. AI harness v2

Server-side AI lives in `packages/server/src/ai/` (`service.ts`, `providers.ts`,
`agent.ts`, `routes.ts`, `search.ts`); SDK contracts in `packages/sdk/src/ai.ts`; UI in
`packages/ui/src/components/{AiSettings,AgentPanel,AiBridgeHost}.tsx` +
`lib/aiBridge.ts`. **Staying on local models** (llama.cpp / MLX / OpenAI-compatible).

### Decisions

| Question | Decision |
|----------|----------|
| Thinking | **Auto-detect `<think>…</think>` + scratchpad fallback.** If the model emits think tags (Qwen-QwQ, DeepSeek-R1…), parse and stream them as collapsible reasoning. Otherwise prompt a structured scratchpad we parse out. Works on any local model. |
| Effort | **One knob → thinking budget + sampling + step cap.** low/med/high maps to max thinking/answer tokens, temperature, and the agent's max tool-call steps. |
| Write safety | **Preview + confirm before applying.** Agent proposes writes (kit values, DB cells, blocks); user sees a diff/summary and approves before anything changes. |
| Skills | **Both.** User-authored prompt/recipe skills (per-workspace markdown, no code) **and** plugin-registered tool-backed skills (via the existing extension system). |

### 4.1 Thinking + effort

- Extend `GenerateOptions` (`providers.ts`) with `thinkingBudget?: number`,
  `effort?: 'low'|'med'|'high'`. Map effort → `{thinkingBudget, temperature, maxTokens,
  maxSteps}` in one place.
- Streaming: detect `<think>` / `</think>` boundaries in the token stream; route
  reasoning tokens to a separate `AiStreamEvent` channel (`thinking` vs `answer`) so the
  UI renders reasoning as a collapsible block. Add the event variant to
  `packages/sdk/src/ai.ts`.
- Scratchpad fallback: when no think tags appear, prompt the model to emit a delimited
  scratchpad (e.g. `### reasoning … ### answer`) and split server-side.
- `AgentRunner` (`agent.ts`): `MAX_STEPS` (~26) becomes effort-driven.

### 4.2 Tools — inspect pages & update controls

Current: JSON-protocol loop, 5 read/append text tools, `parseAction()` (~133).

- Keep the JSON-protocol loop (reliable across all local models); **use native
  OpenAI-style tool-calling when the endpoint advertises it, fall back to JSON.**
  (Implementation default — not separately confirmed; revisit if it complicates.)
- New **read** tools: `inspect_page_structure` (block tree, not just text),
  `get_kit_values` (named inputScope values for a page), `get_db_row`/`list_db_views`.
- New **write** tools (all behind the confirm gate, §4.3): `set_kit_value`,
  `set_db_cell`, `update_block`, `create/append` for block-editor pages (today
  `appendTextToSnapshot` returns null for block-editor pages — extend it to apply a
  CRDT transaction).
- The write path must reach the block editor's CRDT. `lib/aiBridge.ts` already injects
  capabilities into the editor without coupling — extend the bridge with mutation
  methods the agent's write tools call, rather than mutating snapshots server-side.
- Expose the same new tools via the MCP server (`packages/mcp/src/server.ts`) for parity.

### 4.3 Write safety — preview + confirm

- Write tools don't mutate immediately; they enqueue a **proposed change set**
  (block/cell/value diffs) returned to the UI.
- `AgentPanel.tsx` renders a diff/summary card; user approves → apply via the bridge in
  one CRDT transaction (undoable). Reject → discard.
- Batch multiple writes from one agent turn into a single approval where sensible.

### 4.4 Skills

- **Prompt/recipe skills:** markdown files (name + description + instructions) stored
  per-workspace (a `skills` table or a workspace folder). The agent lists available
  skills in its system prompt and can "invoke" one (inlines its instructions). Editable
  by the user, no code. Mirror Claude-Code's skill ergonomics.
- **Plugin tool skills:** let plugins (`packages/ui/src/plugins/`, `/api/plugins`)
  register agent tools/actions, surfaced to `AgentRunner` alongside built-ins. Signing
  ≠ sandbox caveat applies (memory `plugin-extension-system`).
- Skill discovery feeds the system prompt catalogue (`agent.ts` `systemPrompt()` ~112).

### Open implementation defaults (not separately confirmed)

- Native-tool-calling-with-JSON-fallback (4.2) — chosen by me; flag if undesired.
- Skill storage location (table vs workspace folder) — pick during implementation.

---

## Verification (all areas)

Per memory `design-system`: `pnpm verify` + `pnpm test:e2e:web` (Playwright) +
`pnpm chromatic`. Use `components/ui` primitives + `ReactiveCard`/`FieldRow`, never
ad-hoc inline styles. Reactive/save-loop regressions are guarded by `reactive.spec.ts`;
respect the diff-render rule (ARCHITECTURE §4, memory `editorjs-reactive-blocks-loop`).
