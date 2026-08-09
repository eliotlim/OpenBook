# Plugin signing & the registry key ceremony

How first-party (bundled) plugins get their **Verified** badge, where the
trust anchor lives, and how the owner mints, stores, and rotates the signing
key. Covers `packages/sdk/src/plugins.ts` (the pinned key + sign/verify),
`packages/ui/scripts/bundlePlugins.ts` / `bundleSigning.ts` (build-time
signing), `scripts/gen-registry-key.mjs` (the ceremony), and the CI guards.

## How trust flows

1. Every OpenBook build **pins the first-party public keys**:
   `OPENBOOK_REGISTRY_KEYS` in `packages/sdk/src/plugins.ts` — a LIST so
   rotation can overlap (normally one entry; two during a rotation window).
   That constant is the ONE place the production keys live; users may trust
   additional registry keys on top (Settings → Extensions → Trusted
   registries). `OPENBOOK_REGISTRY` remains as a deprecated alias for entry
   `[0]` (display/back-compat only — trust decisions consume the list).
2. At build, `pnpm run gen:bundled-plugins` (part of the ui build) embeds the
   first-party plugin sources into `packages/ui/src/plugins/bundled.gen.ts`
   and **signs each package** (Ed25519 over the canonical SHA-256 digest of
   manifest + files):
   - with the **`OPENBOOK_REGISTRY_PRIVATE_KEY`** env var when set (release
     CI reads the GitHub Actions secret of the same name; the public half is
     derived from it — it must be a pinned `OPENBOOK_REGISTRY_KEYS` entry for
     installs to show Verified, and release CI's post-build backstop
     `scripts/check-bundled-signatures.mjs` enforces exactly that), or
   - with the committed **TEST-ONLY** key `scripts/test-registry-key.json`
     when unset (dev/test builds; logged loudly). Its private half is public
     by definition, so nothing trusts it by default — e2e trusts it
     explicitly per test.
   `OPENBOOK_REGISTRY_REQUIRE_KEY=1` turns the test fallback into a hard
   build failure (for wiring a strict release later).
3. The client verifies every installed plugin on each sync
   (`packages/ui/src/plugins/host.ts`) against the pinned key plus the user's
   trusted keys. Match → **Verified by \<registry\>**; unsigned / unknown key /
   tampered content → **Unverified** (still installs — signing is provenance,
   not sandboxing).

Signing a plugin zip by hand always takes an explicit key — there is no
silent default:

```sh
node scripts/pack-plugin.mjs <plugin-dir> <out.zip> --sign --key <key.json>
# or: OPENBOOK_REGISTRY_PRIVATE_KEY=<base64 pkcs8> node scripts/pack-plugin.mjs … --sign
```

## Current state (ceremony performed 2026-08-09)

The pinned key is the production key minted during the 2026-08-09 ceremony.
Its private half is held only in the GitHub Actions `publish` environment
secret **`OPENBOOK_REGISTRY_PRIVATE_KEY`**. Release builds sign bundled
first-party plugins with that key, so they will show **Verified** beginning
with the next release. Ceremony step 6 (`OPENBOOK_REGISTRY_REQUIRE_KEY`
lock-in) remains **PENDING** until that first verified release confirms the
secret works.

## Key ceremony (owner runbook)

One person, a few minutes, nothing sensitive touches the repo:

1. **Generate** — on a trusted machine:

   ```sh
   node scripts/gen-registry-key.mjs --out registry-key.json
   ```

   Prints the raw base64 **public** key and writes the PKCS#8 base64
   **private** key to `registry-key.json` (mode 0600).
2. **Store the secret** — GitHub → repo Settings → Environments → `publish` →
   add secret **`OPENBOOK_REGISTRY_PRIVATE_KEY`** = the `privateKey` value.
   (Same environment as the Tauri updater / Apple signing secrets; both
   release build legs read it.)
3. **Commit the public key** — replace the placeholder entry in
   `OPENBOOK_REGISTRY_KEYS` (`packages/sdk/src/plugins.ts`) with the printed
   public key (and refresh its placeholder note). This is the only repo
   change the ceremony makes. (`registry-key.json` is gitignored, and the
   generator refuses to overwrite existing files.)
