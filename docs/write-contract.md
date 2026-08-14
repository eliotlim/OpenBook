# Write contract: errors, optimistic revisions, and idempotency

Status: accepted contract spike (2026-08-14). This document is normative for
the CWD-2, CWD-5, CWD-6, CWD-7, CWD-10, and CWD-12 implementation work. The
types land with this document, but this spike deliberately changes no runtime
behaviour.

## 1. Goals and compatibility

The durable JSON write path needs three properties that compose:

1. callers receive one typed error model at the SDK boundary;
2. callers may opt into compare-and-set (CAS) with an entity revision; and
3. an outbox may replay a request without applying the same logical write twice.

CAS is opt-in. Omitting `expectedRev` preserves today's last-write-wins (LWW)
behaviour. This is not a hard `If-Match` migration, and legacy clients do not
start failing merely because they do not know about revisions.

The contract is additive during rolling upgrades. `rev` is optional in shared
representations so a new SDK can still read an old server; a server implementing
this contract MUST advertise `InstanceInfo.writeContract: 1` on
`GET /api/instance` and MUST return `rev`. A client MUST send `expectedRev` only
after reading `rev` from such a server. CWD-7 MUST NOT automatically replay an
outbox entry against a server that does not advertise `writeContract: 1`: an old
server ignores
`Idempotency-Key`, so replay could apply the write twice.

The SDK types remain exported. There is currently no api-extractor or equivalent
export-surface guard; adding that is DATA-1's remit, not a build change in this
spike.

## 2. `WriteError` taxonomy

`HttpDataClient.request()` is not the SDK write chokepoint: 31 current
`authFetch` call sites bypass it, including the wave-1 `restoreVersion`,
`deletePage`, `restorePage`, and `deleteDatabase` routes. CWD-6 MUST introduce
one private `write()` helper and route every durable SDK write through it. That
helper owns request options, timeout/abort attribution, idempotency headers, and
error materialization. Reads and specialized write protocols may continue to
use their existing paths after the explicit audit in §6.

`write()` attaches `Idempotency-Key` only for the routes in the §4.1 table;
other durable writes, including `purgePage` and `deleteComment`, still receive
typed errors but no key, because the server rejects that header on unlisted
mutation routes.

Every `WriteError` carries:

- `kind`: the stable class discriminator below;
- `status`: the HTTP status when a response was received, otherwise `null`;
- `retryable`: whether the same operation may succeed without changing its
  semantic payload; and
- `code`, `message`, and optional structured `details` from the server envelope.

`retryable` follows the existing `SiteReattachError.retryable` convention in
`packages/sdk/src/forwarding/forwardingClient.ts`: it is derived once by the SDK,
not re-inferred by each caller. It does not by itself make a retry safe. An
ambiguous write is automatically replayable only with the same
`Idempotency-Key` and fingerprint.

| SDK class | `kind` | `status` | `retryable` | Classification |
| --- | --- | --- | --- | --- |
| `WriteTimeoutError` | `timeout` | `null`, `408`, or `504` | `true` | SDK deadline, or an HTTP timeout response. The outcome may be unknown; reuse the key. |
| `WriteAbortError` | `abort` | `null` | `false` | The caller's `AbortSignal` fired. Cancellation is not an automatic retry request. |
| `WriteConflictError` | `conflict` | `409` | `false` | `code: rev-conflict`; exposes the discriminated conflict body in `details`. Resolution or user choice is required. |
| `WriteIdempotencyReuseError` | `idempotency-reuse` | `409` | `false` | `code: idempotency-key-reused`; the key was bound to another fingerprint and must be reconciled. |
| `WriteValidationError` | `validation` | `400`, `413`, or `422` | `false` | The request cannot succeed unchanged. `details.issues` may identify fields. |
| `WriteAuthorizationError` | `authorization` | `401` or `403` | `false` | Authentication or permission must change first. |
| `WriteRateLimitError` | `rate-limit` | `429` | `true` | Retry after `retryAfterMs`, when supplied, with the same key. |
| `WriteTransportError` | `transport` | `null` | `true` | Fetch/network failure before a usable response. The outcome may be unknown; reuse the key. |
| `WriteServerError` | `server` | `500`, `502`, or `503` | `true` | Transient server failure. Reuse the key because the response may have been lost after commit. |
| `WriteHttpError` | `http` | any unmatched non-2xx status | `false` | Typed fallback, including a 409 without a recognized contract code; it is never silently guessed retryable. |

