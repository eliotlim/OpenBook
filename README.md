# OpenBook

OpenBook is a place to write and organize knowledge.

Store thoughts, notes, and ideas in a simple and intuitive way.

## Getting Started

> [!IMPORTANT]
> OpenBook is currently in active development.
> Please make regular backups of your data while using it.

Download OpenBook from the [Releases page](https://github.com/eliotlim/openbook/releases).

Alternatively, you can build it from source.

### Prerequisites

* [Node.JS 18.x or later](https://nodejs.org/en/download)
* [pnpm](https://pnpm.io/installation) (pinned via the `packageManager` field — `corepack enable` will install it automatically)
* [Rust toolchain](https://www.rust-lang.org/tools/install) (for the desktop apps)

## Setting up development environment

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
[`@open-book/sdk`](packages/sdk/README.md).

Packages:

- [`packages/sdk`](packages/sdk/README.md) — shared types + `HttpDataClient`.
- [`packages/server`](packages/server/README.md) — page store + Hono API,
  backed by PGlite (embedded) or external Postgres. Full architecture and
  deployment modes documented there.

Run the headless server:

```sh
OPENBOOK_DATABASE_URL=postgres://user:pass@host:5432/openbook \
  pnpm --filter @open-book/server dev
```

`pnpm dev` runs the SDK, server (with embedded Postgres), UI, web, and desktop
together.
