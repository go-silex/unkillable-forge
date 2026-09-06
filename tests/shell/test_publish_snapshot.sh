#!/usr/bin/env bash
# Behavioral tests for the hub drift guard and the stripped hub write-back.
#
# Why the guard exists: every deploy is a FULL snapshot of the Pages project
# built from the LOCAL hub, and that hub must be a directory shared between
# everyone who publishes to the forge, by whatever sync mechanism the operator
# chose. A local copy that is behind therefore publishes a snapshot that
# silently DELETES the artifacts other people added.
#
# Fail-closed: no record, a KV read that was denied or failed, a broken record,
# a failed live lookup, or a record anchored on another deployment all REFUSE
# unless the operator passes --allow-unverified. A proven unexpected removal
# refuses unless --allow-removals — and when the record is not anchored on what
# is live, the removal list cannot be complete, so BOTH flags are required:
# --allow-removals alone used to clear an untrusted record because the shell
# read the compare exit code and discarded the `verifiable` payload. Only a
# fresh Pages project (no live deployment, no record) bootstraps. The
# 2026-09-06 loss was the old "bootstrap when no record" path.
#
# The guard also arms what deploy_pages re-asserts immediately before the
# upload: SNAPSHOT_GUARD_PASSED, SNAPSHOT_GUARD_LIVE_ID and
# SNAPSHOT_GUARD_LIVE_UNKNOWN. The guard runs in the preflight and the upload
# happens minutes later, so a teammate deploying inside that window has to be
# caught there (the per-slug flock is kernel-local: it never serializes two
# machines). The UNKNOWN flag is what keeps that check honest: an empty live id
# means "confirmed no deployment" on one path and "could not read live" on
# another, and only the first makes a later mismatch a provable race.
#
# A denied KV read is not a stale hub: the refusal must name the denial, or the
# operator is sent to re-sync a hub that was never the problem.
#
# Isolation: FORGE_CONFIG + FORGE_ENV point into mktemp -d and no Cloudflare
# credential is exported, so the REAL `snapshot.py live-deployment` fails on
# auth_missing without ever opening a socket (offline proof below). After the
# lib-only source, kv_get_key and live_deployment_json are redefined so the
# record and live state are test-controlled — KV_GET_STATUS is then set by
# hand, exactly as the real kv_get_key would. No network, no real hub.
# bash 3.2-safe (no mapfile, no declare -A, no ${x^^}).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
PUBLISH="${FORGE_PUBLISH_SH:-$ROOT/plugins/silex-forge/scripts/publish.sh}"
SNAP="$ROOT/plugins/silex-forge/scripts/lib/snapshot.py"
BUILD="$ROOT/plugins/silex-forge/scripts/build-site-from-hub.py"

pass() { echo "  ok  $*"; }
fail() { echo "  FAIL $*" >&2; exit 1; }
note() { echo "      $*"; }

[ -f "$SNAP" ] || fail "lib/snapshot.py missing — the guard cannot exist without it"

echo "snapshot guard tests ($PUBLISH)"

TD="$(mktemp -d)"
trap 'rm -rf "$TD"' EXIT

mkdir -p "$TD/hub/artifacts/kept" "$TD/hub/artifacts/gone"
mkdir -p "$TD/work/repo/site" "$TD/work/repo/registry"
echo '<html><head><title>Kept</title></head><body>kept</body></html>' \
  > "$TD/hub/artifacts/kept/index.html"
echo '<html><head><title>Gone</title></head><body>gone</body></html>' \
  > "$TD/hub/artifacts/gone/index.html"

cat > "$TD/cfg.json" <<EOF
{"version": 1, "hub_root": "$TD/hub", "artifacts_dir": "artifacts",
 "site_dir": "site", "registry_dir": "registry", "internal_prefix": "a",
 "public_host": "forge.test.invalid", "pages_project": "forge-test-project"}
EOF
export FORGE_CONFIG="$TD/cfg.json"

# No credentials anywhere: live-deployment must fail closed on auth_missing
# rather than reach the network. An empty file, not a missing one, so the
# permission check has something to look at.
: > "$TD/forge.env"
chmod 600 "$TD/forge.env"
export FORGE_ENV="$TD/forge.env"
export FORGE_ENV_FILE="$TD/forge.env"
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL

PYQ="PYTHONPATH=$ROOT/plugins/silex-forge/scripts/lib"

# Two names for one file, on purpose: the shell reads FORGE_ENV_FILE, the Python
# lib reads FORGE_ENV (load_config.forge_env_path). Exporting only one leaves
# resolve_api_token() falling back to the operator's real ~/.config/silex/forge.env
# — which would hand this suite a production token and point
# `live-deployment` at the live silex-forge project. Assert the isolation
# instead of trusting the two exports above.
iso=$(env "$PYQ" python3 -c '
import json
from load_config import forge_env_path, resolve_api_token, resolved_account_id
print(json.dumps({
    "env_path": str(forge_env_path()),
    "has_token": bool(resolve_api_token()),
    "account": resolved_account_id(),
}))') || fail "could not probe credential isolation"
case "$iso" in
  *"$TD/forge.env"*) ;;
  *) fail "FORGE_ENV not isolated — the python lib would read a real forge.env: $iso" ;;
