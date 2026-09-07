#!/usr/bin/env bash
# ShellCheck gate. Single definition, three consumers: the ci.yml `check` job,
# the lefthook pre-push hook, and `.dev/stack.yml` commands.lint. Do not copy
# the file list into any of them.
#
# publish.sh keeps the two exclusions it has always had:
#   SC1091 — sourced files resolved at runtime from the engine clone
#   SC2086 — deliberate word splitting in the wrangler argv assembly
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v shellcheck > /dev/null 2>&1 || {
  echo >&2 "ERROR: shellcheck not found (apt-get install shellcheck / brew install shellcheck)"
  exit 1
}

# Loop, so a new plugin script is covered the day it lands.
for f in plugins/silex-forge/scripts/*.sh; do
  case "$f" in
    */publish.sh) shellcheck -e SC1091,SC2086 "$f" ;;
    *) shellcheck "$f" ;;
  esac
done

shellcheck scripts/*.sh tests/shell/test_release_plugin.sh

echo "lint-shell: clean"
