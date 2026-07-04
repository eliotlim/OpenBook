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

Two GitHub Actions secrets, read by the `publish-tauri` job's build step, must
be set in the **`publish`** environment (where the `APPLE_*` secrets already
live):

| Secret | What it is |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | The updater private key **contents** (the whole minisign-format key string, not a file path). |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password chosen when generating the key. Set to an empty string if the key was generated without one. |

If these are **absent**, the build still produces the updater archives but leaves
them **unsigned** (no `.sig`). If the key **is** present but signing produces no
`.sig` files (bad key/password), the "Guard — updater signatures must exist"
step fails the job loudly rather than publishing an un-updatable release.

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

### Pubkey (IMPORTANT — currently a placeholder)

Tauri v2 refuses to build updater artifacts unless
`packages/app/src-tauri/tauri.conf.json` has a `plugins.updater` block with a
valid-format `pubkey` (the build hard-errors: *"failed to get updater
configuration: plugins > updater doesn't exist"*). So this pipeline change ships
a **placeholder pubkey** to keep the release build green.

**The placeholder's matching private key was generated as a throwaway and
destroyed — it can never sign anything.** Before shipping any real auto-update:

1. Generate the production keypair (above) and set the two secrets.
2. Replace `plugins.updater.pubkey` in `tauri.conf.json` with the **production**
   `~/openbook-updater.key.pub` contents. It must correspond to the exact private
   key in `TAURI_SIGNING_PRIVATE_KEY`, or every update is rejected at verify time.
3. Point `plugins.updater.endpoints` at the real account-server manifest URL.

That production wiring (plus the `tauri-plugin-updater` Cargo dependency and the
in-app update-check UI) is owned by the **desktop-integration task** — this
change only makes CI *emit* signed artifacts. Until the placeholder is replaced,
CI still produces valid `.sig` files (signed with whatever `TAURI_SIGNING_PRIVATE_KEY`
holds), but an installed app would reject them because the embedded pubkey won't
match — which is fine, because no updater runtime ships until that task lands.

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