`WriteRateLimitError.retryAfterMs` is derived from the HTTP `Retry-After`
header: the server's values at `app.ts:517/534/546` are seconds and the SDK
converts them to milliseconds; it remains absent on bare legacy `{error}` 429
responses that omit the header.

An abort caused by the SDK's own deadline is a timeout, not an abort. CWD-6 must
track which signal fired so the two do not collapse into the same DOM exception.
A non-JSON or legacy `{error}` response still becomes the appropriate class,
with a synthesized code and retryability based on the table. A malformed
`rev-conflict` envelope becomes `WriteHttpError`, because inventing current state
would make conflict resolution unsafe. Likewise, the live move-cycle 409
(`app.ts:1690`) and already-claimed 409 (`app.ts:1880`) map to `WriteHttpError`
unless and until those routes return a recognized contract code.

### 2.1 Server error envelope

Durable write routes return this minimum JSON shape for non-2xx application
responses:

```json
{
  "error": "human-readable message",
  "code": "stable-machine-code",
  "retryable": false
}
```

The HTTP status remains authoritative; it is not duplicated in the body. The
server types this shape as `ServerWriteErrorEnvelope`, an alias of the SDK's
shared `WriteErrorEnvelope`. Existing untyped error shapes remain readable by
CWD-6 during the transition. CWD-2 owns emitting these envelopes from the server
routes it converts.

The stable codes introduced by this contract are:

- `rev-conflict` for a failed revision guard;
- `idempotency-key-reused` when a key names a different request;
- `invalid-input`, `unauthorized`, `forbidden`, `not-found`, `rate-limited`, and
  `server-error` for the corresponding general classes.

Server `retryable` values must agree with the taxonomy. In particular, a
revision conflict and an idempotency-key reuse are both 409 and non-retryable,
but only the former is a take-mine/take-theirs case.
For a 429, `retryAfterMs` comes from the `Retry-After` header's seconds value,
not from this JSON envelope, and is absent when that header is absent.

## 3. Entity revision token

### 3.1 Representation and lifecycle

`EntityRev` is a positive JavaScript-safe integer. Storage uses a non-null
integer column, backfilled/defaulted to `1`. A newly created entity has `rev: 1`.
A commit that WRITES an entity's persisted row increments that row's `rev`
exactly once. Failed authorization, validation, or CAS attempts do not increment
it, and an idempotent replay does not execute the mutation.

An existing no-op guard may elide the write. In particular,
`upsertPageTx`'s `IS DISTINCT FROM` check and move/reorder position guards neither
write nor increment when persisted values are unchanged. The route then returns
the unchanged representation with its current `rev`. This is distinct from
merely submitting equal values to a route that has no no-op guard: if that route
writes the row, it increments `rev`.
No-op elision takes precedence over the revision guard: equal intended and
persisted values with a stale `expectedRev` return 200 and the current `rev`
because nothing was overwritten. Consequently, `expectedRev` is a write guard,
not a read-your-writes assertion.

The token belongs to the persisted entity, not to an HTTP representation:

- ordinary pages and row pages use `pages.rev`;
- `StoredPage`, `PageMeta`, `PageVisibilitySettings`, the agent-edits response,
  and `DatabaseRow` projections of the same page id expose the same token;
- databases use `databases.rev`; and
- the `settings.key = 'instance'` record has an instance-config `rev`, stored
  beside the JSON value rather than as a client-editable policy field.