esac
case "$iso" in
  *'"has_token": true'*) fail "a real Cloudflare token leaked into this suite: aborting before any API call" ;;
esac
case "$iso" in
  *'"account": ""'*) ;;
  *) fail "a real Cloudflare account id leaked into this suite: $iso" ;;
esac
pass "credentials isolated (FORGE_ENV + FORGE_ENV_FILE in the temp dir, no token, no account)"

# --- offline precondition ----------------------------------------------------
live=$(env "$PYQ" python3 "$SNAP" live-deployment) \
  || fail "live-deployment must exit 0 even when it cannot resolve the deployment"
# auth_missing, specifically: that is the code path that returns BEFORE _cf_api,
# i.e. the proof this suite opens no socket. An api_error here would mean a
# credential leaked in and the request actually left the machine.
case "$live" in
  *'"error_kind": "auth_missing"'*|*'"error_kind":"auth_missing"'*) ;;
  *) fail "live-deployment must short-circuit on auth_missing (no socket), got: $live" ;;
esac
pass "live-deployment fails closed offline (exit 0, ok:false) — no socket, no crash"

# The record is generated by the real `record` subcommand, so the digests are
# whatever snapshot.py actually computes. Hand-written fixtures would pin a hash
# algorithm instead of the behaviour.
RECORD="$TD/record.json"
env "$PYQ" python3 "$SNAP" record \
  --deployment-id "dep-live-1" \
  --engine-commit "abc1234" \
  --by "tester@example.invalid" > "$RECORD" \
  || fail "record subcommand failed"
grep -q '"kept"' "$RECORD" || fail "record does not contain the kept slug"
grep -q '"gone"' "$RECORD" || fail "record does not contain the gone slug"
pass "record captures both hub slugs"

# --- load publish.sh as a library -------------------------------------------
export FORGE_PUBLISH_LIB_ONLY=1
# shellcheck source=/dev/null
. "$PUBLISH"
# publish.sh installs its own `trap cleanup EXIT`, replacing ours and leaking $TD.
trap 'rm -rf "$TD"' EXIT

WORK="$TD/work"
ARTIFACTS_ROOT="$TD/hub/artifacts"
INTERNAL_PREFIX="a"
DRY_RUN=false

# Test-controlled KV: $KV_RECORD is the value snapshot_guard reads, and
# $KV_GET_STATUS is the classification the real kv_get_key would have set
# (ok | miss | denied | error). Default: a plain miss, i.e. today's behaviour.
KV_RECORD=""
KV_GET_STATUS="miss"
kv_get_key() {
  [ -n "$KV_RECORD" ] || return 1
  cat "$KV_RECORD"
}

# Test-controlled live state. Default: a trusted live deployment matching the
# record fixture, so case 2 still proves "a matching hub deploys".
LIVE_JSON='{"ok":true,"deployment_id":"dep-live-1","engine_commit":"abc1234"}'
live_deployment_json() {
  printf '%s\n' "$LIVE_JSON"
  return 0
}

guard() {
  # snapshot_guard calls die on refusal, which exits — run it in a subshell so
  # this suite survives and can assert on the exit status.
  ( snapshot_guard ) 2>"$TD/guard.err"
}

guard_direct() {
  # snapshot_guard in THIS shell: SNAPSHOT_GUARD_PASSED / _LIVE_ID /
  # _LIVE_UNKNOWN are globals and the subshell in guard() would discard them.
  # Only for paths that return 0 — a die() here exits the suite. The pre-set
  # values are deliberately wrong so an assertion cannot pass on a leftover
  # from an earlier case.
  SNAPSHOT_GUARD_PASSED=false
  SNAPSHOT_GUARD_LIVE_ID="never-set"
  SNAPSHOT_GUARD_LIVE_UNKNOWN="never-set"
  snapshot_guard 2>"$TD/guard.err"
}

guard_err() { cat "$TD/guard.err"; }

# --- 1. no record: refuse (live content exists) ------------------------------
KV_RECORD=""
ALLOW_UNVERIFIED=false
ALLOW_REMOVALS=false
DRY_RUN=false
if guard; then
  guard_err
  fail "no KV record with a live deployment must refuse"
fi
grep -q -- "--allow-unverified" "$TD/guard.err" \
  || { guard_err; fail "refusal must name --allow-unverified"; }
ALLOW_UNVERIFIED=true
guard || { guard_err; fail "--allow-unverified must let a missing record through"; }
grep -q "allow-unverified" "$TD/guard.err" \
  || { guard_err; fail "the override must still warn"; }
ALLOW_UNVERIFIED=false
pass "no KV record -> refuses; --allow-unverified proceeds with a warning"

# --- 2. hub matches the record: proceed silently -----------------------------
KV_RECORD="$RECORD"
LIVE_JSON='{"ok":true,"deployment_id":"dep-live-1","engine_commit":"abc1234"}'
guard || { guard_err; fail "a hub matching the record must deploy"; }
if grep -q "hub drift —" "$TD/guard.err"; then
  guard_err
  fail "a matching hub must not be reported as drift"
fi
pass "hub matching the record deploys"

# --- 3. a slug missing locally is refused ------------------------------------
rm -rf "$TD/hub/artifacts/gone"
EXPECTED_REMOVALS=""
ALLOW_REMOVALS=false
if guard; then
  guard_err
  fail "a snapshot that removes a live artifact must be refused"
