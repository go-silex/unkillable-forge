#!/usr/bin/env bash
# Behavioral tests for OG thumbnail staleness.
#
# Regeneration is keyed on sha256(canonical source HTML) + sha256(og.jpg),
# recorded as one bound pair in og.src. Two measured failure modes motivate it:
#
#   mtimes      A hub received without modtime preservation (Drive desktop
#               client, a zip, cp -r) reorders index.html against og.jpg — 13 of
#               30 slugs on the real hub — so every affected machine re-renders.
#               Some decks embed remote resources (lgu-recap has a tella.tv
#               iframe), so their capture is not byte-reproducible and those
#               re-renders upload thumbnails that are merely different, never
#               newer. The unstable set varies between runs, so it cannot be
#               fixed artifact by artifact.
#
#   deploy copy Hashing the deploy-tree index.html instead would tie the digest
#               to share-bar.js: one engine update would invalidate all 30
#               thumbnails at once — the same mass regeneration, displaced from
#               the sync to the plugin update.
#
# Both are asserted here, plus out-of-order source/image sync and the mtime
# fallback for a standalone run with no resolvable hub.
#
# Isolation: hub + deploy tree in mktemp -d, FORGE_CONFIG points at a temp
# config, and lib/og_render.py is a stub (digest/subresources/payload exec the
# real kernel; render writes deterministic bytes, never networks). Renderer is
# Browser Run. bash 3.2-safe.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
# gen-og-images.sh resolves its ROOT (registry/, site/) from its own location,
# not from cwd — exactly as it does inside the engine clone. So the suite runs a
# copy placed in the temp tree, mirroring the real flow, and $GEN is set after
# the fixture is built.
GEN=""

pass() { echo "  ok  $*"; }
fail() { echo "  FAIL $*" >&2; exit 1; }
note() { echo "      $*"; }

echo "og staleness tests"

TD="$(mktemp -d)"
trap 'rm -rf "$TD"' EXIT

# --- fixture -----------------------------------------------------------------
SLUG="deck-one"
mkdir -p "$TD/hub/artifacts/$SLUG" "$TD/repo/registry" "$TD/repo/site/a/$SLUG"
HUB_HTML="$TD/hub/artifacts/$SLUG/index.html"
printf '%s\n' '<html><head><title>One</title></head><body>craft v1</body></html>' > "$HUB_HTML"

cat > "$TD/cfg.json" <<EOF
{"version": 1, "hub_root": "$TD/hub", "artifacts_dir": "artifacts",
 "site_dir": "site", "registry_dir": "registry", "internal_prefix": "a",
 "public_host": "forge.test.invalid", "pages_project": "p"}
EOF
export FORGE_CONFIG="$TD/cfg.json"

printf '%s\n' "{\"slug\":\"$SLUG\",\"title\":\"One\",\"path\":\"/a/$SLUG/\",\"type\":\"deck\",\"date\":\"2026-01-01\",\"list_on_index\":true}" \
  > "$TD/repo/registry/$SLUG.json"

# The engine copy, as materialize_engine would provide it.
mkdir -p "$TD/repo/plugins/silex-forge"
cp -a "$ROOT/plugins/silex-forge/scripts" "$TD/repo/plugins/silex-forge/scripts"
cp -a "$ROOT/plugins/silex-forge/forge.config.example.json" \
  "$TD/repo/plugins/silex-forge/forge.config.example.json"
GEN="$TD/repo/plugins/silex-forge/scripts/gen-og-images.sh"

# --- og_render.py stub -------------------------------------------------------
# digest/subresources/payload must stay the real kernel (persist/staleness
# assertions hash the canonical source). render writes deterministic bytes so
# any difference in the assertions below comes from the staleness decision,
# never from Browser Run.
OG_LIB="$TD/repo/plugins/silex-forge/scripts/lib"
mv "$OG_LIB/og_render.py" "$OG_LIB/og_render.py.real"
cat > "$OG_LIB/og_render.py" <<'PY'
#!/usr/bin/env python3
import os
import sys
from pathlib import Path