Page mutations include content, name, manual properties, parent and stable
position, soft delete/restore, visibility, and agent-edit policy. A database
token covers its existence, name, and schema while that database exists; a hard
delete guards and then destroys both the entity and its token.
`hostedDatabaseId` is outside the host page's rev-covered surface: it projects
the database's existence, which is tracked by the database entity's `rev`, so
database create/delete does not bump the host page. `rev` is a write-guard token,
not a projection-cache key: `hostedDatabaseId` can change when database deletion
republishes the host page over SSE without a host-page bump. Row creation creates
a page at `rev: 1`; a row edit increments that page. Under the stable-position
model in §3.3, a non-rebalancing move writes and increments only the moved page;
sibling rows are not written or incremented. CWD-12's bounded rebalance MAY
write and increment affected siblings, and its response carries every changed
sibling's `rev`. Every stored instance-policy change, claim, or repair increments
the instance-config `rev`. Server-managed row writes obey the same rule.

All entity-returning reads and successful writes include `rev`. Lists include
it too, so a client does not need an extra GET before editing. A successful
§4.1 response that does not return a full representation MUST still return the
primary entity's `{id, rev}`. The carve-out is a response that destroys the
entity: it returns `{id}` with no `rev`, because no token survives; the next list
establishes the new baseline. `DELETE /api/databases/:id` is such a hard delete.
A multi-page stable-position response returns a page-id-keyed record whose
changed entries each carry `rev`. SSE events carry the same revision-bearing
projections they already carry. The revision is JSON data, not an ETag, and
caches must not derive it from `updatedAt`.

### 3.2 Sending `expectedRev`

The caller sends an optional top-level JSON body field:

```json
{
  "expectedRev": 17,
  "name": "Quarterly plan",
  "data": {}
}
```

We choose a body field, not `If-Match`, because CAS remains visibly opt-in in the
existing TypeScript write inputs; the token is an integer rather than an HTTP
entity tag; desktop fetch/IPC transports already preserve JSON bodies; and an
outbox can persist one semantic payload while keeping `Idempotency-Key` as
request metadata.

`expectedRev` must be a positive safe integer. `null`, zero, fractions, and
unsafe integers are `400 invalid-input`. It is omitted on creates. Bodyless
legacy calls remain unguarded; bodyless `DELETE`/restore routes accept the small
body `{expectedRev}` when a caller wants CAS.

`POST /api/pages` is dual-mode today. When the request selects its update arm
(an existing `id`), `expectedRev` guards that update. If the request selects its
create arm, the presence of `expectedRev` is rejected as `422 invalid-input`;
the server never silently ignores a caller's requested guard.

### 3.3 Guarded update and stable ordering

For an existing target, a non-no-op mutation and increment are one guarded
statement:

```sql
UPDATE pages
SET data = $data, rev = rev + 1, updated_at = now()
WHERE id = $id
  AND ($expected_rev IS NULL OR rev = $expected_rev)
  AND data IS DISTINCT FROM $data
RETURNING ...;
```

Equivalent database and instance-config updates use the same CAS predicate and
their existing no-op predicates, if any. With no expected revision, the nullable
arm preserves LWW. With a revision, exactly one concurrent writer can match.
A zero-row result is not automatically a conflict: inside the transaction the
route must distinguish (a) a readable target whose values made the no-op guard
elide the write, which returns its unchanged projection and current `rev`; (b) a
readable target with changed values but a mismatched `expectedRev`, which returns
the typed 409 below; and (c) the route's normal missing/unreadable 404/403
posture. `RETURNING` on both logical arms or an in-transaction pre-read are valid
approaches; the exact SQL is CWD-2's decision. Authorization and managed-entity
gates continue to run before CAS, so it creates no existence oracle.

