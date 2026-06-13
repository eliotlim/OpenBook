# TODOS

Post-v0 follow-ups surfaced during `/office-hours` (2026-05-27) and `/plan-eng-review` (2026-05-27) on the OpenBook v0 design (`~/.gstack/projects/eliotlim-open-book/eliot-main-design-20260527-141226.md`).

## T1 — Swap `new Function()` for QuickJS sandbox

**What:** Replace the v0 expression evaluator (`new Function('store', '...')` in `packages/ui/src/reactive/compile.ts`) with a sandboxed evaluator (likely `quickjs-emscripten`).

**Why:** v0 uses `new Function()` which has full access to globals. Safe for a single-user local app where the only code in expression blocks is code the user wrote themselves. The moment ANY shared doc opens (even read-only sharing, AI-generated expressions, or imported `.openbook` files from elsewhere), `new Function()` is a code-execution vulnerability. This is the load-bearing migration if collab or sharing ever lands.

**Pros:** Sandbox-safe expression eval; enables shared/imported docs without trusting their authors; required for any v1 collab feature.

**Cons:** WASM init is async; value marshalling across the WASM boundary is fiddly; ~1MB added to the bundle.

**Context:** The v0 `compile()` function is already written with an async-friendly signature `(store) => Promise<unknown> | unknown` (see plan-eng-review Issue 1E) specifically so the swap to QuickJS is a one-file change. All ExprBlock effects already `await Promise.resolve(...)` on the result. Eureka logged in office-hours: Signals' dependency tracking cannot cross the WASM boundary, so the QuickJS implementation will need to statically extract cellId references from the source string before eval and pass values in as primitives — not rely on store-call interception inside the sandbox.

**Depends on / blocked by:** Triggered when any of: (a) collab feature lands, (b) `.openbook` artifact import lands, (c) AI-generated expressions become a feature.

---

## T2 — Cell garbage collection sweep

**What:** Add a sweep that drops Signal objects for cellIds no longer referenced by any block in the current document.

**Why:** v0 `deleteCell` deliberately keeps the Signal object alive forever (per plan-eng-review Issue 1D) to avoid subscription leaks under React StrictMode. This is correct for v0 but means Signals accumulate over the life of a document. With hundreds of cells across multi-doc, this becomes real memory.

**Pros:** Bounded memory growth; cleaner snapshot output (no zombie cellIds).

**Cons:** Sweep timing is tricky — must run AFTER all blocks have mounted and registered, not during a transition. Easiest hook is a "document fully loaded" event followed by a `setTimeout(0)` sweep.

**Context:** The bug class to avoid is "sweep runs while a block is unmounted mid-rerender and the cellId looks orphaned." Mitigation: only sweep cellIds with no subscribers AND not present in the EditorJS block list AND no recent activity.

**Depends on / blocked by:** Not blocking; runs whenever it bothers the user. Probably triggered by multi-doc landing (T5).

---

## T3 — Cross-document reactive references (THE long-term wedge)

**What:** Implement `@docName.cellName` (or chosen syntax) syntax in ExprBlock expressions, allowing one document to reference cells in another document in the vault. References resolve through the same lazy-create + Signals subscribe pattern v0 uses for intra-doc.

**Why:** This is the actual moat per cross-model second opinion: *"a personal computational substrate, not a notes app with toys."* Nothing in the OSS notes / notebook landscape ships this. Mainstream block editors can't do it. Observable can't do it across notebooks. Obsidian Dataview is read-only and not reactive.

**Pros:** The differentiator that justifies OpenBook existing at all in v1+. A household dashboard page that imports rent.total from one doc, grocery.weekly from another, kWh.monthly from a third — and recomputes live when any of them change — is a demo nobody else can give.

**Cons:** Requires multi-doc persistence (T5) to be meaningful. Requires designing a stable cross-doc identifier (probably `docId.cellId`, both stable UUIDs, with `docName.cellName` as the display sugar). Cycle detection across documents adds graph complexity.

**Context:** Open Question #5 in the v0 design doc tabled the syntax choice. Office-hours session committed to this as the v1 wedge. Currently OpenQuestion in design doc.

**Depends on / blocked by:** Multi-doc persistence (T5) must land first.

---

## T4 — Full rename UX (source rewrite + cursor-preserving contenteditable)

