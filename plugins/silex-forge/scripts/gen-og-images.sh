#!/usr/bin/env bash
# gen-og-images.sh — screenshot each forge artifact → site/a/<slug>/og.jpg
#
# Stack:
#   jq           — registry JSON
#   python3      — canonical source digest when a forge hub is configured
#   google-chrome|chromium — headless screenshot at deck native 1920×1080
#   ffmpeg       — cover-crop to OG 1200×630 JPEG (no side letterbox)
#
# Why 1920×1080 first?
#   Silex decks are 16:9 stages letterboxed into the viewport with --stage-bg.
#   Capturing at 1200×630 (wider than 16:9) left grey side bars. Capture at
#   native stage size, then ffmpeg cover-crop → full-bleed OG.
#
# Usage (repo root):
#   plugins/silex-forge/scripts/gen-og-images.sh
#   plugins/silex-forge/scripts/gen-og-images.sh --slug my-slug --force
#   plugins/silex-forge/scripts/gen-og-images.sh --quality 4
#
# Regeneration is keyed on sha256(canonical source HTML) + sha256(og.jpg),
# recorded together in og.src (unless --force). See is_stale.
# Best-effort: missing chrome/ffmpeg → exit 0 + warn (publish continues).
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
# Capture at deck native size (16:9) → then cover-crop to OG card ratio
CAP_W=1920
CAP_H=1080
OG_W=1200
OG_H=630
QUALITY=5   # ffmpeg -q:v for mjpeg: 2=best, 5≈good, 10=small
FORCE=0
SLUG_FILTER=""

# shellcheck source=/dev/null
. "$LIB_DIR/forge_common.sh"
die()  { forge_die "$@"; }
warn() { forge_warn "$@"; }

usage() {
  cat <<EOF
Usage: gen-og-images.sh [--slug SLUG] [--force] [--quality N]
  --quality  ffmpeg -q:v 2..12 (default 5; lower = larger/better)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --slug)    SLUG_FILTER="${2-}"; shift 2 ;;
    --force)   FORCE=1; shift ;;
    --quality) QUALITY="${2-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 — see gen-og-images.sh --help" ;;
  esac
done

# ── deps ──────────────────────────────────────────────────────────
CHROME=""
for c in google-chrome google-chrome-stable chromium chromium-browser; do
  if command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