cmd = sys.argv[1] if len(sys.argv) > 1 else ""
real = Path(__file__).with_name("og_render.py.real")
if cmd in ("digest", "subresources", "payload"):
    os.execv(sys.executable, [sys.executable, str(real), *sys.argv[1:]])

if cmd == "render":
    out = None
    args = sys.argv[2:]
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--out" and i + 1 < len(args):
            out = args[i + 1]
            i += 2
            continue
        if a.startswith("--out="):
            out = a.split("=", 1)[1]
            i += 1
            continue
        if a in ("--quality", "--timeout") and i + 1 < len(args):
            i += 2
            continue
        i += 1
    if not out:
        sys.exit(1)
    data = b"FAKE_OG_JPEG"
    Path(out).write_bytes(data)
    print(len(data))
    sys.exit(0)

sys.exit(2)
PY

DEPLOY="$TD/repo/site/a/$SLUG"
JPG="$DEPLOY/og.jpg"
SRC="$DEPLOY/og.src"
HUB_SRC="$TD/hub/artifacts/$SLUG/og.src"

# Mirrors build_from_hub (copy2 keeps the mtime) + the share-bar injection.
sync_deploy() {
  rm -f "$SRC"
  cp -p "$HUB_HTML" "$DEPLOY/index.html"
  printf '%s\n' '<!-- forge-share-bar --><script>BAR_V1</script><!-- /forge-share-bar -->' \
    >> "$DEPLOY/index.html"
}

# Mirrors persist_og_to_hub: og.jpg and og.src both travel to the hub.
persist() {
  [ -f "$JPG" ] && cp -f "$JPG" "$TD/hub/artifacts/$SLUG/og.jpg"
  [ -f "$SRC" ] && cp -f "$SRC" "$HUB_SRC"
  return 0
}

run_gen() {
  ( cd "$TD/repo" && bash "$GEN" 2>&1 )
}

count() {
  # $1 = output, $2 = field ("rendered" | "up-to-date")
  printf '%s' "$1" | sed -n "s/.*— \([0-9]*\) rendered.*/\1/p" | head -1
}
up_to_date_of() {
  printf '%s' "$1" | sed -n "s/.*, \([0-9]*\) up-to-date.*/\1/p" | head -1
}

assert_counts() {
  # $1 = output, $2 = expected rendered, $3 = expected up-to-date, $4 = label
  local r u
  r=$(count "$1"); u=$(up_to_date_of "$1")
  [ "$r" = "$2" ] && [ "$u" = "$3" ] \
    || { note "$1"; fail "$4: expected ${2} rendered / ${3} up-to-date, got ${r}/${u}"; }
}

# --- 1. first run records the digest ----------------------------------------
sync_deploy
out=$(run_gen)
assert_counts "$out" 1 0 "first run"
[ -f "$JPG" ] || fail "no thumbnail produced"
[ -f "$SRC" ] || fail "og.src was not written beside the thumbnail"
persist
WANT=$(cat "$HUB_SRC")
[ -n "$WANT" ] || fail "og.src is empty"
note "digest recorded: ${WANT:0:16}…"
pass "first run renders and records the hub source digest"

# --- 2. unchanged source is up-to-date --------------------------------------
sync_deploy
out=$(run_gen)
assert_counts "$out" 0 1 "unchanged source"
[ -f "$SRC" ] || fail "up-to-date check did not emit a freshness proof"
pass "unchanged craft is up-to-date"

# A content-addressed source marker is insufficient by itself: Drive may sync
# the tiny sidecar before the JPEG. The image digest must reject that mixed
# generation even though the source half still matches.
printf 'STALE_JPEG_FROM_ANOTHER_GENERATION' > "$JPG"
cp -f "$JPG" "$TD/hub/artifacts/$SLUG/og.jpg"
sync_deploy
out=$(run_gen)
assert_counts "$out" 1 0 "mixed source/image generation"
persist
pass "a matching source with different JPEG bytes re-renders"

