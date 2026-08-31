#!/usr/bin/env bash
# Tag silex-forge/vX.Y.Z + GitHub Release when plugins/silex-forge/plugin.json is a new SemVer.
# Format <component>/vX.Y.Z (Convention A). Prior naked tags from before 2026-07-20
# remain in place and are not renamed.
# No-op if the tag already points at this commit or an ancestor. Never moves a tag.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CHECK="$ROOT/scripts/check_plugin_versions.py"
VERSION="$(python3 "$CHECK" --print-version)"
TAG="silex-forge/v${VERSION}"
TITLE="silex-forge ${TAG#silex-forge/}"

git fetch --tags --force origin

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  existing="$(git rev-list -n 1 "$TAG")"
  head="$(git rev-parse HEAD)"
  if [ "$existing" = "$head" ]; then
    echo "tag ${TAG} already on HEAD — skip"
    exit 0
  fi
  if git merge-base --is-ancestor "$existing" "$head"; then
    echo "tag ${TAG} already at ${existing:0:7} (ancestor of HEAD) — skip"
    exit 0
  fi
  echo "tag ${TAG} exists at ${existing:0:7}, not an ancestor of HEAD ${head:0:7}" >&2
  echo "refusing to move the tag" >&2
  exit 1
fi

NOTES="$(mktemp)"
trap 'rm -f "$NOTES"' EXIT
python3 "$CHECK" --print-notes >"$NOTES"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git tag -a "$TAG" -m "$TITLE"
git push origin "refs/tags/${TAG}"

gh release create "$TAG" \
  --title "$TITLE" \
  --notes-file "$NOTES" \
  --verify-tag

echo "created ${TAG}"
