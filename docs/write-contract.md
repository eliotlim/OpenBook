# Write contract: errors, optimistic versions, and idempotency

Status: accepted contract spike (2026-08-14). This document is normative for the
CWD-2, CWD-5, and CWD-6 implementation work. The types land with this document,
but this spike deliberately changes no runtime behaviour.

## 1. Goals and compatibility

The durable JSON write path needs three properties that compose:

1. callers receive one typed error model at the SDK boundary;
2. callers may opt into compare-and-set (CAS) with an entity version; and
3. an outbox may replay a request without applying the same logical write twice.

CAS is opt-in. Omitting `expectedVersion` preserves today's last-write-wins
(LWW) behaviour. This is not a hard `If-Match` migration and legacy clients do
not start failing merely because they do not know about versions.

The contract is additive during rolling upgrades. Version properties are
optional in the shared TypeScript interfaces so a new SDK can still talk to an
old server; a server that implements this contract MUST return them. A client
MUST only send `expectedVersion` after reading a version from that server.

## 2. `WriteError` taxonomy

`HttpDataClient.request()` is the SDK chokepoint. CWD-6 will translate every
failed durable write through it into a `WriteError` subclass instead of leaking
raw `Error`, `TypeError`, or response-body parsing errors. Read behaviour,
including the existing `IdentityRejectedError` special case, is unchanged.

Every `WriteError` carries:

- `kind`: the stable class discriminator below;
- `status`: the HTTP status when a response was received, otherwise `null`;
- `retryable`: whether the same operation may succeed without changing its
  semantic payload; and
- `code`, `message`, and optional structured `details` from the server envelope.

`retryable` follows the existing `SiteReattachError.retryable` convention in
`packages/sdk/src/forwarding/forwardingClient.ts`: it is an explicit fact on the
error, derived once by the SDK rather than re-inferred by each caller. It does
not by itself make a retry safe. An ambiguous write is automatically replayable
only when it carries the same `Idempotency-Key`.

| SDK class | `kind` | `status` | `retryable` | Classification |
| --- | --- | --- | --- | --- |
| `WriteTimeoutError` | `timeout` | `null`, `408`, or `504` | `true` | SDK deadline, or an HTTP timeout response. The outcome may be unknown; reuse the key. |
| `WriteAbortError` | `abort` | `null` | `false` | The caller's `AbortSignal` fired. Cancellation is not an automatic retry request. |
| `WriteConflictError<T>` | `conflict` | `409` | `false` | `code: version-conflict`; exposes the typed conflict body in `details`. Resolution or user choice is required. |
| `WriteValidationError` | `validation` | `400`, `413`, or `422` | `false` | The request cannot succeed unchanged. `details.issues` may identify fields. |
| `WriteAuthorizationError` | `authorization` | `401` or `403` | `false` | Authentication or permission must change first. |
| `WriteRateLimitError` | `rate-limit` | `429` | `true` | Retry after the response's delay, with the same key. |
| `WriteTransportError` | `transport` | `null` | `true` | Fetch/network failure before a usable response. The outcome may be unknown; reuse the key. |
| `WriteServerError` | `server` | `500`, `502`, or `503` | `true` | Transient server failure. Reuse the key because the response may have been lost after commit. |
| `WriteHttpError` | `http` | any other non-2xx status | `false` | Typed fallback; it is never silently guessed retryable. |

An abort caused by the SDK's own deadline is a timeout, not an abort. CWD-6 must
track which signal fired so the two do not collapse into the same DOM exception.
A non-JSON or legacy `{error}` response still becomes the appropriate class,
with a synthesized code and retryability based on the table. A malformed
`version-conflict` envelope becomes `WriteHttpError`, because inventing a current
value would make conflict resolution unsafe.

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
CWD-6 during the transition.

The stable codes introduced by this contract are:

- `version-conflict` for a failed version guard;
- `idempotency-key-reused` when a key names a different request;
- `invalid-input`, `unauthorized`, `forbidden`, `not-found`, `rate-limited`, and
  `server-error` for the corresponding general classes.

Server `retryable` values must agree with the taxonomy. In particular, a version
conflict and an idempotency-key reuse are both 409 and both non-retryable; the
latter is a programming/data-integrity error, not a take-mine/take-theirs case.

## 3. Entity version token

### 3.1 Representation and lifecycle