fi
grep -q "gone" "$TD/guard.err" \
  || { guard_err; fail "the refusal must name the artifact it would delete"; }
note "refusal message: $(grep -m1 'hub drift' "$TD/guard.err" || true)"
pass "unexpected removal is refused (stale hub cannot delete a teammate's artifact)"

# --- 4. --allow-removals overrides -------------------------------------------
ALLOW_REMOVALS=true
guard || { guard_err; fail "--allow-removals must let the deploy through"; }
grep -q "allow-removals" "$TD/guard.err" \
  || { guard_err; fail "the override must still warn"; }
pass "--allow-removals proceeds, with a warning"

# --- 5. a removal the command performs by design is accepted -----------------
ALLOW_REMOVALS=false
EXPECTED_REMOVALS="gone"
guard || { guard_err; fail "a declared removal (cmd_remove) must not be refused"; }
pass "EXPECTED_REMOVALS lets --remove through without --allow-removals"

# cmd_remove is the only command that declares one; assert it actually does,
# rather than trusting the comment.
grep -q 'EXPECTED_REMOVALS="\$slug"' "$PUBLISH" \
  || fail "cmd_remove no longer declares its expected removal"
pass "cmd_remove declares its slug as an expected removal"

# --- 6. an unusable record refuses ------------------------------------------
EXPECTED_REMOVALS=""
ALLOW_UNVERIFIED=false
echo 'not json at all' > "$TD/broken.json"
KV_RECORD="$TD/broken.json"
if guard; then
  guard_err
  fail "an unparseable record must refuse"
fi
grep -q -- "--allow-unverified" "$TD/guard.err" \
  || { guard_err; fail "broken-record refusal must name --allow-unverified"; }
ALLOW_UNVERIFIED=true
guard || { guard_err; fail "--allow-unverified must let a broken record through"; }
grep -q "allow-unverified" "$TD/guard.err" \
  || { guard_err; fail "broken-record override must still warn"; }
ALLOW_UNVERIFIED=false
pass "unparseable record -> refuses; --allow-unverified proceeds with a warning"

# Restore the slug removed in case 3 so later unverifiable cases are not
# masked by a proven removal (exit 3 outranks exit 4).
mkdir -p "$TD/hub/artifacts/gone"
echo '<html><head><title>Gone</title></head><body>gone</body></html>' \
  > "$TD/hub/artifacts/gone/index.html"

# --- 6b. live lookup failing with a valid record refuses ---------------------
KV_RECORD="$RECORD"
LIVE_JSON='{"ok":false,"reason":"api_error"}'
if guard; then
  guard_err
  fail "a failed live lookup must refuse even with a valid record"
fi
grep -q -- "--allow-unverified" "$TD/guard.err" \
  || { guard_err; fail "live-lookup refusal must name --allow-unverified"; }
pass "live lookup ok:false with valid record refuses"

# --- 6c. fresh project (no live deployment, no record) bootstraps -----------
# The real payload, and the only one: live_deployment() never emits ok:true
# with an empty deployment id. A Pages project whose deployment list is
# confirmed empty returns ok:false, error_kind=no_deployment. Treating that as
# a failed lookup would refuse the first publish of a new forge.
KV_RECORD=""
LIVE_JSON='{"ok":false,"error_kind":"no_deployment","error":"Pages project forge-test-project has no deployment yet"}'
guard || { guard_err; fail "error_kind=no_deployment must bootstrap, not refuse as unverified"; }
pass "fresh project (real no_deployment payload, no record) proceeds"

# --- 6d. DRY_RUN turns unverified refusal into a warning ---------------------
KV_RECORD=""
LIVE_JSON='{"ok":true,"deployment_id":"dep-live-1","engine_commit":"abc1234"}'
DRY_RUN=true
ALLOW_UNVERIFIED=false
guard || { guard_err; fail "DRY_RUN must not hard-refuse an unverified deploy"; }
grep -q "would refuse" "$TD/guard.err" \
  || { guard_err; fail "DRY_RUN unverified path must warn with 'would refuse'"; }
pass "DRY_RUN + unverified -> would refuse warning, proceeds"

# --- 6e. DRY_RUN + proven removal still refuses ------------------------------
KV_RECORD="$RECORD"
LIVE_JSON='{"ok":true,"deployment_id":"dep-live-1","engine_commit":"abc1234"}'
rm -rf "$TD/hub/artifacts/gone"
DRY_RUN=true
ALLOW_REMOVALS=false
if guard; then
  guard_err
  fail "DRY_RUN must still refuse a proven unexpected removal"
fi
grep -q "gone" "$TD/guard.err" \
  || { guard_err; fail "DRY_RUN removal refusal must still name the slug"; }
DRY_RUN=false
pass "DRY_RUN + proven removal still refuses"

# --- 6f. an untrusted record needs BOTH flags to remove ----------------------
# A proven removal (exit 3) outranks an unverifiable state (exit 4), so a
# record anchored on another deployment lands in the removals branch. Reading
# only that exit code let --allow-removals clear the unanchored record: the
# strictly MORE dangerous state took the WEAKER flag. It is more dangerous
# because the removal list is differenced against the record, so live slugs a
# stale record never listed are invisible to it — the full-snapshot deploy
# deletes them without ever naming them.
KV_RECORD="$RECORD"
LIVE_JSON='{"ok":true,"deployment_id":"dep-live-2","engine_commit":"abc1234"}'
rm -rf "$TD/hub/artifacts/gone"
DRY_RUN=false
ALLOW_UNVERIFIED=false
ALLOW_REMOVALS=true
if guard; then
  guard_err
  fail "--allow-removals alone must not clear a record that is not anchored on the live deployment"
