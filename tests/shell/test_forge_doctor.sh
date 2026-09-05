#!/usr/bin/env bash
# Behavioral: forge-doctor.sh three-way exit contract (0 ready / 1 config KO /
# 2 deploy blocked), the next-action command each blocker names, mode
# separation, and secret hygiene.
#
# Every case runs against a temp HOME + FORGE_CONFIG + FORGE_ENV: the doctor's
# verdict must come from the fixture, never from the operator's machine.
# Exit codes are asserted, never swallowed — the skill, publish.sh and CI
# dispatch on them.
# bash 3.2-safe, no GNU-only flags, no network.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOCTOR="$ROOT/plugins/silex-forge/scripts/forge-doctor.sh"
SH="${FORGE_BASH:-bash}"

pass() { echo "  ok  $*"; }
fail() { echo "  FAIL $*" >&2; exit 1; }

echo "forge-doctor behavioral tests"

TD="$(mktemp -d)"
trap 'rm -rf "$TD"' EXIT

# Ambient credentials/hub would decide the verdict instead of the fixture.
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_EMAIL || true
unset FORGE_SHARES_KV_ID CF_ACCESS_AUD CF_ACCESS_TEAM_DOMAIN || true
unset FORGE_PAGES_PROJECT FORGE_CONFIG FORGE_ENV HUB_ROOT || true

ACCT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
KV_ID="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
AUD="dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
# Only ever written to the fixture forge.env: no doctor mode may echo it.
SECRET="cf-token-sentinel-7b3e9f1c02"

export HOME="$TD/home"
mkdir -p "$HOME/.config/silex" "$TD/blank"
mkdir -p "$TD/hub/00_COCKPIT/Forge/artifacts" "$TD/hub/01_COMPANY"

CFG="$TD/home/.config/silex/forge.config.json"
cat > "$CFG" <<EOF
{
  "version": 1,
  "hub_root": "$TD/hub",
  "artifacts_dir": "00_COCKPIT/Forge/artifacts",
  "public_host": "forge.example.com",
  "forge_repo": "https://github.com/go-silex/silex-forge.git",
  "site_dir": "site",
  "registry_dir": "registry",
  "internal_prefix": "a",
  "pages_project": "silex-forge"
}
EOF

ENVF="$TD/home/.config/silex/forge.env"
cat > "$ENVF" <<EOF
CLOUDFLARE_API_TOKEN=${SECRET}
CLOUDFLARE_ACCOUNT_ID=${ACCT}
FORGE_SHARES_KV_ID=${KV_ID}
CF_ACCESS_TEAM_DOMAIN=example.cloudflareaccess.com
CF_ACCESS_AUD=${AUD}
EOF
chmod 600 "$ENVF"

# run <args...> → RC, OUT (stdout), ERR (stderr). Never aborts the test.
run() {
  set +e
  OUT="$("$SH" "$DOCTOR" "$@" 2>"$TD/err")"
  RC=$?
  set -e
  ERR="$(cat "$TD/err")"
  ERR_LINES="$(wc -l < "$TD/err" | tr -d ' ')"
}

is_json() { printf '%s' "$1" | python3 -c 'import json,sys; json.load(sys.stdin)'; }

# ── exit 0 · installed, credentialed, deploy-ready ─────────────────────────────
export FORGE_CONFIG="$CFG"
export FORGE_ENV="$ENVF"

run
[ "$RC" -eq 0 ] || fail "healthy install must exit 0, got $RC: $OUT $ERR"
HEALTHY_HUMAN="$OUT$ERR"
pass "healthy fixture → exit 0"

run --json
[ "$RC" -eq 0 ] || fail "healthy install must exit 0 in --json too, got $RC"
is_json "$OUT" || fail "--json stdout is not valid JSON: ${OUT}"
case "$OUT" in
  '{'*) ;;
  *) fail "--json must emit the payload alone, got: ${OUT}" ;;
esac
echo "$OUT" | grep -q '"deploy_blockers"' \
  || fail "--json must expose deploy_blockers (setup/publish read it)"
echo "$OUT" | grep -q '"config_source"' \
  || fail "--json must expose config_source"
HEALTHY_JSON="$OUT$ERR"
pass "--json emits the payload alone and keeps exit 0"

run --quiet
[ "$RC" -eq 0 ] || fail "--quiet must exit 0 on a healthy install, got $RC"
[ -z "$OUT" ] || fail "--quiet must not print to stdout, got: $OUT"
[ -z "$ERR" ] || fail "--quiet must stay silent when everything is OK, got: $ERR"
HEALTHY_QUIET="$OUT$ERR"
pass "--quiet is silent and exits 0 when ready"

for blob in "$HEALTHY_HUMAN" "$HEALTHY_JSON" "$HEALTHY_QUIET"; do
  case "$blob" in
    *"$SECRET"*) fail "a doctor output mode echoed the API token" ;;
  esac
done
pass "no output mode leaks the token value"