`EntityVersion` is a positive JavaScript-safe integer. Storage uses a non-null
integer column, backfilled/defaulted to `1`. A newly created entity is version
`1`; every committed mutation of that entity increments its version exactly
once, even when the submitted values compare equal to the stored values. Failed
authorization, validation, or CAS attempts do not increment it. An idempotent
replay does not execute the mutation and therefore does not increment it.

The token belongs to the persisted entity, not to an HTTP representation:

- ordinary pages and row pages use `pages.version`;
- `StoredPage`, `PageMeta`, and `DatabaseRow` representations of the same page id
  expose the same token;
- databases use `databases.version`; and
- the `settings.key = 'instance'` record has an instance-config version (stored
  alongside the JSON value, not as a client-editable policy field).

Page mutations include content, name, manual properties, parent/order, soft
delete/restore, visibility, and agent-edit policy. A database token covers its
name and schema. Row membership does not churn the database token: row creation
creates a page at version 1, row edits bump that page, and row reorder bumps each
page whose position changes. Creating or deleting a hosted database also bumps
the host page because `hostedDatabaseId` changes in its read representation.
Every stored instance-policy change, claim, or repair bumps the instance-config
version. Server-managed writes obey the same increments even when their routes
are not client writable.

All entity-returning reads and successful writes include `version` on the
returned representation. Lists include it too, so a client does not need an
extra GET before editing. A delete/void response has no live representation and
therefore need not invent a token; a later GET/list establishes a new baseline.
SSE events carry the same versioned representations they already carry. The
version is JSON data, not an ETag, and caches must not derive one from
`updatedAt`.

### 3.2 Sending `expectedVersion`

The caller sends an optional top-level JSON body field:

```json
{
  "expectedVersion": 17,
  "name": "Quarterly plan",
  "data": {}
}
```

We choose a body field, not `If-Match`, for four reasons: CAS remains visibly
opt-in in the existing TypeScript write inputs; the token is an integer rather
than an HTTP entity tag; the desktop's injected fetch/IPC transports already
preserve JSON bodies uniformly; and an outbox can persist one self-contained
semantic payload while keeping `Idempotency-Key` as request metadata. A custom
version header would add transport plumbing without gaining HTTP cache semantics.

`expectedVersion` must be a positive safe integer. `null`, zero, fractions, and
unsafe integers are `400 invalid-input`. It is omitted on creates. Bodyless
legacy calls remain unguarded; bodyless `DELETE`/restore routes may accept the
small body `{expectedVersion}` when a caller wants CAS.

### 3.3 Guarded update

For an existing target, the mutation and increment are one guarded statement in
the same transaction as all derived writes:

```sql
UPDATE pages
SET data = $data, version = version + 1, updated_at = now()
WHERE id = $id
  AND ($expected_version IS NULL OR version = $expected_version)
RETURNING ...;
```

Equivalent database and instance-config updates use the same predicate. With no
expected version, the nullable arm preserves LWW. With a version, exactly one
concurrent writer can match. A zero-row result is resolved under the route's
normal access rules: missing/unreadable remains its existing 404/403 posture;
an existing readable target with a different version is the typed 409 below.
The authorization and managed-entity gates continue to run before the guard, so
CAS never creates an existence oracle or bypasses the current mount order.

For a mutation with derived side effects (relation inverses, move/reorder, or
host-database linkage), `expectedVersion` guards the route's primary target
before any side effect. The entire transaction rolls back on failure, and every
entity actually changed gets its own increment. Wave 1 does not offer CAS for a
pure multi-target row-order request because one scalar token cannot honestly
guard an ordered set.

### 3.4 Version-conflict response

A failed guard returns HTTP 409 and the full current, permission-filtered value
(the example abbreviates unchanged page fields):

```json
{
  "error": "page changed since version 17",
  "code": "version-conflict",
  "retryable": false,
  "entity": {"kind": "page", "id": "5d2d..."},
  "expectedVersion": 17,
  "currentVersion": 18,
  "current": {
    "id": "5d2d...",
    "name": "Quarterly plan (server)",
    "data": {},
    "version": 18
  },
  "links": {
    "versionHistory": "/api/pages/5d2d.../versions"
  }
}
```

`current.version` MUST equal `currentVersion`. Page and row-page conflicts carry
their page-version-history path; database and instance-config conflicts set
`links.versionHistory` to `null`. Embedding `current` is deliberate: conflicts
are rare, and one larger 409 avoids a second race-prone GET while giving wave-1
take-theirs everything it needs. It is produced only after the normal read gate
and uses the same projection as the corresponding GET.

