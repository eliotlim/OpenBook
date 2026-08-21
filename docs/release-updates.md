# Release updates & updater signing

How OpenBook desktop ships auto-updatable, signed releases, and how to operate
the update channel. This covers the CI plumbing added to `.github/workflows/release.yml`
and `packages/app/src-tauri/tauri.conf.json` — not the in-app updater UI, which
the desktop-integration task wires separately (see "Pubkey" below).

## How updates flow

1. A merge to `main` cuts a release (`nx release`), which tags `vX.Y.Z` and
   creates a GitHub Release.
2. The `publish-tauri` matrix builds per-target desktop bundles. With
   `bundle.createUpdaterArtifacts: true` (Tauri v2), each target also emits an
   **updater archive** plus a detached **`.sig`** minisign signature:
   - macOS (per arch): `OpenBook.app.tar.gz` + `OpenBook.app.tar.gz.sig`
   - Linux: `*.AppImage` + `*.AppImage.sig`
   - Windows: `*.msi` + `*.msi.sig` and/or nsis `*-setup.exe` + `*-setup.exe.sig`
   Every `.sig` (and any Tauri-emitted `latest.json`) is uploaded to the release
   alongside the human-facing installers.
3. The **account server builds the updater manifest dynamically** from the
   GitHub Release assets — there is no committed/generated `latest.json` in this
   repo. A Tauri-emitted `latest.json` may be uploaded as a harmless fallback if
   it appears; the client-facing source of truth is the account-server manifest.
4. The desktop app's updater fetches the archive named in the manifest and
   verifies its `.sig` against the **pubkey compiled into the app** before
   applying. A missing or bad signature = the update is rejected.

## Signing secrets

Windows Authenticode publisher signing is separate from these updater `.sig`
files; see [Windows Authenticode signing](windows-signing.md).

Two GitHub Actions secrets, read by the `publish-tauri` job's build step, must
be set in the **`publish`** environment (where the `APPLE_*` secrets already
live):

| Secret | What it is |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | The updater private key **contents** (the whole minisign-format key string, not a file path). |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password chosen when generating the key. Set to an empty string if the key was generated without one. |

These are a **hard prerequisite** for every release once a pubkey is configured —
not an optional enhancement. With `bundle.createUpdaterArtifacts: true` **and** a
configured `plugins.updater` pubkey, `tauri build` **refuses to bundle** when
`TAURI_SIGNING_PRIVATE_KEY` is unset: it errors out, it does *not* fall back to
emitting unsigned archives. The workflow enforces this in layers:

1. A top-level **`preflight` job** (in the `publish` environment — where the
   secret lives, and which the `release` job's own environment cannot read)
   asserts `TAURI_SIGNING_PRIVATE_KEY` is non-empty **before anything
   irreversible happens**: both `release` (the tag + GitHub release) and
   `publish-npm` `need` it, so a secrets-less run dies before a tag exists or a
   library ships. Presence check only — nothing about the secret is echoed. The
   `publish` environment has no required reviewers or wait timer (verified
   2026-07-04; only a `main`/`v*` deployment branch policy this run already
   satisfies), so the job adds **no approval friction** — the single human
   approval stays on the `release` environment.
2. A **per-leg preflight step** inside `publish-tauri` (before the expensive
   build) re-asserts the key **and** greps `tauri.conf.json` for the placeholder
   pubkey — the backstop for a *standalone re-run* of that job, which skips
   upstream jobs.
3. If the key **is** present but signing produces no `.sig` files (bad key/wrong
   password), the post-build "Guard — updater signatures must exist" step fails
   the job rather than publishing an un-updatable release.

### Generating the keypair (one-time, owner)

Run locally in `packages/app`:

```sh
pnpm exec tauri signer generate -w ~/openbook-updater.key
# You'll be prompted for a password (recommended). It writes:
#   ~/openbook-updater.key       (PRIVATE — never commit, never share)
#   ~/openbook-updater.key.pub   (PUBLIC  — safe to commit; goes in tauri.conf.json)
```

Then add the secrets (via the GitHub UI, Settings → Environments → `publish` →
secrets, or with the `gh` CLI):

```sh
# Private key CONTENTS (not the path) — the whole file:
gh secret set TAURI_SIGNING_PRIVATE_KEY --env publish < ~/openbook-updater.key
# The password you chose above (omit --body for an empty password):
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --env publish --body 'the-password'
```

Store the private key + password in the team password manager. If the private
key is lost, already-installed apps can no longer be updated (they only trust
the pubkey they shipped with) — you would have to ship a new pubkey in a fresh
build and have users reinstall. Treat it like the Apple signing cert.

### Pubkey (production key now wired)

Tauri v2 refuses to build updater artifacts unless
`packages/app/src-tauri/tauri.conf.json` has a `plugins.updater` block with a
valid-format `pubkey` (the build hard-errors: *"failed to get updater
configuration: plugins > updater doesn't exist"*). The original pipeline change
shipped a **placeholder pubkey** (throwaway key id `556A7C0F67F480F8`, whose
private half was destroyed) purely to keep the release build green while the
production key was minted.

The **desktop-integration change** replaced that placeholder with the
**production** pubkey and pointed `plugins.updater.endpoints` at the real
account-server manifest URL
(`https://account.book.pub/api/updates/manifest?target={{target}}&arch={{arch}}&current_version={{current_version}}`),
alongside adding the `tauri-plugin-updater` Cargo dependency and the in-app
update-check surface. The production pubkey must correspond to the exact private
key in `TAURI_SIGNING_PRIVATE_KEY`, or every update is rejected at verify time.

The `publish-tauri` **preflight** greps `tauri.conf.json` for the old
placeholder base64 and fails the run if it is ever reintroduced — so a
regression to the throwaway key can't ship. If you rotate the production
keypair, update both the secret and `plugins.updater.pubkey` together.

## The `[security]` marker convention

The update checker treats a release as a **security release** when the GitHub
release body contains the literal marker `[security]`. Mark a release this way
to signal the client that the update is important (e.g. surface a stronger
"update now" prompt / reduce defer options). For a routine release, omit the
marker. Place it on its own line in the release notes, e.g.:

```
[security]

Fixes CVE-… in the bundled server sidecar.
```

## Rollback

There is no manifest to edit — the account server derives "latest" from the
GitHub Release assets. To roll a bad release back:

1. **Delete the bad release's updater assets** (the `.app.tar.gz`/`.AppImage`/
   `.msi`/`.exe` + their `.sig`) from the GitHub Release, or delete/mark the
   whole release as a draft. With those assets gone, the account-server manifest
   **falls back to the previous release**, so clients on the bad version get
   offered the older good build (or simply stop being offered the bad one).
2. If the bad version was already installed by users, cut a **new** higher
   version with the fix — you cannot downgrade an installed client, only move it
   forward. A `[security]` marker on the fix release nudges clients to take it
   promptly.

Keep the previous release's assets intact until the replacement is confirmed
healthy, since they are the fallback target.
