#!/usr/bin/env bash
# Behavioral: publish.sh --dry-run is a gate, not a preview.
#
# What is locked here (the --dry-run contract):
#   1. the real hub comes out of the run byte-identical (the hub sandbox is the
#      core seam — a cp into the real ARTIFACTS_ROOT fails check 1)
#   2. the sandbox really receives the writes, hub notes included, so the whole
#      chain runs instead of being skipped wholesale (a no-op mode fails check 2)
#   3. wrangler / curl / shlink are never invoked — asserted on a recording file,
#      not on stdout
#   4. the plan is printed with the config's Pages project and public host
#   5. a failed precondition (empty CLOUDFLARE_API_TOKEN) exits non-zero, exactly
#      where the wet path fails
#   6. --dry-run is consumed anywhere in argv, for every command
#   7. --share mints nothing: no KV mutation, no HTTP, no shortlink
#
# Isolation: FORGE_CONFIG + FORGE_ENV/FORGE_ENV_FILE point at temp files, the hub
# is a temp directory, FORGE_REPO is a throwaway git engine, and wrangler / curl /
# shlink are recording PATH stubs. The machine hub, ~/.config/silex and the network
# are never touched: the only python3 calls stubbed out are publish.sh's two online
# boundaries (Cloudflare preflight, remote Pages var fetch); every other python3
# call runs for real, so the build → patch → index chain is the real one.
# bash 3.2-safe (no mapfile, no assoc arrays, no ${x^^}).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
PUBLISH="$ROOT/plugins/silex-forge/scripts/publish.sh"
BASH_BIN="${FORGE_BASH:-bash}"

pass() { echo "  ok  $*"; }
fail() { echo "  FAIL $*" >&2; exit 1; }

echo "publish.sh --dry-run tests"

PY_REAL="$(command -v python3 || true)"
[ -n "$PY_REAL" ] || fail "python3 not on PATH"

TD="$(mktemp -d)"
DUMP_ON_EXIT=""
trap 'rm -rf "$TD"' EXIT

# ---------------------------------------------------------------- fixture: hub
# A throwaway hub root with one pre-existing artifact. vault_markers: [] keeps
# the config doctor happy without faking an Obsidian vault.
mkdir -p "$TD/hub/artifacts/old-deck"
printf '<html><head><title>Old</title></head><body>OLD-DECK-BODY</body></html>\n' \
  > "$TD/hub/artifacts/old-deck/index.html"
cat > "$TD/hub/artifacts/old-deck/meta.json" <<'EOF'
{
  "slug": "old-deck",
  "title": "Old deck",
  "description": "pre-existing hub artifact",
  "type": "html",
  "date": "2026-01-01",
  "path": "/a/old-deck/",
  "list_on_index": true,
  "visibility": "internal",
  "shared": false
}
EOF

# ------------------------------------------------------------- fixture: engine
# materialize_engine does `git archive HEAD` from a local checkout. gen-og-images.sh
# is dropped so gen_og_images is a silent no-op: no chrome, no ffmpeg, no delay.
mkdir -p "$TD/engine"
git -C "$ROOT" archive HEAD | tar -x -C "$TD/engine"
rm -f "$TD/engine/plugins/silex-forge/scripts/gen-og-images.sh"
git -C "$TD/engine" init -q >/dev/null 2>&1 || fail "engine fixture: git init failed"
git -C "$TD/engine" config user.email "forge-test@example.com"
git -C "$TD/engine" config user.name "Forge Test"
git -C "$TD/engine" add -A
git -C "$TD/engine" -c commit.gpgsign=false commit -q -m "engine fixture"

# --------------------------------------------------------- fixture: PATH stubs
# One recording file for every mutating boundary a dry run must not cross.
REC="$TD/invocations.log"
: > "$REC"
mkdir -p "$TD/bin"
for tool in wrangler curl shlink; do
  cat > "$TD/bin/$tool" <<EOS
#!/usr/bin/env bash
printf '%s %s\n' "$tool" "\$*" >> "$REC"
exit 0
EOS
  chmod +x "$TD/bin/$tool"
done

cat > "$TD/bin/python3" <<EOS
#!/usr/bin/env bash
# Offline stand-in for publish.sh's online python boundaries only.
for a in "\$@"; do
  case "\$a" in
    *preflight_mutations*)
      echo '{"ok": true, "errors": [], "warnings": [], "checks": {"token": "stub"}, "require_kv": false}'
      exit 0
      ;;
    --fetch-remote|*fetch_pages_plain_var*|*doctor_online*)
      echo "refused: online call in dry-run test (\$a)" >&2
      exit 1
      ;;
  esac
