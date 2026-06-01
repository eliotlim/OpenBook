# @open-book/server

The OpenBook server: a page store (Postgres) and HTTP API written in
TypeScript. **The desktop app and the headless deployment run this exact same
code** — they differ only in how Postgres is provided.

## One server, two modes

```
                         ┌───────────────────────────┐
                         │      @open-book/sdk        │  types + HTTP client
                         │  Page · PageInput · API    │  (shared everywhere)
                         └─────────────┬─────────────┘
                                       │
                         ┌─────────────▼─────────────┐
                         │     @open-book/server      │  PageStore + Hono API
                         │  startServer({...})        │
                         └──────┬──────────────┬──────┘
              embedded (no URL) │              │ DATABASE_URL
                  ┌─────────────▼───┐    ┌─────▼─────────────────┐
                  │  Desktop (Tauri)│    │  Headless deployment  │
                  │  sidecar + local│    │  node dist/bin.js     │
                  │  embedded pg    │    │  + external Postgres  │
                  └─────────────────┘    └───────────────────────┘
```

- **Embedded (desktop).** `startServer({ dataDir })` boots a real Postgres
  locally under `dataDir` (via [`embedded-postgres`]) and serves the API on
  loopback. The Tauri host bundles this program as a sidecar and spawns it.
- **Server (headless).** `startServer({ databaseUrl })` connects to an external
  Postgres. `node dist/bin.js` with `OPENBOOK_DATABASE_URL` set.

Both run the same `PageStore`, the same migrations, and the same Hono routes.

## HTTP API

Paths come from `@open-book/sdk` (`API`), so the server and `HttpDataClient`
cannot disagree.

| Method | Path               | Body        | Response        |
| ------ | ------------------ | ----------- | --------------- |
| GET    | `/health`          | —           | `ok`            |
| GET    | `/api/pages`       | —           | `PageMeta[]`    |
| POST   | `/api/pages`       | `PageInput` | `201` `StoredPage` |
| GET    | `/api/pages/:id`   | —           | `StoredPage` / `404` |
| PUT    | `/api/pages/:id`   | `PageInput` | `StoredPage` (upsert) |
| DELETE | `/api/pages/:id`   | —           | `204` / `404`   |

JSON is camelCase; errors are `{ "error": "..." }` (`404`, `409` name conflict,
`500`).

## Schema

```sql
CREATE TABLE pages (
  id          UUID PRIMARY KEY,
  name        TEXT,                          -- optional, unique when present
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pages_name_key ON pages (name) WHERE name IS NOT NULL;
```

Migrations (`src/migrations.ts`) are tracked in a `_migrations` table and run on
every boot.

## Running headless

```sh
export OPENBOOK_DATABASE_URL=postgres://user:pass@host:5432/openbook
export OPENBOOK_BIND=0.0.0.0:4319        # optional (default)
pnpm --filter @open-book/server dev      # tsx, watch mode
# or, built:
pnpm --filter @open-book/server build && node packages/server/dist/bin.js
```

Config (flags or env):

| Flag             | Env                        | Meaning                                  |
| ---------------- | -------------------------- | ---------------------------------------- |
| `--data-dir`     | `OPENBOOK_DATA_DIR`        | Embedded cluster location (embedded mode)|
| —                | `OPENBOOK_DATABASE_URL` / `DATABASE_URL` | External Postgres (server mode) |
| `--bind`         | `OPENBOOK_BIND`            | `host:port` to listen on                 |
| `--host` `--port`| —                          | Listen host / port (default `127.0.0.1:4319`) |
| `--embedded-port`| `OPENBOOK_EMBEDDED_PORT`   | Embedded Postgres cluster port (default `5433`) |

On startup it prints `OPENBOOK_READY <url>` — the desktop host parses this line.

## Desktop sidecar

`pnpm --filter @open-book/server build:sidecar` compiles this server into a
single executable (via [Bun](https://bun.sh)) at
`packages/app/src-tauri/binaries/openbook-server-<triple>`, which Tauri bundles
and launches in release builds. In dev the server is run directly via `tsx` (see
the root `dev` script), so the desktop webview connects to it on
`127.0.0.1:4319` without a sidecar.

[`embedded-postgres`]: https://www.npmjs.com/package/embedded-postgres
