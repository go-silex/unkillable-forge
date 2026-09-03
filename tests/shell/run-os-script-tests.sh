#!/usr/bin/env bash
# Script tests for the supported POSIX contract:
#   Linux (any bash ≥ 3.2) · macOS stock /bin/bash 3.2 · Windows = WSL (same as Linux)
# Native Windows Git Bash is not a supported runtime (scripts call python3, chmod 600).
# Invoke as `/bin/bash tests/shell/run-os-script-tests.sh` on macOS so brew bash 5
# is not used. Child tests run under "$BASH" (this interpreter), not PATH bash.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [ "${FORGE_REQUIRE_BASH32:-}" = 1 ]; then
  case "$BASH_VERSION" in
    3.2*) ;;
    *)
      echo "FORGE_REQUIRE_BASH32: need bash 3.2, got ${BASH_VERSION} ($BASH)" >&2
      exit 1
      ;;
  esac
fi

if command -v python3 >/dev/null 2>&1; then
  PY=python3
else
  echo "python3 missing (Windows native is not supported — use WSL)" >&2
  exit 1
fi

echo "== host $(uname -s) interpreter $BASH ${BASH_VERSION} py=$PY =="

echo "== bash -n ($BASH) =="
for f in plugins/silex-forge/scripts/*.sh; do
  "$BASH" -n "$f"
done

echo "== python unittest =="
"$PY" -m unittest discover -s tests/python -p 'test_*.py' -v

echo "== shell ($BASH) =="
export FORGE_BASH="$BASH"
"$BASH" tests/shell/test_bash32_lint.sh
"$BASH" tests/shell/test_publish_contracts.sh
"$BASH" tests/shell/test_forge_doctor.sh
"$BASH" tests/shell/test_publish_lock.sh
"$BASH" tests/shell/test_og_persist.sh

echo "os-script-tests OK"