fi
grep -q "hub drift" "$TD/guard.err" \
  || { guard_err; fail "the refusal must keep the hub drift prefix"; }
grep -q -- "--allow-unverified" "$TD/guard.err" \
  || { guard_err; fail "the refusal must name --allow-unverified as required in addition"; }
grep -q "cannot be trusted" "$TD/guard.err" \
  || { guard_err; fail "the refusal must say the removal list cannot be trusted"; }
pass "untrusted record + proven removal + --allow-removals only -> refuses"

ALLOW_UNVERIFIED=true
guard || { guard_err; fail "--allow-removals with --allow-unverified must let the removal through"; }
grep -q -- "--allow-removals was passed" "$TD/guard.err" \
  || { guard_err; fail "the double override must still warn about the removal"; }
grep -q "unanchored record" "$TD/guard.err" \
  || { guard_err; fail "the double override must say the record is unanchored, not just that artifacts are removed"; }
ALLOW_UNVERIFIED=false
ALLOW_REMOVALS=false
pass "untrusted record + both flags -> proceeds, naming the unanchored record"

# --- 6g. a verifiable record still takes --allow-removals alone --------------
KV_RECORD="$RECORD"
LIVE_JSON='{"ok":true,"deployment_id":"dep-live-1","engine_commit":"abc1234"}'
ALLOW_REMOVALS=true
guard || { guard_err; fail "a verifiable record must still proceed on --allow-removals alone"; }
grep -q -- "--allow-removals was passed" "$TD/guard.err" \
  || { guard_err; fail "the override must still warn"; }
if grep -q "unanchored record" "$TD/guard.err"; then
  guard_err
  fail "a record anchored on the live deployment must not be reported as unanchored"
fi
ALLOW_REMOVALS=false
pass "verifiable record + removal + --allow-removals -> proceeds (no regression)"

mkdir -p "$TD/hub/artifacts/gone"
echo '<html><head><title>Gone</title></head><body>gone</body></html>' \
  > "$TD/hub/artifacts/gone/index.html"

# --- 6h. a denied KV read is not a stale hub ---------------------------------
# kv_get_key collapsed 403 into the same failure as 404, so a token without
# Workers KV read produced "no record" — and the refusal told the operator to
# re-sync a hub that was never the problem, on every publish, forever.
KV_RECORD=""
LIVE_JSON='{"ok":true,"deployment_id":"dep-live-1","engine_commit":"abc1234"}'
KV_GET_STATUS="denied"
if guard; then
  guard_err
  fail "a denied KV read with live content must still refuse"
fi
grep -q "read denied" "$TD/guard.err" \
  || { guard_err; fail "the refusal must name the denied KV read"; }
grep -q "Workers KV" "$TD/guard.err" \
  || { guard_err; fail "the refusal must name the missing Workers KV read scope"; }
pass "denied KV read -> refusal names the denial, not a stale hub"

KV_GET_STATUS="error"
if guard; then guard_err; fail "a failed KV read must refuse"; fi
grep -q "read failed" "$TD/guard.err" \
  || { guard_err; fail "a failed KV read must be named as such" ; }
pass "failed KV read -> refusal names the read failure"

# An unset status is what every caller that replaces kv_get_key produces; it
# must keep meaning "no record", never fail closed with a KV story.
KV_GET_STATUS=""
if guard; then guard_err; fail "an empty record must still refuse when live content exists"; fi
if grep -q "KV record read" "$TD/guard.err"; then
  guard_err
  fail "an unset KV_GET_STATUS was reported as a KV read failure"
fi
KV_GET_STATUS="miss"
pass "unset KV_GET_STATUS behaves exactly as a miss"

# --- 6i. the guard arms what deploy_pages re-asserts before the upload -------
# The guard runs in the preflight and the upload happens minutes later, so
# deploy_pages re-checks these three before wrangler. Every path that lets the
# deploy proceed must set them, or the deploy dies as an internal error.
#
# SNAPSHOT_GUARD_LIVE_UNKNOWN is not redundant with an empty live id: an id is
# also empty for a project whose deployment list is confirmed empty, and there
# the pre-upload compare is a REAL race check (live gaining a deployment means
# a teammate deployed). Collapsing the two made the re-assert refuse an
# --allow-unverified publish with a fabricated "someone else deployed".
KV_RECORD="$RECORD"
LIVE_JSON='{"ok":true,"deployment_id":"dep-live-1","engine_commit":"abc1234"}'
ALLOW_REMOVALS=false
ALLOW_UNVERIFIED=false
DRY_RUN=false
guard_direct || { guard_err; fail "a matching hub must deploy"; }
[ "$SNAPSHOT_GUARD_PASSED" = true ] \
  || { guard_err; fail "a clean pass did not arm SNAPSHOT_GUARD_PASSED"; }