done
if [ -z "$CHROME" ] && [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
fi
# Playwright-cached chromium as last resort (linux + mac)
if [ -z "$CHROME" ]; then
  for bin in \
    "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome \
    "$HOME"/.cache/ms-playwright/chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium
  do
    if [ -x "$bin" ]; then CHROME="$bin"; break; fi
  done
fi

if [ -z "$CHROME" ]; then
  warn "no chrome/chromium — skip OG images"
  exit 0
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  warn "ffmpeg missing — skip OG images"
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  warn "jq missing — skip OG images"
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

# Hash the exact craft HTML represented by the deploy tree, not a second read
# from a hub that may be syncing concurrently. The share bar and forge OG block
# are engine-owned overlays; use their exact inverses so engine/metadata changes
# do not invalidate thumbnails.
canonical_html_digest() {
  local html="$1" tmp="" digest=""
  if ! command -v python3 >/dev/null 2>&1 \
      || [ ! -f "$SCRIPT_DIR/inject-share-bar.py" ] \
      || [ ! -f "$SCRIPT_DIR/inject-og.py" ]; then
    echo ""
    return 0
  fi
  tmp="$(dirname "$html")/.og-source-$$.html"
  if ! cp -f "$html" "$tmp"; then
    echo ""
    return 0
  fi
  if python3 "$SCRIPT_DIR/inject-share-bar.py" "$tmp" --strip \
      >/dev/null 2>&1 \
      && python3 "$SCRIPT_DIR/inject-og.py" "$tmp" --strip \
      >/dev/null 2>&1; then
    digest="$(sha256_of "$tmp")"
  fi
  rm -f "$tmp"
  printf '%s\n' "$digest"
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

# Render one HTML file → og.jpg next to it (full-bleed, no stage letterbox)
render_one() {
  local slug="$1" html="$2"
  local dir
  dir="$(dirname "$html")"
  local out="$dir/og.jpg"
  local tmp_png="$dir/.og-tmp-$$.png"
  local tmp_html="$dir/.og-render-$$.html"
  local tmp_jpg="$dir/.og-tmp-$$.jpg"

  # Temp HTML: strip share-bar + inject capture CSS.
  # Do NOT force body background:#000 — that letterboxes light guides (forge-guide /
  # diagrams) into a black void. Decks already set --stage-bg on html/body; pinning
  # .deck-stage to 1920×1080 fills the viewport so the mat never shows anyway.
  {
    if grep -q 'forge-share-bar' "$html" 2>/dev/null; then
      sed '/<!-- forge-share-bar -->/,/<!-- \/forge-share-bar -->/d' "$html"
    else
      cat "$html"
    fi
  } | sed '/<\/head>/i\
<style id="forge-og-capture">\
  html,body{margin:0!important;padding:0!important;overflow:hidden!important}\
  .edit-toggle,.edit-hotzone,[data-forge-share-bar],[data-forge-toast]{display:none!important}\
  .deck-viewport{background:transparent!important;inset:0!important}\
  /* pin stage 1:1 at 1920×1080 — no letterbox scale from fit() */\
  .deck-stage{transform:none!important;left:0!important;top:0!important;width:1920px!important;height:1080px!important}\
  .slide.active{visibility:visible!important;opacity:1!important;pointer-events:auto!important}\
</style>
' >"$tmp_html"

  local url="file://${tmp_html}"
  # Capture at native deck size so fit() / stage scale has nothing to letterbox
  if ! "$CHROME" \
      --headless=new \
      --disable-gpu \
      --no-sandbox \
      --hide-scrollbars \
      --force-device-scale-factor=1 \
      --window-size="${CAP_W},${CAP_H}" \
      --virtual-time-budget=10000 \
      --run-all-compositor-stages-before-draw \
      --screenshot="$tmp_png" \
      "$url" >/dev/null 2>&1; then
    warn "$slug: chrome screenshot failed"
    rm -f "$tmp_png" "$tmp_html" "$tmp_jpg"
    return 1
  fi

  if [ ! -s "$tmp_png" ]; then
    warn "$slug: empty screenshot"
    rm -f "$tmp_png" "$tmp_html" "$tmp_jpg"
    return 1
  fi

  # Cover-crop 16:9 → OG 1200×630 (fills width, slight vertical crop — no side bars)
  # + JPEG compress. No intermediate PNG committed.
  if ! ffmpeg -y -loglevel error -i "$tmp_png" \
      -vf "scale=${OG_W}:${OG_H}:force_original_aspect_ratio=increase,crop=${OG_W}:${OG_H}" \
      -frames:v 1 -q:v "$QUALITY" "$tmp_jpg" 2>/dev/null; then
    warn "$slug: ffmpeg jpeg failed"
    rm -f "$tmp_png" "$tmp_html" "$tmp_jpg"
    return 1
  fi

  mv -f "$tmp_jpg" "$out"
  rm -f "$tmp_png" "$tmp_html" "$dir/og.png"
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
  slug="$(jq -r '.slug // empty' "$reg")"
  [ -n "$slug" ] || continue
  if [ -n "$SLUG_FILTER" ] && [ "$slug" != "$SLUG_FILTER" ]; then
    continue
  fi

  path="$(jq -r '.path // empty' "$reg")"
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
  source_digest="$(canonical_html_digest "$html")"
  image_digest=""
  [ ! -f "$jpg" ] || image_digest="$(sha256_of "$jpg")"
  # A stale proof from a standalone invocation must not survive a failed
  # renderer. The normal publish build already starts from a clean deploy tree.
  rm -f "$src_proof"
  if [ "$FORCE" -eq 0 ] \
      && ! is_stale "$html" "$jpg" "$slug" "$source_digest" "$image_digest"; then
    record_source_proof "$src_proof" "$source_digest" "$image_digest"
    up_to_date=$((up_to_date + 1))
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
echo "og-images — ${rendered} rendered (~${avg} kb avg), ${up_to_date} up-to-date, ${failed} failed (chrome+ffmpeg pipeline)"
exit 0
