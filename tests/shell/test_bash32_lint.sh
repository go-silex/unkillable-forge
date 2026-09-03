#!/usr/bin/env bash
# Fail if any plugins/silex-forge/scripts/*.sh uses bash 4+ or unguarded GNU-only.
# bash 3.2-safe (no mapfile / declare -A).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPTS="$ROOT/plugins/silex-forge/scripts"

pass() { echo "  ok  $*"; }
fail() { echo "  FAIL $*" >&2; exit 1; }

n=0
for f in "$SCRIPTS"/*.sh; do
  [ -f "$f" ] || continue
  n=$((n + 1))
done
[ "$n" -gt 0 ] || fail "no $SCRIPTS/*.sh"

echo "bash-3.2 lint ($n scripts)"

hit() {
  # $1 pattern  $2 file — ignore comments so docs don't trip the lint
  sed 's/[[:space:]]*#.*$//' "$2" | grep -nE "$1" 2>/dev/null || true
}

for f in "$SCRIPTS"/*.sh; do
  [ -f "$f" ] || continue
  rel="${f#"$ROOT"/}"

  bad=$(hit '^[[:space:]]*exec \{' "$f")
  [ -z "$bad" ] || fail "$rel: bash 4.1 exec {fd}> (use a fixed FD): $bad"
  bad=$(hit 'declare[[:space:]]+-A' "$f")
  [ -z "$bad" ] || fail "$rel: declare -A is bash 4.0: $bad"

  bad=$(hit 'mapfile|readarray' "$f")
  [ -z "$bad" ] || fail "$rel: mapfile/readarray is bash 4.0: $bad"

  bad=$(hit '\$\{[A-Za-z_][A-Za-z0-9_]*\^\^|\$\{[A-Za-z_][A-Za-z0-9_]*,,' "$f")
  [ -z "$bad" ] || fail "$rel: \${var^^}/\${var,,} is bash 4.0: $bad"

  bad=$(hit '&>>' "$f")
  [ -z "$bad" ] || fail "$rel: &>> is bash 4.0: $bad"

  bad=$(hit ';;&' "$f")
  [ -z "$bad" ] || fail "$rel: ;;& is bash 4.0: $bad"

  bad=$(hit 'readlink[[:space:]]+-f' "$f")
  [ -z "$bad" ] || fail "$rel: readlink -f is GNU: $bad"

  # sed -i is unportable (GNU: no suffix, BSD: suffix required)
  bad=$(hit 'sed([[:space:]]+-[a-zA-Z]+)*[[:space:]]+-i([[:space:]]|$)' "$f")
  [ -z "$bad" ] || fail "$rel: sed -i is not portable (write to a temp file): $bad"

  # GNU-only address flag /re/I — BSD sed has no case-insensitive modifier
  bad=$(hit 'sed[^|]*/I[[:space:]]' "$f")
  [ -z "$bad" ] || fail "$rel: sed /re/I flag is GNU: $bad"

  if grep -qE 'stat[[:space:]]+-c' "$f"; then
    grep -qE 'stat[[:space:]]+-f' "$f" \
      || fail "$rel: stat -c (GNU) without stat -f (BSD) fallback"
  fi

  if grep -qE '(^|[^[:alnum:]_])flock($|[^[:alnum:]_])' "$f"; then
    grep -qE 'command[[:space:]]+-v[[:space:]]+flock' "$f" \
      || fail "$rel: flock used without command -v flock probe"
  fi

  pass "$rel"
done

echo "all bash-3.2 lint checks passed"