[ "$SNAPSHOT_GUARD_LIVE_ID" = "dep-live-1" ] \
  || { guard_err; fail "clean pass recorded live id '$SNAPSHOT_GUARD_LIVE_ID', expected dep-live-1"; }
[ "$SNAPSHOT_GUARD_LIVE_UNKNOWN" = false ] \
  || { guard_err; fail "a clean pass against a resolvable deployment armed LIVE_UNKNOWN='$SNAPSHOT_GUARD_LIVE_UNKNOWN', expected false"; }
pass "clean pass arms SNAPSHOT_GUARD_PASSED + the live id it checked"

LIVE_JSON='{"ok":true,"deployment_id":"dep-live-9","engine_commit":"abc1234"}'
ALLOW_UNVERIFIED=true
guard_direct || { guard_err; fail "--allow-unverified must proceed on an untrusted record"; }
[ "$SNAPSHOT_GUARD_PASSED" = true ] \
  || { guard_err; fail "an override did not arm SNAPSHOT_GUARD_PASSED"; }
[ "$SNAPSHOT_GUARD_LIVE_ID" = "dep-live-9" ] \
  || { guard_err; fail "override recorded live id '$SNAPSHOT_GUARD_LIVE_ID', expected dep-live-9"; }
[ "$SNAPSHOT_GUARD_LIVE_UNKNOWN" = false ] \
  || { guard_err; fail "an override granted against a KNOWN live id armed LIVE_UNKNOWN='$SNAPSHOT_GUARD_LIVE_UNKNOWN', expected false"; }
ALLOW_UNVERIFIED=false
pass "--allow-unverified arms the sentinels with the id the override was granted against"

KV_RECORD=""
LIVE_JSON='{"ok":true,"deployment_id":"dep-live-1","engine_commit":"abc1234"}'
DRY_RUN=true
guard_direct || { guard_err; fail "the dry-run downgrade must proceed"; }
grep -q "would refuse" "$TD/guard.err" \
  || { guard_err; fail "the dry-run downgrade must still warn"; }
[ "$SNAPSHOT_GUARD_PASSED" = true ] \
  || { guard_err; fail "the dry-run downgrade did not arm SNAPSHOT_GUARD_PASSED"; }
[ "$SNAPSHOT_GUARD_LIVE_ID" = "dep-live-1" ] \
  || { guard_err; fail "dry-run downgrade recorded live id '$SNAPSHOT_GUARD_LIVE_ID'"; }
[ "$SNAPSHOT_GUARD_LIVE_UNKNOWN" = false ] \
  || { guard_err; fail "dry-run downgrade armed LIVE_UNKNOWN='$SNAPSHOT_GUARD_LIVE_UNKNOWN' against a resolvable deployment"; }
DRY_RUN=false
pass "dry-run downgrade arms the sentinels too"

# A live lookup that FAILED is the case the id alone cannot express: the guard
# proceeds on --allow-unverified with no id at all, and the pre-upload
# re-assert must know that it never observed live rather than read the empty
# id as "the project had no deployment".
KV_RECORD="$RECORD"
LIVE_JSON='{"ok":false,"reason":"api_error"}'
ALLOW_UNVERIFIED=true
guard_direct || { guard_err; fail "--allow-unverified must proceed when the live lookup failed"; }
[ "$SNAPSHOT_GUARD_PASSED" = true ] \
  || { guard_err; fail "the failed-lookup override did not arm SNAPSHOT_GUARD_PASSED"; }
[ -z "$SNAPSHOT_GUARD_LIVE_ID" ] \
  || { guard_err; fail "a failed live lookup must claim no live id, got '$SNAPSHOT_GUARD_LIVE_ID'"; }
[ "$SNAPSHOT_GUARD_LIVE_UNKNOWN" = true ] \
  || { guard_err; fail "a failed live lookup armed LIVE_UNKNOWN='$SNAPSHOT_GUARD_LIVE_UNKNOWN', expected true"; }
ALLOW_UNVERIFIED=false
pass "failed live lookup + --allow-unverified arms LIVE_UNKNOWN=true (no id to compare)"

# The other empty id, and the row that must NOT become "unknown": the real
# no_deployment payload is a confirmed-empty deployment list, i.e. an
# observation. A later non-empty live state is a teammate's deploy and the
# pre-upload re-assert has to keep refusing it.
KV_RECORD=""
LIVE_JSON='{"ok":false,"error_kind":"no_deployment","error":"Pages project forge-test-project has no deployment yet"}'
guard_direct || { guard_err; fail "the real no_deployment payload must bootstrap"; }
[ "$SNAPSHOT_GUARD_PASSED" = true ] \
  || { guard_err; fail "the bootstrap path did not arm SNAPSHOT_GUARD_PASSED"; }
[ -z "$SNAPSHOT_GUARD_LIVE_ID" ] \
  || { guard_err; fail "a confirmed-empty project must claim no live id, got '$SNAPSHOT_GUARD_LIVE_ID'"; }
[ "$SNAPSHOT_GUARD_LIVE_UNKNOWN" = false ] \
  || { guard_err; fail "confirmed-empty live armed LIVE_UNKNOWN='$SNAPSHOT_GUARD_LIVE_UNKNOWN' — a verified-empty project is an observation, not an unknown"; }
pass "confirmed-empty live (no_deployment) arms LIVE_UNKNOWN=false — the race check stays armed"

