# FORM-6 handoff

Branch: `feat/form6-uploads-abuse`  
Stack/merge order: `feat/form5-submission-runtime` first, then this branch; no rebase or push.  
Setup: `pnpm install` ran first, then `pnpm --filter @book.dev/sdk build` completed before server or UI work. The install-created `.pnpm-store` was moved out of the worktree after setup.

## Commits

- `6477093a feat(forms): stage uploads and limit abuse`
- `7bb56582 feat(ui): upload public form files`
- `docs(forms): record form6 verification` (this handoff commit)

## Acceptance matrix

| Criterion | Test evidence |
| --- | --- |
| Staged upload uses an opaque token; a valid submission writes files-property asset URLs; replay creates one row; served asset remains sanitized, `nosniff`, and attachment-only | `packages/server/src/formSubmissions.test.ts`: `stages opaque tokens, stores asset URLs on one row, and replays safely`; SDK upload wire/error tests in `packages/sdk/src/client.test.ts` |
| Decoded file over 5 MiB returns 413 | `formSubmissions.test.ts`: `rejects a decoded file over 5 MiB with 413` |
| More than five file tokens across the submission returns 400 and creates no row | `formSubmissions.test.ts`: `rejects more than five upload tokens in one submission` |
| Wrong capability and a form without a files field use the submission route's byte-identical 404 | `formSubmissions.test.ts`: `uses the submission route's byte-identical 404 for wrong keys and forms without files`; the unchanged FORM-1 deny matrix remains covered by `returns byte-identical denials for every existence/capability/read failure` |
| Submission and upload floods each return 429 with `Retry-After: 60` | `formSubmissions.test.ts`: `returns 429 plus Retry-After when either public form route floods its window` |
| An unclaimed stage older than 30 minutes is swept, including its unreferenced asset | `formSubmissions.test.ts`: `sweeps a staged orphan after 30 minutes on the next submission` |
| Honeypot plus staged upload fake-succeeds, creates no row, and retains neither token nor asset | `formSubmissions.test.ts`: `fake-succeeds a honeypot carrying an upload and retains neither row nor staged asset` |
| Per-form 50 MiB asset budget returns 507 without leaving the rejected asset | `formSubmissions.test.ts`: `returns 507 when the per-form 50 MiB asset budget is exhausted` |
| Upload-token table and sweep indexes migrate cleanly | `packages/server/src/migrations.test.ts`: `creates the token table and orphan-sweep indexes` |
| UI progresses uploading -> ready -> token submission | `packages/ui/src/blockeditor/__tests__/formSubmissionView.test.tsx`: `shows upload progress, stores opaque tokens, then submits those tokens` |
| UI blocks oversize/over-count selections before transport and maps storage 507 to a clean localized field error | `formSubmissionView.test.tsx`: `rejects oversized and over-count selections before transport`; `surfaces a localized clean error when staged asset storage returns 507` |
| `schema.retention` survives the runtime CRDT/save projection | `packages/ui/src/blockeditor/__tests__/formBlock.test.tsx`: `round-trips every FORM-1 gate prop through the CRDT JSON projection` |

## Caps and constants

| Control | Default |
| --- | --- |
| Decoded bytes per file | `FORM_UPLOAD_MAX_FILE_BYTES = 5 * 1024 * 1024` (5 MiB) |
| Files per submission, summed across files fields | `FORM_UPLOAD_MAX_FILES = 5` |
| Unique stored asset bytes per form | `FORM_UPLOAD_MAX_FORM_BYTES = 50 * 1024 * 1024` (50 MiB) |
| Unconsumed stage lifetime | `FORM_UPLOAD_ORPHAN_TTL_MS = 30 * 60 * 1000` (30 minutes) |
| Shared upload + submission fixed window | `FORM_REQUEST_RATE_LIMIT = 30` requests per `FORM_REQUEST_RATE_WINDOW_MS = 60_000` |
| Existing default form ceiling | `FORM_SUBMISSION_DEFAULT_MAX_SUBMISSIONS = 10_000`; a schema override remains authoritative |

The limiter runs only after the security-cleared capability/read/same-host/ceiling gate, preserving uniform 404 denials. Direct requests use the socket peer plus page/form. Forwarded requests and adapters without a trustworthy peer deliberately fall back to one page/form bucket; client forwarding headers are not trusted. Upload and submission requests consume the same bucket.

The per-form byte transaction is serialized and content-addressed duplicates count once for that form. The pre-existing instance asset budget remains an additional limit. Either budget returns 507. The upload JSON raw-body cap accounts for base64 expansion, while the decoded-byte check remains authoritative.

## Storage, orphan, and retention defaults

- Upload bytes enter the existing asset store but are unreadable stages until a valid submission consumes their random token and attaches an asset reference to the row.
- Orphan collection is the cheap activity-triggered option: both form routes sweep unconsumed stages older than 30 minutes. The sweep removes the asset only when no other stage, asset reference, or page document protects it.
- A honeypot submission immediately discards the supplied unconsumed stages instead of waiting for the sweep.
- `FormSchema.retention?: AutoExpiryConfig` is already present and is preserved by the schema/runtime projection. Applying it to the bound database was not wired: this stacked branch has no FORM-4 builder/save seam, and the anonymous routes must not mutate database policy. Follow up in the FORM-4 owner save path by copying the authored retention value into `DatabaseSchema.autoExpiry`; the existing hourly `autoExpiry` sweep will then enforce it.

## Verification

- Focused: SDK client `24/24`; server access/submission/migration `39/39`; UI form suites `19/19`.
- Package gates: SDK, server, and UI typecheck and lint passed. The seven FORM-6 locale additions are present in en/de/ja/zh; i18n reports no extra-key or placeholder mismatch in any locale (after the main merge, the repository's untranslated-key baseline is de 675, ja 679, zh 679).
- Foreground `pnpm verify`: all library builds, generated-mirror check, six workspace typechecks, six workspace lints, SDK `473/473`, UI `1928/1928`, and MCP workspace tests passed. Server Vitest reached `1190 passed`, `5 skipped`, `1 failed` across `89 passed`/`1 failed` files. The sole failure and 14 unhandled errors are the known sandbox-only watcher exhaustion in `mirror.integration.test.ts` (`EMFILE: too many open files, watch`); per task direction it was recorded and not chased. Verify stopped before its e2e phase.
- E2E invoked separately after verify stopped: server `256/256`; MCP `44/44`.

## Manager capture list

1. Anonymous live form immediately after selecting a file, showing the localized upload-in-progress state and disabled submit.
2. The same form with the staged file ready, followed by its success state; pair with the bound database row showing the files-property attachment.
3. Client-side oversize or six-file rejection with its localized inline/ARIA error.
4. Storage-budget 507 rendered as the clean localized form error.

No browser captures were generated in this worker run; the list above is the requested manager capture set.