The entity kind is `page`, `database-row`, `database`, or `instance-config`.
Row-property routes return the `DatabaseRow` projection and row content routes
return `StoredPage`; both carry the same page token. If the target is no longer
readable or no longer exists, the route returns its normal 403/404 rather than a
conflict envelope with hidden data.

Take-theirs adopts `current` and performs no write. Take-mine sends the intended
value again with `expectedVersion: currentVersion` and a **fresh**
`Idempotency-Key`; reusing the rejected request's key would mean "replay that
same attempt", not "make a new decision". The version-history link remains
available for either choice.

## 4. `Idempotency-Key`

### 4.1 Header, key format, and route scope

The transport is the standard `Idempotency-Key` request header. It is separate
from the JSON payload because it identifies an HTTP attempt, not entity state,
and lets the SDK chokepoint attach the same metadata to differently shaped write
bodies.

A new key is a canonical RFC 4122 UUID v4 (the current
`crypto.randomUUID()` output) or UUID v7: 36 ASCII characters in
`8-4-4-4-12` lowercase hexadecimal form, with a valid version and variant. The
server accepts hexadecimal case but stores lowercase. Missing keys preserve
legacy behaviour. Empty, duplicated/comma-joined, or malformed headers return
`400 invalid-input` before any mutation.

Wave 1 supports the header on these durable core writes:

| Resource | Routes | `expectedVersion` |
| --- | --- | --- |
| Page / row page | `POST /api/pages`; `PUT`, `PATCH`, `DELETE /api/pages/:id`; `PATCH /properties`; `PUT /move`; `POST /restore`; `POST /versions/:versionId/restore`; `PUT /visibility`; `PUT /agent-edits` | Existing single target only; omit for create. |
| Database | `POST /api/databases`; `PATCH`, `DELETE /api/databases/:id` | Existing single target only; omit for create. |
| Database row | `POST /api/databases/:id/rows`; `PATCH /api/databases/:id/rows/:rowId`; `PUT /api/databases/:id/rows/order` | Row PATCH only. Row content uses the page route. Row-order CAS is out of wave 1. |
| Instance config | `PUT /api/instance` | Yes, including claim/repair after their existing authority checks. |

The header is ignored on reads and rejected as `400 invalid-input` on other
mutation routes until those routes explicitly adopt the ledger. The incremental
Yjs update/sync/awareness routes, asset uploads, public form submissions, import,
ledger operations, sharing, comments, suggestions, plugins, AI, and maintenance
keep their existing specialized or natural idempotency. In particular,
`/api/import` remains content-hash keyed by `import_log`, and public form writes
keep their body key/capability-scoped `write_keys` flow.

`PageInput.idempotencyKey` remains a compatibility input for legacy keyless page
create. New SDK code uses the header. If both are present they must be byte-for-
byte equal or the server returns `400 invalid-input`; the header owns the general
response ledger and the body field may still satisfy the legacy create ledger.

### 4.2 Scope and request identity

The ledger key is `(actor_scope, idempotency_key)`, following today's
per-principal `write_keys` precedent. A verified user and a PAT bound to that
user share the user's `iss#sub` scope; the trusted local transport uses
`local:owner`. Guest/unverified writes use their resolved subject in the guest
namespace. UUID entropy prevents accidental guest collisions, and every replay
still passes current authorization before a stored response may be disclosed.

The key is deliberately not scoped by route. Reusing one UUID anywhere in an
actor's write namespace is an error, which catches outbox bugs instead of
silently treating two operations as unrelated. The ledger stores a SHA-256
request fingerprint over the uppercase method, normalized pathname and sorted
semantic query, content type, and exact body bytes. Authentication headers and
`Idempotency-Key` itself are excluded. Same actor+key with a different
fingerprint returns:

```json
{
  "error": "idempotency key was already used for a different request",
  "code": "idempotency-key-reused",
  "retryable": false
}
```

It never returns the first response for a different fingerprint.

### 4.3 Response-capturing ledger

CWD-5 generalizes the two existing atomic-claim patterns into a ledger that can
represent a complete successful JSON response. Conceptually each committed row
contains:

- actor scope and normalized key (the primary key);
- request fingerprint, method, and normalized target (diagnostics and mismatch
  detection);
- HTTP status, JSON response body, and an allowlist of replayable response
  headers (`Content-Type` and `Location`); and