done
exec "$PY_REAL" "\$@"
EOS
chmod +x "$TD/bin/python3"
PATH="$TD/bin:$PATH"
export PATH

# --------------------------------------------------------- fixture: config/env
cat > "$TD/forge.config.json" <<EOF
{"version": 1,
 "hub_root": "$TD/hub",
 "artifacts_dir": "artifacts",
 "site_dir": "site",
 "registry_dir": "registry",
 "internal_prefix": "a",
 "public_host": "forge.test.invalid",
 "pages_project": "dryrun-test-project",
 "forge_repo": "$TD/engine",
 "vault_markers": []}
EOF

write_env() {
  # $1 = target file, $2 = token value ("" writes a tokenless env)
  {
    if [ -n "$2" ]; then
      printf 'CLOUDFLARE_API_TOKEN=%s\n' "$2"
    fi
    printf 'CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef\n'
    printf 'FORGE_SHARES_KV_ID=deadbeefdeadbeefdeadbeefdeadbeef\n'
    printf 'CF_ACCESS_TEAM_DOMAIN=dryrun.cloudflareaccess.com\n'
    printf 'CF_ACCESS_AUD=dryrun-aud\n'
  } > "$1"
  chmod 600 "$1"
}
write_env "$TD/forge.env" "dry-run-fake-token"
write_env "$TD/forge-notoken.env" ""

export FORGE_CONFIG="$TD/forge.config.json"
export FORGE_ENV="$TD/forge.env"        # load_config's forge.env path override
export FORGE_ENV_FILE="$TD/forge.env"   # publish.sh's own reader
export FORGE_REPO="$TD/engine"
# Belt and braces: any stray urllib call lands on a dead local port, never the net.
export http_proxy="http://127.0.0.1:9" https_proxy="http://127.0.0.1:9"

mkdir -p "$TD/src"
printf '<html><head><title>Dry Run Deck</title></head><body>DRYRUN-BODY-MARKER</body></html>\n' \
  > "$TD/src/deck.html"

# ------------------------------------------------------------------- snapshots
snapshot_tree() {
  # "<path><TAB><cksum+size>" per file, "<path><TAB>DIR" per directory, sorted.
  # cksum is POSIX — md5sum does not exist on macOS. .forge-locks is publish lock
  # bookkeeping rather than hub content, so it is pruned on purpose.
  ( cd "$1" && find . -mindepth 1 -name .forge-locks -prune -o -print \
      | LC_ALL=C sort \
      | while IFS= read -r p; do
          if [ -f "$p" ]; then
            printf '%s\t%s\n' "$p" "$(cksum < "$p" | tr -d ' \t')"
          else
            printf '%s\tDIR\n' "$p"
          fi
        done )
}

assert_hub_untouched() {
  # $1 = label
  snapshot_tree "$TD/hub" > "$TD/snap.after"
  if ! diff -u "$TD/snap.before" "$TD/snap.after" > "$TD/snap.diff" 2>&1; then
    echo "--- real hub mutated ($1) ---" >&2
    cat "$TD/snap.diff" >&2
    fail "$1: the real hub was mutated by a dry run"
  fi
}

refute() {
  # $1 = pattern, $2 = file, $3 = message
  if grep -q "$1" "$2"; then
    fail "$3"
  fi
}

# ------------------------------------------------------- library-only sourcing
export FORGE_PUBLISH_LIB_ONLY=1
# shellcheck source=/dev/null
. "$PUBLISH"

# publish.sh installs its own EXIT trap when sourced — chain ours behind it, and
# surface the captured log of whatever run died (a die() inside a sourced
# function exits this shell directly).
on_exit() {
  local st=$?
  if [ "$st" -ne 0 ] && [ -n "$DUMP_ON_EXIT" ] && [ -f "$DUMP_ON_EXIT" ]; then
    echo "--- captured output ($DUMP_ON_EXIT) ---" >&2
    cat "$DUMP_ON_EXIT" >&2
  fi
  cleanup 2>/dev/null || true
  rm -rf "$TD"
}
trap on_exit EXIT

REAL_ART="$ARTIFACTS_ROOT"
case "$REAL_ART" in
  "$TD/hub/artifacts") ;;
  *) fail "fixture leak: ARTIFACTS_ROOT is '$REAL_ART', expected $TD/hub/artifacts" ;;
