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