KV_RECORD="$RECORD"
LIVE_JSON='{"ok":true,"deployment_id":"dep-live-1","engine_commit":"abc1234"}'

# --- 6j. a skipped guard must not look like a clean pass ---------------------
SAVED_ART="$ARTIFACTS_ROOT"
ARTIFACTS_ROOT=""
guard_direct || { guard_err; fail "an unresolved artifacts root must not fail the publish here"; }
grep -q "guard skipped" "$TD/guard.err" \
  || { guard_err; fail "a skipped guard must say so — silence is indistinguishable from a clean pass"; }
grep -q "artifacts root" "$TD/guard.err" \
  || { guard_err; fail "the skip must name the unresolved artifacts root"; }
[ "$SNAPSHOT_GUARD_PASSED" = true ] \
  || { guard_err; fail "the skipped path must still arm the sentinel, or every deploy dies as an internal error"; }
[ -z "$SNAPSHOT_GUARD_LIVE_ID" ] \
  || { guard_err; fail "a skipped guard must not claim a live id, got '$SNAPSHOT_GUARD_LIVE_ID'"; }
[ "$SNAPSHOT_GUARD_LIVE_UNKNOWN" = true ] \
  || { guard_err; fail "a skipped guard armed LIVE_UNKNOWN='$SNAPSHOT_GUARD_LIVE_UNKNOWN' — it never looked at live, so it must be unknown, not known-empty"; }
ARTIFACTS_ROOT="$SAVED_ART"
pass "guard skipped (artifacts root unresolved) warns and claims no live id"

# --- 6k. --reanchor-snapshot: the recovery that keeps the baseline -----------
# snapshot_record is best-effort, so one refused KV write after a successful
# deploy leaves the record anchored on the PREVIOUS deployment while live has
# moved on — which the guard reads as untrusted. The only sanctioned exit used
# to be --allow-unverified, i.e. rebuilding the record from this machine's
# possibly-stale hub: byte for byte the 2026-09-06 loss. Re-anchoring must move
# the anchor and nothing else, and must never invent a record.
REANCHOR_DIR="$TD/reanchor"
mkdir -p "$REANCHOR_DIR"
STALE_RECORD='{"deployment_id":"dep-OLD","engine_commit":"eng-old","by":"teammate@example.invalid","at":"2026-01-01T00:00:00Z","slugs":{"kept":"h-kept","teammate-only":"h-teammate"}}'
reanchor_case() {
  # $1 = DRY_RUN, $2 = the live-deployment payload. A subshell: it redefines
  # the KV and live stubs the rest of this file relies on, and
  # cmd_reanchor_snapshot dies (exits) on every refusal.
  RE_LIVE="$2"
  rm -f "$REANCHOR_DIR/written.json"
  (
    require_forge_config() { :; }
    preflight_cf_mutations() { :; }
    source_cf_credentials() { :; }
    kv_get_key() { [ -s "$REANCHOR_DIR/record.json" ] || return 1; cat "$REANCHOR_DIR/record.json"; }
    kv_put_value() { printf '%s' "$2" > "$REANCHOR_DIR/written.json"; }
    live_deployment_json() { printf '%s\n' "$RE_LIVE"; }
    DRY_RUN="$1"
    cmd_reanchor_snapshot
  ) > "$REANCHOR_DIR/out" 2>&1
}
reanchor_out() { cat "$REANCHOR_DIR/out"; }

printf '%s' "$STALE_RECORD" > "$REANCHOR_DIR/record.json"
reanchor_case true '{"ok":true,"deployment_id":"dep-NEW","engine_commit":"eng-new"}' \
  || { reanchor_out; fail "--reanchor-snapshot --dry-run must not fail"; }
[ ! -f "$REANCHOR_DIR/written.json" ] \
  || { reanchor_out; fail "--reanchor-snapshot --dry-run wrote to KV"; }
grep -q "dep-OLD" "$REANCHOR_DIR/out" \
  || { reanchor_out; fail "the dry run must name the anchor it would leave"; }
grep -q "dep-NEW" "$REANCHOR_DIR/out" \
  || { reanchor_out; fail "the dry run must name the anchor it would write"; }
pass "--reanchor-snapshot --dry-run prints the anchor change and mutates nothing"

reanchor_case false '{"ok":true,"deployment_id":"dep-NEW","engine_commit":"eng-new"}' \
  || { reanchor_out; fail "--reanchor-snapshot must re-anchor a stale record"; }
[ -f "$REANCHOR_DIR/written.json" ] \
  || { reanchor_out; fail "--reanchor-snapshot wrote no record to KV"; }
python3 - "$REANCHOR_DIR/written.json" <<'PY' || fail "the re-anchored record is not the old record with a new anchor"
import json, sys
d = json.load(open(sys.argv[1]))
assert d["deployment_id"] == "dep-NEW", d
assert sorted(d["slugs"]) == ["kept", "teammate-only"], d
assert d["slugs"]["teammate-only"] == "h-teammate", d
assert d["by"] == "teammate@example.invalid", d
assert d["engine_commit"] == "eng-old", d
assert d["at"] != "2026-01-01T00:00:00Z", d
PY
pass "--reanchor-snapshot moves only the anchor (slug set, author, engine commit survive)"

if reanchor_case false '{"ok":false,"reason":"api_error"}'; then
  reanchor_out
  fail "a failed live lookup must not re-anchor the record on a guessed deployment"