- completion timestamp for garbage collection.

The key claim, durable mutation, version increment, and response capture commit
in one database transaction. Like `import_log`, a claimant inserts first; a
concurrent identical claimant waits on the unique key, then reads the committed
response. A process failure rolls the uncommitted claim and mutation back, so no
permanent "pending" row is required. The response is fully constructed before
commit; a failure to construct it rolls back the write.

Only successful 2xx responses are retained. Authorization, validation, CAS,
rate-limit, and server-error responses do not consume a key. They perform no
mutation and can safely be evaluated again; notably, a retried stale CAS gets a
fresh current value rather than an old cached 409. Existing authentication,
authorization, access, managed-entity, and body-size gates run before ledger
claim/replay. This prevents a previously successful response from bypassing a
later permission revocation.

On an exact replay after those gates:

1. verify the stored fingerprint;
2. return the stored status, semantically identical JSON body, and allowlisted
   headers; and
3. do not re-run CAS, mutate storage, bump a version, publish a duplicate event,
   or append duplicate edit/history entries.

The existing `import_log` is the precedent for claim-before-work plus stored
result, while `write_keys` supplies the actor scoping. They remain in place for
their legacy routes during wave 1; the generalized ledger does not reinterpret
or discard their existing rows.

### 4.4 Replay with `expectedVersion`

The order is fixed:

1. authenticate, authorize, and apply the existing route gates;
2. validate the key and compute the fingerprint (which includes
   `expectedVersion` in the body);
3. if the same completed key+fingerprint exists, return its captured response;
4. otherwise claim the key and execute the version guard plus mutation in the
   same transaction; and
5. capture the successful response before commit.

Therefore a response-lost replay of `{expectedVersion: 17}` returns the original
successful version-18 response even if the entity is now at version 19; it never
applies the mutation twice and never turns the replay into a false conflict. A
new key with the stale version is a new attempt and receives 409. This is the
exactly-once-ish property the IndexedDB outbox needs: at-most-one committed
effect inside the dedup window, plus the original success response on retry.

The client mints the key once when an outbox entry is created and persists it
beside the exact serialized method/path/body. Network retries reuse it. Editing
the body, changing `expectedVersion`, or choosing take-mine creates a new outbox
entry and a new key.

### 4.5 TTL and garbage collection

The generalized rows use the existing `idempotencyRetentionMs` policy: seven
days by default, `<= 0` to retain forever. The periodic cleanup job deletes rows
whose completion time is older than the configured retention; active
transactions are protected by normal database locking. No request extends its
TTL, which bounds storage even under replay storms.

TTL is also the exact dedup guarantee window. CWD-7 must persist the entry's
creation time and must not automatically replay an entry once the server's
default seven-day window has elapsed; it surfaces that item for explicit user
reconciliation instead. Deployments that intentionally support longer offline
windows set a longer `idempotencyRetentionMs`. This makes the boundary honest:
automatic outbox replay is exactly-once-ish within the configured window, never
silently "probably once" after its proof has been garbage-collected.

## 5. Explicit non-goals

- No CRDT algorithm or storage change. `Y.applyUpdate` is already idempotent for
  content updates; the incremental update, sync, and awareness routes are outside
  this HTTP write ledger.
- No transport change. HTTP, desktop IPC-injected fetch, forwarded HTTP, and the
  browser-local implementation keep their existing paths. The body field and
  header travel through the current fetch abstraction.
- No mandatory CAS for legacy callers, no `If-Match`/ETag cache protocol, and no
  server-side merge policy.
- No full IndexedDB outbox in this wave. The contract only supplies the stable
  key, replay response, version conflict, and retention boundary it will consume.
- No expansion to specialized writes listed outside the route table in §4.1.

## 6. Downstream implementation map

| Issue | Contract sections consumed | Required outcome |
| --- | --- | --- |
| CWD-2 — server CAS | §3.1–§3.4 and §4.4 | Add/backfill counters, return versions, apply opt-in guarded updates, and emit the typed 409 with current state/history link. |
| CWD-5 — idempotency | §4.1–§4.5 (plus §2.1) | Add the actor-scoped response ledger, request fingerprinting, atomic claim/capture, replay ordering, and seven-day GC. |
| CWD-6 — client chokepoint | §2, §3.2–§3.4, and §4.1/§4.4 | Materialize typed errors in `request()`, attach/preserve keys, send body versions, and expose conflict details to take-mine/take-theirs UX. |