Ordering's post-CWD-12 target contract is a stable-id + position-record model.
The request uses `positions: Record<pageId, position>`, where each position is an
opaque, non-empty string ordered by bytewise lexicographic comparison. This
contract assumes a fractional-key scheme can generate a key strictly between
adjacent siblings without renumbering them; that scheme is an explicit
owner-veto point. CWD-12 owns the storage/API migration and any bounded rebalance
strategy. A non-rebalancing position move changes only the moved page; a bounded
rebalance MAY write and increment sibling rows and returns every changed page's
`rev`.

In wave 1, `PUT /api/pages/:id/move` keeps the existing
`{parentId, orderedIds}` payload. `expectedRev` guards only the moved page's row;
sibling ordering requested through `orderedIds` remains LWW. A no-op move returns
the unchanged page and current `rev`. The array-based `orderedIds` move payload
and `reorderRows(databaseId, orderedIds)` signature are deprecated-for-CAS
migration surfaces: they MUST NOT imply one atomic conflict unit. CWD-12 replaces
them with stable position-record inputs before guarded reordering is exposed.
The existing `StoredPage.position?: number` is load-bearing for both the LEDGER's
audited posting-order hash and bundle-v2 import compatibility; CWD-12 MUST
preserve both while changing its ordering representation.

Relation inverses are not a derived transactional side effect: today
`useDatabase.ts:709-762` performs N+1 independent client PATCHes. Wave 1 accepts
partial inverse application. CWD-6 must preserve the individual conflicts and
must not present that group as one atomic conflict unit.

### 3.4 Rev-conflict response

A failed guard returns HTTP 409 and, below CWD-2's response-size threshold, the
current permission-filtered route projection:

```json
{
  "error": "page changed since rev 17",
  "code": "rev-conflict",
  "retryable": false,
  "entity": {"kind": "page", "id": "5d2d..."},
  "projection": "page",
  "expectedRev": 17,
  "currentRev": 18,
  "current": {
    "id": "5d2d...",
    "name": "Quarterly plan (server)",
    "data": {},
    "rev": 18
  },
  "links": {
    "self": "/api/pages/5d2d...",
    "versionHistory": "/api/pages/5d2d.../versions"
  }
}
```

`WriteConflictEnvelope` is first discriminated on `entity.kind` into
`PageConflict`, `DatabaseRowConflict`, `DatabaseConflict`, and
`InstanceConfigConflict`. `PageConflict` keeps `entity.kind: 'page'` stable and
adds a second `projection: 'page' | 'visibility' | 'agent-edits'` discriminator
that types `current` as `StoredPage`, `PageVisibilitySettings`, or
`AgentEditsPolicySettings`, respectively. Row-property routes use
`database-row`; row-content routes use the `page` projection. When `current` is
present, `current.rev` MUST equal `currentRev`.

The server MAY return `current: null` above a CWD-2-chosen serialized-size
threshold. `links.self` is always the permission-appropriate GET fallback, and
CWD-10 must handle both embedded and null current state. Page and row-page
conflicts carry their page-version-history path; database and instance-config
conflicts set `links.versionHistory` to `null`. The response is produced only
after the normal read gate. If the target is gone or no longer readable, the
route returns its normal 403/404 instead of a conflict containing hidden data.

Take-theirs adopts `current`, or follows `links.self` when it is null, and
performs no write. Take-mine sends the intended value with
`expectedRev: currentRev` and a fresh `Idempotency-Key`. At receipt of a same-key
take-mine 409, the original attempt's outcome may be UNKNOWN: if it actually
committed, its stored fingerprint makes that request a
`409 idempotency-key-reused`, which CWD-7 treats as INDETERMINATE; if it genuinely
CAS-409'd, no key was consumed (§4.3) and using a fresh key is hygiene. A
row-route take-mine currently clobbers disjoint manual-property cells because
`updateRow` replaces the whole property bag; CWD-3's per-key merge must land
before the UX claims otherwise.

## 4. `Idempotency-Key`

### 4.1 Header, key format, route scope, and responses

