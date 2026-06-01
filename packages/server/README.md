# @open-book/server

The OpenBook server: a page store and HTTP API written in TypeScript. **The
desktop app and the headless deployment run this exact same code** — they differ
only in which database backend is used.

## One server, two backends

```
                         ┌───────────────────────────┐
                         │      @open-book/sdk        │  types + HTTP client
                         │  Page · PageInput · API    │  (shared everywhere)
                         └─────────────┬─────────────┘
                                       │
                         ┌─────────────▼─────────────┐
                         │     @open-book/server      │  PageStore + Hono API
                         │  startServer({...})        │  over a `Db` interface
                         └──────┬──────────────┬──────┘
              embedded (dataDir)│              │ databaseUrl
                  ┌─────────────▼───┐    ┌─────▼─────────────────┐
                  │  Desktop (Tauri)│    │  Headless deployment  │
                  │  PGlite (WASM)  │    │  node dist/bin.js     │
                  │  sidecar binary │    │  + external Postgres  │
                  └─────────────────┘    └───────────────────────┘
```

There is one `PageStore` and one HTTP API. They run over a small [`Db`](src/db.ts)
interface with two implementations:

- **`PgliteDb`** — [PGlite](https://pglite.dev) (Postgres compiled to WASM),
  in-process, persisted to a directory. Used for the embedded desktop database.
- **`PostgresDb`** — a real Postgres over the wire via the `postgres` driver.
  Used for the headless server and any remote connection.

Both speak the same Postgres SQL, so the queries and migrations are identical.

## HTTP API

Paths come from `@open-book/sdk` (`API`), so the server and `HttpDataClient`
cannot disagree.

| Method | Path               | Body        | Response             |
| ------ | ------------------ | ----------- | -------------------- |
| GET    | `/health`          | —           | `ok`                 |
| GET    | `/api/pages`       | —           | `PageMeta[]`         |
| POST   | `/api/pages`       | `PageInput` | `201` `StoredPage`   |
| GET    | `/api/pages/:id`   | —           | `StoredPage` / `404` |
| PUT    | `/api/pages/:id`   | `PageInput` | `StoredPage` (upsert)|
| DELETE | `/api/pages/:id`   | —           | `204` / `404`        |

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

Migrations live in [`src/migrations.ts`](src/migrations.ts), are tracked in a
`_migrations` table, and run on every boot in both backends.

## Running headless

```sh
export OPENBOOK_DATABASE_URL=postgres://user:pass@host:5432/openbook
export OPENBOOK_BIND=0.0.0.0:4319        # optional (default)
pnpm --filter @open-book/server dev      # tsx, embedded PGlite, watch mode
# or built:
pnpm --filter @open-book/server build && node packages/server/dist/bin.js
```

Config (flags or env):

| Flag             | Env                                       | Meaning                                       |
| ---------------- | ----------------------------------------- | --------------------------------------------- |
| `--data-dir`     | `OPENBOOK_DATA_DIR`                       | Embedded PGlite location (embedded mode)      |
| —                | `OPENBOOK_DATABASE_URL` / `DATABASE_URL`  | External Postgres (server mode)               |
| `--bind`         | `OPENBOOK_BIND`                           | `host:port` to listen on                      |
| `--host` `--port`| —                                         | Listen host / port (default `127.0.0.1:4319`) |

On startup it prints `OPENBOOK_READY <url>` — the desktop host parses this line.

## Desktop sidecar

`pnpm --filter @open-book/server build:sidecar` compiles the server into a single
self-contained executable (via [Bun](https://bun.sh)) at
`packages/app/src-tauri/binaries/openbook-server-<triple>`. It **embeds PGlite's
WASM/data assets** (see `bin.bun.ts` + `pglite-assets.bun.ts`), so the binary
runs with nothing else on disk. Tauri bundles and launches it in release builds;
`tauri build`'s `beforeBuildCommand` runs this automatically. In dev the server
is run directly via `tsx`, so the desktop webview connects to `127.0.0.1:4319`
without a sidecar.

## Entrypoints

- `src/bin.ts` — Node entry (headless + `pnpm dev`). PGlite loads its own WASM.
- `src/bin.bun.ts` — Bun entry (compiled sidecar). Embeds the WASM assets.
- Both call the shared `src/cli.ts`.
