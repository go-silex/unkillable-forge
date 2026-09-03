#!/usr/bin/env bash
# Behavioral lock test: hide flock, two parallel acquires, one .lockdir, cleanup removes it.
# bash 3.2-safe (no {fd}, no mapfile, no assoc arrays).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PUBLISH="$ROOT/plugins/silex-forge/scripts/publish.sh"

# flock lives next to mkdir in /usr/bin — cannot drop it from PATH without
# losing mkdir. Hide via function (exported into the lock subshells).
command() {
  if [ "${1-}" = "-v" ] && [ "${2-}" = "flock" ]; then
    return 1
  fi
  builtin command "$@"
}
export -f command

ART="$(mktemp -d)"
got="$ART/got"
trap 'rm -rf "$ART"' EXIT

export ARTIFACTS_ROOT="$ART"
export FORGE_ARTIFACTS_ROOT="$ART"
export FORGE_PUBLISH_LIB_ONLY=1

# shellcheck disable=SC1090
. "$PUBLISH"
# export_env overwrites FORGE_ARTIFACTS_ROOT with the machine hub — pin temp dir
# before any acquire (a mkdir lock on the real hub never expires).
ARTIFACTS_ROOT="$ART"
FORGE_ARTIFACTS_ROOT="$ART"
export ARTIFACTS_ROOT FORGE_ARTIFACTS_ROOT
case "$ARTIFACTS_ROOT" in
  "$ART") ;;
  *) echo "FAIL: ARTIFACTS_ROOT not temp dir: $ARTIFACTS_ROOT" >&2; exit 1 ;;
esac
case "$ARTIFACTS_ROOT" in
  *silex-hub*|*Forge/artifacts*)
    echo "refuse: ARTIFACTS_ROOT looks like the hub ($ARTIFACTS_ROOT)" >&2
    exit 1
    ;;
esac
trap 'cleanup 2>/dev/null || true; rm -rf "$ART"' EXIT

export -f acquire_publish_lock cleanup die

: > "$got"

(
  acquire_publish_lock demo
  [ -d "$ART/.forge-locks/demo.lockdir" ]
  [ ! -d "$ART/.forge-locks/demo.lock" ]
  sleep 1
  echo A >> "$got"
  cleanup
) &
pid1=$!
sleep 0.2
(
  acquire_publish_lock demo
  echo B >> "$got"
  cleanup
) &
pid2=$!

wait "$pid1"
wait "$pid2"

if [ -d "$ART/.forge-locks/demo.lockdir" ]; then
  echo "FAIL: lockdir left after cleanup" >&2
  exit 1
fi

seq="$(tr '\n' ' ' < "$got")"
case "$seq" in
  "A B "|"A B") ;;
  *)
    echo "FAIL: expected A then B, got: $seq" >&2
    exit 1
    ;;
esac

echo "ok  mkdir lock serializes and cleanup removes lockdir"
