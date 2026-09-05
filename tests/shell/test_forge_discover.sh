#!/usr/bin/env bash
# Behavioral: forge-discover.sh CLI contract, driven by a stubbed `wrangler`.
#
# The real script is executed — only the network is replaced. Isolation:
#   PATH        → temp bin/ holding the wrangler double (python3 stays reachable)
#   HOME        → temp dir, so ~/.config/silex is never the operator's
#   FORGE_CONFIG→ temp file, so no real forge.config.json is read or written
# Asserts exit codes (0/1/2 = the contract the skill and README dispatch on),
# file modes, the next-action command each failure names, and that no secret is
# echoed. Wrangler output fixtures mirror tests/python/test_discover.py.
# bash 3.2-safe (no mapfile / assoc arrays / ${x^^}), no GNU-only flags.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DISCOVER="$ROOT/plugins/silex-forge/scripts/forge-discover.sh"
SH="${FORGE_BASH:-bash}"

pass() { echo "  ok  $*"; }
fail() { echo "  FAIL $*" >&2; exit 1; }

echo "forge-discover behavioral tests"

TD="$(mktemp -d)"
trap 'rm -rf "$TD"' EXIT

# Ambient Cloudflare state would leak into the run — this test owns its inputs.
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_EMAIL || true
unset FORGE_SHARES_KV_ID CF_ACCESS_AUD CF_ACCESS_TEAM_DOMAIN || true
unset FORGE_PAGES_PROJECT FORGE_ENV FORGE_CONFIG PUBLIC_HOST || true

FX="$TD/fx"
mkdir -p "$FX" "$TD/bin" "$TD/home"
export HOME="$TD/home"
export PATH="$TD/bin:$PATH"
export STUB_FIXTURES="$FX"

ACCT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
KV_ID="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
AUD="dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
# A secret that only ever exists on disk: if any output mode echoes file
# contents instead of key names, this string shows up and the test fails.
SECRET="cf-token-sentinel-2f9c4d7e1a"

cat > "$FX/whoami.txt" <<EOF

 ⛅️ wrangler 4.0.0
👋 You are logged in with an OAuth Token, associated with the email user@example.com.
┌────────────────┬──────────────────────────────────┐
│ Account Name   │ Account ID                       │
├────────────────┼──────────────────────────────────┤
│ Example Inc    │ ${ACCT} │
└────────────────┴──────────────────────────────────┘
EOF

cat > "$FX/projects_table.txt" <<'EOF'
┌──────────────┬────────────┐
│ Project Name │ Created    │
├──────────────┼────────────┤
│ silex-forge  │ 2024-01-01 │
│ client-site  │ 2024-02-02 │
└──────────────┴────────────┘
EOF

: > "$FX/projects_none.txt"

cat > "$FX/projects_unparsed.txt" <<'EOF'
┌──────────────┐
│ Project Name │
└──────────────┘
EOF

cat > "$FX/full.toml" <<EOF
name = "silex-forge"
pages_build_output_dir = "site"
compatibility_date = "2026-07-17"

[env.production.vars]
CF_ACCESS_AUD = "${AUD}"
CF_ACCESS_TEAM_DOMAIN = "example.cloudflareaccess.com"
PUBLIC_HOST = "forge.example.com"
SHLINK_API_URL = "https://s.example.com/rest/v3/short-urls"

[[env.production.kv_namespaces]]
id = "${KV_ID}"
binding = "SHARES"
EOF

# Half-forged: real Pages project, SHARES KV never created.
cat > "$FX/nokv.toml" <<EOF
name = "silex-forge"
pages_build_output_dir = "site"

[env.production.vars]
CF_ACCESS_AUD = "${AUD}"
CF_ACCESS_TEAM_DOMAIN = "example.cloudflareaccess.com"
PUBLIC_HOST = "forge.example.com"
SHLINK_API_URL = "https://s.example.com/rest/v3/short-urls"
EOF

# wrangler double: no network, behavior selected by STUB_* env vars.
cat > "$TD/bin/wrangler" <<'STUB'
#!/usr/bin/env bash
set -u
if [ "${1-}" = "whoami" ]; then
  if [ "${STUB_WHOAMI_FAIL:-0}" = 1 ]; then
    echo "You are not authenticated." >&2
    exit 1
  fi
  cat "$STUB_FIXTURES/whoami.txt"
  exit 0
