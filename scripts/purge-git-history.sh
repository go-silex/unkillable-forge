#!/usr/bin/env bash
# Purge sensitive paths from git history before making the repo public.
#
# The infra IDs are resolved from the machine config at run time
# (~/.config/silex/forge.env → CLOUDFLARE_ACCOUNT_ID, FORGE_SHARES_KV_ID, read
# through load_config.py). They are deliberately absent from this file: it is
# public, so a literal here re-publishes on HEAD the exact value the script
# exists to erase from history — which is what it did until 2026-09-08, when a
# history scan found both IDs sitting on `main` inside the purge tool itself
# (AGENTS rule 11).
#
# Requires: git-filter-repo (pip install git-filter-repo), python3
#
# WARNING: rewrites EVERY local ref, not just main. All clones must be
# recreated. Coordinate with the team.
# After running: filter-repo drops the `origin` remote, so re-add it, fetch,
# then force-push the branch list this script prints (from
# `git ls-remote --heads origin`, captured before the rewrite) AND --tags.
# Never `push --all`: filter-repo migrates every remote-tracking ref into a
# local branch, so --all from a clone that once fetched refs/pull/* would
# publish those as real branches on the public repo.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB_DIR="$ROOT/plugins/silex-forge/scripts/lib"
cd "$ROOT"

# Captured before the rewrite: git filter-repo deletes the remote, so the
# closing instructions cannot read it back.
ORIGIN_URL_BEFORE="$(git remote get-url origin 2>/dev/null || true)"

die() { echo "✗ $*" >&2; exit 1; }

DRY_RUN=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes) ASSUME_YES=1 ;;
    -h|--help)
      cat <<'USAGE'
Usage: purge-git-history.sh [--yes] [--dry-run]

  Rewrites git history: drops the committed deploy tree and registry, then
  redacts the Cloudflare account / KV / Access IDs from historical blobs.

  --yes      skip the confirmation prompt
  --dry-run  print the plan (values redacted) and rewrite nothing

  The closing push is an explicit branch list from
  `git ls-remote --heads origin`, never `git push --all`. The IDs come from
  ~/.config/silex/forge.env, never from this file.
USAGE
      exit 0 ;;
    *) die "unknown argument: $arg (see --help)" ;;
  esac
done

command -v python3 >/dev/null 2>&1 \
  || die "python3 not found — required to resolve the infra IDs from forge.env"
[ -f "$LIB_DIR/load_config.py" ] \
  || die "load_config.py missing under $LIB_DIR — run this from an engine checkout"
if [ "$DRY_RUN" -eq 0 ]; then
  command -v git-filter-repo >/dev/null 2>&1 \
    || die "git-filter-repo not found — install: pip install git-filter-repo"
fi

# Same resolution as publish.sh: forge.env, with forge.config.json as fallback.
eval "$(PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 -c \
  'from load_config import export_env; print(export_env())')" \
  || die "load_config.py failed — run plugins/silex-forge/scripts/forge-doctor.sh"

ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
KV_ID="${FORGE_SHARES_KV_ID:-}"
ENV_FILE="${FORGE_ENV_FILE:-$HOME/.config/silex/forge.env}"

# Fail closed. While the IDs were hardcoded an unresolved value was impossible;
# reading them from config makes an empty one reachable, and it would both ship
# a history that still carries the value and turn `literal:==>x` into a rule
# that matches at every byte offset.
hex32() { [[ "$1" =~ ^[0-9a-f]{32}$ ]]; }
hex32 "$ACCOUNT_ID" \
  || die "CLOUDFLARE_ACCOUNT_ID unresolved or not 32 lowercase hex — set it in $ENV_FILE (forge-discover.sh --write prints it), then forge-doctor.sh"
hex32 "$KV_ID" \
  || die "FORGE_SHARES_KV_ID unresolved or not 32 lowercase hex — set it in $ENV_FILE (forge-discover.sh --write prints it), then forge-doctor.sh"

# Origin's real branch set, captured before filter-repo deletes the remote.
# GIT_TERMINAL_PROMPT=0: an HTTPS credential prompt would hang instead of
# becoming the already-handled empty list. Never recommend `push --all` —
# filter-repo turns refs/remotes/origin/pr/12 into refs/heads/pr/12, and
# --all from a clone that fetched refs/pull/* would publish those.
ORIGIN_BRANCHES=()
LS_REMOTE_OK=0
if remote_ls="$(GIT_TERMINAL_PROMPT=0 git ls-remote --heads origin 2>/dev/null)"; then
  LS_REMOTE_OK=1
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    name="${line##*refs/heads/}"
    [ -n "$name" ] && ORIGIN_BRANCHES+=("$name")
  done <<< "$remote_ls"
fi
if [ "$LS_REMOTE_OK" -eq 1 ] && [ "${#ORIGIN_BRANCHES[@]}" -gt 0 ]; then
  PUSH_REFS="${ORIGIN_BRANCHES[*]}"
else
  PUSH_REFS="<branch-list from: git ls-remote --heads origin>"
fi

# Paths that must not exist in public history
PURGE_PATHS=(site/a site/index.html site/manifest.json registry)

