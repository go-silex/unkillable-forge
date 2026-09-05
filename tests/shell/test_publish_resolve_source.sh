#!/usr/bin/env bash
# Behavioral: resolve_source — what the caller observes in SRC_DIR.
#
#   file  input  → staged as $WORK/src/index.html, SRC_DIR=$WORK/src
#   dir   input  → SRC_DIR = that directory itself, no copy. write_source_to_hub
#                  compares SRC_DIR with the hub dest and skips the wipe when
#                  they are the same path, so "always stage" would make it
#                  delete the artifact it was told to publish.
#   anything else → dies, naming the offending path.
#
# Isolated config (FORGE_CONFIG/FORGE_ENV → temp): no real hub, no credentials,
# no network. bash 3.2-safe.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
PUBLISH="$ROOT/plugins/silex-forge/scripts/publish.sh"

pass() { echo "  ok  $*"; }
fail() { echo "  FAIL $*" >&2; exit 1; }

echo "resolve_source tests"

TD="$(mktemp -d)"

cat > "$TD/cfg.json" <<EOF
{"hub_root": "$TD/hub", "artifacts_dir": "artifacts", "site_dir": "site",
 "registry_dir": "registry", "internal_prefix": "a",
 "public_host": "forge.example.com", "pages_project": "x"}
EOF
: > "$TD/forge.env"
export FORGE_CONFIG="$TD/cfg.json"
export FORGE_ENV="$TD/forge.env"

# Load publish.sh as a library (no CLI dispatch, no credentials).
export FORGE_PUBLISH_LIB_ONLY=1
# shellcheck source=/dev/null
. "$PUBLISH"
# publish.sh installed its own EXIT trap (rm -rf $WORK); ours owns the temp root.
trap 'rm -rf "$TD"' EXIT

# expect_die <label> <input> <message substring>
# `trap - EXIT` first: the sourced cleanup must never reach $TD.
expect_die() {
  local label="$1" input="$2" needle="$3"
  local err="$TD/err.log"
  if ( trap - EXIT; WORK="$TD/w-die"; mkdir -p "$WORK"; resolve_source "$input" ) 2>"$err"; then
    fail "$label — resolve_source returned 0 instead of failing closed"
  fi
  grep -Fq "$needle" "$err" \
    || fail "$label — message lacks '$needle': $(cat "$err")"
  grep -Fq "$input" "$err" \
    || fail "$label — message does not name the path: $(cat "$err")"
  pass "$label"
}

# --- file branch -------------------------------------------------------------
printf '<html><body>DECK-MARKER</body></html>\n' > "$TD/deck.html"
WORK="$TD/w-html"
mkdir -p "$WORK"
SRC_DIR=""
resolve_source "$TD/deck.html"
[ "$SRC_DIR" = "$WORK/src" ] \
  || fail ".html file: SRC_DIR is '$SRC_DIR', expected '$WORK/src'"
[ -f "$SRC_DIR/index.html" ] \
  || fail ".html file: nothing staged at \$WORK/src/index.html"
diff -q "$TD/deck.html" "$SRC_DIR/index.html" >/dev/null \
  || fail ".html file: staged index.html content differs from the input"
pass ".html file is staged as \$WORK/src/index.html with the input content"

# --- .htm is accepted too ----------------------------------------------------
printf '<html><body>HTM-MARKER</body></html>\n' > "$TD/note.htm"
WORK="$TD/w-htm"
mkdir -p "$WORK"
SRC_DIR=""
resolve_source "$TD/note.htm"
[ "$SRC_DIR" = "$WORK/src" ] \
  || fail ".htm file: SRC_DIR is '$SRC_DIR', expected '$WORK/src'"
diff -q "$TD/note.htm" "$SRC_DIR/index.html" >/dev/null \
  || fail ".htm file: staged index.html content differs from the input"
pass ".htm file is accepted like .html"

# --- directory branch: adopted in place, never copied ------------------------
art="$TD/artifact-dir"
mkdir -p "$art"
printf 'HUB-SSOT-MARKER\n' > "$art/index.html"
WORK="$TD/w-dir"
mkdir -p "$WORK"
SRC_DIR=""
resolve_source "$art"
[ "$SRC_DIR" = "$art" ] \
  || fail "directory: SRC_DIR is '$SRC_DIR', expected the input dir '$art' — staging it breaks write_source_to_hub's in-place branch, which then wipes the hub artifact"
[ ! -e "$WORK/src" ] \
  || fail "directory: content was staged into \$WORK/src instead of being used in place"
pass "directory with index.html is adopted in place"

# --- fail-closed paths -------------------------------------------------------
expect_die "missing path dies" "$TD/absent.html" "source not found"

printf 'plain text\n' > "$TD/notes.txt"
expect_die "non-HTML extension dies" "$TD/notes.txt" ".html file"

mkdir -p "$TD/empty-dir"
expect_die "directory without index.html dies" "$TD/empty-dir" "no index.html"

WORK=""
echo "all resolve_source checks passed"
