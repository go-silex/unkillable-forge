#!/usr/bin/env bash
# forge_common.sh — shared helpers for silex-forge shell scripts.
#
# Sourced, never executed. Import has no side effects: no set -e, no cd,
# no writes, no output.

# Print "wrangler" or "npx --yes wrangler". Return 1 if neither is on PATH.
forge_wrangler() {
  if command -v wrangler >/dev/null 2>&1; then
    printf '%s\n' wrangler
    return 0
  fi
  if command -v npx >/dev/null 2>&1; then
    printf '%s\n' 'npx --yes wrangler'
    return 0
  fi
  return 1
}

forge_die() {
  echo "✗ $*" >&2
  exit 1
}

forge_warn() {
  echo "  ⚠ $*" >&2
}

forge_info() {
  echo "→ $*" >&2
}

forge_ok() {
  echo "✓ $*"
}
