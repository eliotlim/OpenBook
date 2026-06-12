# OpenBook architecture

OpenBook is a local-first, block-based document workspace: a block editor with
nested pages, databases, and **reactive blocks** (spreadsheet-like cells, formulas
and charts that recompute live). It ships as a Tauri desktop app and a Next.js web
app over the same UI and the same server.

This document is the map: how the layers fit together, how data flows, and the
non-obvious traps (mostly the desktop WKWebView) that the tests guard against.

---

## 1. Monorepo layout

A pnpm workspace (`pnpm@10`, `packages/*`). Strict dependency direction — arrows
point at what a package depends on:

```
app (Tauri)  ─┐
              ├─► ui ─► sdk
web (Next.js)─┘        ▲
                server ┘   (server also depends on sdk for the shared contract)
                mcp ───┘   (the MCP server is another sdk client, over HTTP)
```

| Package | Role |
|---------|------|
| **`@open-book/sdk`** | The contract: TypeScript types (`StoredPage`, `PageSnapshot`, `DatabaseSchema`, …), the route table (`API`), `HttpDataClient` (the isomorphic `fetch` client), and the shared content helpers (`snapshotText`, `textSnapshot`, …). No React, no Node. |
| **`@open-book/server`** | `PageStore` (all SQL) + a Hono HTTP API + a `PageHub` (in-memory pub/sub for live updates). Runs over **embedded PGlite** (desktop/local) or **external Postgres** (headless). |
| **`@open-book/ui`** | The React app: the EditorJS document, reactive blocks, the sidebar tree, providers, and the design primitives (`components/ui/*`). Consumed as a built library. |
| **`@open-book/app`** | The Tauri desktop shell. Spawns the server as a sidecar and points the UI at it. |
| **`@open-book/web`** | The Next.js web shell. Talks to a deployed server. Hosts the Playwright e2e + Chromatic config. |
| **`@open-book/mcp`** | A stdio [MCP](https://modelcontextprotocol.io) server (`openbook-mcp`) exposing the workspace to external agents (Claude Desktop/Code) as tools, over `HttpDataClient`. See its README. |

---

## 2. Data flow

```
React components
   │  (useNavigation / useData)
   ▼
HttpDataClient  ──HTTP──►  Hono routes  ──►  PageStore  ──SQL──►  PGlite | Postgres
   ▲                          │
   └───────  SSE  ◄───────  PageHub   (every write publishes; clients re-fetch/patch)
```

- **Reads/writes** go through `HttpDataClient` (`packages/sdk/src/client.ts`) →
  the Hono routes (`packages/server/src/app.ts`) → `PageStore`
  (`packages/server/src/store.ts`) → the `Db` interface (PGlite or Postgres,
  `packages/server/src/db.ts`).
- **Live updates**: every mutating route publishes to `PageHub`
  (`packages/server/src/hub.ts`) and the SSE endpoint relays the events. Clients
  subscribe via `client.subscribePage` / `subscribePages` and apply the snapshot.
- **API responses are `Cache-Control: no-store`** (a middleware on `/api/*`). The
  desktop WKWebView otherwise serves stale GETs from its URL cache (see §7).

### Desktop vs web

| | Desktop (`@open-book/app`) | Web (`@open-book/web`) |
|--|--|--|
| Shell | Tauri (macOS WKWebView / WebView2) | Browser (Next.js) |
| Server | **Bundled sidecar** binary (Bun-compiled, embedded PGlite), spawned by the Rust host at `127.0.0.1:4319` | A deployed `@open-book/server` (external Postgres), URL via `NEXT_PUBLIC_OPENBOOK_SERVER` |
| Data | Local-first, offline (`~/Library/Application Support/dev.book.open`) | Network |
| In `tauri dev` | The server is **run by `pnpm dev`**, not the host (see `app/src-tauri/src/main.rs`) | `next dev` |

> **Sidecar staleness trap.** The desktop UI and its server are built separately.
> A release build runs the *bundled* sidecar binary (`build:sidecar`); pulling new
> code without rebuilding it leaves the app on an old server. If a desktop bug
> contradicts the current server source, suspect a stale sidecar first.

---

## 3. Data model

One table, `pages`, models everything (`packages/server/src/store.ts`):

```ts
StoredPage = {
  id: UUID;
  name: string | null;          // unique among *live* pages
  data: PageSnapshot;           // the document (see below)
  parentId: UUID | null;        // nesting → sidebar tree
  databaseId: UUID | null;      // set ⇒ this page is a row of that database
  hostedDatabaseId: UUID | null;// set ⇒ this page hosts a database (1:1)
  properties: Record<string, unknown>; // a database row's column values
  deletedAt: ISO | null;        // soft delete (the trash)
  createdAt; updatedAt;
}

PageSnapshot = {
  editorjs: OutputData;            // the EditorJS blocks
  values: [cellId, value][];       // reactive cell values
  names:  [name, cellId][];        // reactive cell name → id
}
```

- **Nesting**: a page's `parentId` builds the sidebar tree (`buildTree` in
  `WorkspaceNavigationTree.tsx`). `upsertPage` writes `parent_id` only on insert,
  so a content save never detaches a page from its parent.