# --- 3. destroyed mtimes must NOT trigger a render --------------------------
# This is the measured failure mode: a hub copied without modtime preservation
# leaves index.html newer than og.jpg. Under the old mtime rule that re-rendered
# 13 of 30 real slugs on every affected machine.
sync_deploy
touch "$TD/hub/artifacts/$SLUG/og.jpg"
sleep 1
touch "$HUB_HTML" "$DEPLOY/index.html"
[ "$DEPLOY/index.html" -nt "$JPG" ] \
  || fail "fixture failed: index.html should be newer than og.jpg here"
out=$(run_gen)
assert_counts "$out" 0 1 "destroyed mtimes"
pass "a hub whose mtimes were not preserved does not re-render (13/30 -> 0)"

# --- 4. an engine update must NOT trigger a render --------------------------
# The digest is on the hub source, never on the deploy copy. Hashing the copy
# would move with share-bar.js and invalidate every thumbnail on one update.
cp -p "$HUB_HTML" "$DEPLOY/index.html"
printf '%s\n' '<!-- forge-share-bar --><script>BAR_V2_UPDATED_ENGINE</script><!-- /forge-share-bar -->' \
  >> "$DEPLOY/index.html"
out=$(run_gen)
assert_counts "$out" 0 1 "engine update"
pass "a share-bar.js change does not re-render (digest tracks craft, not engine)"

# --- 5. a real craft change DOES trigger a render ---------------------------
printf '%s\n' '<html><head><title>One</title></head><body>craft v2</body></html>' > "$HUB_HTML"
sync_deploy
out=$(run_gen)
assert_counts "$out" 1 0 "craft change"
persist
NEW=$(cat "$HUB_SRC")
[ "$NEW" != "$WANT" ] || fail "the recorded digest did not move after a craft change"
pass "a craft change re-renders and updates the digest"

sync_deploy
out=$(run_gen)
assert_counts "$out" 0 1 "after craft change"
pass "the following run is up-to-date again"

# --- 6. a missing thumbnail always renders ----------------------------------
rm -f "$JPG"
out=$(run_gen)
assert_counts "$out" 1 0 "missing thumbnail"
pass "a missing thumbnail renders even when the digest matches"
persist

# --- 7. no resolvable hub falls back to the mtime comparison ----------------
# gen-og-images.sh must stay usable standalone, without a resolvable hub.
# python3 is required for digest; empty ARTIFACTS still degrades to mtimes.
cat > "$TD/cfg-nohub.json" <<EOF
{"version": 1, "hub_root": "$TD/absent", "artifacts_dir": "artifacts",
 "site_dir": "site", "registry_dir": "registry", "internal_prefix": "a",
 "public_host": "forge.test.invalid", "pages_project": "p"}
EOF
FORGE_CONFIG="$TD/cfg-nohub.json" bash -c "cd '$TD/repo' && bash '$GEN'" >/dev/null 2>&1 \
  || fail "a run without a resolvable hub must not fail"
touch "$JPG"
sleep 1
touch "$DEPLOY/index.html"
out=$(FORGE_CONFIG="$TD/cfg-nohub.json" bash -c "cd '$TD/repo' && bash '$GEN'" 2>&1)
assert_counts "$out" 1 0 "mtime fallback"
pass "without a resolvable hub, staleness falls back to the mtime comparison"

# --- 8. --dry-run writes nothing and does not lie in the summary ------------
rm -f "$JPG" "$SRC"
out=$(cd "$TD/repo" && bash "$GEN" --dry-run 2>&1)
case "$out" in
  *"og-images — dry run: 1 would render, 0 up-to-date (nothing posted)"*) ;;
  *) note "$out"; fail "dry-run: expected dry-run summary form" ;;
esac
[ ! -f "$JPG" ] || fail "dry-run created og.jpg"
[ ! -f "$SRC" ] || fail "dry-run created og.src"
pass "--dry-run reports would-render and writes nothing"

echo "all og staleness checks passed"