run --json --quiet
[ "$RC" -eq 0 ] || fail "--json --quiet must exit 0 on a healthy install, got $RC"
is_json "$OUT" || fail "--json --quiet must still emit JSON only: ${OUT}"
pass "--json --quiet prefers JSON"

# ── exit 2 · config fine, credentials missing → deploy blocked ─────────────────
export FORGE_ENV="$TD/absent.env"
[ ! -f "$TD/absent.env" ] || fail "fixture error: absent.env exists"

run --json
[ "$RC" -eq 2 ] || fail "missing credentials must exit 2 in --json, got $RC"
BLOCKERS="$(printf '%s' "$OUT" | python3 -c \
  'import json,sys; print("\n".join(json.load(sys.stdin)["deploy_blockers"]))')"
NB="$(printf '%s\n' "$BLOCKERS" | grep -c . || true)"
[ "$NB" -ge 3 ] || fail "fixture must block deploy on several codes, got: $BLOCKERS"
pass "--json exits 2 when hub is OK but deploy is blocked"

run
[ "$RC" -eq 2 ] || fail "missing credentials must exit 2, got $RC: $OUT"
ARROWS="$(printf '%s\n' "$OUT" | grep -c '→' || true)"
[ "$ARROWS" -ge "$NB" ] \
  || fail "each of the $NB blockers needs a → next-action line, got $ARROWS: $OUT"
echo "$OUT" | grep -q 'CLOUDFLARE_API_TOKEN' \
  || fail "missing token must be named by key, got: $OUT"
echo "$OUT" | grep -q 'chmod 600' \
  || fail "the token fix must name chmod 600, got: $OUT"
echo "$OUT" | grep -q 'forge-discover.sh --write' \
  || fail "the KV/Access fixes must name forge-discover.sh --write, got: $OUT"
pass "exit 2 report names a fixing command per blocker"

run --quiet
[ "$RC" -eq 2 ] || fail "--quiet must exit 2 when deploy is blocked, got $RC"
[ -z "$OUT" ] || fail "--quiet must not print to stdout, got: $OUT"
[ "$ERR_LINES" -eq 1 ] \
  || fail "--quiet must emit exactly one stderr line on failure, got $ERR_LINES: $ERR"
echo "$ERR" | grep -q 'deploy blocked' \
  || fail "--quiet stderr must say deploy is blocked, got: $ERR"
echo "$ERR" | grep -q 'forge-doctor.sh' \
  || fail "--quiet stderr must name the command that details the fix, got: $ERR"
case "$ERR" in
  *"$SECRET"*) fail "--quiet leaked the token value" ;;
esac
pass "--quiet: exit 2, one stderr line naming the next action"

# ── exit 1 · never installed (no local config) ─────────────────────────────────
export HOME="$TD/blank"
unset FORGE_CONFIG FORGE_ENV

run
[ "$RC" -eq 1 ] || fail "no local config must exit 1, got $RC: $OUT"
echo "$OUT" | grep -q 'forge-setup' \
  || fail "no local config must name the forge-setup skill, got: $OUT"
pass "never-installed → exit 1 naming forge-setup"

run --json
[ "$RC" -eq 1 ] || fail "no local config must exit 1 in --json, got $RC"
is_json "$OUT" || fail "--json must stay valid JSON on a broken install: ${OUT}"
pass "--json exits 1 on a broken config and still emits JSON"

run --quiet
[ "$RC" -eq 1 ] || fail "--quiet must exit 1 on a broken config, got $RC"
[ -z "$OUT" ] || fail "--quiet must not print to stdout, got: $OUT"
[ "$ERR_LINES" -eq 1 ] \
  || fail "--quiet must emit exactly one stderr line on failure, got $ERR_LINES: $ERR"
echo "$ERR" | grep -q 'config KO' \
  || fail "--quiet stderr must say the config is KO, got: $ERR"
echo "$ERR" | grep -q 'forge-setup' \
  || fail "--quiet stderr must name forge-setup, got: $ERR"
pass "--quiet: exit 1, one stderr line naming forge-setup"

# ── exit 1 · the doctor must survive the broken install it diagnoses ───────────
mkdir -p "$TD/broken/scripts"
cp "$DOCTOR" "$TD/broken/scripts/"
run_broken() {
  set +e
  OUT="$("$SH" "$TD/broken/scripts/forge-doctor.sh" 2>&1)"
  RC=$?
  set -e
}
run_broken
[ "$RC" -eq 1 ] || fail "missing lib/ must exit 1, got $RC: $OUT"
echo "$OUT" | grep -q 'lib' \
  || fail "missing lib/ must name the missing directory, got: $OUT"
if echo "$OUT" | grep -q 'No such file or directory'; then
  fail "missing lib/ leaked a raw shell error instead of the diagnostic: $OUT"
fi
pass "missing lib/ → exit 1 with a diagnostic, not a crash"

echo "all forge-doctor behavioral checks passed"
