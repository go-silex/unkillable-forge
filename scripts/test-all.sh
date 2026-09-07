#!/usr/bin/env bash
# The three test suites. Single definition, three consumers: the ci.yml `test`
# job, the lefthook pre-push hook, and `.dev/stack.yml` commands.test.
#
# run-os-script-tests.sh already runs `python3 -m unittest discover -s tests/python`,
# which is why there is no separate Python invocation here.
set -euo pipefail

# One definition, sourced by every consumer — see the file's header for the
# incident it prevents.
# shellcheck source=tests/shell/lib/git-env-guard.sh
. "$(dirname "${BASH_SOURCE[0]}")/../tests/shell/lib/git-env-guard.sh"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[ -d node_modules ] || {
  echo >&2 "ERROR: node_modules missing — run \`npm ci\` first"
  exit 1
}

npm test
bash tests/shell/run-os-script-tests.sh
bash tests/shell/test_release_plugin.sh

echo "test-all: clean"
