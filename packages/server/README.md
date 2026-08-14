# @book.dev/server

The OpenBook server: a page store and HTTP API written in TypeScript. **The
desktop app and the headless deployment run this exact same code** — they differ
only in which database backend is used.

## One server, two backends

```
                         ┌───────────────────────────┐
                         │      @book.dev/sdk        │  types + HTTP client
                         │  Page · PageInput · API    │  (shared everywhere)
                         └─────────────┬─────────────┘
                                       │
                         ┌─────────────▼─────────────┐
                         │     @book.dev/server      │  PageStore + Hono API
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

## Real-Postgres concurrency tests

The default `pnpm test` path stays on PGlite, whose store mutex deliberately
serializes calls. The CWD-11 suite instead uses `PostgresDb` with a connection
pool so MVCC write races remain observable. Run the pinned local service and
the dedicated suite from the repository root:

```sh
docker compose -f docker-compose.test-pg.yml up -d --wait
OPENBOOK_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres pnpm --filter @book.dev/server test:pg
docker compose -f docker-compose.test-pg.yml down -v
```

The URL must name an administrative database on a server where the test user
may create and drop scratch databases. Each test gets a migrated, uniquely
named database and drops it afterward. With no URL, `test:pg` exits successfully
after printing a prominent skip notice. CI sets
`OPENBOOK_REQUIRE_CONCURRENCY_PG=1`, which forbids that skip.

The test-only primitives in `src/testUtils/concurrency.ts` make interleavings
repeatable:

- `runConcurrently` launches N store calls behind one start gate.
- `createBarrier` divides caller work into explicit read and write phases.
- `withQueryBarrier` decorates `Db`, including transaction handles, and pauses
  the first N matching queries after their rows have been read. This exposes an
  internal stale-snapshot window without adding delay hooks to `PageStore`.

The CWD-2, CWD-3, and CWD-4 assertions are `test.fails` while their lost-update
races are live. Their one-line comments identify the issue that changes each to
a plain test once fixed. A passing control covers property-patch overlap with
`renamePage` and `upsertPage`, whose writes currently touch disjoint columns.

The stale snapshot-PUT versus collab persister checkpoint stretch is deferred.
Calling `saveServerDoc` directly could manufacture a store-level overwrite,
but would bypass the full collab stack's debounce, canonical Yjs document, and
checkpoint scheduling; such a test would not prove the production race named by
the criterion. That case belongs in the later collab-backed concurrency leg.

## HTTP API

Paths come from `@book.dev/sdk` (`API`), so the server and `HttpDataClient`
cannot disagree.

| Method | Path               | Body        | Response             |
| ------ | ------------------ | ----------- | -------------------- |
| GET    | `/health`          | —           | `ok`                 |
| GET    | `/api/pages`       | —           | `PageMeta[]`         |
| POST   | `/api/pages`       | `PageInput` | `201` `StoredPage`   |
| GET    | `/api/pages/:id`   | —           | `StoredPage` / `404` |
| PUT    | `/api/pages/:id`   | `PageInput` | `StoredPage` (upsert)|
| DELETE | `/api/pages/:id`   | —           | `204` / `404`        |

JSON is camelCase; errors are `{ "error": "..." }` (`404`, `409` conflict,
`500`).

## Schema

```sql
CREATE TABLE pages (
  id          UUID PRIMARY KEY,
  name        TEXT,                          -- optional display label (not unique)
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pages_name_idx ON pages (name) WHERE name IS NOT NULL AND deleted_at IS NULL;
```

Migrations live in [`src/migrations.ts`](src/migrations.ts), are tracked in a
`_migrations` table, and run on every boot in both backends.

## Running headless

```sh
export OPENBOOK_DATABASE_URL=postgres://user:pass@host:5432/openbook
export OPENBOOK_BIND=0.0.0.0:4319        # optional (default)
pnpm --filter @book.dev/server dev      # tsx, embedded PGlite, watch mode
# or built:
pnpm --filter @book.dev/server build && node packages/server/dist/bin.js
```

Config (flags or env):

| Flag                  | Env                                       | Meaning                                       |
| --------------------- | ----------------------------------------- | --------------------------------------------- |
| `--data-dir`          | `OPENBOOK_DATA_DIR`                       | Embedded PGlite location (embedded mode)      |
| —                     | `OPENBOOK_DATABASE_URL` / `DATABASE_URL`  | External Postgres (server mode)               |
| `--bind`              | `OPENBOOK_BIND`                           | `host:port` to listen on                      |
| `--host` `--port`     | —                                         | Listen host / port (default `127.0.0.1:4319`) |
| `--ledger-export-root`| `OPENBOOK_LEDGER_EXPORT_ROOTS`            | Extra dirs the ledger auto-export may write into |
| `--verify-ledger`     | —                                         | Run the ledger verifier and exit (0 clean / 1 findings / 2 error) |

On startup it prints `OPENBOOK_READY <url>` — the desktop host parses this line.

### Ledger auto-export roots

The ledger's insurance export (owner-set `ledgerAutoExportPath` in instance
policy) writes the canonical postings CSV to a path the **owner** chooses, so
that path is fenced to a fixed set of directories. The fence is
process-level — nothing reachable over HTTP can widen it.

- Always allowed: **`<data-dir>/exports`** (created on demand). Deliberately not
  the data dir itself, which is the live PGlite directory.
- `--ledger-export-root <paths>` / `OPENBOOK_LEDGER_EXPORT_ROOTS=<paths>` add
  more. Both accept a list separated by the platform path delimiter (`:` on
  POSIX, `;` on Windows); the flag may also be repeated.
- Roots and the target's parent directory are compared as **real** paths, so a
  symlink planted inside a root cannot redirect the export out of the fence. A
  refused path is reported on stderr, never silently skipped.
- With no data dir and no configured root, **every** path is refused (fail closed).

## Desktop sidecar

`pnpm --filter @book.dev/server build:sidecar` compiles the server into a single
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
