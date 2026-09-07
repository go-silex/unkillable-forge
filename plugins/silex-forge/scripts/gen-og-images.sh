#!/usr/bin/env bash
# gen-og-images.sh — screenshot each forge artifact → site/a/<slug>/og.jpg
#
# Stack:
#   python3 + lib/og_render.py — canonical source digest + Browser Run JPEG
#
# Usage (repo root):
#   plugins/silex-forge/scripts/gen-og-images.sh
#   plugins/silex-forge/scripts/gen-og-images.sh --slug my-slug --force
#   plugins/silex-forge/scripts/gen-og-images.sh --quality 80
#   plugins/silex-forge/scripts/gen-og-images.sh --dry-run
#
# Regeneration is keyed on sha256(canonical source HTML) + sha256(og.jpg),
# recorded together in og.src (unless --force). See is_stale.
# Best-effort: missing python3/og_render.py → exit 0 + warn (publish continues).
# A failed render never fails the batch. Token absence is not a startup abort:
# digest/staleness still run; render fails per slug.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"
REG="$ROOT/registry"
SITE="$ROOT/site"
# Config-aware dirs (local forge.config → example fallback)
if [ -f "$LIB_DIR/load_config.py" ] && command -v python3 >/dev/null 2>&1; then
  # shellcheck disable=SC1090
  eval "$(PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 -c 'from load_config import export_env; print(export_env())' 2>/dev/null || true)"
  [ -n "${FORGE_SITE_DIR:-}" ] && SITE="$ROOT/${FORGE_SITE_DIR}"
  [ -n "${FORGE_REGISTRY_DIR:-}" ] && REG="$ROOT/${FORGE_REGISTRY_DIR}"
fi
# Hub artifacts root: the SOURCE of truth for "did the craft change".
# Empty when the config or python3 is unavailable — the staleness check then
# falls back to the mtime comparison so a standalone run still works.
ARTIFACTS=""
if [ -n "${FORGE_HUB_ROOT:-}" ] && [ -n "${FORGE_ARTIFACTS_DIR:-}" ]; then
  ARTIFACTS="${FORGE_HUB_ROOT}/${FORGE_ARTIFACTS_DIR}"
fi
QUALITY=80   # JPEG quality 1–100 (Browser Run)
FORCE=0
DRY_RUN=0
SLUG_FILTER=""

# shellcheck source=/dev/null
. "$LIB_DIR/forge_common.sh"
die()  { forge_die "$@"; }
warn() { forge_warn "$@"; }

usage() {
  cat <<EOF
Usage: gen-og-images.sh [--slug SLUG] [--force] [--quality N] [--dry-run]
  --quality  JPEG quality 1..100 (default 80)
  --dry-run  compute staleness and print counts; do not render
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --slug)    SLUG_FILTER="${2-}"; shift 2 ;;
    --force)   FORCE=1; shift ;;
    --quality) QUALITY="${2-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 — see gen-og-images.sh --help" ;;
  esac
done

# ── deps ──────────────────────────────────────────────────────────
if ! command -v python3 >/dev/null 2>&1; then
  warn "python3 missing — skip OG images"
  exit 0
fi
if [ ! -f "$LIB_DIR/og_render.py" ]; then
  warn "og_render.py missing — skip OG images"
  exit 0
fi
if [ ! -d "$REG" ]; then
  warn "no registry/ at $REG"
  exit 0
fi

# ── helpers ───────────────────────────────────────────────────────
# Regeneration is keyed on the HUB source HTML — never on mtimes, and never on
# the deploy-tree copy.
#
# Not mtimes: a hub received without modtime preservation (Drive desktop
# client, a zip, cp -r) reorders index.html against og.jpg — measured 13 of 30
# slugs — so every affected machine re-renders. Some decks embed remote
# resources (lgu-recap has a tella.tv iframe; most carry Google webfonts), so
# their capture is not byte-reproducible and those re-renders upload
# thumbnails that are merely different, never newer. The unstable set even
# varies between runs, so it cannot be fixed artifact by artifact.
#
# Not the deploy-tree copy: it carries the injected share bar, so its digest
# would move with share-bar.js and a single engine update would invalidate all
# 30 thumbnails at once — the same mass regeneration, displaced from the sync
# to the plugin update.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    echo ""
  fi
}

# Registry JSON field. Empty on missing key or unreadable file.
reg_field() {
  python3 -c 'import json,sys
p,k=sys.argv[1],sys.argv[2]
try:
    v=json.load(open(p,encoding="utf-8")).get(k)
except Exception:
    v=None
print("" if v is None else v)
' "$1" "$2"
}

