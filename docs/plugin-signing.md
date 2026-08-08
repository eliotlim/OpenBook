# Plugin signing & the registry key ceremony

How first-party (bundled) plugins get their **Verified** badge, where the
trust anchor lives, and how the owner mints, stores, and rotates the signing
key. Covers `packages/sdk/src/plugins.ts` (the pinned key + sign/verify),
`packages/ui/scripts/bundlePlugins.ts` / `bundleSigning.ts` (build-time
signing), `scripts/gen-registry-key.mjs` (the ceremony), and the CI guards.

## How trust flows

1. Every OpenBook build **pins one first-party public key**:
   `OPENBOOK_REGISTRY` in `packages/sdk/src/plugins.ts`. That constant is the
   ONE place the production key lives; users may trust additional registry
   keys on top (Settings → Extensions → Trusted registries).
2. At build, `pnpm run gen:bundled-plugins` (part of the ui build) embeds the
   first-party plugin sources into `packages/ui/src/plugins/bundled.gen.ts`
   and **signs each package** (Ed25519 over the canonical SHA-256 digest of
   manifest + files):
   - with the **`OPENBOOK_REGISTRY_PRIVATE_KEY`** env var when set (release
     CI reads the GitHub Actions secret of the same name; the public half is
     derived from it), or
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

## Current state (until the ceremony)

The pinned key is a **placeholder** whose private half was generated in
memory and destroyed — nothing can ever sign for it. Bundled plugins are
TEST-signed and therefore show **Unverified**, exactly like the pre-signing
builds. Nothing breaks; the ceremony below turns the badge on.

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
3. **Commit the public key** — replace `OPENBOOK_REGISTRY.publicKey` in
   `packages/sdk/src/plugins.ts` with the printed public key (and refresh its
   placeholder note). This is the only repo change the ceremony makes.
4. **Destroy local copies** — delete `registry-key.json` (`rm -P` /
   `shred -u`). The secret store is now the only holder of the private half.
5. **Verify** — the next release's build logs show
   `signed by OpenBook Registry [env]` (not the TEST-key warning), and a
   fresh install shows the Ledger extension as **Verified**.

## Rotation (with overlap) and revocation

Clients only trust keys they ship with (or that users add by hand), so rotate
**add-then-remove** — never cut over in one step:

1. Generate the NEW keypair (ceremony steps 1–2; store the secret under the
   same name only at the cutover, step 3 below — until then keep it aside or
   under a temp name).
2. **Ship overlap**: commit a release where builds trust BOTH keys — swap
   `OPENBOOK_REGISTRY.publicKey` to the new key and keep the old key
   available to clients (e.g. as an additional trusted key surfaced in
   Settings, or by keeping the old key pinned one more release while the new
   one rides as an extra). Bundles are still signed by the OLD key, so
   existing and updated clients both verify.
3. **Cut over signing**: once the overlap release is broadly installed,
   replace the `OPENBOOK_REGISTRY_PRIVATE_KEY` secret with the new private
   key. New builds are signed by the new key; overlap-release clients verify
   either.
4. **Revoke**: a later release drops the old public key everywhere. Builds
   that shipped before the overlap release keep trusting the old key — for a
   genuine compromise treat those builds as burned and push users forward via
   the app updater.

**Compromise response**: rotate immediately (skip the overlap niceties),
publish the incident, and never sign with the leaked key again. Anything it
signed after the leak date must be treated as untrusted.

## Guard rails (CI)

- **No private material in git** — `scripts/check-no-private-keys.sh` runs
  first in the CI verify job and fails on any committed private-key material
  (Ed25519/EC/RSA PKCS#8 base64 DER prefixes, PEM blocks, minisign secret
  keys) outside two allowlisted, deliberately-public test fixtures.
- **The test key can never become the trust anchor** — the release workflow
  refuses (pre-tag) to release when `OPENBOOK_REGISTRY.publicKey` equals
  `scripts/test-registry-key.json`'s public key; a unit test
  (`packages/ui/scripts/bundleSigning.test.ts`) enforces the same invariant
  at development time.
- **Missing secret degrades, never breaks** — release builds without
  `OPENBOOK_REGISTRY_PRIVATE_KEY` emit a loud `::warning` and TEST-sign the
  bundle (Unverified badge), preserving the pre-signing status quo.
