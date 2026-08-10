# OpenBook

**A safe space for your notes.** OpenBook is a free, [open-source](LICENSE)
(MIT), local-first app for writing and organizing knowledge — where a document
isn't just text, it can *compute*.

![OpenBook — a document with a slider driving a live chart](docs/media/hero-reactive-kit.png)

Your work lives on your machine first. OpenBook runs as a desktop app that keeps
everything in a local database on your own device, so your notes stay yours and
the app doesn't phone home or collect anything about how you use it. Want your
pages on another device, or shared with other people? Sync is optional — and you
can host it yourself. Curious how any of it works? [Check out the source on
GitHub](https://github.com/eliotlim/openbook).

## What you can build

**Documents that compute.** The block editor ships an **artifact kit**: named
inputs (sliders, number steppers, text fields, radio groups, checklists,
toggles, locations, action buttons) publish values onto a shared reactive scope,
and live blocks compute over it — formulas, charts (line, area, bar, pie, donut,
scatter, funnel), and status lights. Assemble a calculator, a picker, or a tiny
dashboard out of blocks — collaborative by default, and the interactive HTML
export keeps the computation alive offline. A **dataflow view** (page menu →
"Dataflow view") opens the page's reactive wiring as a live node graph in the
split pane: inputs flowing into code into charts, values updating as you edit,
nodes clicking through to their blocks.

**Databases live inside pages.** A page can host a **database** (a Notion-style
collection in its own table). Database rows are themselves ordinary pages — each
with its own editable document — so a row opens in a split pane for editing.
Columns are typed properties, or `expr` columns that read a row page's live
exported reactive value, and every view can filter and sort.

**Pages nest.** A page can be a child of another (cascading on delete), so the
sidebar is a tree and the breadcrumb shows the full path. Inside the editor, a
**Page** or **Database** block links a child inline — it creates the nested page
on the spot and clicking it navigates there.

**Deletes are recoverable.** Deleting a page is a soft delete: it (and its
nested subtree) moves to the **Trash**, where it can be restored or removed for
good. A background cleanup job empties the trash after a configurable retention
window (default 30 days).

**Tabs are native.** Each page lives at its own URL (`?page=<id>`), so opening a
page elsewhere uses the platform: on the web a new browser tab or window, on the
desktop a macOS window-tab or a standalone window. A window can also split to
show two pages side by side.

**It's extensible.** Plugins — zips of TypeScript source — add custom blocks,
palette commands, and integrations (see [PLUGINS.md](PLUGINS.md)). Registries can
sign packages (Ed25519); the app verifies against keys you trust and badges
provenance.

## Sharing & sync

OpenBook works fully offline on a single device with nothing to sign up for. When
you do want to sync across devices or collaborate, you have two options: run the
same server yourself against your own Postgres (see [Storage &
server](#storage--server)), or publish a library to **book.cloud**, our hosted
service. Publishing to book.cloud needs a free account — that's how we keep out
abuse and fraud.

## Getting started

> [!NOTE]
> OpenBook backs itself up on a schedule (daily/weekly/monthly/yearly, on by
> default), and every backup — the ledger's audit trail and evidence included —
> is restore-tested in CI on both storage backends. See the
> [backup architecture & restore runbook](docs/ledger/backup-restore.md).

Download OpenBook from the [Releases page](https://github.com/eliotlim/openbook/releases).

Alternatively, you can build it from source.

### Prerequisites

* [Node.JS 18.x or later](https://nodejs.org/en/download)
* [pnpm](https://pnpm.io/installation) (pinned via the `packageManager` field — `corepack enable` will install it automatically)
* [Rust toolchain](https://www.rust-lang.org/tools/install) (for the desktop apps)

### Setting up the development environment

1. Download and install the [prerequisites](#prerequisites).
2. Install dependencies: `pnpm install`.
3. Build and start developing: `pnpm run build`.

## Storage & server

OpenBook stores documents as **pages** (UUID + optional name + JSON payload) in
Postgres. The server is written in TypeScript and **the desktop app and the
headless deployment run the exact same code** — the desktop bundles it as a
self-contained sidecar over an embedded Postgres (PGlite/WASM); a headless
deployment runs it against an external Postgres. The web shell, desktop, and
server all share types and the HTTP client through
[`@book.dev/sdk`](packages/sdk/README.md).

Packages:

- [`packages/sdk`](packages/sdk/README.md) — shared types + `HttpDataClient`.
- [`packages/server`](packages/server/README.md) — page store + Hono API,
  backed by PGlite (embedded) or external Postgres. Full architecture and
  deployment modes documented there.

Run the headless server:

```sh
OPENBOOK_DATABASE_URL=postgres://user:pass@host:5432/openbook \
  pnpm --filter @book.dev/server dev
```

`pnpm dev` runs the SDK, server (with embedded Postgres), UI, web, and desktop
together.

## Contributing

**Security:** Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md); do not open a public issue.

## License

OpenBook is released under the [MIT License](LICENSE).
