# Development

## Prerequisites

- Node.js `^22.14.0 || >=24.10.0`. `.nvmrc` pins Node 24.
- [pnpm](https://pnpm.io/installation). The repository pins the version.
- Bun `1.3.14` for the server sidecar.
- A [Rust toolchain](https://www.rust-lang.org/tools/install) for the desktop app.

## Setup

```sh
corepack enable
pnpm install
pnpm dev
```

`pnpm dev` starts the SDK, server, UI, web, and desktop development loops.
`pnpm build` is a full production build.

## Storage and server

OpenBook stores documents as pages: a UUID, an optional name, and JSON data in
Postgres. The desktop and headless deployments use the same TypeScript server.
The desktop bundles it as a Bun sidecar with embedded PGlite. Headless
deployments use external Postgres.

The web app, desktop app, and server share types and the HTTP client through
[`@book.dev/sdk`](packages/sdk/README.md).

- [`packages/sdk`](packages/sdk/README.md): shared types and `HttpDataClient`.
- [`packages/server`](packages/server/README.md): Hono API and page store for
  embedded or external Postgres.

Run the headless server:

```sh
OPENBOOK_DATABASE_URL=postgres://user:pass@host:5432/openbook \
  pnpm --filter @book.dev/server dev
```

Without `OPENBOOK_DATABASE_URL`, the development server uses embedded PGlite.

## Further reading

- [Architecture](ARCHITECTURE.md)
- [Plugins](PLUGINS.md)
- [Release updates](docs/release-updates.md)
- [Backup and restore](docs/ledger/backup-restore.md)