esac
[ "$PAGES_PROJECT" = "dryrun-test-project" ] || fail "fixture leak: PAGES_PROJECT=$PAGES_PROJECT"
[ "$PUBLIC_HOST" = "forge.test.invalid" ] || fail "fixture leak: PUBLIC_HOST=$PUBLIC_HOST"

reset_fixture_env() {
  # DRY_RUN=true is what the CLI pre-pass sets when it strips --dry-run from
  # argv; the library entry points (cmd_publish, deploy_pages) read it directly.
  DRY_RUN=true
  # enter_dry_run_sandbox re-points ARTIFACTS_ROOT and re-exports FORGE_CONFIG at
  # the sandbox; restore the real fixture before each run.
  ARTIFACTS_ROOT="$REAL_ART"
  FORGE_CONFIG="$TD/forge.config.json"
  export FORGE_CONFIG
  # publish.sh's cleanup only ever removes the *current* WORK; drop the previous
  # run's engine tree here so the test leaves nothing behind under TMPDIR.
  if [ -n "${WORK:-}" ] && [ "$WORK" != "$TD" ]; then
    rm -rf "$WORK"
  fi
  : > "$REC"
}

# =============================================================== dry-run publish
snapshot_tree "$TD/hub" > "$TD/snap.before"
[ -s "$TD/snap.before" ] || fail "fixture broken: empty hub snapshot"

reset_fixture_env
out="$TD/publish.out"
DUMP_ON_EXIT="$out"
cmd_publish dry-deck "$TD/src/deck.html" > "$out" 2>&1 \
  || { cat "$out" >&2; fail "dry-run publish exited non-zero"; }
SANDBOX_ROOT="$WORK/hub-root"
SANDBOX_ART="$SANDBOX_ROOT/artifacts"

# 1. the real hub is untouched
assert_hub_untouched "publish --dry-run"
pass "dry-run publish leaves the real hub byte-identical"

# 2. the sandbox received the writes — the chain ran, nothing was skipped
[ -d "$SANDBOX_ROOT" ] || fail "no hub sandbox at $SANDBOX_ROOT"
grep -q "dry run — hub sandboxed at $SANDBOX_ROOT" "$out" \
  || fail "sandbox notice missing or points elsewhere than $SANDBOX_ROOT"
[ -f "$SANDBOX_ART/dry-deck/index.html" ] \
  || fail "sandbox hub has no dry-deck/index.html — the hub write chain was skipped"
grep -q 'DRYRUN-BODY-MARKER' "$SANDBOX_ART/dry-deck/index.html" \
  || fail "sandbox dry-deck/index.html does not hold the new source content"
[ -f "$SANDBOX_ART/dry-deck/meta.json" ] \
  || fail "sandbox hub has no dry-deck/meta.json — write_hub_meta was skipped"
[ -f "$SANDBOX_ART/old-deck/index.html" ] \
  || fail "sandbox is not a snapshot of the hub — old-deck is missing"
[ -f "$SANDBOX_ROOT/00_COCKPIT/Forge_Catalogue.md" ] \
  || fail "hub index notes were skipped — no $SANDBOX_ROOT/00_COCKPIT/Forge_Catalogue.md"
[ -f "$WORK/repo/site/a/dry-deck/index.html" ] \
  || fail "the deploy tree was never built for dry-deck"
pass "the whole hub write chain ran, into the sandbox"

# 3. no wrangler, no curl, no shlink
[ ! -s "$REC" ] || fail "a mutating CLI ran during the dry run: $(tr '\n' ';' < "$REC")"
pass "dry-run publish invokes no wrangler / curl / shlink"

# 4. the plan carries the config's project and host
grep -q '^  project : dryrun-test-project$' "$out" \
  || fail "plan does not report the config's Pages project (expected 'project : dryrun-test-project')"
grep -q '^  host    : forge.test.invalid$' "$out" \
  || fail "plan does not report the config's public host"
grep -q 'dry run OK — nothing deployed' "$out" \
  || fail "plan does not end with the dry-run OK line"
refute 'wrangler pages deploy' "$out" "dry run announced a wrangler deploy"
grep -q 'PUBLIC_HOST' "$WORK/repo/wrangler.toml" \
  || fail "wrangler.toml was not patched locally during the dry run"
grep -q 'forge.test.invalid' "$WORK/repo/wrangler.toml" \
  || fail "wrangler.toml patch did not stamp the config host"