fi
[ ! -f "$REANCHOR_DIR/written.json" ] \
  || { reanchor_out; fail "KV was written despite a failed live lookup"; }
pass "--reanchor-snapshot refuses when the live deployment is unknown"

: > "$REANCHOR_DIR/record.json"
if reanchor_case false '{"ok":true,"deployment_id":"dep-NEW","engine_commit":"eng-new"}'; then
  reanchor_out
  fail "an absent record must not be re-anchored — an invented slug set authorises a full wipe"
fi
grep -q "nothing to re-anchor" "$REANCHOR_DIR/out" \
  || { reanchor_out; fail "the refusal must say there is nothing to re-anchor"; }
[ ! -f "$REANCHOR_DIR/written.json" ] \
  || { reanchor_out; fail "KV was written although there was no record to re-anchor"; }
pass "--reanchor-snapshot with no record refuses instead of inventing one"

grep -q -- '--reanchor-snapshot) cmd_reanchor_snapshot' "$PUBLISH" \
  || fail "--reanchor-snapshot is not wired into the command dispatch"
pass "--reanchor-snapshot is reachable from the CLI"

# Restore a trusted live default for the write-back half.
LIVE_JSON='{"ok":true,"deployment_id":"dep-live-1","engine_commit":"abc1234"}'
KV_RECORD="$RECORD"

# --- 7. the guard runs before any mutation -----------------------------------
# cmd_remove clears KV and rm -rf's the hub artifact before it ever reaches
# deploy_pages, so the guard has to sit in the preflight. If it drifts back into
# deploy_pages it would abort after the destruction it exists to prevent.
awk '/^preflight_before_live\(\)/,/^}/' "$PUBLISH" | grep -q 'snapshot_guard' \
  || fail "snapshot_guard must be called from preflight_before_live, before any mutation"
pass "guard is wired into preflight_before_live (pre-mutation)"

# --- 8. hub write-back keeps the share bar out of the hub --------------------
# The bar is deploy-tree only. Persisting it made it craft input for the next
# build; combined with a non-exact strip/inject inverse, every artifact changed
# content hash on every publish and Cloudflare re-uploaded all of it.
mkdir -p "$TD/hub/artifacts/wb"
printf '%s\n' '<html><head><title>WB</title></head><body>wb</body></html>' \
  > "$TD/hub/artifacts/wb/index.html"
HUB_ORIG="$(cat "$TD/hub/artifacts/wb/index.html")"

python3 "$BUILD" --repo-root "$WORK/repo" >/dev/null 2>&1 \
  || fail "build_from_hub failed for the write-back case"
DEST="$WORK/repo/site/a/wb/index.html"
[ -f "$DEST" ] || fail "build produced no deploy-tree index.html for wb"
grep -qF '<!-- forge-share-bar -->' "$DEST" \
  || fail "build did not inject the share bar into the deploy tree"

PUBLIC_HOST="forge.test.invalid"
inject_og_for_slug wb "WB title" "WB desc" "/a/wb/" \
  || fail "inject_og_for_slug failed"

grep -qF '<!-- forge-share-bar -->' "$DEST" \
  || fail "the deploy tree lost its share bar — the live page would have no toolbar"
pass "deploy tree keeps the share bar"

HUB_AFTER="$TD/hub/artifacts/wb/index.html"
if grep -qF 'forge-share-bar' "$HUB_AFTER"; then
  fail "the share bar was written back into the hub SSOT"
fi
pass "hub write-back is bar-free"

grep -q 'og:title' "$HUB_AFTER" \
  || fail "the OG meta did not reach the hub — inject-og would re-run every publish"
pass "hub write-back still carries the OG meta (the reason the copy exists)"

# The bar-stripped write-back must be byte-stable: a second identical publish
# cycle must not change the hub file, or the content hash churns again.
cp -f "$HUB_AFTER" "$TD/wb-first.html"
python3 "$BUILD" --repo-root "$WORK/repo" >/dev/null 2>&1 \
  || fail "second build failed"
inject_og_for_slug wb "WB title" "WB desc" "/a/wb/" \
  || fail "second inject_og_for_slug failed"
cmp -s "$TD/wb-first.html" "$HUB_AFTER" \
  || fail "the hub file changed on an identical second cycle — hash churn is back"
pass "identical second cycle leaves the hub file byte-identical"

note "hub original was $(printf '%s' "$HUB_ORIG" | wc -c | tr -d '[:space:]') bytes"

# --- 9. an engine clone that cannot strip must degrade, not die --------------
# share_bar_script resolves the CLONE first, on purpose: the bytes injected into
# the deploy tree must come from the engine being deployed. The strip therefore
# has to come from that same script — substituting the local plugin could strip
# differently from how the clone injected, which is the cross-version drift this
# change removes. So when the clone predates --strip there are only two honest
# options, and only one of them is acceptable:
#   die                -> an old clone becomes a publish outage
#   write barred HTML  -> re-creates the churn bug
#   skip the write-back-> hub keeps its content, inject-og re-runs next publish
# This asserts the third. Found the hard way: a real --dry-run against a clone
# of HEAD died here, because HEAD did not yet carry --strip.
# A full copy of the real scripts, with ONLY inject-share-bar.py swapped for a
# stub that rejects --strip — i.e. exactly an engine clone predating the flag.
SAVED_WORK="$WORK"
WORK_STRIPLESS="$TD/work-stripless"
STRIPLESS="$WORK_STRIPLESS/repo/plugins/silex-forge/scripts"
mkdir -p "$STRIPLESS" "$WORK_STRIPLESS/repo/site"
cp -a "$ROOT/plugins/silex-forge/scripts/." "$STRIPLESS/"
cp -a "$SAVED_WORK/repo/site/." "$WORK_STRIPLESS/repo/site/"
cat > "$STRIPLESS/inject-share-bar.py" <<'PY'
import sys