# The proof binds both sides of the relation: the canonical source and the
# exact JPEG bytes. A Drive sync that delivers index.html, og.jpg, and og.src
# in different orders therefore fails stale until all three agree.
record_source_proof() {
  local out="$1" source_digest="$2" image_digest="$3"
  [ -n "$source_digest" ] && [ -n "$image_digest" ] || return 0
  printf '%s %s\n' "$source_digest" "$image_digest" > "$out"
}

# Stale when the thumbnail is missing, either digest is unavailable/malformed,
# or the stored source/image pair no longer matches the deploy input.
is_stale() {
  local html="$1" jpg="$2" slug="$3" source_digest="$4" image_digest="$5"
  [ ! -f "$jpg" ] && return 0
  if [ -z "${ARTIFACTS:-}" ] \
      || [ -z "$source_digest" ] || [ -z "$image_digest" ]; then
    # No hub, canonicalizer, or digest tool: degrade to the historical mtime
    # comparison so the script remains usable standalone.
    [ "$html" -nt "$jpg" ]
    return
  fi
  local proof="${ARTIFACTS}/${slug}/og.src" have_source="" have_image=""
  if [ -f "$proof" ]; then
    have_source="$(awk 'NR == 1 {print $1}' "$proof" 2>/dev/null)"
    have_image="$(awk 'NR == 1 {print $2}' "$proof" 2>/dev/null)"
  fi
  [ "$have_source" != "$source_digest" ] \
    || [ "$have_image" != "$image_digest" ]
}

# Render one HTML file → og.jpg next to it (cover-crop JPEG via Browser Run)
render_one() {
  local slug="$1" html="$2"
  local dir
  dir="$(dirname "$html")"
  local out="$dir/og.jpg"
  local tmp_jpg="$dir/.og-tmp-$$.jpg"

  if ! python3 "$LIB_DIR/og_render.py" render "$html" --out "$tmp_jpg" --quality "$QUALITY" >/dev/null 2>&1; then
    warn "$slug: browser-run render failed"
    rm -f "$tmp_jpg"
    return 1
  fi
  if [ ! -s "$tmp_jpg" ]; then
    warn "$slug: browser-run render failed"
    rm -f "$tmp_jpg"
    return 1
  fi

  mv -f "$tmp_jpg" "$out"
  local kb
  kb=$(( $(wc -c <"$out") / 1024 ))
  echo "  ✓ $slug → site/a/${slug}/og.jpg (${kb} kb, full-bleed, q=${QUALITY})"
  return 0
}

# ── main ──────────────────────────────────────────────────────────
rendered=0
failed=0
up_to_date=0
total_kb=0

shopt -s nullglob
for reg in "$REG"/*.json; do
  slug="$(reg_field "$reg" slug)"
  [ -n "$slug" ] || continue
  if [ -n "$SLUG_FILTER" ] && [ "$slug" != "$SLUG_FILTER" ]; then
    continue
  fi

  path="$(reg_field "$reg" path)"
  [ -n "$path" ] || path="/a/${slug}/"
  rel="${path#/}"
  rel="${rel%/}"
  html="$SITE/${rel}/index.html"
  if [ ! -f "$html" ]; then
    html="$SITE/a/${slug}/index.html"
  fi
  if [ ! -f "$html" ]; then
    warn "skip $slug: no index.html"
    continue
  fi

  jpg="$(dirname "$html")/og.jpg"
  src_proof="$(dirname "$jpg")/og.src"
  source_digest="$(python3 "$LIB_DIR/og_render.py" digest "$html" 2>/dev/null || true)"
  image_digest=""
  [ ! -f "$jpg" ] || image_digest="$(sha256_of "$jpg")"
  # A stale proof from a standalone invocation must not survive a failed
  # renderer. The normal publish build already starts from a clean deploy tree.
  # --dry-run must not touch a would-render slug's og.src (or og.jpg).
  if [ "$DRY_RUN" -eq 0 ]; then
    rm -f "$src_proof"
  fi
  if [ "$FORCE" -eq 0 ] \
      && ! is_stale "$html" "$jpg" "$slug" "$source_digest" "$image_digest"; then
    record_source_proof "$src_proof" "$source_digest" "$image_digest"
    up_to_date=$((up_to_date + 1))
    continue
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    rendered=$((rendered + 1))
    continue
  fi

  if render_one "$slug" "$html"; then
    image_digest="$(sha256_of "$jpg")"
    record_source_proof "$src_proof" "$source_digest" "$image_digest"
    rendered=$((rendered + 1))
    total_kb=$((total_kb + $(wc -c <"$jpg") / 1024))
  else
    failed=$((failed + 1))
  fi
done

avg=0
[ "$rendered" -gt 0 ] && avg=$((total_kb / rendered))
echo "og-images — ${rendered} rendered (~${avg} kb avg), ${up_to_date} up-to-date, ${failed} failed (browser-run pipeline)"
exit 0
