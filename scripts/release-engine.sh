#!/usr/bin/env bash
# Decide whether to publish engine/vX.Y.Z and optionally build / publish the release.
#
#   scripts/release-engine.sh check   — exit 0=publish/resume, 78=complete skip, 1=refuse move
#   scripts/release-engine.sh build <outdir>
#   scripts/release-engine.sh publish <outdir>
#
# On the exact tagged SHA, an incomplete GitHub Release (missing assets) is resumed
# without moving the tag. Effects stay in CI after attestation.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CHECK="$ROOT/scripts/check_plugin_versions.py"
VERSION="$(python3 "$CHECK" --print-engine-version)"
TAG="engine/v${VERSION}"
TARBALL_NAME="forge-engine-${VERSION}.tar.gz"

release_assets_ready() {
  # Drafts may have all assets but must not be considered published yet.
  local release
  release="$(gh release view "$TAG" --json isDraft,assets 2>/dev/null)" || return 1
  python3 - "$release" "$TARBALL_NAME" "${1:-published}" <<'PY'
import json, sys
release = json.loads(sys.argv[1])
need = {sys.argv[2], "release.json", "SHA256SUMS"}
ready = {a["name"] for a in release["assets"] if a["state"] == "uploaded"}
sys.exit(0 if need <= ready and (sys.argv[3] == "any" or not release["isDraft"]) else 1)
PY
}

release_complete() {
  command -v gh >/dev/null 2>&1 && release_assets_ready
}

cmd_check() {
  git fetch --tags --force origin
  if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
    existing="$(git rev-list -n 1 "$TAG")"
    head="$(git rev-parse HEAD)"
    if [ "$existing" = "$head" ]; then
      if release_complete; then
        echo "tag ${TAG} already on HEAD with complete release — skip"
        exit 78
      fi
      echo "tag ${TAG} already on HEAD — resume incomplete GitHub Release"
      echo "ENGINE_VERSION=${VERSION}"
      echo "ENGINE_TAG=${TAG}"
      echo "ENGINE_RESUME=1"
      return 0
    fi
    if git merge-base --is-ancestor "$existing" "$head"; then
      echo "tag ${TAG} already at ${existing:0:7} (ancestor of HEAD) — skip"
      exit 78
    fi
    echo "tag ${TAG} exists at ${existing:0:7}, not an ancestor of HEAD ${head:0:7}" >&2
    echo "refusing to move the tag" >&2
    exit 1
  fi
  echo "ENGINE_VERSION=${VERSION}"
  echo "ENGINE_TAG=${TAG}"
  echo "ENGINE_RESUME=0"
  echo "will publish ${TAG}"
}

cmd_build() {
  local outdir="${1:-}"
  [ -n "$outdir" ] || { echo "usage: $0 build <outdir>" >&2; exit 2; }
  bash "$ROOT/scripts/build-engine-release.sh" "$outdir"
}

cmd_publish() {
  local outdir="${1:-}"
  [ -n "$outdir" ] || { echo "usage: $0 publish <outdir>" >&2; exit 2; }
  local tarball="$outdir/$TARBALL_NAME"
  [ -f "$tarball" ] || { echo "missing $tarball" >&2; exit 1; }
  [ -f "$outdir/release.json" ] || { echo "missing release.json" >&2; exit 1; }
  [ -f "$outdir/SHA256SUMS" ] || { echo "missing SHA256SUMS" >&2; exit 1; }

  NOTES="$(mktemp)"
  trap 'rm -f "$NOTES"' EXIT
  python3 - "$ROOT/docs/engine-changelog.md" "$VERSION" >"$NOTES" <<'PY'
import re, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text(encoding="utf-8")
version = sys.argv[2]
heading = re.compile(r"^## \[([^\]]+)\]")
lines = text.splitlines()
start = None
for i, line in enumerate(lines):
    m = heading.match(line)
    if m and m.group(1) == version:
        start = i
        break
if start is None:
    raise SystemExit(f"missing ## [{version}]")
end = len(lines)
for j in range(start + 1, len(lines)):
    if heading.match(lines[j]):
        end = j
        break
sys.stdout.write("\n".join(lines[start:end]).strip() + "\n")
PY

  if ! git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
    git config user.name "github-actions[bot]"
    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    git tag -a "$TAG" -m "forge-engine v${VERSION}"
    git push origin "refs/tags/${TAG}"
  else
    existing="$(git rev-list -n 1 "$TAG")"
    head="$(git rev-parse HEAD)"
    [ "$existing" = "$head" ] || { echo "tag ${TAG} not on HEAD — refuse" >&2; exit 1; }
  fi

  if gh release view "$TAG" >/dev/null 2>&1; then
    # Resume incomplete releases, replacing any incomplete uploads.
    gh release upload "$TAG" \
      "$tarball" \
      "$outdir/release.json" \
      "$outdir/SHA256SUMS" \
      --clobber
    release_assets_ready any || { echo "release assets are not uploaded" >&2; exit 1; }
    gh release edit "$TAG" --notes-file "$NOTES" --draft=false >/dev/null
    echo "resumed ${TAG}"
  else
    gh release create "$TAG" \
      "$tarball" \
      "$outdir/release.json" \
      "$outdir/SHA256SUMS" \
      --title "forge-engine v${VERSION}" \
      --notes-file "$NOTES" \
      --verify-tag
    echo "created ${TAG}"
  fi
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    check) cmd_check ;;
    build) cmd_build "$@" ;;
    publish) cmd_publish "$@" ;;
    *)
      echo "usage: $0 check | build <outdir> | publish <outdir>" >&2
      exit 2
      ;;
  esac
}

main "$@"