- **Databases**: a database is owned 1:1 by a host page. Its **rows are pages**
  tagged with `database_id` (excluded from the sidebar list, listed via the
  database APIs). Reactive cell values are projected into row columns (`exports`);
  a row's `parent_id` can point at another row, giving **sub-items**.

#### Database feature surface

The database is full-featured. The pure model + evaluation lives in
`packages/sdk/src/database.ts` (and the formula engine in `formula.ts`); the UI is
`packages/ui/src/components/database/*` plus the page-view panel
(`DatabaseRowProperties.tsx`) and the inline editor block (`editor/blocks/DatabaseBlock.ts`).

- **Property types** — text, number (formats incl. $/€/£/¥/₹ and **show-as
  bar/ring** scaled to a target), **rating** (clickable stars), select, multi-select,
  **status** (lifecycle groups), checkbox, date (single, **start–end range**, **with
  time**, and **absolute/relative display** — "In 3 days"; dated cells render as
  text and reveal the native picker on click), url, email, phone,
  **files & media** (URLs/images), relation, **dependency** (links rows in the same
  DB, optionally **two-way/synced**), **rollup** (folds a target across a relation),
  created/last-edited time, **unique ID** (auto-incrementing, optional prefix),
  person, verification, backlinks, plus two computed kinds: `expr` (reads a reactive
  cell from the row's document) and `formula` (`prop("Price") * prop("Qty")`).
- **Views** — table (with a **frozen Name column** that casts an edge shadow
  while scrolled), board (**collapsible columns**, configurable footer
  **calculation**, **add-a-group in place**, card **covers**), gallery (**card
  size S/M/L**, **grouped sections**, covers that tolerate extension-less CDN
  URLs), calendar (**click-a-day to add**, range-dated rows on their start day),
  **timeline** (Gantt with drag-to-reschedule + dependency arrows),
  **dependency graph**, list, and
  **interactive** bar/pie charts. Per-view config: filters (a nested **AND/OR tree**,
  `filterRoot`), sorts, visible/ordered columns, group-by (table/list/**gallery**,
  with **hide-empty** + collapse/expand-all; **group by sub-items** — the
  `'__parent__'` sentinel makes each parent row a board column / table group /
  chart slice of its direct children, with drag-to-re-parent and per-column
  sub-item creation), chart aggregate + second-level
  **breakdown**, **dashboard metric cards** (count/sum/avg/… with optional target +
  progress bar), **colour-by** a select property (tints every layout's row/card edge),
  date/cover/dependency properties, and column summary footers (**per-group** too).
- **Charts** — bar and pie are SVG, interactive, and dependency-free: hovering a
  bar/slice (or its legend) highlights it and dims the rest with a live readout;
  clicking drills into the underlying rows. A `breakdownPropertyId` turns them into
  **stacked bars** / a **two-ring sunburst** (donut with a centre total), with an
  optional **100%-stacked** mode. `aggregateMatrix` (pure) powers both.
- **Interactions** — **right-click context menus** everywhere — a cell (filter by
  its value, sort, group-by, relative-date presets, row actions), a row / board /
  gallery / list / calendar / timeline card (open / insert / duplicate / delete), and
  a column header (sort / group / hide / duplicate / delete); **active filter & sort
  chips** below the toolbar (removable, click a sort to flip it); drag to reorder rows
  (and sub-items), columns, board columns, calendar items, **select options**, and
  **view tabs**; **multi-row select** with bulk delete / duplicate / **set any select
  property**; insert-row-below; **row templates**; double-click a tab to rename; quick
  search with an "X of Y" count; CSV import/export; **interactive multi-page HTML
  export** (the page's whole reachable subtree — subpages, databases, and row pages —
  as one navigable file, see `export/exportSite.ts` + `toHtml.ts`); full-page **and**
  inline/linked databases. Optimistic mutations revert gracefully on a server rejection.
- **Purity** — `rowValue` / `applyView` / `matchesFilter` / `groupRows` /
  `aggregateRows` / `aggregateMatrix` / `summarizeColumn` / `rowDateSpan` /
  `dependencyGraph` / `syncInverseUpdates` / `buildRowTree` / `removeProperty` /
  `numberProgress` / `formatUniqueId` are pure and unit-tested, so the same logic
  runs in the table UI, the server, and tests. Behaviour is covered end-to-end by
  `packages/web/e2e/database-parity.spec.ts` and the `database-*.spec.ts` suite.

### Trash / soft delete

`deletePage` stamps `deleted_at` on the page **and its whole subtree** (same
timestamp) instead of removing rows. The trash lists the *roots* of deleted
subtrees. `restorePage` brings back exactly the subtree deleted together (and
frees a colliding name with a `" (restored)"` suffix). A cleanup job
(`purgeExpired`, default 30-day retention, hourly sweep) permanently removes
expired trash; `purgePage` / `emptyTrash` do it on demand. See `README.md`.

---

## 4. The editor & reactive system

The document is **EditorJS** (vanilla JS) hosting **React** blocks via a small
adapter (`packages/ui/src/reactive/editorJsReactAdapter.ts`): each block tool
mounts its own React root.

### Reactive blocks (`packages/ui/src/reactive/`)
- **`ReactiveStore`** — a Preact-signals store of named cells. Lazy signal
  creation keyed by `cellId`; downstream blocks subscribe by reading a signal.
- **`ExprBlock`** — a formula cell; `compile.ts` turns `@name` / `__C__{id}__`
  references into a function that re-runs (via a signals `effect`) whenever a
  referenced cell changes.
- **`ChartBlock`** — plots one or more cells (Observable Plot); re-renders on
  value change; shows a height-reserving skeleton while pending.
- **`SliderBlock`** — an input cell.
- **`SubpageBlock`** — an inline link to a nested page; creates the child once on
  first mount and records its `pageId` in the block data.

### Live sync — `packages/ui/src/screens/liveSync.ts`
The trickiest part, and the source of two classes of bug, so the logic is **pure
and unit-tested** (`liveSync.test.ts`):

- **`planBlockSync(current, next, focusedBlockId)`** diffs the editor against an
  incoming snapshot and returns *only* the delete/update/insert ops for blocks
  that changed. An identical snapshot → an empty plan. `PageDocument` executes the
  plan via the EditorJS block API; it **never calls `editor.render(next)`**.
  - *Why*: a full render tears down and rebuilds every block — shifting layout and
    re-mounting reactive/subpage blocks, which re-runs their side effects. With
    the SSE echo of a save, that becomes an infinite **save loop + layout jump** on
    pages with reactive blocks.
  - The block under the caret (`focusedBlockId`) is never touched, so typing
    survives a peer's edits.
- **`isPersistWorthyChange(event)`** decides whether an `onChange` is a real edit
  worth autosaving. Structural changes (add/remove/move) count; a subpage
  recording its new child id counts; **reactive `block-changed` events do not** —
  reactive blocks fire them constantly as they recompute, and treating those as
  edits is the other half of the save loop.

### The block editor (`packages/ui/src/blockeditor/`) — the successor

A fully custom, CRDT-native block editor being introduced **in parallel** with
the EditorJS surface (per-page dispatch in `ConnectedPageDocument`):

- **Model** (`model.ts`) — a Y.Doc holding one uniform recursive tree:
  `Y.Array` of block `Y.Map`s (`id`, `type`, `text: Y.Text` with attribute
  runs, `props: Y.Map`, `children: Y.Array`). Columns (2–4 on a 12-col grid,
  resizable spans), tables (rows → rich-text cells), and nesting all recurse
  through the same shape. Two serializations live in the page snapshot:
  the base64 CRDT update (what collaboration merges) and a JSON projection
  (what exports/tests/the server read). `migrateEditorJs` converts legacy
  documents; `createSeededDoc` writes seeds as a fixed replica so racing
  clients converge instead of duplicating content.
- **Engine** (`TextBlockView.tsx`) — per-block contenteditable driven by
  **native** `beforeinput` (React's `onBeforeInput` is a keypress polyfill
  whose `preventDefault` can't cancel the real event). Every edit applies to
  Y.Text and re-renders from the model; IME composition lets the browser own
  the DOM, then diffs back on `compositionend`. Yjs gotchas encoded here:
  detached `Y.Map`s can't be read (settle ids before construction), inserts
  without explicit attrs inherit the previous run's formatting, and the
  UndoManager must be created in an effect (StrictMode's mount-cycle cleanup
  destroys a useMemo-created one).
- **Editing surface** — slash menu, markdown shortcuts, floating format
  toolbar, block selection (document-level key handling — a selected block
  has no DOM focus), drag handles with drop-beside-to-create-columns, touch
  drag via pointer events, aria-live move announcements.
- **Extensibility** (`registry.tsx`) — `registerCustomBlock({type, render,
  slash})`: custom blocks render inside the standard row, store state as CRDT
  props, and join the slash menu. `reactiveBlocks.tsx` ships slider + live
  formula plugins (code over input values, recomputed per keystroke/drag,
  collaborative because props are CRDT state).
- **Artifact kit** (`kit/`) — reusable interactive components for building
  small artifacts (calculators, pickers, dashboards) out of blocks instead of
  hand-coding them. *Inputs* publish named values onto a shared reactive
  scope (`kit/scope.ts`): number stepper, text field, radio group, choice
  checklist, toggle, location, and an action button that sets/steps/flips
  another input (or opens a link). *Consumers* evaluate expressions over the
  scope: a chart block (line/area/bar/pie/donut/scatter/funnel, multi-series
  via `{name: [..]}`, pure-SVG geometry in unit-tested `kit/chartMath.ts`),
  a status light with ok/warn thresholds, a tooltip term, and a link card.
  Every block leads with its control surface; config hides behind a ⚙
  toggle. Exports (`exportBlocks.ts`): steppers stay interactive as sliders,
  status/chart expressions stay live (tokenized over every named input),
  text-ish inputs freeze to readable paragraphs but still publish values.
  e2e in `packages/web/e2e/kit.spec.ts`.
- **Collaboration** — `provider.ts` syncs tabs via BroadcastChannel
  (hello/state/update + presence); cross-client sync rides the existing SSE
  page stream — `BlockPageDocument` merges pushed snapshots with
  `Y.applyUpdate` (idempotent), so no server changes were needed. A websocket
  relay can later speak the same three messages for live remote cursors.
- **Rollout** — pages stamped `data.editor === 'blocks'` always use the new
  editor; `?editor=next` forces it (and migrates legacy content); the
  Settings → General toggle opts *empty* pages in. The sandbox lives at
  `/editor-lab` (localStorage-persisted, cross-tab sync); e2e in
  `packages/web/e2e/block-editor.spec.ts`.

### Optional local AI (`packages/server/src/ai/`)

An opt-in, local-only model subsystem (Settings → AI). Pluggable engines
behind one interface (`providers.ts`):

- **llama** — in-process llama.cpp via `node-llama-cpp` (an
  `optionalDependency`, imported dynamically; GGUF models download into the
  server's models dir from Settings). Cross-platform: Metal/CUDA/Vulkan/CPU.
- **mlx** — Apple-Silicon MLX through `mlx_lm.server`'s OpenAI-compatible
  API; the server auto-spawns it when installed (`pip install mlx-lm`).
- **openai** — any OpenAI-compatible local endpoint (Ollama, LM Studio,
  llama-server, vLLM…). Pure fetch.
- **mock** — deterministic in-process engine powering tests/e2e.

Capabilities (`/api/ai/*`, SSE for generation): **note search** — BM25 over
every live page (works with AI off), upgraded to hybrid embedding rerank when
the engine embeds; **task breakdown** (`aiTasks` → parsed list); **document
completion** (`aiComplete`, streamed). The block editor surfaces these as
slash actions ("Continue writing" streams tokens straight into Y.Text —
collaborators watch it arrive; "Break into tasks" inserts to-dos), gated on
engine readiness via the `aiBridge` singleton. The AI search dialog lives in
the command palette ("Search notes with AI"). Config persists in the
`settings` table; everything degrades gracefully — engine failures never
touch the document APIs.

### Extensions (`packages/ui/src/plugins/` + `/api/plugins`)

TypeScript plugins, VS Code-shaped: a zip of source + `openbook.json`
installs from Settings → Extensions, is stored server-side per workspace
(migration `0007_plugins`), and loads on boot. The loader strips types with
sucrase and links files through an in-memory CommonJS resolver (`react` and
`@open-book/plugin-sdk` map to host modules; other bare imports are
refused). `activate(api)` registers custom blocks (namespaced
`<pluginId>/<type>`, straight into the block-editor registry), palette
commands (a subscribable registry merged into `useAppCommands`), and uses
`pages`/`storage`/`fetch` for integrations — all tracked as disposables so
disable/remove tears down cleanly and an activation crash rolls back
without touching neighbours. Provenance: Ed25519 over a canonical digest
(`packages/sdk/src/plugins.ts`), verified client-side against the pinned
first-party key plus user-trusted registry keys; signing is provenance, not
sandboxing. See PLUGINS.md; e2e in `packages/web/e2e/plugins.spec.ts`.

### The agent surface — in-app harness + MCP

Two ways for a model to *act on* the workspace, sharing one tool contract
(search / read / list / create / append, all grounded in live pages):

- **In-app agent** (`packages/server/src/ai/agent.ts`): `AgentRunner` wraps
  the configured AI engine in a tool loop — the model answers each turn with
  one JSON object (`{"tool", "args"}` or `{"final"}`), a deliberate
  lowest-common-denominator protocol so small local GGUF/MLX models work
  without native function calling. `POST /api/agent/chat` streams each step
  (tool call → tool result → final answer) as SSE;
  `HttpDataClient.agentChat()` consumes it, and the UI's `AgentPanel`
  (command palette → "Ask the assistant") renders the steps live. The mock
  engine scripts a search-then-answer run for tests.
- **MCP server** (`packages/mcp`): the same capabilities (plus database
  row tools) for *external* agents, as a stdio MCP server over
  `HttpDataClient` (`OPENBOOK_URL`). Tool implementations share the SDK
  content helpers with the agent, so both surfaces obey the same rules
  (e.g. neither appends to collaborative-editor pages). Integration-tested
  end-to-end via a real MCP client handshake
  (`packages/mcp/scripts/e2e.mts`).

---

## 5. UI structure

- **Providers** (`packages/ui/src/providers/`): `DataProvider` (the client),
  `NavigationProvider` (page list, current window/tabs/panes, create/delete/rename),
  `HudProvider` (view state incl. `viewMode.fullWidth`, sidebar), `ThemeProvider`,
  `WorkspaceProvider`, and `ConfirmProvider` (promise-based confirm dialog).
- **`windowModel.ts`** — pure tab/split-pane navigation model (history, reconcile);
  unit-tested.
- **Template gallery** (`components/TemplateGallery.tsx` over `sdk/templates.ts`):
  ready-made pages — documents and databases with sample rows — instantiated
  client-side through the normal data APIs; page *and* sample-row names are
  suffixed past the workspace-unique name constraint so a template can be
  instantiated repeatedly.
- **Design primitives** (`packages/ui/src/components/ui/`): Radix-based `dialog`,
  `dropdown-menu`, `context-menu`, `tree`, `skeleton`, `button`, etc. Tailwind v4
  tokens live in `index.css`.
- **`DefaultLayout`** composes the titlebar, sidebar (`SideNav` →
  `WorkspaceNavigationTree`), and the `DocumentArea` (one or two `PageDocument`
  panes). It also mounts the `ConfirmProvider`.

---

## 6. Build, lint & test — one command

```bash
pnpm verify
```

Runs, in order: **build:libs** (sdk → ui → server) → **typecheck** (all packages)
→ **lint** (all) → **test** (vitest unit suites) → **test:e2e** (server e2e). This
is the gate to run before committing and in CI (`.github/workflows/ci.yml`).

Other commands:

| Command | What |
|---------|------|
| `pnpm build` | Full app build: libs → web → desktop (`tauri build`, needs Rust) |
| `pnpm test` | Vitest unit suites (`packages/ui/src/**/__tests__`) |
| `pnpm test:e2e` | Server + SDK e2e (`packages/server/scripts/e2e.mts`) — embedded, persistence, headless, trash-cleanup, cache headers |
| `pnpm test:e2e:web` | Playwright browser e2e (`packages/web/e2e/`); boots the server + Next app |
| `pnpm chromatic` | Upload Playwright snapshots for visual diffs (needs `CHROMATIC_PROJECT_TOKEN`) |

### Test layers

1. **Unit (vitest, happy-dom)** — pure logic: `liveSync` (diff planner + edit
   detection), `windowModel`, `buildTree` (sidebar nesting), the reactive store,
   the formula compiler, chart normalization.
2. **Server e2e (`e2e.mts`)** — the real `HttpDataClient` against a live server in
   both DB modes: CRUD, nesting, trash/restore/purge, databases & rows, persistence
   across restart, the cleanup job, and `Cache-Control: no-store`.
3. **Browser e2e (Playwright, `packages/web/e2e/`)** — the web app end-to-end:
   delete-confirm dialog + centering, full-width toggle (incl. the editor),
   right-click context menu, subpage idempotency, and **no save loop** on a
   reactive page.
4. **Visual diffs (Chromatic)** — the Playwright tests use `@chromatic-com/playwright`;
   `takeSnapshot` captures key states (centered dialog, full-width editor, computed
   reactive blocks, the page / block / sidebar context menus open, the `@`
   page-link menu, the backup restore dialog, and the desktop titlebar shell). The
   desktop chrome (in-window tabs + titlebar workspace switcher
   and sidebar toggle) is web-invisible, so the web shell exposes a `?shell=desktop`
   preview seam (`packages/web/src/pages/index.tsx`) the snapshot drives.
   `chromatic --playwright` uploads them. Set the `CHROMATIC_PROJECT_TOKEN` repo
   secret to enable the CI step.

> **What automated tests can't cover.** WKWebView-only behavior (see §7) doesn't
> reproduce in headless Chromium — verify those on the real desktop app.

---

## 7. WKWebView gotchas (desktop only)

The desktop runs in macOS WKWebView, which differs from Chromium in ways the web
tests can't catch:

1. **Clicks need `cursor: pointer`.** WKWebView only dispatches `click` to elements
   it treats as clickable; a `<div role=menuitem>` with `cursor: default` is dead.
   All non-`<button>` interactive elements set `cursor-pointer`.
2. **`window.confirm/alert/prompt` are dead** — they return without showing a
   dialog. Use the in-app `useConfirm()` (`ConfirmProvider`), never native dialogs.
3. **Header-less GETs are cached** — hence `Cache-Control: no-store` on `/api/*`
   plus `cache: 'no-store'` on the SDK reads.
4. **Modals must center with flexbox, not `translate`** — Tailwind v4 centers via
   the `translate` CSS property, which WKWebView didn't apply (modals jumped to the
   top-left). `dialog.tsx` centers with `fixed inset-0 flex items-center justify-center`.
5. **HTML5 drag needs `fileDropEnabled: false`** in `tauri.conf.json`, or the native
   OS file-drop handler eats EditorJS block reordering.