**What:** When a cell is renamed, automatically update the displayed name in all ExprBlock token spans across all blocks (v0 already does this, see Saturday PM spec) AND preserve cursor position in any ExprBlock the user is currently editing (v0 ships WITHOUT cursor preservation — outside voice finding #1, deferred to v1 per plan review).

**Why:** v0 ships with the cursor-jumps-to-start bug when a rename happens elsewhere mid-edit. Acceptable for personal use where renames are infrequent, but every active collab session would hit this constantly.

**Pros:** Smooth editing UX during collaborative or even busy solo sessions.

**Cons:** Real `contenteditable` plumbing — Range/Selection save+restore around the re-render, IME composition handling, Safari/WKWebView quirks where selection APIs diverge from Chromium. Budget 2 hours alone per outside voice estimate.

**Context:** v0 Saturday PM spec includes the token-rendering pipeline. Adding cursor preservation = wrapping the innerHTML swap in `getSelection().getRangeAt(0)` capture-then-restore with explicit text-node-offset translation. WKWebView is the macOS Tauri target; testing needs to happen there, not just in Chrome dev.

**Depends on / blocked by:** Triggered when collab lands OR when v0 use surfaces the rename pain enough to warrant the fix.

---

## T5 — Multi-document persistence + `.openbook` portable artifact format

**What:** Support more than one document per vault. Each document is a separate `.openbook` file (the portable artifact format suggested by the cold-read second opinion in office-hours). The vault is a directory; the app reads/writes individual files.

**Why:** v0 is single-doc, single-file. The user's actual use case is household management with his wife — that's many notes (rent calc, grocery budget, vacation planning), each potentially with reactive blocks. Multi-doc is required for the vault concept and for cross-doc references (T3).

**Pros:** Enables T3 (the real wedge). Enables sharing individual documents as standalone files (Approach C from the original alternatives). Sets up the architecture for v1 collab.

**Cons:** Document-routing UX (sidebar tree, recent files, file browser inside the app). Cell-scoping question (Open Question #4 in design doc): are cellIds per-document or per-vault? Cross-doc references need vault-scoped IDs.

**Context:** Approach C from the original alternatives — the cold-read second opinion's preferred direction (artifact-as-product). Deferred from v0 to keep the weekend bounded.

**Depends on / blocked by:** v0 ships and is dogfooded for at least 1 week on a real interactive report; only then commit to v1.

---

## T6 — Editor undo/redo (block-level)

**What:** ⌘Z/⇧⌘Z across block operations (delete/move/insert/convert). Today only the browser's native per-block contenteditable undo exists; deleting or moving a block is irreversible.

**Why:** Undo is a baseline editor trust feature — its absence is the largest remaining interaction gap after the 2026-06-10 polish pass.

**Pros:** `editorjs-undo` exists and pairs with the already-used `editorjs-drag-drop`.

**Cons / landmines:** The plugin restores snapshots via a full `editor.render()` — exactly the remount-everything path `liveSync`'s diff renderer was built to avoid (reactive blocks re-run side effects → save-loop risk, ARCHITECTURE §4). It also restores state programmatically, so `userEditedRef` (which gates autosave on genuine `input`/`beforeinput` events) would treat the undone state as not-an-edit and never persist it. A correct integration likely means a custom history stack that replays through `planBlockSync` instead of `render`, and an explicit "undo counts as a user edit" hook into the autosave gate.

**Depends on / blocked by:** Nothing external; needs a focused session with the reactive save-loop e2e (`reactive.spec.ts`) as the regression gate.

---

## T7 — Localize the database UI strings

**What:** The database surface (toolbar Search/Filter/Sort/View, property type names, summary labels, menu items in `DatabaseView.tsx` / `databaseMenus.tsx` / `databaseCells.tsx` / `databaseLayouts.tsx`) is hardcoded English; only the app chrome goes through the `t()` catalogs.

**Why:** With the chrome catalogs now complete (de/ja/zh filled 2026-06-10), a German UI is consistent until you touch a database — then every control flips to English.

**Pros:** Mechanical extraction; the i18n plumbing already exists.

**Cons:** Several hundred strings across four large files; e2e specs assert many of these literals (`getByRole('button', {name: 'Filter'})` etc.) and would need `t()`-aware fixtures or English-locale test runs.

**Depends on / blocked by:** Nothing; best done as one focused mechanical PR with the Playwright suite pinned to English.

---

The next four (T8–T11) are the June-2026 feature slate. Decisions captured interactively with the owner; full design in `docs/feature-design-2026-06.md`.

## T8 — Database map view

**What:** A `map` database view. Leaflet + OpenStreetMap raster tiles. Markers from a new first-class `location` property type (lat/lng + optional label/address) AND optional geocoding of an existing address text property. Markers colored by a group-by property (legend) with clustering at low zoom; click → row card.

**Why:** Geographic data (places, trips, assets, field notes) has no spatial view today; only an abstract `location` kit *input* exists, not a database property or view.

**Pros:** Leaflet needs no API key; reuses `groupRowsBy` for color/legend; coordinate shape matches the existing location kit input.

**Cons:** Leaflet injects its own stylesheet (CSS-clobber trap) and isn't React-native; geocoding is a network call so it must be opt-in + cached to honor local-first.

**Context:** 5 view touch points (`DatabaseViewType`, `VIEW_TYPES`, new `databaseMap.tsx`, `ViewBody` switch, `viewTypePatch`); new `'location'` `DatabasePropertyType`; `geoPropertyId`/`addressPropertyId` on `DatabaseView`. See design doc §1.

**Depends on / blocked by:** Nothing; geocoding cache wants a server endpoint + table.

---

## T9 — Sub-grouping (swimlanes) for board & timeline

**What:** Add a second grouping dimension. Board: horizontal swimlanes (columns = primary group, lanes = sub-group, Notion model), collapsible. Timeline: Gantt swimlane bands by `groupByPropertyId` (timeline has no grouping today), collapsible.

**Why:** Single-level grouping forces flat boards and a single undifferentiated timeline track; teams want e.g. status × assignee, or a timeline banded by workstream.

**Pros:** Board already grids by group; timeline already lays bars by date — both extend rather than rewrite. New `subGroupByPropertyId` field keeps it distinct from chart `breakdownPropertyId`.

**Cons:** Board card DnD must write two property values in one transaction (column + lane); collapsed-lane state needs persisting.

**Context:** `BoardView` (`databaseLayouts.tsx` ~288), `TimelineView` (`databaseTimeline.tsx` ~269), `ViewOptionsMenu` pickers (`databaseMenus.tsx` ~1441). See design doc §2.

**Depends on / blocked by:** Nothing.

---

## T10 — New interactive kit components

**What:** Eight new artifact-kit components: choice cards (image-cover radio cards, multi-select capable; image via URL-or-upload per option), accordion checklist sections (container, auto-computed completion + optional stage gating), tabs with completion (container, same gating), progress bar (display computed from an expression), long text AND rich text (two components), searchable select/multi-select (static + dynamic-binding options), tag field (free-entry + suggestions, toggleable). All inputs are full reactive citizens (publish into `inputScope`, var-name override, group namespacing).

**Why:** The current kit (radio/checklist/dropdown/toggle/number/text/location + charts/status/cards) can't express image choices, staged/wizard flows, progress, searchable pickers, tags, or long-form input.

**Pros:** Reuses kit anatomy (KitFrame/KitSettings/KitInlineText), the group container infra (tabs/accordion), `inputScope`/`evalExpr` dataflow, and `components/ui/command.tsx` for search.

**Cons:** Containers add nesting/DnD complexity; rich-text publishes markup that the export tokenizer and `evalExpr` must handle; image upload reuses the files mechanism.

**Context:** `kit/inputs.tsx`, `kit/cards.tsx`, `kit/scope.ts` (`INPUT_TYPES` + `inputValue`), `SlashMenu.tsx` `TYPE_ICONS`, `OptionsEditor`. Slash e2e matches `.obe-slash-label`. See design doc §3.

**Depends on / blocked by:** Container components lean on the existing group block (memory `blockeditor-groups`).

---

## T11 — AI harness v2 (tools, thinking, effort, skills)

**What:** (a) Tool-calling to inspect pages (block tree, kit values, DB rows) and update controls (kit values, DB cells, blocks) — writes behind a preview-and-confirm gate applied via the editor bridge in one CRDT transaction. (b) Thinking: auto-detect `<think>` tags (Qwen-QwQ/DeepSeek-R1), scratchpad fallback otherwise, streamed as collapsible reasoning. (c) Effort knob (low/med/high) → thinking budget + sampling + agent step cap. (d) Skills: both user-authored prompt/recipe skills (per-workspace markdown) and plugin-registered tool skills. Still local models only.

**Why:** The agent today is text-only (5 read/append tools), no thinking, no effort control, no skills, and can't touch blocks/cells/kit values — so it can't actually operate the workspace.

**Pros:** JSON-protocol loop + SSE streaming + provider abstraction already exist; `aiBridge` already injects capabilities into the editor without coupling.

**Cons:** Block-level writes need new CRDT mutation paths (`appendTextToSnapshot` returns null for block-editor pages today); confirm-gate is real UI; native tool-calling support varies across local endpoints (fall back to JSON).

**Context:** `packages/server/src/ai/{agent,providers,routes,service}.ts`, `packages/sdk/src/ai.ts`, `AgentPanel.tsx`/`aiBridge.ts`, MCP parity (`packages/mcp`). See design doc §4.

**Depends on / blocked by:** Write tools for kit values (T10) and DB cells (T8/T9) are richer once those land, but read tools + thinking/effort/skills are independent.
