#!/usr/bin/env bash
# Fail if private-key material is committed anywhere in the repo (ST-1).
#
# Runs over TRACKED files only (git grep), locally and in CI (.github/
# workflows/ci.yml). Mirrors the release trust-anchor guard style
# (.github/workflows/release.yml): loud, specific, and zero-tolerance —
# any hit outside the explicit allowlist fails the build, and the two
# allowlisted files are themselves CONTENT-PINNED below (an excluded path
# can't quietly grow a second, different key).
#
# Residual gaps (pattern-based scanning can't see everything): raw 32-byte
# seeds/keys as bare hex or base64 (indistinguishable from hashes/nonces),
# PKCS#8-v2 Ed25519 (RFC 5958 OneAsymmetricKey with the public key attached
# — a different DER prefix), keys inside BINARY files (-I skips them),
# base64 split across lines/concatenated strings, and encrypted key formats
# (PKCS#8 EncryptedPrivateKeyInfo, openssh AES). Defence in depth: the
# release workflow separately refuses to pin the committed test key, and
# CODEOWNERS gates changes to the trust-anchor files.
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
# 5. Bare-base64 PKCS#1 RSA private key (no PEM armor).
RSA_PKCS1='MIIEpAIBAAKC'
# 6. JWK private-key heuristic: a "d" member whose value is 43 base64url
#    chars (the Ed25519/P-256 private scalar length). Cautious on purpose —
#    43 fixed-length url-safe chars after a literal "d": is rare in honest
#    JSON; widen only with evidence.
JWK_D='"d"[[:space:]]*:[[:space:]]*"[A-Za-z0-9_-]{43}"'

EXCLUDES=(
  ':(exclude)scripts/test-registry-key.json'
  ':(exclude)packages/sdk/src/forwarding/rosterAssertion.test.ts'
  ':(exclude)scripts/check-no-private-keys.sh'
)

fail=0
for pattern in "$ED25519_PKCS8" "$PEM" "$MINISIGN" "$EC_PKCS8" "$RSA_PKCS8" "$RSA_PKCS1" "$JWK_D"; do
  if git grep -nIE -e "$pattern" -- . "${EXCLUDES[@]}"; then
    echo "::error::private-key material matching '$pattern' is committed (see above). Remove it and rotate the key — treat it as compromised. Runbook: docs/plugin-signing.md" >&2
    fail=1
  fi
done

# ── Content-pin the allowlisted files ────────────────────────────────────────
# Exclusion is by PATH, so without these checks an allowlisted file could be
# edited to smuggle in a DIFFERENT (real) key. Pin each to its known material.

# scripts/test-registry-key.json: exactly the historical dev key, nothing else.
TEST_KEY_PUB_EXPECTED='nI4eBQzqrIyVPEmJSEzGtqC9B0+kfWTXKyN5t8Yki/E='
test_key_pub=$(node -p "require('./scripts/test-registry-key.json').publicKey")
if [ "$test_key_pub" != "$TEST_KEY_PUB_EXPECTED" ]; then
  echo "::error::scripts/test-registry-key.json's publicKey changed (got '$test_key_pub', pinned '$TEST_KEY_PUB_EXPECTED'). The allowlist covers ONLY the historical dev key — a new keypair here is a smuggled key. Revert, or re-pin deliberately in scripts/check-no-private-keys.sh with review." >&2
  fail=1
fi

# rosterAssertion.test.ts: exactly ONE PKCS#8 match, equal to the fixed vector.
ROSTER_VECTOR_EXPECTED="${ED25519_PKCS8}O3ux9SxxRdqR6MruNpKlIxvnKj5kVhAT7ar4kSSXWTE"
roster_matches=$(git grep -ohE "${ED25519_PKCS8}[A-Za-z0-9+/=_-]*" -- packages/sdk/src/forwarding/rosterAssertion.test.ts | sort -u)
roster_count=$(printf '%s\n' "$roster_matches" | sed '/^$/d' | wc -l | tr -d ' ')
if [ "$roster_count" != "1" ] || [ "$roster_matches" != "$ROSTER_VECTOR_EXPECTED" ]; then
  echo "::error::packages/sdk/src/forwarding/rosterAssertion.test.ts must contain EXACTLY one PKCS#8 key: the pinned fixed test vector. Found $roster_count distinct match(es):" >&2
  printf '%s\n' "$roster_matches" >&2
  echo "Expected only: $ROSTER_VECTOR_EXPECTED — a different key here is a smuggled key. Revert, or re-pin deliberately with review." >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "No committed private-key material found; allowlisted test fixtures match their pinned content."