The transport is the standard `Idempotency-Key` request header. It is separate
from JSON because it identifies an HTTP attempt, not entity state. CWD-5 MUST
also add `Idempotency-Key` to the CORS `allowHeaders` list at `app.ts:628-641`.
The current check at `originHardening.test.ts:133` is a substring `toContain`,
not an exact-list assertion; CWD-5 MUST add an exact-list assertion that pins the
complete allowlist.

A new key is a canonical RFC 4122 UUID v4 (the current
`crypto.randomUUID()` output) or UUID v7: 36 ASCII characters in
`8-4-4-4-12` hexadecimal form, with a valid UUID version and variant. The server
accepts hexadecimal case but stores lowercase. Missing keys preserve legacy
behaviour. Empty, duplicated/comma-joined, or malformed headers return
`400 invalid-input` before mutation.

Wave 1 supports the header on these durable core writes. Every successful
response carries `rev` as specified in §3.1 except a response that destroys its
entity, which returns `{id}` without `rev`; a later list establishes the new
baseline.

| Resource | Routes | `expectedRev` |
| --- | --- | --- |
| Page / row page | `POST /api/pages`; `PUT`, `PATCH`, `DELETE /api/pages/:id`; `PATCH /properties`; `PUT /move`; `POST /restore`; `POST /versions/:vid/restore`; `PUT /visibility`; `PUT /agent-edits` | Existing single target only; create rejects it. Move follows §3.3. |
| Database | `POST /api/databases`; `PATCH`, `DELETE /api/databases/:id` | Existing single target only; omit for create. |
| Database row | `POST /api/databases/:id/rows`; `PATCH /api/databases/:id/rows/:rowId`; `PUT /api/databases/:id/rows/order` | Row PATCH only until CWD-12 replaces array reorder. Row content uses the page route. |
| Instance config | `PUT /api/instance` | Yes, including claim/repair after existing authority checks. Returns `InstanceConfigWithRev`. |

The header is ignored on reads and rejected as `400 invalid-input` on other
mutation routes until they explicitly adopt the ledger. Incremental Yjs
update/sync/awareness routes, asset uploads, public form submissions, import,
ledger operations, sharing, comments, suggestions, plugins, AI, and maintenance
keep their existing specialized or natural idempotency. `/api/import` remains
content-hash keyed by `import_log`, and public form writes retain their body
key/capability-scoped `write_keys` flow.

`PageInput.idempotencyKey` remains a compatibility input for legacy keyless page
create. New SDK code uses the header. If both are present they must be byte-for-
byte equal or the server returns `400 invalid-input`; the header owns the general
response ledger and the body field may still satisfy the legacy create ledger.

### 4.2 Scope, request identity, and key-reuse handling

The ledger key is `(actor_scope, idempotency_key)`, following today's
per-principal `write_keys` precedent. A verified user and a PAT bound to that
user share the user's `iss#sub` scope; trusted local transport uses
`local:owner`. Guest/unverified writes use their resolved subject in the guest
namespace. UUID entropy prevents accidental guest collisions, and replay still
passes current authorization before a stored response may be disclosed.

The key is deliberately not route-scoped. Reusing one UUID anywhere in an
actor's write namespace catches outbox bugs instead of treating two operations
as unrelated. The SHA-256 fingerprint is over a length-delimited tuple of:

1. the uppercase HTTP method;
2. the URL parser's normalized pathname (dot segments resolved, percent escapes
   left encoded, no origin or fragment);
3. the lowercased, parameter-free media type; and
4. the exact request body bytes, with an empty byte string for no body.

Wave-1 idempotent routes accept no semantic query parameters, so the query string
is excluded and those routes reject a non-empty query as `400 invalid-input`.
Any future route that needs query semantics must revise the fingerprint contract
before joining the ledger. Authentication headers and `Idempotency-Key` itself
are excluded.

The same actor+key with another fingerprint returns
`409 idempotency-key-reused` and never returns the first response. On this code,
CWD-7 marks the outbox entry INDETERMINATE and routes it to explicit
reconciliation, the same terminal handling as TTL expiry in §4.5. It never
silently re-mints a key, because doing so could double-apply an already committed
request.

