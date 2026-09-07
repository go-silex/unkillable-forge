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

DEPLOY_DIR="$WORK/repo/site/a/new-deck"
DEPLOY_HTML="$DEPLOY_DIR/index.html"
DEPLOY_OG="$DEPLOY_DIR/og.jpg"
DEPLOY_SRC="$DEPLOY_DIR/og.src"

# Model gen_og_images: a successful render produces an image plus a proof that
# binds the canonical deploy source to those exact image bytes. The source
# half is the kernel digest (og_render.py digest), not a local strip+sha256.
printf 'FAKE_OG' > "$DEPLOY_OG"
SOURCE_DIGEST="$(python3 "$LIB_DIR/og_render.py" digest "$DEPLOY_HTML")"
IMAGE_DIGEST="$(sha256_file "$DEPLOY_OG")"
printf '%s %s\n' "$SOURCE_DIGEST" "$IMAGE_DIGEST" > "$DEPLOY_SRC"

# cmd_publish then injects stable OG metadata and writes it back to the hub.
# The proof must be rebound to that exact final HTML before persistence.
inject_og_for_slug new-deck "New" "" "/a/new-deck/"
persist_og_to_hub new-deck

[ -f "$ARTIFACTS_ROOT/new-deck/og.jpg" ] \
  || fail "og.jpg not persisted to the hub SSOT"
pass "og.jpg lands in the hub SSOT"
[ -f "$ARTIFACTS_ROOT/new-deck/og.src" ] \
  || fail "og.src not persisted to the hub SSOT"
EXPECTED_SOURCE="$(python3 "$LIB_DIR/og_render.py" digest "$ARTIFACTS_ROOT/new-deck/index.html")"
EXPECTED_IMAGE="$(sha256_file "$ARTIFACTS_ROOT/new-deck/og.jpg")"
[ "$(cat "$ARTIFACTS_ROOT/new-deck/og.src")" = "$EXPECTED_SOURCE $EXPECTED_IMAGE" ] \
  || fail "og.src does not bind the final hub HTML to the persisted JPEG"
pass "og.src binds the final hub source and exact image bytes"

build || fail "second build_from_hub failed"

[ -f "$WORK/repo/site/a/new-deck/og.jpg" ] \
  || fail "og.jpg dropped by the rebuild — the deploy would ship no card"
[ "$(cat "$WORK/repo/site/a/new-deck/og.jpg")" = "FAKE_OG" ] \
  || fail "og.jpg content not preserved through the rebuild"
pass "og.jpg survives the rebuild into the deployed tree"
[ ! -f "$WORK/repo/site/a/new-deck/og.src" ] \
  || fail "og.src leaked into the deployed tree"
pass "og.src remains hub-only bookkeeping"

# An existing card without a deploy-tree sidecar means this run did not render
# it (for example Chrome/ffmpeg was absent or failed). Never create a fresh hub
# digest in that state: it would bless the old card against the new source.
rm -f "$ARTIFACTS_ROOT/new-deck/og.src"
persist_og_to_hub new-deck
[ ! -f "$ARTIFACTS_ROOT/new-deck/og.src" ] \
  || fail "persist marked an unrendered thumbnail as fresh"
pass "no render proof means no new source digest"

# If the hub changes after the deploy tree was checked, the proof describes the
# old source. Refuse the whole copy rather than clobbering a remotely-synced
# image and stamping the new HTML as fresh against it.
CHECKED_SOURCE="$(python3 "$LIB_DIR/og_render.py" digest "$DEPLOY_HTML")"
CHECKED_IMAGE="$(sha256_file "$DEPLOY_OG")"
printf '%s %s\n' "$CHECKED_SOURCE" "$CHECKED_IMAGE" > "$DEPLOY_SRC"
printf '%s\n' '<html><body>concurrent hub update</body></html>' \
  > "$ARTIFACTS_ROOT/new-deck/index.html"
