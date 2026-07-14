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