if "--strip" in sys.argv:
    sys.stderr.write("error: unrecognized arguments: --strip\n")
    raise SystemExit(2)
raise SystemExit(0)
PY

cp -f "$HUB_AFTER" "$TD/wb-before-stripless.html"
WORK="$WORK_STRIPLESS"
set +e
out_stripless=$(inject_og_for_slug wb "WB title" "WB desc" "/a/wb/" 2>&1)
rc_stripless=$?
set -e
WORK="$SAVED_WORK"

[ "$rc_stripless" -eq 0 ] \
  || fail "a clone without --strip must not fail the publish (exit $rc_stripless): $out_stripless"
case "$out_stripless" in
  *"predates inject-share-bar --strip"*) ;;
  *) fail "an old clone must be named as such, got: $out_stripless" ;;
esac
cmp -s "$TD/wb-before-stripless.html" "$HUB_AFTER" \
  || fail "the hub file was modified by a strip-less engine — barred HTML may have landed in the hub"
if grep -qF 'forge-share-bar' "$HUB_AFTER"; then
  fail "a strip-less engine wrote a barred HTML into the hub"
fi
pass "strip-less engine clone: named precisely, write-back skipped, hub untouched"

# --- 10. a strip that fails for another reason must not blame the clone ------
# The diagnosis has to separate "unknown flag" (argparse exit 2 — really an old
# engine) from every other fault. Attributing a crash to a stale clone sends the
# operator to update a checkout that is already current.
cat > "$STRIPLESS/inject-share-bar.py" <<'PY'
import sys

sys.stderr.write("Traceback (most recent call last):\nRuntimeError: boom\n")
raise SystemExit(1)
PY
cp -f "$HUB_AFTER" "$TD/wb-before-crash.html"
WORK="$WORK_STRIPLESS"
set +e
out_crash=$(inject_og_for_slug wb "WB title" "WB desc" "/a/wb/" 2>&1)
rc_crash=$?
set -e
WORK="$SAVED_WORK"

[ "$rc_crash" -eq 0 ] \
  || fail "a crashing strip must not fail the publish (exit $rc_crash): $out_crash"
case "$out_crash" in
  *"predates"*) fail "a crashing strip was misreported as an old clone: $out_crash" ;;
  *"strip failed for wb (exit 1)"*) ;;
  *) fail "a crashing strip must name its exit code and cause, got: $out_crash" ;;
esac
cmp -s "$TD/wb-before-crash.html" "$HUB_AFTER" \
  || fail "a crashing strip still modified the hub file"
pass "a strip failing for another reason names the real cause, not the clone"

# --- 11. share_bar_script contract: fallback, then a die that propagates -----
# The end-to-end "script missing" path is unreachable, and that is worth
# pinning: removing it from the clone makes share_bar_script fall back to
# $SCRIPT_DIR, which is where publish.sh itself lives. What must still hold is
# the shape of the failure when BOTH are absent. Inline
# `python3 "$(share_bar_script)"` would have hidden it: die() inside `$(...)`
# exits only the subshell, so python3 would run with an empty path and exit 2 —
# the code reserved for argparse rejecting an unknown flag, i.e. reported as a
# stale clone. The path is resolved into a variable first.
rm -f "$STRIPLESS/inject-share-bar.py"
SAVED_SCRIPT_DIR="$SCRIPT_DIR"

WORK="$WORK_STRIPLESS"
fallback=$(share_bar_script) \
  || fail "share_bar_script must fall back to \$SCRIPT_DIR when the clone lacks the script"
[ "$fallback" = "$SAVED_SCRIPT_DIR/inject-share-bar.py" ] \
  || fail "fallback resolved to '$fallback', expected \$SCRIPT_DIR's copy"
pass "share_bar_script falls back to \$SCRIPT_DIR (why the e2e missing case cannot occur)"

mkdir -p "$TD/empty-scripts"
set +e
out_none=$( SCRIPT_DIR="$TD/empty-scripts"; share_bar_script 2>&1 )
rc_none=$?
set -e
WORK="$SAVED_WORK"
SCRIPT_DIR="$SAVED_SCRIPT_DIR"

[ "$rc_none" -ne 0 ] \
  || fail "share_bar_script must fail when neither the clone nor SCRIPT_DIR has the script (got '$out_none')"
case "$out_none" in
  *"inject-share-bar.py missing"*) ;;
  *) fail "the failure must name the missing script, got: $out_none" ;;
esac
case "$out_none" in
  *"predates"*) fail "a missing script was described as a stale clone: $out_none" ;;
esac
pass "share_bar_script fails by naming the missing script, never the clone"

echo "all snapshot guard checks passed"