fi
if [ "${1-}" = "pages" ] && [ "${2-}" = "project" ] && [ "${3-}" = "list" ]; then
  if [ "${STUB_LIST_FAIL:-0}" = 1 ]; then
    echo "A request to the Cloudflare API failed." >&2
    exit 1
  fi
  cat "$STUB_FIXTURES/${STUB_LIST:-projects_table}.txt"
  exit 0
fi
if [ "${1-}" = "pages" ] && [ "${2-}" = "download" ] && [ "${3-}" = "config" ]; then
  cp "$STUB_FIXTURES/${STUB_TOML:-full}.toml" ./wrangler.toml
  echo "Success! Your wrangler.toml file is ready."
  exit 0
fi
echo "wrangler stub: unhandled argv: $*" >&2
exit 97
STUB
chmod +x "$TD/bin/wrangler"

# Portable mode read: `stat -c` is GNU-only, `ls -l` prefix is not.
mode_of() { ls -ld "$1" | cut -c1-10; }

run() { # run <label-unused> <args...> → sets RC, OUT (stdout+stderr merged)
  set +e
  OUT="$("$SH" "$DISCOVER" "$@" 2>&1)"
  RC=$?
  set -e
}

# ── exit 2 · wanted project absent, others exist ───────────────────────────────
STUB_LIST=projects_table run --project ghost-forge
[ "$RC" -eq 2 ] || fail "absent project with others must exit 2, got $RC: $OUT"
echo "$OUT" | grep -q 'silex-forge' \
  || fail "must list the projects that do exist, got: $OUT"
echo "$OUT" | grep -q 'client-site' \
  || fail "must list every existing project, got: $OUT"
echo "$OUT" | grep -q -- '--project' \
  || fail "must name --project as the retry, got: $OUT"
pass "absent project → exit 2, other names listed, --project named"

# ── exit 2 · account holds no Pages project at all ─────────────────────────────
STUB_LIST=projects_none run --project silex-forge
[ "$RC" -eq 2 ] || fail "empty account must exit 2, got $RC: $OUT"
echo "$OUT" | grep -q 'forge-provision.sh' \
  || fail "empty account must point at forge-provision.sh, got: $OUT"
pass "no Pages project → exit 2 pointing at forge-provision.sh"

# ── exit 2 · project list unreadable → never offer to create a second forge ────
STUB_LIST=projects_unparsed run --project silex-forge
[ "$RC" -eq 2 ] || fail "unparsed list must exit 2, got $RC: $OUT"
if echo "$OUT" | grep -q 'forge-provision.sh'; then
  fail "unparsed list must NOT offer to provision (would fork a second forge): $OUT"
fi
echo "$OUT" | grep -qE 'check:|wrangler|forge-doctor\.sh|forge-setup' \
  || fail "unparsed list must still name a next action, got: $OUT"
pass "unparsed list → exit 2, no provision offer, next action named"

# ── exit 1 · not logged in ─────────────────────────────────────────────────────
STUB_WHOAMI_FAIL=1 run --project silex-forge
[ "$RC" -eq 1 ] || fail "whoami failure must exit 1, got $RC: $OUT"
echo "$OUT" | grep -q 'wrangler login' \
  || fail "whoami failure must name \`wrangler login\`, got: $OUT"
pass "whoami failure → exit 1 naming wrangler login"

# ── exit 1 · cannot list projects (auth/API) ───────────────────────────────────
STUB_LIST_FAIL=1 run --project silex-forge
[ "$RC" -eq 1 ] || fail "unreadable project list must exit 1, got $RC: $OUT"
echo "$OUT" | grep -q 'wrangler login' \
  || fail "unreadable project list must name a next action, got: $OUT"
pass "project list failure → exit 1 naming a next action"

# ── exit 0 · half-forged project still names the follow-up per missing key ─────
STUB_TOML=nokv run --project silex-forge
[ "$RC" -eq 0 ] || fail "half-forged project must still exit 0, got $RC: $OUT"
echo "$OUT" | grep -q 'FORGE_SHARES_KV_ID' \
  || fail "missing SHARES KV must be reported by key name, got: $OUT"