pass "plan reports the config's project + host, and the toml is patched offline"

# =========================================================== dry run is a gate
reset_fixture_env
gate="$TD/gate.out"
DUMP_ON_EXIT=""
if (
  trap - EXIT                       # never let a subshell die() drop $TD or $WORK
  unset CLOUDFLARE_API_TOKEN
  FORGE_ENV_FILE="$TD/forge-notoken.env"
  WORK="$TD/gatework"
  mkdir -p "$WORK/repo/site"
  cp "$TD/engine/wrangler.toml" "$WORK/repo/wrangler.toml"
  # shellcheck disable=SC2034  # read by the sourced deploy_pages, not by this file
  DRY_RUN=true
  deploy_pages
) > "$gate" 2>&1; then
  cat "$gate" >&2
  fail "dry run exited 0 with an empty CLOUDFLARE_API_TOKEN — it is a preview, not a gate"
fi
grep -q 'CLOUDFLARE_API_TOKEN' "$gate" \
  || fail "dry run failed without naming the missing CLOUDFLARE_API_TOKEN"
refute 'dry run OK' "$gate" "dry run printed its OK line despite a failed precondition"
[ ! -s "$REC" ] || fail "a mutating CLI ran on the failed-precondition path: $(tr '\n' ';' < "$REC")"
pass "empty CLOUDFLARE_API_TOKEN makes the dry run exit non-zero"

# ================================================================ --share: no KV
reset_fixture_env
share_out="$TD/share.out"
DUMP_ON_EXIT="$share_out"
cmd_publish share-deck "$TD/src/deck.html" --share > "$share_out" 2>&1 \
  || { cat "$share_out" >&2; fail "dry-run publish --share exited non-zero"; }
[ ! -s "$REC" ] \
  || fail "dry-run --share mutated something: $(tr '\n' ';' < "$REC")"
grep -q 'dry run' "$share_out" || fail "dry-run --share printed no dry-run line"
assert_hub_untouched "publish --share --dry-run"
pass "dry-run --share mints no KV entry, no HTTP call, no shortlink"

# ====================================================== --dry-run is positional
# Driven through the real CLI: argv is stripped by the pre-pass, so the flag never
# reaches the slug or cmd_publish's option loop, and DRY_RUN is on either way — a
# leaked flag either dies ("invalid slug" / "unknown option") or deploys for real
# (the wrangler stub records it).
cli_case() {
  # $1 = label, then argv for publish.sh
  local label="$1"
  shift
  reset_fixture_env
  local log="$TD/cli.out"
  DUMP_ON_EXIT="$log"
  # FORGE_PUBLISH_LIB_ONLY is exported for the library checks above — the child
  # must run the CLI dispatch, so clear it for this invocation only.
  FORGE_PUBLISH_LIB_ONLY='' "$BASH_BIN" "$PUBLISH" "$@" > "$log" 2>&1 \
    || { cat "$log" >&2; fail "CLI $label exited non-zero"; }
  refute 'unknown option' "$log" "CLI $label: --dry-run leaked into the option loop"
  refute 'invalid slug' "$log" "CLI $label: --dry-run leaked into the slug"
  grep -q 'dry run OK — nothing deployed' "$log" \
    || fail "CLI $label: no dry-run plan — the flag was not consumed"
  [ ! -s "$REC" ] || fail "CLI $label deployed for real: $(tr '\n' ';' < "$REC")"
  assert_hub_untouched "CLI $label"
}

cli_case "--dry-run before the slug"        --dry-run cli-before "$TD/src/deck.html"
cli_case "--dry-run after the slug"         cli-after "$TD/src/deck.html" --dry-run
cli_case "--dry-run before --rebuild-index" --dry-run --rebuild-index
cli_case "--dry-run after --rebuild-index"  --rebuild-index --dry-run
pass "--dry-run is consumed before or after the subcommand/slug"

# usage() must advertise the flag (operators discover the mode there)
usage_out="$TD/usage.out"
DUMP_ON_EXIT="$usage_out"
FORGE_PUBLISH_LIB_ONLY='' "$BASH_BIN" "$PUBLISH" --help > "$usage_out" 2>&1
grep -q -- '--dry-run' "$usage_out" || fail "usage() does not mention --dry-run"
pass "usage() advertises --dry-run"

DUMP_ON_EXIT=""
echo "all publish --dry-run checks passed"