### 4.3 Response-capturing ledger

CWD-5 generalizes the two existing atomic-claim patterns into a ledger that can
represent a complete successful JSON response. Each committed row contains:

- actor scope and normalized key (the primary key);
- fingerprint, method, and normalized target for diagnostics;
- HTTP status, JSON response body, and the replayable `Content-Type` and
  `Location` response headers; and
- completion time for garbage collection.

The key claim, durable mutation, `rev` increment, and response capture commit in
one database transaction. Like `import_log`, a claimant inserts first; a
concurrent identical claimant waits on the unique key, then reads the committed
response. A process failure rolls the uncommitted claim and mutation back, so no
permanent pending row is required. A response-construction failure also rolls
back the write.

Only successful 2xx responses are retained. Authorization, validation, CAS,
rate-limit, and server-error responses do not consume a key. They perform no
mutation and may be evaluated again; notably, a retried stale CAS gets fresh
current state rather than a cached 409. Authentication, authorization, access,
managed-entity, and body-size gates run before claim/replay, preventing an old
success from bypassing a later permission revocation.

On an exact replay after those gates:

1. verify the stored fingerprint;
2. return the stored status, semantically identical JSON body, and allowlisted
   headers; and
3. do not re-run CAS, mutate storage, increment `rev`, publish a duplicate event,
   or append duplicate edit/history entries.

The existing `import_log` is the precedent for claim-before-work plus stored
result, while `write_keys` supplies actor scoping. Both remain for their legacy
routes during wave 1.

### 4.4 Replay with `expectedRev`

The order and implementation ownership are fixed:

1. CWD-5 authenticates, authorizes, and applies existing route gates;
2. CWD-5 validates the key and computes the fingerprint, including
   `expectedRev` in the exact body bytes;
3. CWD-5 returns a completed response for an identical key+fingerprint;
4. CWD-2 executes the revision guard and mutation under CWD-5's claimed key in
   the same transaction; and
5. CWD-5 captures the successful response before commit.

A response-lost replay of `{expectedRev: 17}` therefore returns the original
successful rev-18 response even if the entity is now at rev 19. It neither
reapplies the mutation nor becomes a false conflict. A new key with stale
`expectedRev` is a new attempt and receives 409.

The client mints the key once when creating an outbox entry and persists it with
the exact serialized method/path/body. Network retries reuse it. Editing the
body, changing `expectedRev`, or choosing take-mine creates a new entry and key.

### 4.5 TTL and garbage collection

Generalized ledger rows use the existing `idempotencyRetentionMs` policy: seven
days by default, `<= 0` to retain forever. Periodic cleanup deletes completed
rows older than the configured retention; normal locking protects active
transactions. Replay does not extend TTL.

TTL is the exact dedup guarantee window. CWD-7 persists entry creation time and
MUST NOT automatically replay after the server's configured window. The entry
becomes INDETERMINATE and requires explicit reconciliation, matching §4.2.
Deployments needing longer offline windows set longer retention. Automatic
outbox replay is exactly-once-ish within that window, never silently “probably
once” after its proof has been collected.

## 5. Local and collaborative write paths

`LocalDataClient` implements this contract because it owns the same `PageStore`:
guarded writes and revision-bearing responses work without HTTP. Until CWD-2
wires each local signature and store guard, `LocalDataClient` MUST throw when it
receives `expectedRev`; it must never silently downgrade a guarded write to LWW.
That rejection is a `WriteValidationError` with `code: 'invalid-input'`. The
HTTP-only idempotency ledger/header is not synthesized for in-process calls.

Every `pages` row write increments `rev`, including Collab T9
`saveServerDoc` persister checkpoints (`app.ts:600-610` →
`store.ts:2447-2465`). An existing no-op guard may still elide an unchanged
checkpoint under §3.1. REST content CAS is therefore meaningful only on
single-writer/non-collaborative pages. Actively collaborated content is protected
by CRDT merge, the stronger mechanism; a REST writer racing a live collaboration
checkpoint earns its 409.

