#!/usr/bin/env bash
# Behavioral: og.jpg must survive the rebuild that follows gen_og_images.
#
# build_from_hub rebuilds site/<prefix> from the hub SSOT and drops whatever the
# hub does not hold. gen_og_images writes og.jpg under site/ only, so a first
# publish of a new slug used to deploy without its card. Isolated hub via
# FORGE_CONFIG — no Cloudflare, no network, no real hub.
# bash 3.2-safe.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
PUBLISH="$ROOT/plugins/silex-forge/scripts/publish.sh"
BUILD="$ROOT/plugins/silex-forge/scripts/build-site-from-hub.py"

pass() { echo "  ok  $*"; }
fail() { echo "  FAIL $*" >&2; exit 1; }

echo "og persistence tests"

TD="$(mktemp -d)"
trap 'rm -rf "$TD"' EXIT

mkdir -p "$TD/hub/artifacts/new-deck" "$TD/work/repo/site" "$TD/work/repo/registry"
echo '<html><head><title>New</title></head><body>hi</body></html>' \
  > "$TD/hub/artifacts/new-deck/index.html"

cat > "$TD/cfg.json" <<EOF
{"hub_root": "$TD/hub", "artifacts_dir": "artifacts", "site_dir": "site",
 "registry_dir": "registry", "internal_prefix": "a",
 "public_host": "forge.example.com", "pages_project": "x"}
EOF
export FORGE_CONFIG="$TD/cfg.json"

# Load publish.sh as a library (no CLI dispatch, no credentials).
export FORGE_PUBLISH_LIB_ONLY=1
# shellcheck source=/dev/null
. "$PUBLISH"
# publish.sh installs its own `trap cleanup EXIT`, which replaces the trap set
# at the top of this file and leaks $TD. Re-install it after sourcing.
trap 'rm -rf "$TD"' EXIT

WORK="$TD/work"
ARTIFACTS_ROOT="$TD/hub/artifacts"
INTERNAL_PREFIX="a"

build() { python3 "$BUILD" --repo-root "$WORK/repo" >/dev/null 2>&1; }

build || fail "initial build_from_hub failed"
[ -f "$WORK/repo/site/a/new-deck/index.html" ] || fail "build produced no index.html"

# gen_og_images writes the card under site/ only
printf 'FAKE_OG' > "$WORK/repo/site/a/new-deck/og.jpg"

persist_og_to_hub new-deck

[ -f "$ARTIFACTS_ROOT/new-deck/og.jpg" ] \
  || fail "og.jpg not persisted to the hub SSOT"
pass "og.jpg lands in the hub SSOT"

build || fail "second build_from_hub failed"

[ -f "$WORK/repo/site/a/new-deck/og.jpg" ] \
  || fail "og.jpg dropped by the rebuild — the deploy would ship no card"
[ "$(cat "$WORK/repo/site/a/new-deck/og.jpg")" = "FAKE_OG" ] \
  || fail "og.jpg content not preserved through the rebuild"
pass "og.jpg survives the rebuild into the deployed tree"

# No og.jpg produced (chrome/ffmpeg missing) must stay a silent no-op.
rm -f "$WORK/repo/site/a/new-deck/og.jpg" "$ARTIFACTS_ROOT/new-deck/og.jpg"
persist_og_to_hub new-deck || fail "persist_og_to_hub must tolerate a missing og.jpg"
[ ! -f "$ARTIFACTS_ROOT/new-deck/og.jpg" ] || fail "persist created an og.jpg out of nothing"
pass "missing og.jpg is a no-op"

# Unknown slug must not create a hub directory.
persist_og_to_hub ghost-slug || fail "persist_og_to_hub must tolerate an unknown slug"
[ ! -d "$ARTIFACTS_ROOT/ghost-slug" ] || fail "persist created a hub dir for an unknown slug"
pass "unknown slug does not touch the hub"

echo "all og persistence checks passed"
