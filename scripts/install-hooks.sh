#!/usr/bin/env bash
# Installs the lefthook pre-push hook. Called by package.json `prepare`, so
# `npm ci` / `npm install` wires the gate for a fresh clone.
#
# The kit's one-liner (`git config --get core.hooksPath || lefthook install`)
# skips SILENTLY when a hooksPath is configured — and a silent skip means this
# repo has no pre-push gate at all, which is the opposite of what it is for.
# The fleet removed the machine-wide core.hooksPath on 2026-08-02, but repo-local
# dispatchers still exist on some machines and must not be overwritten, so the
# skip stays — it just says so, loudly, with the way out.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -n "${CI:-}" ]; then
  echo "install-hooks: CI detected — no git hooks to install"
  exit 0
fi

hooks_path="$(git config --get core.hooksPath 2> /dev/null || true)"
if [ -n "$hooks_path" ]; then
  cat >&2 <<EOF
install-hooks: lefthook NOT installed — core.hooksPath is set to '${hooks_path}'.

Shared hooks win over ours, but that leaves this clone with NO pre-push gate:
secret-scan, lint-shell and test-all will not run before your pushes.

Fix one of:
  · wire 'bash scripts/secret-scan.sh' into that dispatcher, or
  · git config --unset core.hooksPath && npm run prepare
EOF
  exit 0
fi

npx lefthook install