echo "$OUT" | grep -q 'kv namespace create SHARES' \
  || fail "missing FORGE_SHARES_KV_ID must name the kv namespace create follow-up, got: $OUT"
pass "half-forged project → exit 0 with a follow-up command for the missing key"

# ── --write · credentials file ─────────────────────────────────────────────────
ENVF="$HOME/.config/silex/forge.env"
mkdir -p "$HOME/.config/silex"
cat > "$ENVF" <<EOF
# hand-written before discovery ran
CLOUDFLARE_API_TOKEN=${SECRET}
EOF
chmod 644 "$ENVF"

run --project silex-forge --write
[ "$RC" -eq 0 ] || fail "--write on a healthy forge must exit 0, got $RC: $OUT"

[ "$(mode_of "$ENVF")" = "-rw-------" ] \
  || fail "forge.env must end up 600, got $(mode_of "$ENVF")"
[ "$(mode_of "$HOME/.config/silex")" = "drwx------" ] \
  || fail "\$HOME/.config/silex must end up 700, got $(mode_of "$HOME/.config/silex")"
pass "--write leaves forge.env 600 in a 700 directory"

grep -q "CLOUDFLARE_API_TOKEN=${SECRET}" "$ENVF" \
  || fail "--write destroyed the pre-existing CLOUDFLARE_API_TOKEN"
grep -q "CLOUDFLARE_ACCOUNT_ID=${ACCT}" "$ENVF" \
  || fail "--write did not persist the discovered account id"
grep -q "FORGE_SHARES_KV_ID=${KV_ID}" "$ENVF" \
  || fail "--write did not persist the discovered SHARES KV id"
pass "--write merges discovered keys and preserves the existing token"

if printf '%s\n' "$OUT" | grep -q "$SECRET"; then
  fail "--write echoed a secret value to its output"
fi
pass "--write prints key names only, never a secret value"

# ── --write · pages_project SSOT (contract C2) ─────────────────────────────────
CFG="$HOME/.config/silex/forge.config.json"
cat > "$CFG" <<EOF
{
  "version": 1,
  "hub_root": "$TD/hub",
  "artifacts_dir": "artifacts",
  "public_host": "stale.example.com",
  "forge_repo": "https://github.com/go-silex/silex-forge.git",
  "site_dir": "site",
  "registry_dir": "registry",
  "internal_prefix": "a",
  "pages_project": "stale-name"
}
EOF
export FORGE_CONFIG="$CFG"

run --project silex-forge --write
[ "$RC" -eq 0 ] || fail "--write with a local config must exit 0, got $RC: $OUT"

python3 - "$CFG" <<'PY' || fail "--write broke the local forge.config.json contract"
import json, sys
cfg = json.load(open(sys.argv[1], encoding="utf-8"))
assert cfg.get("pages_project") == "silex-forge", cfg.get("pages_project")
assert cfg.get("hub_root"), "hub_root dropped"
assert cfg.get("internal_prefix") == "a", "internal_prefix dropped"
assert cfg.get("public_host") == "forge.example.com", cfg.get("public_host")
assert cfg.get("forge_repo", "").startswith("https://"), "forge_repo dropped"
assert cfg.get("registry_dir") == "registry", "registry_dir dropped"
PY
pass "--write updates pages_project in place and preserves every other key"

# No local config → discover must not fabricate one (doctor's "no local config"
# diagnostic and the forge-setup skill own creation).
unset FORGE_CONFIG
rm -f "$CFG"
run --project silex-forge --write
[ "$RC" -eq 0 ] || fail "--write without a local config must still exit 0, got $RC: $OUT"
[ ! -f "$CFG" ] \
  || fail "--write created $CFG — creation belongs to the forge-setup skill"
echo "$OUT" | grep -q 'no local config at' \
  || fail "--write must say the project name is not remembered, got: $OUT"
echo "$OUT" | grep -q '/forge-setup' \
  || fail "--write without a local config must name /forge-setup, got: $OUT"
pass "--write never creates forge.config.json"

echo "all forge-discover behavioral checks passed"