printf 'REMOTE_OG' > "$ARTIFACTS_ROOT/new-deck/og.jpg"
persist_og_to_hub new-deck
[ "$(cat "$ARTIFACTS_ROOT/new-deck/og.jpg")" = "REMOTE_OG" ] \
  || fail "persist clobbered an image after the hub source changed"
[ ! -f "$ARTIFACTS_ROOT/new-deck/og.src" ] \
  || fail "persist blessed a mixed source/image generation"
pass "a concurrent hub source change refuses stale image persistence"

# No og.jpg produced (chrome/ffmpeg missing) must stay a silent no-op.
rm -f "$WORK/repo/site/a/new-deck/og.jpg" "$ARTIFACTS_ROOT/new-deck/og.jpg"
persist_og_to_hub new-deck || fail "persist_og_to_hub must tolerate a missing og.jpg"
[ ! -f "$ARTIFACTS_ROOT/new-deck/og.jpg" ] || fail "persist created an og.jpg out of nothing"
pass "missing og.jpg is a no-op"

# Unknown slug must not create a hub directory.
persist_og_to_hub ghost-slug || fail "persist_og_to_hub must tolerate an unknown slug"
[ ! -d "$ARTIFACTS_ROOT/ghost-slug" ] || fail "persist created a hub dir for an unknown slug"
pass "unknown slug does not touch the hub"

# The deploy tree must mirror the hub's mtime relationship. copy2 carries it
# over, then the share-bar injection rewrites index.html — which used to stamp
# it with "now", making it newer than the og.jpg beside it. gen-og-images.sh
# then considered EVERY thumbnail stale and re-rendered all of them through
# headless Chrome on every publish (~55 s for 30 slugs) with no craft change,
# and the decks that animate are not byte-reproducible, so those re-renders
# uploaded thumbnails that were merely different. Measured before the fix:
printf 'HUB_OG' > "$ARTIFACTS_ROOT/new-deck/og.jpg"
# build-site-from-hub copies og.jpg only when og.src matches the kernel digest.
printf '%s %s\n' \
  "$(python3 "$LIB_DIR/og_render.py" digest "$ARTIFACTS_ROOT/new-deck/index.html")" \
  "$(sha256_file "$ARTIFACTS_ROOT/new-deck/og.jpg")" \
  > "$ARTIFACTS_ROOT/new-deck/og.src"
# Make the hub's og.jpg newer than its index.html, i.e. not stale at source.
touch -t 202601010000 "$ARTIFACTS_ROOT/new-deck/index.html"
touch -t 202601020000 "$ARTIFACTS_ROOT/new-deck/og.jpg"

build || fail "build_from_hub failed for the mtime case"

DEPLOY_HTML="$WORK/repo/site/a/new-deck/index.html"
DEPLOY_OG="$WORK/repo/site/a/new-deck/og.jpg"
[ -f "$DEPLOY_HTML" ] || fail "no deploy-tree index.html"
[ -f "$DEPLOY_OG" ] || fail "no deploy-tree og.jpg"

grep -qF '<!-- forge-share-bar -->' "$DEPLOY_HTML" \
  || fail "the bar was not injected — this case only matters after the rewrite"

if [ "$DEPLOY_HTML" -nt "$DEPLOY_OG" ]; then
  fail "index.html is newer than og.jpg in the deploy tree — gen-og-images would re-render every thumbnail on every publish"
fi
pass "share-bar injection preserves the hub mtime (og staleness still means 'craft changed')"

# And the converse must still work: a genuinely newer craft HTML stays stale.
touch -t 202601030000 "$ARTIFACTS_ROOT/new-deck/index.html"
build || fail "build_from_hub failed for the genuinely-stale case"
[ "$DEPLOY_HTML" -nt "$DEPLOY_OG" ] \
  || fail "a hub index.html newer than its og.jpg must stay stale in the deploy tree"
pass "a genuinely newer craft HTML is still reported stale"

echo "all og persistence checks passed"
