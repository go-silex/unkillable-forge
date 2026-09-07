#!/usr/bin/env bash
# The suite must be hermetic against an inherited git environment.
#
# git exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE (plus a quarantine object
# dir on push) to its hooks, and those variables OVERRIDE `-C <path>` and the
# child's cwd. On 2026-09-07 that turned a `git commit` inside a test fixture
# into a commit on this repository: `main` and a feature branch each gained a
# commit authored "Forge Test", wrangler.toml was truncated to one line,
# site/404.html to a stub, and site/a/index.html appeared. `.git/config` also
# gained a user.name/user.email from the fixture.
#
# The suite entrypoints unset those variables. Nothing but a test stops someone
# from deleting the unset, so: point GIT_DIR at a SCRATCH repository, run the
# guarded entrypoints, and assert the scratch repository was not written to.
# Safe by construction — the scratch repo is the only thing at risk here.
set -euo pipefail

# shellcheck source=tests/shell/lib/git-env-guard.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/git-env-guard.sh"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

BASH_BIN="${FORGE_BASH:-bash}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
ok() { printf '  ok  %s\n' "$1"; }
ko() {
  printf '  FAIL %s\n' "$1"
  fail=1
}

scratch="$TMP/scratch"
mkdir -p "$scratch"
git -c init.defaultBranch=main init -q "$scratch"
git -C "$scratch" -c user.name=Scratch -c user.email=scratch@example.invalid \
  commit -q --allow-empty -m "scratch base"

before_head="$(git -C "$scratch" rev-parse HEAD)"
before_count="$(git -C "$scratch" rev-list --count HEAD)"
before_cfg="$(git -C "$scratch" config --local --list | sort | cksum)"

# test_publish_contracts.sh is the inner target: it builds git repositories and
# commits in them (that is where the leaked fixture files came from), it is part
# of run-os-script-tests.sh, and it is green in every supported environment —
# including the alpine/bash-3.2 docker job. test_release_plugin.sh would be the
# sharper case (it also tags) but it fails there for unrelated reasons ("nominal
# (remote tag missing)"), with or without an inherited GIT_DIR.
if ! env GIT_DIR="$scratch/.git" GIT_WORK_TREE="$scratch" \
  "$BASH_BIN" tests/shell/test_publish_contracts.sh > "$TMP/out.log" 2>&1; then
  ko "guarded suite failed with an inherited GIT_DIR"
  echo "  --- last lines of the guarded run ---"
  tail -15 "$TMP/out.log" | sed 's/^/  | /'
  echo "  --- end ---"
fi

after_head="$(git -C "$scratch" rev-parse HEAD)"
after_count="$(git -C "$scratch" rev-list --count HEAD)"
after_cfg="$(git -C "$scratch" config --local --list | sort | cksum)"
tags="$(git -C "$scratch" tag | wc -l | tr -d ' ')"

assert_eq() {
  local label="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then
    ok "$label"
  else
    ko "$label (want '${want}', got '${got}')"
  fi
}

assert_eq "inherited GIT_DIR: HEAD untouched" "$before_head" "$after_head"
assert_eq "inherited GIT_DIR: no commit added" "$before_count" "$after_count"
assert_eq "inherited GIT_DIR: no tag created" "0" "$tags"
assert_eq "inherited GIT_DIR: .git/config untouched" "$before_cfg" "$after_cfg"
assert_eq "inherited GIT_DIR: work tree left clean" "" "$(git -C "$scratch" status --porcelain)"

# The behavioural check above exercises ONE representative suite. This static
# check covers the rest: any tests/shell script that touches git must source the
# guard, so a new fixture added later cannot re-open the hole without failing
# here. Cheaper and broader than re-running all eleven suites under GIT_DIR.
unguarded=""
for f in tests/shell/test_*.sh tests/shell/run-os-script-tests.sh; do
  grep -qE '(^|[^A-Za-z_])git ' "$f" || continue
  grep -q 'git-env-guard\.sh' "$f" || unguarded="${unguarded} ${f}"
done
assert_eq "every git-touching tests/shell script sources the guard" "" "$unguarded"

[ "$fail" -eq 0 ] || exit 1
echo "git env isolation checks passed"
