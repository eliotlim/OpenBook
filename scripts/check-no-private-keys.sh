#!/usr/bin/env bash
# Fail if private-key material is committed anywhere in the repo (ST-1).
#
# Runs over TRACKED files only (git grep), locally and in CI (.github/
# workflows/ci.yml). Mirrors the release trust-anchor guard style
# (.github/workflows/release.yml): loud, specific, and zero-tolerance —
# any hit outside the explicit allowlist fails the build.
#
# Allowlisted (deliberately-public TEST material only — never trust anchors):
#   scripts/test-registry-key.json                    the TEST-ONLY plugin-registry
#                                                     key (release CI separately
#                                                     refuses to ship a build whose
#                                                     pinned key matches it)
#   packages/sdk/src/forwarding/rosterAssertion.test.ts  a FIXED test vector keypair
#                                                     (canonical byte-agreement
#                                                     vectors, test-only)
set -euo pipefail
cd "$(dirname "$0")/.."

# Every pattern is split ('…''…') so this script never matches itself.
# 1. Ed25519 PKCS#8 private key, base64 — the constant DER prefix every such
#    key starts with (this repo's registry/identity key format).
ED25519_PKCS8='MC4CAQAwBQYDK2Vw''BCIEI'
# 2. Any PEM-armored private key (RSA/EC/OpenSSH/PKCS#8/…).
PEM='-----BEGIN'' [A-Z0-9 ]*PRIVATE KEY'
# 3. A minisign/Tauri-updater secret key file's banner.
MINISIGN='untrusted comment:'' .*secret key'
# 4. Non-Ed25519 base64 private-key DER prefixes (EC P-256, PKCS#8 RSA).
EC_PKCS8='MIGHAgEAMBMGByqGSM49''AgEG'
RSA_PKCS8='MIIEvAIBADANBgkqhkiG9w0''BAQEF'

EXCLUDES=(
  ':(exclude)scripts/test-registry-key.json'
  ':(exclude)packages/sdk/src/forwarding/rosterAssertion.test.ts'
  ':(exclude)scripts/check-no-private-keys.sh'
)

fail=0
for pattern in "$ED25519_PKCS8" "$PEM" "$MINISIGN" "$EC_PKCS8" "$RSA_PKCS8"; do
  if git grep -nIE -e "$pattern" -- . "${EXCLUDES[@]}"; then
    echo "::error::private-key material matching '$pattern' is committed (see above). Remove it and rotate the key — treat it as compromised. Runbook: docs/plugin-signing.md" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "No committed private-key material found (outside the allowlisted test fixtures)."
