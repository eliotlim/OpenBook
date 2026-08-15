# Ledger epic — platform capability audit (LGR-1)

Findings for the double-entry ledger epic: 4 ledger databases (accounts /
transactions / postings / reconciliations) with server-side enforcement and a
first-party plugin UI. Each of the five capability questions below is mapped to
**supported** / **needs platform work** / **impossible (as-is)**, with
file:line evidence against the current tree. The load-bearing negative (Q1) is
additionally proven empirically by `packages/sdk/src/ledgerPlatformAudit.test.ts`,
which pins today's row-local semantics as regression documentation.

## Q1 — Can `expr` / `formula` / `rollup` aggregate across database rows (SUM over another database, filtered)?

**Verdict: impossible (as-is).** Every derived-column mechanism is row-local.

- `expr` is a name lookup into the row's **own** page snapshot: `rowValue`
  returns `row.exports[cellName]` (`packages/sdk/src/database.ts:806`), and the
  exports bag is projected from a single page's `{values, names}` snapshot by
  `projectExports` (`packages/sdk/src/database.ts:681-688`). No cross-page input
  channel exists.
- `formula` evaluates per row against a `FormulaResolver` — a
  `(name) => value` lookup over the current row's properties
  (`packages/sdk/src/database.ts:767-791`). Its `sum` is **variadic over its
  arguments**, not a row aggregate: `sum: (a) => a.reduce(...)`
  (`packages/sdk/src/formula.ts:297`). `sum(prop("Amount"))` yields that row's
  amount, never the column total.
- `rollup` folds only rows reachable through a relation/dependency **cell**:
  `computeRollup` reads the ids stored in the relation property and resolves
  them within the passed `rows` array (`packages/sdk/src/database.ts:853-882`).
  An empty or foreign-id relation folds to 0 — there is no "all rows of
  database X where …" reach.
- Whole-database aggregation **does** exist — but only for charts:
  `aggregateDbSeries` folds a database's rows through the SDK `aggregateRows`
  pipeline (`packages/ui/src/blockeditor/kit/chartData.ts:113-141`). Its results
  are rendered, never published: the reactive scope only takes names from live
  code / formula blocks (`packages/ui/src/blockeditor/kit/scope.ts:288-289`),
  so no column or expr can consume a chart aggregate.

Empirical proof: `packages/sdk/src/ledgerPlatformAudit.test.ts` — (a) expr
resolution cannot see a sibling row, (b) formula `sum` doesn't fold rows,
(c) rollups reach only relation-linked rows, and unresolvable ids are dropped,
not fetched.

**Ledger consequence:** account balances and trial-balance checks cannot be
computed columns. They must be computed server-side (or by the ledger plugin)
and rendered by the plugin.

## Q2 — Can a plugin read/query arbitrary databases via the SDK?

**Verdict: needs platform work (epic task LGR-4).** The typed `PluginApi` is
blocks / commands / pages(list, get, create) / plugin-scoped storage / `fetch`
only (`packages/ui/src/plugins/api.ts:30-47`). There is no `databases` surface.
The full REST route table exists (`packages/sdk/src/routes.ts`) and is
reachable through `api.fetch`, so a plugin *can* hit
`GET /api/databases/:id/rows` today — but untyped, transport-coupled, and
broken in browser-local mode (see Q3). LGR-4 should add a typed
database-query surface to `PluginApi` backed by the `DataClient` so it works
across all three transports.

## Q3 — Can a plugin intercept/gate writes (pre-save validation)?

**Verdict: impossible (as-is) at the plugin layer — enforcement must live in
the STORE layer (epic task LGR-3).**

- No pre-save/validation hooks exist anywhere in the plugin or server surface.
- No schema validation on row writes: the PATCH row route passes the body
  straight through (`packages/server/src/app.ts:2673-2688`) and
  `store.updateRow` merges each defined key under a row lock (`null` deletes;
  absent/`undefined` preserves), while `setPageProperties` stores `null` — any
  JSON shape still lands (`packages/server/src/store.ts:3233-3282`).
- Route-level guards are bypassable anyway: in browser-local mode
  `LocalDataClient` implements `DataClient` by calling the store directly —
  no HTTP routes run at all (`packages/server/src/localClient.ts:79`, wired in
  `packages/web/src/pages/index.tsx:33-40`).