4. **Destroy local copies** — delete `registry-key.json` (`rm -P` /
   `shred -u`). The secret store is now the only holder of the private half.
5. **Verify** — the next release's build logs show
   `signed by OpenBook Registry [env]` (not the TEST-key warning), the
   post-build backstop step passes (`check-bundled-signatures.mjs`: every
   bundled signature matches a pinned key), and a fresh install shows the
   Ledger extension as **Verified**.
6. **Lock it in** — uncomment the two `OPENBOOK_REGISTRY_REQUIRE_KEY: "1"`
   env lines in `.github/workflows/release.yml` (the tauri build leg and the
   npm library build leg), so a future loss of the secret FAILS the release
   instead of silently degrading to the TEST-signed fallback.

## Rotation (with overlap) and revocation

Clients only trust keys they ship with (or that users add by hand), so rotate
**add-then-remove** — never cut over in one step. The mechanism is
`OPENBOOK_REGISTRY_KEYS` being a list: every entry is a fully trusted
first-party anchor, on every build, and the release guards check ALL entries.

1. Generate the NEW keypair (ceremony step 1; keep the private half aside —
   do not touch the CI secret yet).
2. **Ship overlap**: append the new public key as a SECOND
   `OPENBOOK_REGISTRY_KEYS` entry and release. Bundles are still signed by
   the OLD key (the unchanged secret), so pre-overlap and overlap clients
   both verify; overlap clients additionally trust the new key.
3. **Cut over signing**: once the overlap release is broadly installed,
   replace the `OPENBOOK_REGISTRY_PRIVATE_KEY` secret with the new private
   key (and destroy the held copy). New builds sign with the new key — still
   verified by overlap clients; the post-build backstop keeps passing because
   the new key is pinned.
4. **Revoke**: a later release removes the OLD entry from
   `OPENBOOK_REGISTRY_KEYS` (back to one entry). Builds that shipped before
   the overlap release keep trusting the old key — for a genuine compromise
   treat those builds as burned and push users forward via the app updater.

**Compromise response**: rotate immediately (skip the overlap niceties),
publish the incident, and never sign with the leaked key again. Anything it
signed after the leak date must be treated as untrusted.

**Threat-model caveat**: signing is provenance, not sandboxing — and the
user-added trust list lives in `localStorage`, which plugins (running with
the page's privileges) can write. A malicious plugin that is ALREADY
installed and enabled could therefore add trusted keys or clear dismissals;
verification protects the decision to install/trust, not a machine that
already runs hostile code. The PINNED keys are compiled into the bundle and
are not reachable that way, and user-added names that collide with a pinned
registry name are rejected (`addTrustedRegistry`), so a first-party-looking
"Verified by OpenBook Registry" badge cannot be minted from localStorage.

## Guard rails (CI)

- **No private material in git** — `scripts/check-no-private-keys.sh` runs
  first in the CI verify job and fails on any committed private-key material
  (Ed25519/EC/RSA PKCS#8 base64 DER prefixes, PEM blocks, minisign secret
  keys) outside two allowlisted, deliberately-public test fixtures.
- **The test key can never become a trust anchor** — the release workflow
  refuses (pre-tag) to release when ANY `OPENBOOK_REGISTRY_KEYS` entry equals
  `scripts/test-registry-key.json`'s public key; a unit test
  (`packages/ui/scripts/bundleSigning.test.ts`) enforces the same invariant
  at development time. The guard script also content-pins the allowlisted
  test fixtures, so the excluded files can't quietly grow different keys, and
  `.github/CODEOWNERS` requires owner review on the trust-anchor files.
- **Wrong-key releases can't slip through** — with the secret set, a
  post-build backstop (`scripts/check-bundled-signatures.mjs`, on both build
  legs) fails the release unless every bundled plugin's signature public key
  is a pinned `OPENBOOK_REGISTRY_KEYS` entry.
- **Missing secret degrades, never breaks** — release builds without
  `OPENBOOK_REGISTRY_PRIVATE_KEY` emit a loud `::warning` and TEST-sign the
  bundle (Unverified badge), preserving the pre-signing status quo.