# site/s/<slug>/<key>/ is a live capability: the key IS the URL (AGENTS rule 8).
# The glob stops one level below site/s, so site/s/.gitkeep — the only entry
# the current tree carries — survives and HEAD is left byte-identical.
PURGE_GLOBS=('site/s/*/*')

# Order matters: the full IDs must be replaced before the account prefix, or
# the prefix rule truncates them into YOUR_CF<remainder> and the 32-hex rules
# no longer match.
REPLACEMENTS=(
  'regex:CF_ACCESS_TEAM_DOMAIN = ".*"==>CF_ACCESS_TEAM_DOMAIN = "REDACTED"'
  'regex:CF_ACCESS_AUD = ".*"==>CF_ACCESS_AUD = "REDACTED"'
  'regex:id = "[0-9a-f]{32}"==>id = "YOUR_KV_NAMESPACE_ID"'
  'regex:cloudflare_account_id": "[0-9a-f]{32}"==>cloudflare_account_id": ""'
  "literal:${ACCOUNT_ID}==>YOUR_CLOUDFLARE_ACCOUNT_ID"
  "literal:${KV_ID}==>YOUR_KV_NAMESPACE_ID"
  "literal:${ACCOUNT_ID:0:8}==>YOUR_CF"
)

# Never print a resolved value: a dry run stays safe to paste into an issue.
fingerprint() {
  printf 'len=%s sha256=%s' "${#1}" "$(printf '%s' "$1" | sha256sum | cut -c1-12)"
}

print_close() {
  local url="${ORIGIN_URL_BEFORE:-<your-origin-url>}"
  echo "  git remote add origin $url"
  echo "  git fetch origin                          # --force-with-lease needs a tracking ref"
  echo "  git push --force-with-lease origin $PUSH_REFS"
  echo "  git push --force origin --tags            # a tag still pins the old history"
}

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Dry run — nothing is rewritten."
  echo ""
  echo "Paths dropped from every commit:"
  printf '  - %s\n' "${PURGE_PATHS[@]}" "${PURGE_GLOBS[@]}"
  echo ""
  echo "Pattern rules:"
  for rule in "${REPLACEMENTS[@]}"; do
    case "$rule" in
      regex:*) echo "  - ${rule#regex:}" ;;
    esac
  done
  echo ""
  echo "Value rules (resolved from $ENV_FILE):"
  printf '  - %-16s %-26s → %s\n' 'account id' "$(fingerprint "$ACCOUNT_ID")" YOUR_CLOUDFLARE_ACCOUNT_ID
  printf '  - %-16s %-26s → %s\n' 'KV namespace id' "$(fingerprint "$KV_ID")" YOUR_KV_NAMESPACE_ID
  printf '  - %-16s %-26s → %s\n' 'account prefix' 'len=8' YOUR_CF
  echo ""
  echo "Closing push (explicit heads from origin, never --all):"
  if [ "$LS_REMOTE_OK" -eq 0 ]; then
    echo "  ⚠ origin unreachable — printed command uses a placeholder; re-run with network"
  else
    echo "  ${#ORIGIN_BRANCHES[@]} branch(es) from git ls-remote --heads origin"
  fi
  print_close
  exit 0
fi

if [ "$ASSUME_YES" -eq 0 ]; then
  echo "This will rewrite git history to remove:"
  printf '  - %s\n' "${PURGE_PATHS[@]}" "${PURGE_GLOBS[@]}"
  echo "  - historical wrangler.toml / docs carrying the real KV, account and Access IDs"
  echo ""
  echo "Then push these origin heads (never --all):"
  echo "  $PUSH_REFS"
  echo ""
  read -r -p "Continue? [y/N] " ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

PATH_ARGS=()
for p in "${PURGE_PATHS[@]}"; do PATH_ARGS+=(--path "$p"); done
for p in "${PURGE_GLOBS[@]}"; do PATH_ARGS+=(--path-glob "$p"); done
git filter-repo --force "${PATH_ARGS[@]}" --invert-paths

# Replace historical blobs that carried real IDs with the current placeholders.
# Process substitution keeps the rules — which contain the live IDs — off disk.
git filter-repo --force --replace-text <(printf '%s\n' "${REPLACEMENTS[@]}")

echo ""
echo "✓ History rewritten locally. filter-repo removed the 'origin' remote."
echo "Next (coordinate with team — every line is required):"
print_close
echo ""
echo "Never git push --all: filter-repo migrates every remote-tracking ref into"
echo "a local branch (refs/remotes/origin/pr/12 → refs/heads/pr/12). The command"
echo "above is origin's real heads, captured before the rewrite, so it is safe"
echo "in a fresh clone and in one that once fetched refs/pull/*."
echo ""
echo "That fetch re-imports the unpurged objects into this clone, so the local"
echo "repo is no longer clean: everyone, including you, ends on a fresh clone."
echo ""
echo "A force-push does not delete GitHub's refs/pull/*/head — those keep serving"
echo "the pre-purge blobs. Ask GitHub Support to drop them, or recreate the repo."