- **Precedent to follow:** the server-managed AI usage database — the store/app
  own the database and the API rejects end-user writes via `rejectManaged`
  (`packages/server/src/app.ts:1749-1753`, `packages/server/src/ai/usage.ts`).
  LGR-3 should make the four ledger databases store-managed the same way, with
  posting rules enforced in store methods so every transport (HTTP, local,
  desktop) hits the same wall.

## Q4 — Are attachments accessible to plugins for hashing?

**Verdict: needs platform work for plugin access (LGR-4); hashing itself is
already free.** Assets are content-addressed — the asset id **is** the SHA-256
of the bytes (`packages/server/src/store.ts:2918-2957`, `assetHash` at
`store.ts:332-341`). REST upload/download is gated per referencing page
(`packages/server/src/app.ts:880-936` upload, `:958-991` read, ETag = the
hash). There is no `PluginApi` asset surface, so a plugin can only reach assets
via raw `api.fetch` (same LGR-4 gap as Q2). **Evidence-manifest implication:**
recording an attachment's hash at posting time costs nothing extra — the id
returned by upload already is the hash; the ledger just stores it.

## Q5 — Is there an atomicity primitive for multi-row writes?

**Verdict: needs platform work (LGR-3).** Internally, transactions exist:
`Db.begin` runs a callback in a transaction (`packages/server/src/dbCore.ts:38-43`),
and the embedded PGlite backend serializes all access through a FIFO mutex
(`dbCore.ts:11-25`); the store uses `begin` for `upsertPage`, `reorderRows` and
friends (`store.ts:553, 926, 1152, …`). But **no multi-entity endpoint is
exposed**: creating a balanced transaction (1 transaction row + N posting rows)
today means N+1 independent `POST /api/databases/:id/rows` calls, each
non-idempotent (`packages/server/src/app.ts:1813-1822` — no idempotency key on
row create, unlike page create's ER-7 dedup at `app.ts:786-792`). And
`unique_id` numbering is **client-assigned**: a browser effect computes the
next number optimistically and races under concurrency
(`packages/ui/src/components/database/useDatabase.ts:400-428`). LGR-3 needs an
atomic posting endpoint (one `begin` for the whole entry) with server-assigned
entry numbers and an idempotency key.

## Constraints (hostile ground for a ledger)

- **Numbers are IEEE-754 doubles end-to-end.** JSONB property bags are parsed
  with plain `JSON.parse` (`packages/server/src/store.ts:168-171`); decimal is
  display-only formatting via `toLocaleString`
  (`packages/sdk/src/database.ts:1400-1420`); no decimal/bignum library exists
  anywhere in the repo. Ledger amounts must be stored as **integer minor units
  (cents)** — never fractional currency.
- **Trash purge hard-deletes with FK cascade.** `purgeExpired` runs
  `DELETE FROM pages …` (`packages/server/src/store.ts:1365-1374`) on a boot +
  interval sweep (`packages/server/src/server.ts:330-341`); child rows cascade
  (`packages/server/src/migrations.ts:49,59`). A trashed-then-purged posting
  row is gone forever — ledger rows must be deletion-protected (store-managed,
  per Q3) or the ledger loses its audit property.

## What this means for the ledger

1. **Reports are plugin-rendered.** Balances, trial balance, and statements
   cannot be computed columns (Q1) — the plugin (or a server endpoint) computes
   and renders them.
2. **Enforcement lives in the store.** Double-entry invariants, immutability of
   posted entries, and deletion protection must be store-layer rules on
   server-managed databases (Q3), following the `rejectManaged` / AI-usage
   precedent — route-level checks are bypassed by browser-local mode.
3. **One atomic posting endpoint.** A transaction + its postings must land in a
   single `Db.begin` unit with an idempotency key (Q5) — never N+1 row POSTs.
4. **Server-assigned entry numbering.** Sequential entry numbers must be
   assigned inside that transaction, not by the client-side `unique_id` effect
   (Q5).
5. **Integer minor units + hash-at-post.** Amounts in cents (constraints);
   attachment evidence hashes are free at posting time because asset ids are
   already SHA-256 (Q4).
