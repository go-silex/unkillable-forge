#!/usr/bin/env bash
# Purge sensitive paths from git history before making the repo public.
#
# Requires: git-filter-repo (pip install git-filter-repo)
#
# WARNING: rewrites history. All clones must re-fetch. Coordinate with the team.
# After running: git push --force-with-lease origin main
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v git-filter-repo >/dev/null 2>&1; then
  echo "✗ git-filter-repo not found — install: pip install git-filter-repo" >&2
  exit 1
fi

if [ "${1:-}" != "--yes" ]; then
  echo "This will rewrite git history to remove:"
  echo "  - site/a/** site/index.html site/manifest.json registry/**"
  echo "  - historical wrangler.toml with real KV/Access IDs"
  echo ""
  read -r -p "Continue? [y/N] " ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

# Paths that must not exist in public history
git filter-repo --force \
  --path site/a \
  --path site/index.html \
  --path site/manifest.json \
  --path registry \
  --invert-paths

# Replace historical wrangler.toml blobs that contained real IDs with current placeholder
git filter-repo --force \
  --replace-text <(cat <<'EOF'
regex:CF_ACCESS_TEAM_DOMAIN = ".*"==>CF_ACCESS_TEAM_DOMAIN = "REDACTED"
regex:CF_ACCESS_AUD = ".*"==>CF_ACCESS_AUD = "REDACTED"
regex:id = "[0-9a-f]{32}"==>id = "YOUR_KV_NAMESPACE_ID"
regex:cloudflare_account_id": "[0-9a-f]{32}"==>cloudflare_account_id": ""
literal:REDACTED_CLOUDFLARE_ACCOUNT_ID==>YOUR_CLOUDFLARE_ACCOUNT_ID
literal:REDACTED_FORGE_SHARES_KV_ID==>YOUR_KV_NAMESPACE_ID
literal:f8026cff==>YOUR_CF
EOF
)

echo ""
echo "✓ History rewritten locally."
echo "Next (coordinate with team):"
echo "  git push --force-with-lease origin main"
echo "  Everyone: fresh clone or git fetch --all && git reset --hard origin/main"
