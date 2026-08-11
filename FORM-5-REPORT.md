# FORM-5 handoff

Branch: `feat/form5-submission-runtime`  
Base/merge order: `feat/form3-form-block` plus `feat/form1-submission-capability`; no rebase, push, or builder edits.  
Setup: `pnpm install` ran first; `@book.dev/sdk` was built before UI work. The install-created untracked `.pnpm-store` was moved out of the worktree after verification.

## Commits

- `32eea174 feat(forms): validate and project public submissions`
- `78878cc1 feat(ui): run forms on locked public pages`
- `ee7fbba4 test(web): cover published form submissions`

## Acceptance map

| Criterion | Commit | Evidence |
| --- | --- | --- |
| Real controls for every field kind; hidden, skipped honeypot | `78878cc1` | `formSubmissionView.test.tsx`: field-kind rendering and honeypot behavior |
| Blur/submit validation, inline ARIA errors, server 400 mapping | `78878cc1` | UI form tests: blur, submit, `aria-invalid`, `aria-describedby`, translated errors, server errors |
| Pending/success/closed/unavailable/too-large/retry UX | `78878cc1` | UI form tests cover pending guard, safe text success, 404, 413, network retry |
| Stable crypto idempotency per render; double submit guarded | `78878cc1` | UI form tests cover key stability/uniqueness, retry reuse, double-submit single request |
| Safe HTTP(S) redirect and `sys_*` stripping | `78878cc1` | UI helper tests cover absolute/relative HTTP(S), rejected unsafe schemes, reserved IDs |
| Live only on locked/read-only/public interactive surfaces; frozen static/offline; disabled/max=0 closed | `78878cc1` | `formBlock.test.tsx` live/frozen/closed matrix; `FormEditView` and static-export arms untouched |
| Four locales, all validation codes plus submission states | `78878cc1` | en/de/ja/zh catalogs; i18n check passed with no extra keys or placeholder mismatches |
| Route validation after capability gate; honeypot fake success; projected row | `32eea174` | `formSubmissions.test.ts`: 13/13, including deny-before-schema, invalid 400, no-row honeypot, projection, replay/cap/oversize |
| Typed SDK submission errors | `32eea174` | SDK client tests: 22/22 focused; `FormSubmissionError` preserves status and validated field errors |
| Anonymous publish flow: invalid inline, valid projected row, double click one row, honeypot no row | `ee7fbba4` | Playwright spec discovered as one Chromium test; browser execution intentionally left to manager |

## Verification

- Focused: SDK client `22/22`; server form route `13/13`; UI form suites `16/16`; Playwright discovery `1` Chromium test.
- Package gates: SDK/UI/server/web typecheck and lint passed; UI i18n check passed. Full `pnpm verify` passed all library builds, generated mirrors, 6 workspace typechecks, 6 workspace lints, SDK `471/471`, and UI `1925/1925` tests.
- Full verify reached server Vitest with `1181 passed`, `5 skipped`, `1 failed` across `89 passed`/`1 failed` files; the sole failure plus 14 unhandled watcher errors was the known sandbox-only `EMFILE` in `mirror.integration.test.ts`. Per task direction this was recorded, not chased; the command stopped before its e2e phase.
- E2E run separately: legacy server smoke rerun passed `256/256`; MCP passed `44/44`. The first server smoke attempt transiently failed its unrelated nested-page `parent left the trash` assertion, then passed cleanly on immediate rerun.
- Manager browser run remains: `pnpm --filter @book.dev/web exec playwright test e2e/form-submission.spec.ts`.

## Route integration behavior for Sasha R4/R5 pass

`POST /api/pages/:pageId/forms/:formId/submissions` parses only enough key material to run `requireFormSubmissionAccess` first, preserving byte-identical 404 denial behavior. After access passes, request-envelope validation runs, followed by schema `validateSubmission`. Invalid schema values return `400 {errors}`. A tripped honeypot returns the normal 201 result shape with a random row ID and timestamp, but performs no database write. Valid coerced values pass through server-side `submissionToRowInput`, so only bound/projected database properties are written; the existing internal submission marker and atomic write-key idempotency remain intact. Key length/format is never validated, preserving 22- and 43-character capabilities. The client also strips every `sys_*` ID before transport and renders success/stored user content through React text nodes only. Existing cap behavior is unchanged; local success is terminal, including the advisory replay-after-cap 404 case.

## Manager capture list

1. Filled live form on the anonymous published/read-only page before submission.
2. Invalid email with its inline translated error and invalid-field styling.
3. Confirmation success state after valid submission (database row visible separately if desired).

## Sane defaults

- Report path defaults to this repository-root file.
- A form is live only when its page is locked/read-only, the block's interactive-when-locked escape hatch is enabled, a safe origin yields a page ID, and the data client supports submission; otherwise it remains the frozen FORM-3 preview.
- `enabled: false` and `maxSubmissions: 0` both mean closed. Missing/unsafe redirects leave the user on the text confirmation. Network retry reuses the render's idempotency key. Files submit their names as the current schema's client value; no upload transport was introduced.
