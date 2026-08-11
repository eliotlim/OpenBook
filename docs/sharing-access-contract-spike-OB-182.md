# Sharing/access contract amendment

> The base OB-182 contract is not present in `origin/main` (it was removed by the
> public-repository hygiene change). This file therefore restores only the new
> amendment below; none of the removed contract text is reconstructed or changed.

## 9. FORM-1 — page-scoped form-submission capabilities

An anonymous form submission is authorized by a capability stored in the form
block's persisted props: `{formId, submissionKey, enabled, databaseId, schema}`.
The v1 endpoint is page-scoped —
`POST /api/pages/:pageId/forms/:formId/submissions` — so the server reads that
single page and scans for a matching `type:'form'` block in
`PageSnapshot.blockdoc.blocks`, the raw recursive
JSON written by the block editor's `encodeSnapshot`; `editorjs` is only the export
projection and is not authoritative for form props/children. The server never
performs a full-library form-id scan and no form-definition table is introduced.
Submission keys are crypto-random, 256-bit,
unpadded base64url values. Keeping the key in readable page props is acceptable:
anyone who can read the published page already has permission to submit to that
form. The capability is not intended to be secret from readers; it prevents
probing and submitting to an otherwise unreachable page/form. Regeneration is a
normal author edit of the form props.

This capability is deliberately **not** a new rung in `authorize()`. It grants
only the form row-create operation and cannot grant page read or write. The
server-side form gate first requires an existing, enabled, unambiguous form and a
constant-time key match, then reuses the request principal's existing
`store.decidePageAccess` result for READ of the host page. An anonymous caller
therefore submits only when an anonymous principal can read that public page;
an authenticated caller may submit when that caller can read it, but still needs
the same form key. Visibility inheritance, ACL/role resolution, the forwarded
request posture, and the `guestAccess:'off'` floor all remain owned by the one
existing page decision. In particular, `guestAccess:'off'` denies every
unauthenticated submission even when the page is public and the supplied key is
valid. The target database must exist and be hosted by the same page; this
fail-closed binding prevents edited props from becoming a confused-deputy write
into an unrelated database. Server-managed databases (including every ledger
database) are also denied inside this same gate, before the generic row writer's
managed-database error can expose a distinct response.

No-such-page, no-such-form, duplicate/malformed form definitions, disabled form,
wrong or missing key, unreadable host page, foreign/missing target database, and
the `guestAccess:'off'` floor, a managed target database, and a reached submission
ceiling all return the identical `404` JSON bytes
`{"error":"form not found"}`. A caller cannot use response status or body as an
existence oracle. The guest-mutation CSRF posture is unchanged: an anonymous POST
must carry `X-OpenBook-Client` (or the existing non-simple Authorization header)
and otherwise returns `403`; embed-anywhere submission is explicitly out of scope
for v1. The request also carries a client idempotency key, atomically claimed in
the existing `write_keys` ledger under the page+form capability namespace, so a
replay returns the original `201` result and row rather than creating another.
Rows record submitted values plus the reserved `sys_form_submission`
`{formId, submittedAt}` provenance marker; anonymous submissions assert no
verified author. FORM-5 will apply the form schema semantics. FORM-1 limits only
the JSON envelope: 100 top-level fields, depth 8, 16 KiB per value, 128 KiB total
values, a 200-byte idempotency key after trimming, and a 160 KiB raw request body.

As an interim abuse ceiling pending FORM-6 rate limiting, the gate counts the
target database's non-deleted rows before creation. It denies when the count is
greater than or equal to the form schema's non-negative integer `maxSubmissions`;
when that field is absent, the instance default is the documented constant
10,000 submissions per form. A malformed override fails closed. The default is
not yet instance-configurable (FORM-6 owns that policy together with rate limits).

**FORM-6 asset-upload carve-out (design only).** A future asset endpoint may accept
the same page+form submission capability to stage files for a submission without
granting general page/database write. It must re-run the same enabled-form,
constant-time-key and host-page READ gate; apply explicit per-file, per-submission
and instance storage caps plus a safe MIME policy; bind finalized asset refs only
to the idempotently created submission row; and timestamp unclaimed uploads so a
bounded orphan-GC job removes uploads that never become reachable. No upload route
or storage behavior is implemented by FORM-1.
