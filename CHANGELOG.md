## 3.12.0 (2026-08-12)

### 🚀 Features

- **lint,ci,web:** spacing enforcement — Chromatic fails on diffs, @visual coverage, no-arbitrary-spacing rule (SPC-6) ([#297](https://github.com/lab255/OpenBook/pull/297))
- **mcp:** form management tools — list/get/update on the write-policy pattern (FORM-7) ([#295](https://github.com/lab255/OpenBook/pull/295))
- **sdk:** FormSchema model + pure validation engine + row projection (FORM-2) ([#280](https://github.com/lab255/OpenBook/pull/280))
- **sdk,server,ui,web:** live public form submissions — locked-mode runtime, validation UX, idempotent submit (FORM-5) ([#296](https://github.com/lab255/OpenBook/pull/296))
- **sdk,server,ui,web:** file-upload fields + abuse controls — staged carve-out, rate limits, retention (FORM-6) ([#298](https://github.com/lab255/OpenBook/pull/298))
- **sdk,ui:** form block end-to-end — catalogue, frozen renders, key-sanitized exports (FORM-3) ([#286](https://github.com/lab255/OpenBook/pull/286))
- **server,sdk:** anonymous form-submission capability route — oracle-safe, idempotent, ceiling-capped (FORM-1) ([#284](https://github.com/lab255/OpenBook/pull/284))
- **ui:** configurable menu density + menu infra dedup, width tokens, shortcut table (CTX-1) ([#279](https://github.com/lab255/OpenBook/pull/279))
- **ui:** EmptyState primitive + 10-site adoption + i18n (SPC-5) ([#281](https://github.com/lab255/OpenBook/pull/281))
- **ui:** page context menus on breadcrumbs, home, backlinks, trash + chrome suppression (CTX-2) ([#282](https://github.com/lab255/OpenBook/pull/282))
- **ui:** one input canon — panel/dense variants, Button xs, settings + AgentPanel sweep (SPC-3) ([#285](https://github.com/lab255/OpenBook/pull/285))
- **ui:** media + link context menus — images, links, mentions, cover, icon (CTX-4) ([#293](https://github.com/lab255/OpenBook/pull/293))
- **ui:** panel context menus — graph, history, review, agent messages (CTX-7) ([#294](https://github.com/lab255/OpenBook/pull/294))
- **ui:** titlebar tab context menu + window-chrome suppression (CTX-3) ([#290](https://github.com/lab255/OpenBook/pull/290))
- **ui:** native-menu passthrough + multi-block bulk context menu (CTX-5) ([#291](https://github.com/lab255/OpenBook/pull/291))
- **ui,docs:** spacing scale tokens + spacing manifest + audit baseline (SPC-1) ([#278](https://github.com/lab255/OpenBook/pull/278))
- **ui,web:** native-menu suppression sweep + editable guard + e2e proof (CTX-8) ([#289](https://github.com/lab255/OpenBook/pull/289))
- **ui,web,docs:** drag-and-drop form builder + publish surfacing + epic close-out (FORM-4 + FORM-8) ([#299](https://github.com/lab255/OpenBook/pull/299))

### 🩹 Fixes

- **ui:** zero layout shift on hover — opacity reveals + no-hover-geometry lint (HOV-1) ([#277](https://github.com/lab255/OpenBook/pull/277))
- **ui:** database menu targeting — scoped view-tab menus, chip menus, chart copy (CTX-6) ([#288](https://github.com/lab255/OpenBook/pull/288))
- **ui:** migrate form block CSS onto the spacing grid (post-merge stylelint gate) ([#292](https://github.com/lab255/OpenBook/pull/292))

### ❤️ Thank You

- Claude Opus 4.8
- Eliot Lim @eliotlim

## 3.11.1 (2026-08-11)

### 🩹 Fixes

- **app:** sidecar supervision — bounded respawn + surfaced state (BOOT-4) ([#275](https://github.com/lab255/OpenBook/pull/275))
- **server,app:** reclaim stale PGlite dir locks from dead processes (BOOT-7) ([#272](https://github.com/lab255/OpenBook/pull/272))
- **server,sdk,ui:** backup boot-path, streaming, and skip+record hardening (BOOT-1/2/3) ([#273](https://github.com/lab255/OpenBook/pull/273))
- **ui:** responsive collapse for page-header controls (UIX-1) ([#274](https://github.com/lab255/OpenBook/pull/274))
- **ui,sdk:** forwarding self-healing — retries, stalled surfacing, intent preservation (TUN-1/2/3/4) ([#276](https://github.com/lab255/OpenBook/pull/276))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 3.11.0 (2026-08-11)

### 🚀 Features

- **server,sdk:** lossless backup bundle v3 — assets + page ACLs (BAK-1) ([#265](https://github.com/lab255/OpenBook/pull/265))
- **ui:** desktop security-advisory warning — update / snooze / typed-ack dismiss (LNCH-9) ([#267](https://github.com/lab255/OpenBook/pull/267))
- **ui:** resident QuickJS sandbox for document eval — closes the desktop RCE chain (SBX-2) ([#270](https://github.com/lab255/OpenBook/pull/270))

### 🩹 Fixes

- **export:** remove new Function from exported HTML runtime + page CSP (SBX-3) ([#268](https://github.com/lab255/OpenBook/pull/268))
- **server:** owner-gate host-sensitive mutations + bind stdio MCP to local owner (SBX-5) ([#264](https://github.com/lab255/OpenBook/pull/264))
- **ui:** normalize bundled plugin paths on Windows — restores the Windows release leg (LNCH-6) ([#261](https://github.com/lab255/OpenBook/pull/261))
- **ui:** defer evalCache dispose — restore initial-load reactive eval (main hotfix) ([#269](https://github.com/lab255/OpenBook/pull/269), [#266](https://github.com/lab255/OpenBook/issues/266))
- **ui:** guest-safe owner gating in instance settings — no more enabled controls that always 403 (PUB-5) ([#271](https://github.com/lab255/OpenBook/pull/271))

### 🔥 Performance

- **ui:** memo reactive scope by editor version + eval guard (SBX-0) ([#263](https://github.com/lab255/OpenBook/pull/263))

### ❤️ Thank You

- Claude Opus 4.8
- Eliot Lim @eliotlim

## 3.10.0 (2026-08-09)

### 🚀 Features

- **sdk:** pin the production registry public key (ST-13, ceremony step 3) ([#244](https://github.com/eliotlim/OpenBook/pull/244))
- **ui:** overlay primitives — dialog size scale, nowrap buttons, toast tokens, one tooltip clock (POL-2) ([#248](https://github.com/eliotlim/OpenBook/pull/248))
- **ui:** i18n parity report + localize stray strings + locale scope fixes (POL-7) ([#247](https://github.com/eliotlim/OpenBook/pull/247))

### 🩹 Fixes

- **ui:** share dialog overflow seam, copy-link wrap, single mount (POL-1) ([#246](https://github.com/eliotlim/OpenBook/pull/246))
- **ui:** rebuild LinkPicker on popover conventions + focus fix (POL-3) ([#250](https://github.com/eliotlim/OpenBook/pull/250))
- **ui:** muted-foreground WCAG AA contrast across the canvas family (DS-1) ([#252](https://github.com/eliotlim/OpenBook/pull/252))
- **ui:** editor alignment — code gutter, merged-table grips (POL-8) ([#253](https://github.com/eliotlim/OpenBook/pull/253))
- **ui:** dark overlay elevation, strong muted tier, z-scale completion (POL-9a) ([#255](https://github.com/eliotlim/OpenBook/pull/255))
- **ui:** QA-sweep fixes — template i18n keys, LinkPicker anchor, timeline labels ([#256](https://github.com/eliotlim/OpenBook/pull/256))
- **ui:** narrow-width usability — drawer sidebar, settings stacking, toolbar overflow (POL-10) ([#257](https://github.com/eliotlim/OpenBook/pull/257))
- **ui:** accessible placeholder contrast + unified dark elevation (A11Y-1) ([#258](https://github.com/eliotlim/OpenBook/pull/258))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 3.9.0 (2026-08-09)

### 🚀 Features

- **build:** registry signing-key rotation + signed first-party bundles (ST-1) ([#236](https://github.com/eliotlim/OpenBook/pull/236), [#8](https://github.com/eliotlim/OpenBook/issues/8), [#1](https://github.com/eliotlim/OpenBook/issues/1))
- **export:** consent-gated ledger records in HTML site exports (LX-2) ([#231](https://github.com/eliotlim/OpenBook/pull/231), [#1](https://github.com/eliotlim/OpenBook/issues/1), [#2](https://github.com/eliotlim/OpenBook/issues/2))
- **export:** static ledger report tables in exported HTML (LX-3) ([#232](https://github.com/eliotlim/OpenBook/pull/232))
- **export:** hydrated viewer preserves the static ledger report tables (LX-5) ([#233](https://github.com/eliotlim/OpenBook/pull/233))
- **import:** ledger round-trip import + recovery surfacing (LX-4) ([#237](https://github.com/eliotlim/OpenBook/pull/237))
- **sdk,mcp:** registry-derived block validation — retire the allowlists (API-1/2/3/4) ([#234](https://github.com/eliotlim/OpenBook/pull/234), [#30](https://github.com/eliotlim/OpenBook/issues/30))
- **sdk,ui,server:** client registry integration — browse, verified installs, upgrades, revocations (ST-6) ([#243](https://github.com/eliotlim/OpenBook/pull/243))
- **ui:** publish selected pages only — fourth default-access state (PUB-1) ([#230](https://github.com/eliotlim/OpenBook/pull/230))
- **ui:** database-grid row/column context menus — parity with block tables (TBL-9) ([#239](https://github.com/eliotlim/OpenBook/pull/239))
- **ui:** range-aware table cell menu + per-cell tint (TBL-6) ([#240](https://github.com/eliotlim/OpenBook/pull/240))
- **ui:** merge / split table cells — colspan + rowspan (TBL-8) ([#242](https://github.com/eliotlim/OpenBook/pull/242))

### 🩹 Fixes

- **app:** stable forwarding names — narrowed reattach + per-account keystore (NAME-1/2) ([#235](https://github.com/eliotlim/OpenBook/pull/235))
- **ui:** deterministic reconcile Amend focus handoff (LGR-22 CI flake — real component race) ([#241](https://github.com/eliotlim/OpenBook/pull/241))
- **web:** bump typecheck target to ES2020 — sdk BigInt literals (LX-4 follow-up) ([#238](https://github.com/eliotlim/OpenBook/pull/238))

### ❤️ Thank You

- Claude Fable 5
- Eliot Lim @eliotlim

## 3.8.0 (2026-08-04)

### 🚀 Features

- **ui:** unsupported ledger blocks — install prompt + bundled plugin ([#229](https://github.com/eliotlim/OpenBook/pull/229))

### ❤️ Thank You

- Claude Opus 4.6
- Eliot Lim @eliotlim

## 3.7.0 (2026-08-03)

### 🚀 Features

- **sdk:** add Simple Budget and Startup Books ledger templates ([#228](https://github.com/eliotlim/OpenBook/pull/228))

### ❤️ Thank You

- Claude Opus 4.6
- Eliot Lim @eliotlim

## 3.6.0 (2026-08-03)

### 🚀 Features

- Ledger — trustworthy double-entry books (epic LGR, review by commit) ([#227](https://github.com/eliotlim/OpenBook/pull/227), [#2](https://github.com/eliotlim/OpenBook/issues/2))

### ❤️ Thank You

- Claude Fable 5
- Claude Opus 5
- Eliot Lim @eliotlim

## 3.5.1 (2026-07-28)

### 🩹 Fixes

- **server:** Host-header allowlist on loopback TCP binds — close the DNS-rebinding hole (STAB-10, OB-571) ([#225](https://github.com/eliotlim/OpenBook/pull/225))
- **ui,web:** hide sign-in chrome + relabel library on the LAN-served UI (STAB-9) ([#226](https://github.com/eliotlim/OpenBook/pull/226))

### ❤️ Thank You

- Claude Fable 5
- Claude Opus 4.8
- Eliot Lim @eliotlim

## 3.5.0 (2026-07-27)

### 🚀 Features

- **blockeditor:** [[wikilink]] autocompletion with create-as-subpage (OB-35) ([#221](https://github.com/eliotlim/OpenBook/pull/221))
- **server,sdk,mcp,ui:** agent direct edits — library setting + per-page override, policy-enforced across MCP, remote PATs and built-in AI (OB-564) ([#222](https://github.com/eliotlim/OpenBook/pull/222))
- **ui:** persistent Linked-references side-pane — backlinks + unlinked mentions (OB-32) ([#218](https://github.com/eliotlim/OpenBook/pull/218))
- **ui,sdk:** publish UI — 'Only published pages' site scope + per-page Publish action & indicator (OB-522/OB-523) ([#224](https://github.com/eliotlim/OpenBook/pull/224))
- **ui,server,sdk:** whole-library page link graph — on-the-fly edges, read-gated, React Flow pane (OB-33) ([#219](https://github.com/eliotlim/OpenBook/pull/219))

### 🩹 Fixes

- **server:** gate four metadata routes off the anonymous surface (GATE-7, OB-517) ([#223](https://github.com/eliotlim/OpenBook/pull/223))

### ❤️ Thank You

- Claude Fable 5
- Claude Opus 4.8
- Eliot Lim @eliotlim

## 3.4.3 (2026-07-25)

### 🩹 Fixes

- **ui:** button icon↔text spacing — gap in the Button primitive + call-site margin sweep (UX-B1) ([#217](https://github.com/eliotlim/OpenBook/pull/217))

### ❤️ Thank You

- Claude Fable 5
- Eliot Lim @eliotlim

## 3.4.2 (2026-07-24)

### 🩹 Fixes

- **build:** spawn pnpm through a shell on Windows in the release build scripts ([#216](https://github.com/eliotlim/OpenBook/pull/216))

### ❤️ Thank You

- Claude Fable 5
- Eliot Lim @eliotlim

## 3.4.1 (2026-07-24)

### 🩹 Fixes

- **app,build:** unbreak release beforeBuildCommand — build:web-ui is a workspace-root script ([#215](https://github.com/eliotlim/OpenBook/pull/215), [#204](https://github.com/eliotlim/OpenBook/issues/204), [#205](https://github.com/eliotlim/OpenBook/issues/205))

### ❤️ Thank You

- Claude Fable 5
- Eliot Lim @eliotlim

## 3.4.0 (2026-07-24)

### 🚀 Features

- **blockeditor:** image lightbox — fullscreen embedded images & GIFs (LBX-1) ([#206](https://github.com/eliotlim/OpenBook/pull/206))
- **blockeditor:** table order contract — fractional keys + column identity (TBL-1) ([#207](https://github.com/eliotlim/OpenBook/pull/207))
- **blockeditor:** marquee rectangle select + shift-click extension (SEL-1) ([#208](https://github.com/eliotlim/OpenBook/pull/208))
- **blockeditor:** multi-block drag — move the whole selection in one drop (SEL-2) ([#211](https://github.com/eliotlim/OpenBook/pull/211))
- **blockeditor:** per-cell table context menus + duplicate row (TBL-3) ([#209](https://github.com/eliotlim/OpenBook/pull/209))
- **blockeditor:** table drag-reorder — row/column grips + keyboard moves (TBL-2) ([#212](https://github.com/eliotlim/OpenBook/pull/212))
- **blockeditor:** table row & column colouring — tint tokens, menu pickers, export fidelity (TBL-4) ([#213](https://github.com/eliotlim/OpenBook/pull/213))
- **blockeditor:** multi-cell table selection — drag/shift range, copy, clear (TBL-5) ([#214](https://github.com/eliotlim/OpenBook/pull/214))
- **server,web,desktop:** serve the LAN web UI from the sidecar — tokenless, guest-gated (STAB-7) ([#205](https://github.com/eliotlim/OpenBook/pull/205))
- **ui:** lightbox zoom & pan — wheel/pinch, drag, fit↔100%, keyboard (LBX-2) ([#210](https://github.com/eliotlim/OpenBook/pull/210))

### 🩹 Fixes

- **server,sdk:** app-origin CORS allowlist + guest-write header gate — close the drive-by loopback hole (STAB-8) ([#204](https://github.com/eliotlim/OpenBook/pull/204))

### ❤️ Thank You

- Claude Fable 5
- Eliot Lim @eliotlim

## 3.3.3 (2026-07-23)

### 🩹 Fixes

- **app,ui:** desktop error boundary + poison-page crash-loop recovery (STAB-3) ([#199](https://github.com/eliotlim/OpenBook/pull/199))
- **blockeditor:** Notion table paste normalization + render guards — end the white-screen crash loop (STAB-1/2) ([#203](https://github.com/eliotlim/OpenBook/pull/203))
- **desktop:** hide window on close and drain the sidecar off the main thread (STAB-6) ([#202](https://github.com/eliotlim/OpenBook/pull/202))
- **mcp,desktop,server:** unify the local MCP endpoint — loopback bind on toggle + instance verification (STAB-5) ([#201](https://github.com/eliotlim/OpenBook/pull/201))
- **ui,desktop:** stop file drops hijacking the webview; origin-guard navigation (STAB-4) ([#200](https://github.com/eliotlim/OpenBook/pull/200))

### ❤️ Thank You

- Claude Fable 5
- Eliot Lim @eliotlim

## 3.3.2 (2026-07-18)

### 🚀 Features

- **search:** local lexical content search on the in-webview transport (Epic 3) ([#198](https://github.com/eliotlim/OpenBook/pull/198), [#197](https://github.com/eliotlim/OpenBook/issues/197))

### ❤️ Thank You

- Claude Opus 4.8
- Eliot Lim @eliotlim

## 3.3.1 (2026-07-17)

### 🩹 Fixes

- **ui:** align active titlebar-tab label with inactive tabs ([#197](https://github.com/eliotlim/OpenBook/pull/197))

### ❤️ Thank You

- Claude Fable 5
- Eliot Lim @eliotlim

## 3.3.0 (2026-07-17)

### 🚀 Features

- **ui:** web browser Back/Forward navigates page history (IA-2) ([#182](https://github.com/eliotlim/OpenBook/pull/182))
- **ui:** expose interactive toHtml/toSlideDeck/toHtmlSite from public API ([#180](https://github.com/eliotlim/OpenBook/pull/180))
- **ui:** Settings V2 Wave 1 — 4-rail regroup, fold Connection into Libraries, control unification, advanced-section primitive ([#181](https://github.com/eliotlim/OpenBook/pull/181))
- **ui:** Settings V2 Wave 2a — AI-tab split, in-panel search, Backups rebuild ([#193](https://github.com/eliotlim/OpenBook/pull/193))
- **ui:** Settings V2 Wave 2b — Shortcuts rename, admin-gate consistency, copy/i18n truth pass ([#194](https://github.com/eliotlim/OpenBook/pull/194))
- **ui:** SHR-7 — one "Default access" control (retire raw guest-gate) ([#196](https://github.com/eliotlim/OpenBook/pull/196))

### 🩹 Fixes

- **ci:** cache packages/mcp/dist for e2e + raise server hook timeout ([#195](https://github.com/eliotlim/OpenBook/pull/195))

### ❤️ Thank You

- Claude Fable 5
- Eliot Lim @eliotlim

## 3.2.0 (2026-07-14)

### 🚀 Features

- **ui:** database views full-width by default + switch control for full width ([#178](https://github.com/eliotlim/OpenBook/pull/178))

### 🩹 Fixes

- **identity:** keep remote-reader content credential alive (cross-server blank pages) ([#179](https://github.com/eliotlim/OpenBook/pull/179))
- **mcp:** local MCP over LAN — loopback-owner gate + owner-subject binding ([#177](https://github.com/eliotlim/OpenBook/pull/177))

### ❤️ Thank You

- Claude Fable 5
- Eliot Lim @eliotlim

## 3.1.0 (2026-07-14)

### 🚀 Features

- **database:** active DB view in the URL (?view=) with shareable deep links (DL-1) ([#163](https://github.com/eliotlim/OpenBook/pull/163))
- **server:** capture per-page version history on save (PVH-1) ([#171](https://github.com/eliotlim/OpenBook/pull/171))
- **server:** retention/pruning for page versions (PVH-2) ([#172](https://github.com/eliotlim/OpenBook/pull/172))
- **server:** page version list/get/restore routes + SDK, non-destructive restore (PVH-3) ([#173](https://github.com/eliotlim/OpenBook/pull/173))
- **server:** reseed canonical collab doc on restore + quiesce to close the clobber race (PVH-8) ([#175](https://github.com/eliotlim/OpenBook/pull/175))
- **ui:** Library Manager — management settings screen + switcher Manage/status (LM-1/LM-2) ([#165](https://github.com/eliotlim/OpenBook/pull/165))
- **ui:** unify page context menus (click + right-click) behind one shared action list (CM-2) ([#164](https://github.com/eliotlim/OpenBook/pull/164))
- **ui:** enrich DB row context menu — open in tab/window + copy link (CM-3) ([#166](https://github.com/eliotlim/OpenBook/pull/166))
- **ui:** persist side-pane target page in the URL (DL-3) ([#167](https://github.com/eliotlim/OpenBook/pull/167))
- **ui:** Library Manager — desktop connect + signed-in discovery (LM-3/LM-4) ([#168](https://github.com/eliotlim/OpenBook/pull/168))
- **ui:** addressable DB rows & groups in the URL + copy-link anchors (DL-2) ([#169](https://github.com/eliotlim/OpenBook/pull/169))
- **ui:** right-click column header keeps quick actions + adds Edit property (CM-4) ([#170](https://github.com/eliotlim/OpenBook/pull/170))
- **ui:** Version History pane — list, read-only preview, restore (PVH-4/5/7) ([#174](https://github.com/eliotlim/OpenBook/pull/174))
- **ui:** Version History block/word-level diff (Compare) (PVH-6) ([#176](https://github.com/eliotlim/OpenBook/pull/176))

### 🩹 Fixes

- **db:** group-header context menu (rename/colour/collapse/delete) — fixes group right-click (CM-1) ([#162](https://github.com/eliotlim/OpenBook/pull/162))

### ❤️ Thank You

- Claude Fable 5
- Eliot Lim @eliotlim

# 3.0.0 (2026-07-14)

### 🚀 Features

- **backups:** scheduled backups on by default (opt-out) with opt-out-preserving migration (B3) ([#156](https://github.com/eliotlim/OpenBook/pull/156))
- ⚠️  **server:** remote MCP origin — conjunctive forwarded-guard + remote_ok tokens + R2/R4/R5/R6 (AGENT-10) ([#157](https://github.com/eliotlim/OpenBook/pull/157))
- **ui:** dual-read/write `libraries`↔`workspaces` account-sync key (LIB-6) ([#158](https://github.com/eliotlim/OpenBook/pull/158))
- **ui:** Library-folder relabel + Export to folder/backup actions with in-place feedback (B1/B2) ([#159](https://github.com/eliotlim/OpenBook/pull/159))

### ⚠️  Breaking Changes

- **server:** remote MCP origin — conjunctive forwarded-guard + remote_ok tokens + R2/R4/R5/R6 (AGENT-10)  ([#157](https://github.com/eliotlim/OpenBook/pull/157))

### ❤️ Thank You

- Claude Fable 5
- Eliot Lim @eliotlim

## 2.2.0 (2026-07-13)

### 🚀 Features

- **ui:** dashboard cross-filter for DB-source charts (DASH-7) ([#153](https://github.com/eliotlim/OpenBook/pull/153))

### 🩹 Fixes

- **release:** build @book.dev/mcp before the desktop sidecar so bun can resolve it ([#152](https://github.com/eliotlim/OpenBook/pull/152))
- **ui:** curve dependency arrows + paint desktop cover tint behind the titlebar glass ([#154](https://github.com/eliotlim/OpenBook/pull/154))

### ❤️ Thank You

- Claude Fable 5
- Eliot Lim @eliotlim

## 2.1.0 (2026-07-13)

### 🚀 Features

- **ai:** model + thinking currency — Opus 4.8 default, adaptive thinking (AGENT-1) ([#140](https://github.com/eliotlim/OpenBook/pull/140))
- **ai:** harden agent tool schemas + error feedback, raise maxSteps ([#144](https://github.com/eliotlim/OpenBook/pull/144))
- **ai:** MCP client — in-app agent consumes external MCP servers (AGENT-3) ([#145](https://github.com/eliotlim/OpenBook/pull/145))
- **mcp:** route writes through the suggestion-review layer ([#142](https://github.com/eliotlim/OpenBook/pull/142))
- **server:** agent PAT credential — dark/default-off (AGENT-6) ([#148](https://github.com/eliotlim/OpenBook/pull/148))
- **server:** remote HTTP MCP transport — dark/default-off (AGENT-5) ([#150](https://github.com/eliotlim/OpenBook/pull/150))
- **ui:** database data source for kit charts (DASH-3) ([#143](https://github.com/eliotlim/OpenBook/pull/143))
- **ui:** interactive kit charts — hover, highlight, context menu (DASH-2) ([#146](https://github.com/eliotlim/OpenBook/pull/146))
- **ui:** KPI, heatmap, combo chart kinds (DASH-5) ([#149](https://github.com/eliotlim/OpenBook/pull/149), [#233246](https://github.com/eliotlim/OpenBook/issues/233246))
- **ui:** dashboard template + build-flow + chart-view polish (DASH-6) ([#151](https://github.com/eliotlim/OpenBook/pull/151))

### ❤️ Thank You

- Claude Fable 5
- Claude Opus 4.8
- Eliot Lim @eliotlim

# 2.0.0 (2026-07-13)

### 🚀 Features

- **app:** migrate localStorage openbook.workspaces -> openbook.libraries (LIB-3) ([#136](https://github.com/eliotlim/OpenBook/pull/136))
- ⚠️  **app:** LIB-5 wire rename — roster v2 signer + dual-read consumer (workspaceId→libraryId) ([#138](https://github.com/eliotlim/OpenBook/pull/138))
- **sdk:** export-format openbook.space.json → openbook.library.json + dual-read (LIB-4) ([#137](https://github.com/eliotlim/OpenBook/pull/137))
- **settings:** merge Members into the Sharing tab ([#127](https://github.com/eliotlim/OpenBook/pull/127))
- **share:** honest + simplified Share dialog ([#125](https://github.com/eliotlim/OpenBook/pull/125))
- **templates:** showcase content — Pitch deck, calendar view, sample doc ([#126](https://github.com/eliotlim/OpenBook/pull/126))
- **templates:** Team status dashboard + Product HQ showcase templates ([#128](https://github.com/eliotlim/OpenBook/pull/128))
- **templates:** seed valid reading-list gallery covers ([#129](https://github.com/eliotlim/OpenBook/pull/129))
- **templates:** guidance callouts + cross-DB rollup residuals ([#132](https://github.com/eliotlim/OpenBook/pull/132))

### 🩹 Fixes

- **sharing:** honest published-address visibility bridge (SHR-8/SHR-10) ([#131](https://github.com/eliotlim/OpenBook/pull/131))

### ⚠️  Breaking Changes

- **app:** LIB-5 wire rename — roster v2 signer + dual-read consumer (workspaceId→libraryId)  ([#138](https://github.com/eliotlim/OpenBook/pull/138))

### ❤️ Thank You

- Claude Opus 4.8
- Eliot Lim @eliotlim

## 1.76.2 (2026-07-12)

### 🚀 Features

- **database:** actionable view setup cards + new-property sentinels ([#121](https://github.com/eliotlim/OpenBook/pull/121))
- **database:** view creation & customisation polish ([#123](https://github.com/eliotlim/OpenBook/pull/123))
- **settings:** command-palette deep links + scope chips + cleanup ([#122](https://github.com/eliotlim/OpenBook/pull/122))
- **templates:** gallery badges + section grouping ([#124](https://github.com/eliotlim/OpenBook/pull/124))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.76.1 (2026-07-11)

### 🩹 Fixes

- **updater:** name macOS updater archives per-arch so the manifest can serve them ([#119](https://github.com/eliotlim/OpenBook/pull/119))

### ❤️ Thank You

- Claude Fable 5
- Eliot Lim @eliotlim

## 1.76.0 (2026-07-10)

### 🚀 Features

- **ai:** usage + cost attribution to an admin-only, tamper-locked database ([#113](https://github.com/eliotlim/OpenBook/pull/113))
- **db:** generalisable database auto-expiry (TTL) ([#112](https://github.com/eliotlim/OpenBook/pull/112))
- **ui:** admin-only AI usage viewer + pricing/retention editor ([#115](https://github.com/eliotlim/OpenBook/pull/115))

### 🩹 Fixes

- **ai:** server-only provider API key + write-only settings entry ([#111](https://github.com/eliotlim/OpenBook/pull/111))
- **ai:** lazily seed the usage DB on first AI use (no phantom page in fresh workspaces) ([#114](https://github.com/eliotlim/OpenBook/pull/114))
- **e2e:** green main — retarget stale specs + fix update-preferences flake ([#116](https://github.com/eliotlim/OpenBook/pull/116), [#111](https://github.com/eliotlim/OpenBook/issues/111))
- **ui:** titlebar tabs connect into the page + unify desk tint ([#117](https://github.com/eliotlim/OpenBook/pull/117))

### ❤️ Thank You

- Claude Fable 5
- Claude Opus 4.8 (1M context)
- Eliot Lim @eliotlim

## 1.75.0 (2026-07-06)

### 🚀 Features

- **ui:** kind-less reactive chart export uses the canonical data palette (OB-380) ([#110](https://github.com/eliotlim/OpenBook/pull/110), [#3](https://github.com/eliotlim/OpenBook/issues/3))

### ❤️ Thank You

- Claude Opus 4.8 (1M context)
- Eliot Lim @eliotlim

## 1.74.0 (2026-07-06)

### 🚀 Features

- **ui,sdk:** colour epic — full-accent sidebar option + soft-pastel data colours (integration) ([#107](https://github.com/eliotlim/OpenBook/pull/107), [#104](https://github.com/eliotlim/OpenBook/issues/104), [#105](https://github.com/eliotlim/OpenBook/issues/105))
- **ui,sdk:** Data colours scheme control — Pastel/Vivid/Muted (OB-379) ([#109](https://github.com/eliotlim/OpenBook/pull/109), [#70](https://github.com/eliotlim/OpenBook/issues/70))

### 🩹 Fixes

- **ui:** buttons no longer shift or resize on click (colour-only press) ([#103](https://github.com/eliotlim/OpenBook/pull/103))

### ❤️ Thank You

- Claude Fable 5
- Eliot Lim @eliotlim

## 1.73.0 (2026-07-05)

### 🚀 Features

- **ui:** land the background update scheduler + one-click install button ([#101](https://github.com/eliotlim/OpenBook/pull/101), [#86](https://github.com/eliotlim/OpenBook/issues/86))
- **ui,sdk,server,mcp:** retire EditorJS — de-name export IR to block-native, creators emit blockdoc ([#100](https://github.com/eliotlim/OpenBook/pull/100))

### ❤️ Thank You

- Claude Fable 5
- Eliot Lim @eliotlim

## 1.72.0 (2026-07-05)

### 🚀 Features

- **ui,sdk:** exported HTML renders embedded artifacts — sandboxed, interactive, CSP-clamped ([#99](https://github.com/eliotlim/OpenBook/pull/99))

### ❤️ Thank You

- Claude Fable 5
- Eliot Lim @eliotlim

## 1.71.0 (2026-07-05)

### 🚀 Features

- **sdk,server,ui:** sync-folder .book.html hydrates via a shared per-folder viewer runtime ([#92](https://github.com/eliotlim/OpenBook/pull/92))
- **sdk,ui:** lossless openbook+json source island in every HTML export ([#88](https://github.com/eliotlim/OpenBook/pull/88))
- **ui:** SandboxedHtml — sandboxed srcdoc renderer + security contract ([#87](https://github.com/eliotlim/OpenBook/pull/87))
- **ui:** OpenBookViewer — self-contained compiled locked renderer bundle ([#90](https://github.com/eliotlim/OpenBook/pull/90))
- **ui:** htmlArtifact block — embed and run interactive HTML artifacts in pages ([#93](https://github.com/eliotlim/OpenBook/pull/93))
- **ui:** rearchitect HTML export — island-hydrated vendored viewer replaces the bespoke runtime ([#97](https://github.com/eliotlim/OpenBook/pull/97))
- **ui:** run/present an HTML artifact full-window (ArtifactOverlay) ([#95](https://github.com/eliotlim/OpenBook/pull/95))
- **ui,sdk:** ImportDialog chooser — run .html as sandboxed artifact or convert to blocks ([#96](https://github.com/eliotlim/OpenBook/pull/96), [#91](https://github.com/eliotlim/OpenBook/issues/91))
- **ui,web:** island-first lossless HTML import — exports re-import exactly ([#91](https://github.com/eliotlim/OpenBook/pull/91))

### 🩹 Fixes

- **sdk:** escape legacy-EditorJS raw text in .book.html rendering ([#94](https://github.com/eliotlim/OpenBook/pull/94), [#92](https://github.com/eliotlim/OpenBook/issues/92))
- **sdk,ui:** scheme-allowlist anchor hrefs in static HTML rendering ([#98](https://github.com/eliotlim/OpenBook/pull/98), [#94](https://github.com/eliotlim/OpenBook/issues/94))

### ❤️ Thank You

- Claude Fable 5
- Eliot Lim @eliotlim

## 1.70.0 (2026-07-04)

### 🚀 Features

- **app,ci:** Tauri auto-updater — signed release artifacts + pinned desktop updater runtime ([#85](https://github.com/eliotlim/OpenBook/pull/85))
- **ui:** update preferences — cadence, security-only, check now, version display ([#84](https://github.com/eliotlim/OpenBook/pull/84))

### ❤️ Thank You

- Claude Fable 5
- Claude Opus 4.8 (1M context)
- Eliot Lim @eliotlim

## 1.69.2 (2026-07-04)

### 🩹 Fixes

- **ui:** render claimed-instance guests read-only so public shares don't 403-spam ([2fc9f41](https://github.com/eliotlim/OpenBook/commit/2fc9f41))

### ❤️ Thank You

- Claude Opus 4.8 (1M context)
- Eliot Lim

## 1.69.1 (2026-07-04)

### 🩹 Fixes

- **ui,web:** surface real identity + site name on forwarded instances ([406d174](https://github.com/eliotlim/OpenBook/commit/406d174))

### ❤️ Thank You

- Claude Opus 4.8 (1M context)
- Eliot Lim

## 1.69.0 (2026-07-04)

### 🚀 Features

- **server,app,sdk:** loopback-owner hatch — restore the machine owner's authority over their own instance ([#81](https://github.com/eliotlim/OpenBook/pull/81))
- **server,ui:** populate youRole so viewer chrome activates (read-only for roster viewers) ([#79](https://github.com/eliotlim/OpenBook/pull/79))
- **ui:** publish-implies-repair — re-point a drifted ownerSubject when enabling forwarding ([#82](https://github.com/eliotlim/OpenBook/pull/82))
- **ui:** Diagnostics settings tab — see how the workspace resolves you, and repair the lockouts ([#83](https://github.com/eliotlim/OpenBook/pull/83))
- **ui:** help owners deliver invites — copy link + sign-in-as guidance ([#78](https://github.com/eliotlim/OpenBook/pull/78), [#76](https://github.com/eliotlim/OpenBook/issues/76), [#77](https://github.com/eliotlim/OpenBook/issues/77))

### 🩹 Fixes

- **sdk,ui:** forwarding identity resilience — unscoped fallback on aud rejection, stale-audience heal, attach-ticket retry ([#80](https://github.com/eliotlim/OpenBook/pull/80))
- **server:** require write access for plugin + AI mutation routes ([#75](https://github.com/eliotlim/OpenBook/pull/75))
- **ui:** copy-link uses the forwarded host when published ([#74](https://github.com/eliotlim/OpenBook/pull/74))
- **ui,web:** honest sharing surfaces on the web build (no dead publish controls) ([#77](https://github.com/eliotlim/OpenBook/pull/77))

### ❤️ Thank You

- Claude Fable 5
- Eliot Lim @eliotlim

## 1.68.0 (2026-07-02)

### 🚀 Features

- ia ux review fixes ([#73](https://github.com/eliotlim/OpenBook/pull/73))

### ❤️ Thank You

- Claude Fable 5
- Eliot Lim @eliotlim

## 1.67.0 (2026-07-01)

### 🚀 Features

- **collab:** live incremental-Yjs relay — server ingest/relay + client provider (Collab T1+T2) ([#54](https://github.com/eliotlim/OpenBook/pull/54))
- **collab:** Yjs awareness presence over the relay (Collab T4) ([#56](https://github.com/eliotlim/OpenBook/pull/56))
- **collab:** remote cursors + presence avatars (Collab T5) ([#58](https://github.com/eliotlim/OpenBook/pull/58))
- **collab:** single-saver election to bound multi-editor write-amplification (Collab T3) ([#61](https://github.com/eliotlim/OpenBook/pull/61))
- **collab:** re-handshake relay + awareness on reconnect for tight convergence (Collab T7) ([#63](https://github.com/eliotlim/OpenBook/pull/63))
- **collab:** server-authoritative Yjs persistence (Collab T9) ([#64](https://github.com/eliotlim/OpenBook/pull/64))
- **sdk:** format-agnostic import core + bundle/create writers (OB-298) ([#51](https://github.com/eliotlim/OpenBook/pull/51))
- **sdk:** Markdown/GFM -> blocks import parser (OB-299) ([#53](https://github.com/eliotlim/OpenBook/pull/53))
- **sdk:** Notion export (MD+CSV) import adapter (OB-300) ([#55](https://github.com/eliotlim/OpenBook/pull/55))
- **sdk:** getAsset/putAsset contract + image block assetId + migration (Assets A2) ([#68](https://github.com/eliotlim/OpenBook/pull/68))
- **sdk:** rehydrate imported image placeholders into stored assets (Assets A4) ([#70](https://github.com/eliotlim/OpenBook/pull/70))
- **server:** content-addressed asset store + gated routes (Assets A1) ([#66](https://github.com/eliotlim/OpenBook/pull/66))
- **server:** asset GC (blockdoc-usage-safe) + storage budget (Assets A6) ([#71](https://github.com/eliotlim/OpenBook/pull/71))
- **ui:** import UI + first-run "bring your content" onboarding (OB-301) ([#57](https://github.com/eliotlim/OpenBook/pull/57))
- **ui:** HTML import (file + paste) (Import T3) ([#65](https://github.com/eliotlim/OpenBook/pull/65))
- **ui:** native image block (data-URL phase-1) (Assets A0) ([#67](https://github.com/eliotlim/OpenBook/pull/67))
- **ui:** render images in HTML/Markdown/PDF export (Assets A3) ([#69](https://github.com/eliotlim/OpenBook/pull/69))

### 🩹 Fixes

- **desktop:** stream SSE end-to-end through the forwarding tunnel (OB-284) ([#49](https://github.com/eliotlim/OpenBook/pull/49))
- **desktop:** harden tunnel streaming — orphan reap + compact chunk encode (OB-285) ([#50](https://github.com/eliotlim/OpenBook/pull/50), [#1](https://github.com/eliotlim/OpenBook/issues/1))
- **sdk:** poll-fallback for tunnel live-updates when SSE can't stream (OB-283) ([#48](https://github.com/eliotlim/OpenBook/pull/48))

### 🔥 Performance

- **collab:** harden the tunneled relay path under multi-editor load (Collab T8) ([#62](https://github.com/eliotlim/OpenBook/pull/62))
- **server:** ETag/304 + serving hardening for assets (Assets A5) ([#72](https://github.com/eliotlim/OpenBook/pull/72))
- **ui:** offload import parsing to an inline Web Worker + watchdog (OB-303 / Import T7) ([#60](https://github.com/eliotlim/OpenBook/pull/60))

### ❤️ Thank You

- Eliot Lim @eliotlim

## 1.66.0 (2026-06-30)

### 🚀 Features

- **e2e:** suite tiering, parallelisation & flake-hardening (OB-219) ([#44](https://github.com/eliotlim/OpenBook/pull/44))
- **ui:** wire five DS interaction tokens into primitives (OB-273) ([#39](https://github.com/eliotlim/OpenBook/pull/39))

### 🩹 Fixes

- **ui:** page-title rename no longer reverts under a save-echo race (OB-278) ([#46](https://github.com/eliotlim/OpenBook/pull/46))

### ❤️ Thank You

- Claude Opus 4.8 (1M context)
- Eliot Lim @eliotlim

## 1.65.1 (2026-06-29)

### 🩹 Fixes

- **desktop:** stop orphaning the sidecar on non-graceful exit (parent-death + Exit + reaper) ([#38](https://github.com/eliotlim/OpenBook/pull/38))
- **sdk:** heal stale forwarding host on attach (book.pub→book.cloud) ([#37](https://github.com/eliotlim/OpenBook/pull/37))

### ❤️ Thank You

- Claude Opus 4.8 (1M context)
- Eliot Lim @eliotlim

## 1.65.0 (2026-06-29)

### 🚀 Features

- **server:** mirror no-op write skip + write-amp budget + convergence invariant + soak (ER-1/2/3/4) ([#30](https://github.com/eliotlim/OpenBook/pull/30))
- **server:** single-owner DirLock + pglite dataDir lock + WriteBudgetError hardening (ER-5) ([#31](https://github.com/eliotlim/OpenBook/pull/31))
- **server:** idempotent /api/import + client write-replay idempotency (ER-6/7) ([#32](https://github.com/eliotlim/OpenBook/pull/32))
- **server:** consume JWS revocation list to reject revoked tokens (OB-106) ([#35](https://github.com/eliotlim/OpenBook/pull/35))

### 🩹 Fixes

- **cleanup:** ER-9 low-severity bundle ([#34](https://github.com/eliotlim/OpenBook/pull/34))
- **server:** converge book-mirror conflict path to stop "(conflicted copy)" write storm (OB-241) ([#29](https://github.com/eliotlim/OpenBook/pull/29))
- **ui:** make groupSync valueEqual structural for plain objects (ER-8) ([#33](https://github.com/eliotlim/OpenBook/pull/33))

### ❤️ Thank You

- Claude Opus 4.8 (1M context)
- Eliot Lim @eliotlim

## 1.64.0 (2026-06-28)

### 🚀 Features

- sharing & membership program — remaining issues (review by commits) ([#26](https://github.com/eliotlim/OpenBook/pull/26))

### 🩹 Fixes

- **release:** bundle Linux AppImage with the Bun sidecar (patch linuxdeploy GTK plugin) ([#27](https://github.com/eliotlim/OpenBook/pull/27), [#8604](https://github.com/eliotlim/OpenBook/issues/8604), [#147](https://github.com/eliotlim/OpenBook/issues/147))

### ❤️ Thank You

- Claude Opus 4.8 (1M context)
- Eliot Lim @eliotlim

## 1.63.0 (2026-06-28)

### 🚀 Features

- **server:** members + per-page visibility/ACL schema (OB-188) ([7784528](https://github.com/eliotlim/OpenBook/commit/7784528))
- **server:** access-control core — roster, roles, per-page ACL, enforcement (Epic A · OB-189–191) ([#23](https://github.com/eliotlim/OpenBook/pull/23))
- **ui:** emoji autocomplete via ":" trigger in the block editor ([c500f4e](https://github.com/eliotlim/OpenBook/commit/c500f4e))
- **ui:** title ⇄ editor caret hand-off ([0a66fcc](https://github.com/eliotlim/OpenBook/commit/0a66fcc))
- **ui:** whole-document read-only / viewer rendering (OB-205) ([#24](https://github.com/eliotlim/OpenBook/pull/24))

### 🩹 Fixes

- **ui:** address review on block-editor muscle-memory (menus, a11y, i18n, colon-insert) ([d71828a](https://github.com/eliotlim/OpenBook/commit/d71828a))

### ❤️ Thank You

- Claude Opus 4.8 (1M context)
- Eliot Lim @eliotlim

## 1.62.0 (2026-06-27)

### 🚀 Features

- **server:** multi-user identity, guest gate & change provenance (OB-165) ([7ea2483](https://github.com/eliotlim/OpenBook/commit/7ea2483))
- **server:** scheduled tiered backups (OB-166) ([b0d41fd](https://github.com/eliotlim/OpenBook/commit/b0d41fd))
- **server:** bound edit-log growth with a retention sweep (OB-165) ([a860962](https://github.com/eliotlim/OpenBook/commit/a860962))
- **server:** server-stamp verified author identity on suggestions/comments (OB-165) ([20942df](https://github.com/eliotlim/OpenBook/commit/20942df))
- **server:** carry verified authorship through the sync/merge path (OB-170) ([fe7ddc9](https://github.com/eliotlim/OpenBook/commit/fe7ddc9))
- **server:** audience-bind the identity verifier (OB-177) ([4809679](https://github.com/eliotlim/OpenBook/commit/4809679))
- **ui:** client identity plumbing + guest-access UI (OB-165) ([29a2ea9](https://github.com/eliotlim/OpenBook/commit/29a2ea9))
- **ui:** fetch + send account-issued identity JWS; default-trust the issuer (OB-165) ([be09732](https://github.com/eliotlim/OpenBook/commit/be09732))
- **ui:** "edited by" provenance indicator in the page header (OB-165) ([ca2b548](https://github.com/eliotlim/OpenBook/commit/ca2b548))

### ❤️ Thank You

- Claude Opus 4.8 (1M context)
- Eliot Lim

## 1.61.3 (2026-06-26)

### 🩹 Fixes

- **ui:** sidebar settings/menu buttons highlight on press, not shrink ([81334ce](https://github.com/eliotlim/OpenBook/commit/81334ce))

### ❤️ Thank You

- Claude Opus 4.8 (1M context)
- Eliot Lim

## 1.61.2 (2026-06-26)

### 🩹 Fixes

- **app:** remove comments from entitlements.plist (AMFI parse error) ([fbcadab](https://github.com/eliotlim/OpenBook/commit/fbcadab))

### ❤️ Thank You

- Claude Opus 4.8 (1M context)
- Eliot Lim

## 1.61.1 (2026-06-26)

### 🩹 Fixes

- **ci:** force bash for the Tauri build step (Windows PowerShell chokes on @book.dev/app) ([c5c9568](https://github.com/eliotlim/OpenBook/commit/c5c9568))
- **ci:** don't fail the release plan when no release is due ([9735e94](https://github.com/eliotlim/OpenBook/commit/9735e94))
- **ui:** make the split-pane spine shadow darker in dark mode ([424955b](https://github.com/eliotlim/OpenBook/commit/424955b))

### ❤️ Thank You

- Claude Opus 4.8 (1M context)
- Eliot Lim

## 1.61.0 (2026-06-26)

### 🚀 Features

- ipc support for dev server ([bd67271](https://github.com/eliotlim/OpenBook/commit/bd67271))
- **ci:** sign + notarize macOS builds and ship per-arch ([dc470d9](https://github.com/eliotlim/OpenBook/commit/dc470d9))
- **ui:** add a compact-database button to reclaim PGlite bloat (OB-164) ([116b708](https://github.com/eliotlim/OpenBook/commit/116b708))

### 🩹 Fixes

- site keychain management ([31b3312](https://github.com/eliotlim/OpenBook/commit/31b3312))
- **server:** self-maintain PGlite + skip no-op saves (OB-164) ([daa1ca0](https://github.com/eliotlim/OpenBook/commit/daa1ca0))

### ❤️ Thank You

- Claude Opus 4.8 (1M context)
- Eliot Lim

## 1.60.0 (2026-06-22)

### 🚀 Features

- **web:** serve the forwarded instance's workspace on a *.book.pub site ([003654d](https://github.com/eliotlim/OpenBook/commit/003654d))

### 🩹 Fixes

- **forwarding:** default the tunnel client region to sin1 ([282857b](https://github.com/eliotlim/OpenBook/commit/282857b))

### ❤️ Thank You

- Claude Opus 4.8 (1M context)
- Eliot Lim

## 1.59.0 (2026-06-21)

### 🚀 Features

- in-webview data layer (LocalDataClient + browser entry) ([eee1eb7](https://github.com/eliotlim/OpenBook/commit/eee1eb7))
- shared folder serialisation (spaceToBookFiles) ([8c1a0b1](https://github.com/eliotlim/OpenBook/commit/8c1a0b1))
- web runs in-webview pglite + book folder export/import ([996076c](https://github.com/eliotlim/OpenBook/commit/996076c))
- desktop runs in-app by default, port only on publish ([d4866ce](https://github.com/eliotlim/OpenBook/commit/d4866ce))
- forward-to-web toggle (device key + site registration) ([35d34a2](https://github.com/eliotlim/OpenBook/commit/35d34a2))
- forward live — serve the local server over the relay tunnel (no port) ([f5cb470](https://github.com/eliotlim/OpenBook/commit/f5cb470))
- **account:** paste-a-code sign-in fallback for when the deep link can't fire ([1b3d616](https://github.com/eliotlim/OpenBook/commit/1b3d616))
- **app:** publishable LAN server + book-folder picker in the Tauri host ([3054ef0](https://github.com/eliotlim/OpenBook/commit/3054ef0))
- **connection:** access-token field for direct remote-server connections ([555e23c](https://github.com/eliotlim/OpenBook/commit/555e23c))
- **desktop:** durable book-file mirror + single-owner store (OB-128) ([7e85a36](https://github.com/eliotlim/OpenBook/commit/7e85a36))
- **desktop:** reach the durable local server over IPC, port only on publish ([cd7eb34](https://github.com/eliotlim/OpenBook/commit/cd7eb34))
- **sdk:** make HttpDataClient transport-pluggable ([1934509](https://github.com/eliotlim/OpenBook/commit/1934509))
- **sdk:** port the forwarding client + protocol core from open.book.pub ([16fb542](https://github.com/eliotlim/OpenBook/commit/16fb542))
- **server:** listen on a unix domain socket (portless desktop ipc) ([ee80a75](https://github.com/eliotlim/OpenBook/commit/ee80a75))
- **server,sdk:** access-token auth for a published LAN server ([98e5476](https://github.com/eliotlim/OpenBook/commit/98e5476))
- **ui:** mobile sidebar opens as an overlay instead of squishing the page ([4de6dd1](https://github.com/eliotlim/OpenBook/commit/4de6dd1))
- **ui:** rock-type grays, always-on tint, in-house icon picker, configurable blur ([044f471](https://github.com/eliotlim/OpenBook/commit/044f471))
- **ui,app:** settings sharing panel + token-aware desktop client ([bd53342](https://github.com/eliotlim/OpenBook/commit/bd53342))

### 🩹 Fixes

- **connection:** warn on mixed-content remote URLs instead of failing silently ([4c4a18d](https://github.com/eliotlim/OpenBook/commit/4c4a18d))
- **forwarding:** send the site routing hint on the relay tunnel WS ([04039f0](https://github.com/eliotlim/OpenBook/commit/04039f0))
- **forwarding:** mint a fresh attach ticket per (re)connect ([a420e16](https://github.com/eliotlim/OpenBook/commit/a420e16))
- **sdk:** bind the default fetch so forwarding works in WKWebView ([f8d9de1](https://github.com/eliotlim/OpenBook/commit/f8d9de1))

### ❤️ Thank You

- Claude Opus 4.8 (1M context)
- Eliot Lim

## 1.58.0 (2026-06-19)

### 🚀 Features

- database groups ([c09a621](https://github.com/eliotlim/OpenBook/commit/c09a621))
- account support ([48a908b](https://github.com/eliotlim/OpenBook/commit/48a908b))
- tighten account handling ([01b1d47](https://github.com/eliotlim/OpenBook/commit/01b1d47))

### ❤️ Thank You

- Eliot Lim

## 1.57.1 (2026-06-18)

### 🚀 Features

- **ai:** assistant pane focus, settings sub-panels, feature visibility, model picker ([b52304b](https://github.com/eliotlim/OpenBook/commit/b52304b))

### ❤️ Thank You

- Claude Opus 4.8
- Eliot Lim

## 1.57.0 (2026-06-17)

### 🚀 Features

- agent interviews and block deletion ([3858079](https://github.com/eliotlim/OpenBook/commit/3858079))
- block updates and replacement ([b9a5dd5](https://github.com/eliotlim/OpenBook/commit/b9a5dd5))

### ❤️ Thank You

- Eliot Lim

## 1.56.0 (2026-06-17)

### 🚀 Features

- db swimlane reordering ([938f878](https://github.com/eliotlim/OpenBook/commit/938f878))

### ❤️ Thank You

- Eliot Lim

## 1.55.0 (2026-06-17)

### 🚀 Features

- md streaming and db improvements ([f8cb0c5](https://github.com/eliotlim/OpenBook/commit/f8cb0c5))
- page structure, appearance settings, and agent tools ([6258f7c](https://github.com/eliotlim/OpenBook/commit/6258f7c))

### ❤️ Thank You

- Eliot Lim

## 1.54.0 (2026-06-16)

### 🚀 Features

- add Claude (Anthropic API) as an AI engine option ([bec64a0](https://github.com/eliotlim/OpenBook/commit/bec64a0))
- add multi-provider support ([5437621](https://github.com/eliotlim/OpenBook/commit/5437621))
- improve system prompt ([c25d424](https://github.com/eliotlim/OpenBook/commit/c25d424))

### ❤️ Thank You

- Claude Opus 4.8
- Eliot Lim

## 1.53.2 (2026-06-16)

### 🩹 Fixes

- reactive HTML export refs + vector PDF rendered from HTML ([de37b29](https://github.com/eliotlim/OpenBook/commit/de37b29))
- render sliders cleanly in PDF export ([31a6c08](https://github.com/eliotlim/OpenBook/commit/31a6c08))
- resolve grouped-input references consistently in exports ([197d2f9](https://github.com/eliotlim/OpenBook/commit/197d2f9))

### ❤️ Thank You

- Claude Opus 4.8
- Eliot Lim

## 1.53.1 (2026-06-15)

### 🩹 Fixes

- html and pdf exports ([cf39d7e](https://github.com/eliotlim/OpenBook/commit/cf39d7e))

### ❤️ Thank You

- Eliot Lim

## 1.53.0 (2026-06-15)

### 🚀 Features

- db timeline improvements 2 ([26b8c2b](https://github.com/eliotlim/OpenBook/commit/26b8c2b))

### ❤️ Thank You

- Eliot Lim

## 1.52.0 (2026-06-15)

### 🚀 Features

- db timeline improvements ([853feb1](https://github.com/eliotlim/OpenBook/commit/853feb1))

### ❤️ Thank You

- Eliot Lim

## 1.51.0 (2026-06-15)

### 🚀 Features

- db timeline and cards ([4676cd7](https://github.com/eliotlim/OpenBook/commit/4676cd7))

### ❤️ Thank You

- Eliot Lim

## 1.50.0 (2026-06-15)

### 🚀 Features

- relations and theming improvements ([d3674ba](https://github.com/eliotlim/OpenBook/commit/d3674ba))

### ❤️ Thank You

- Eliot Lim

## 1.49.0 (2026-06-15)

### 🚀 Features

- better templates 2 ([83ce689](https://github.com/eliotlim/OpenBook/commit/83ce689))

### ❤️ Thank You

- Eliot Lim

## 1.48.0 (2026-06-15)

### 🚀 Features

- better templates ([94a4d7c](https://github.com/eliotlim/open-book/commit/94a4d7c))

### ❤️ Thank You

- Eliot Lim

## 1.47.1 (2026-06-15)

### 🩹 Fixes

- ui, code block, and accent improvements ([44b212a](https://github.com/eliotlim/open-book/commit/44b212a))

### ❤️ Thank You

- Eliot Lim

## 1.47.0 (2026-06-14)

### 🚀 Features

- themed OpenBook logo across web and desktop ([9cd7bd6](https://github.com/eliotlim/open-book/commit/9cd7bd6))
- improve logo placement ([a368e9b](https://github.com/eliotlim/open-book/commit/a368e9b))
- appearance and theming improvements ([89e92d8](https://github.com/eliotlim/open-book/commit/89e92d8))
- improvements to page actions and blocks ([8705e3c](https://github.com/eliotlim/open-book/commit/8705e3c))
- menu and link picker improvements ([dc8a0f0](https://github.com/eliotlim/open-book/commit/dc8a0f0))
- linked database blocks ([849934d](https://github.com/eliotlim/open-book/commit/849934d))
- configure menu improvements ([9981256](https://github.com/eliotlim/open-book/commit/9981256))
- groups, configuration, and editor improvements ([2a6770a](https://github.com/eliotlim/open-book/commit/2a6770a))
- theming improvements and user experience polish ([1649d2d](https://github.com/eliotlim/open-book/commit/1649d2d))
- improve variable mechanism ([96ed72e](https://github.com/eliotlim/open-book/commit/96ed72e))
- page covers, appearance, and typefaces ([70cae69](https://github.com/eliotlim/open-book/commit/70cae69))
- improve drag drop and blocks ([d901c46](https://github.com/eliotlim/open-book/commit/d901c46))
- june-2026 slate — map view, swimlanes, kit components, AI review ([a452348](https://github.com/eliotlim/open-book/commit/a452348))
- migrate expr and slider blocks and ui improvements ([891bd0b](https://github.com/eliotlim/open-book/commit/891bd0b))
- present mode — slide deck with presenter view, speaker notes, slide exports ([33ff2cd](https://github.com/eliotlim/open-book/commit/33ff2cd))

### 🩹 Fixes

- alignment and styling of editor components ([d90cf0e](https://github.com/eliotlim/open-book/commit/d90cf0e))
- ignore lint on release ([b8497d9](https://github.com/eliotlim/open-book/commit/b8497d9))
- pane-aware link navigation and notebook book-cover chrome ([6f34d36](https://github.com/eliotlim/open-book/commit/6f34d36))
- side-pane link navigation drives the primary pane ([148e210](https://github.com/eliotlim/open-book/commit/148e210))

### ❤️ Thank You

- Claude Opus 4.8
- Eliot Lim