This contract does not change the CRDT algorithm, incremental update/sync/
awareness routes, HTTP versus injected-fetch transport, or legacy callers'
opt-in posture. It does not build the IndexedDB outbox or a server-side merge
policy. Stable-position implementation is CWD-12, not this spike.

## 6. Downstream implementation map

| Owner | Contract sections consumed | Required outcome |
| --- | --- | --- |
| CWD-2 — server CAS implementer | §2.1, §3.1-§3.4, §4.4 step 4, §5 | Add/backfill `rev`; return it on every covered non-destroy response; put both server and `LocalDataClient` no-op precedence on the 200/current-rev side; distinguish CAS-miss/missing; implement nullable typed conflicts and the size threshold; increment `saveServerDoc`; add guarded `PUT /api/pages/:id/move` while keeping its existing payload and LWW siblings; wire local guarded writes and reject unsupported `expectedRev` with the typed error until wired. |
| CWD-3 — row merge implementer | §3.4 | Land per-key manual-property merge before row take-mine claims to preserve disjoint cells. |
| CWD-5 — idempotency implementer | §4.1-§4.5 and §2.1 | Add the actor-scoped response ledger, fingerprinting, steps 1-3 and 5 of §4.4, atomic claim/capture, GC, the `Idempotency-Key` CORS allow-header, and a new exact-list assertion pinning the complete allowlist. |
| CWD-6 — SDK write-path implementer | §2, §3.2-§3.4, §4.1, §4.4 | Add the single private `write()` helper; materialize typed errors; accept `WriteRequestOptions`; attach/preserve keys only for §4.1-table routes while giving other durable writes typed errors with no key; update all `DataClient` guarded-write inputs and revision-bearing return signatures; preserve independent relation-inverse conflicts. |
| CWD-7 — outbox implementer | §1, §4.2, §4.4-§4.5 | Gate replay on `writeContract: 1`; persist exact bytes/key/time; reuse only identical fingerprints; route key reuse and TTL expiry to INDETERMINATE explicit reconciliation. |
| CWD-10 — conflict UX implementer | §3.4 | Handle every conflict union member, including the `PageConflict.projection` discriminator, and both embedded and null `current`; use `links.self` fallback; do not overstate row take-mine merge safety. |
| CWD-12 — ordering implementer | §3.1, §3.3, §4.1 | Migrate numeric/array ordering to stable lexicographic position keys and record inputs; preserve legacy `orderedIds`/`reorderRows` as deprecated LWW-only surfaces at the boundary; preserve `StoredPage.position`'s audited LEDGER posting-order hash and bundle-v2 import compatibility; report every sibling `rev` changed by a bounded rebalance. |
| DATA-1 — public API guard owner | §1 | Add an api-extractor or equivalent export-surface guard for the SDK's public contract types. |

CWD-6's required audit starts with all 31 current `authFetch` bypasses (all call
sites except `request()` itself): `getPage`, `submitForm`, `uploadFormFile`,
`getVersion`, `restoreVersion`, `deletePage`, `restorePage`, `purgePage`,
`postPageUpdate`, `postPageAwareness`, `syncPageAwareness`, `putAsset`,
`getAsset`, `getDatabase`, `getPageDatabase`, `revokeDatabaseForm`,
`getPublicDatabaseForm`, `submitDatabaseForm`, `uploadDatabaseFormFile`,
`deleteDatabase`, `ledgerRequest`, `ledgerExportCsv`, `ledgerExportBeancount`,
`deleteSuggestion`, `deleteComment`, `removeMember`, `revokeAgentToken`,
`unsharePage`, `removePlugin`, `agentChat`, and `aiStream`. CWD-6 must classify
each call, route every durable core write through `write()`, and explicitly leave
reads or specialized protocols on their dedicated path; it must not assume
`request()` already covers them.
