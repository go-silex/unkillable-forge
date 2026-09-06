#!/usr/bin/env bash
# publish.sh — hub SSOT → build site → wrangler pages deploy (Direct Upload)
#
#   publish.sh <slug> [path] [options]
#   publish.sh --share <slug>
#   publish.sh --unshare <slug>
#   publish.sh --list | --remove <slug> | --rebuild-index
#
# Architecture (roxabi-forge shape):
#   SSOT     = $hub/$artifacts_dir/<slug>/  (shared silex-hub, outside git)
#   engine   = git main (plugins, functions, site skeleton) — never the HTML
#   deploy   = wrangler pages deploy site  (token ~/.config/silex/forge.env)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"

_ENV_FORGE_REPO="${FORGE_REPO-}"
_ENV_SHLINK_DOMAIN="${SHLINK_DOMAIN-}"

if [ -f "$LIB_DIR/load_config.py" ] && command -v python3 >/dev/null 2>&1; then
  # shellcheck disable=SC1090
  eval "$(PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 -c 'from load_config import export_env; print(export_env())')"
fi

FORGE_REPO="${_ENV_FORGE_REPO:-${FORGE_REPO:-https://github.com/go-silex/silex-forge.git}}"
SHLINK_DOMAIN="${_ENV_SHLINK_DOMAIN:-${FORGE_SHLINK_DOMAIN:-${SHLINK_DOMAIN:-s.gosilex.com}}}"
ARTIFACTS_ROOT="${FORGE_ARTIFACTS_ROOT:-}"
INTERNAL_PREFIX="${FORGE_INTERNAL_PREFIX:-a}"
# forge.config.json is the only source of the host and the Pages project, and
# both are resolved here — before source_cf_credentials reads forge.env — so a
# stale credentials file can never redirect the deploy to another project or
# stamp another host into the deployed [vars]. Point elsewhere with FORGE_CONFIG.
PUBLIC_HOST="${FORGE_PUBLIC_HOST:-forge.gosilex.com}"
PAGES_PROJECT="${FORGE_PAGES_PROJECT:-silex-forge}"
# Exported for patch_wrangler_for_deploy (deployed wrangler.toml [vars]) and for
# the python helpers that read it — not a user-facing override.
export PUBLIC_HOST

# shellcheck source=/dev/null
. "$LIB_DIR/forge_common.sh"
die()  { forge_die "$@"; }
# publish.sh info is ▸ on stdout (tests/callers); lib forge_info is → on stderr.
info() { echo "▸ $*"; }
warn() { forge_warn "$@"; }
ok()   { forge_ok "$@"; }
# test_publish_lock.sh export -f die into lock subshells.
export -f forge_die

GIT() { git -c core.hooksPath=/dev/null "$@"; }

WORK=""
DRY_RUN=false
PUBLISH_LOCK_FD=""
PUBLISH_LOCK_DIR=""
# Removals this command performs by design (space-separated slugs). cmd_remove
# declares its slug; every other command declares nothing, so any slug the live
# snapshot holds and the local hub does not is unexpected drift.
EXPECTED_REMOVALS=""
ALLOW_REMOVALS=false
ALLOW_UNVERIFIED=false
SNAPSHOT_KV_KEY="snapshot:live"
# The guard runs in the preflight; the upload happens minutes later (engine
# clone, OG rendering). deploy_pages re-asserts all three of these immediately
# before wrangler: PASSED makes "no deploy without the guard" machine-checked
# instead of a convention across five call sites, and LIVE_ID catches a
# teammate who deployed inside that window (no flock serializes two machines
# that each hold their own copy of the shared hub). LIVE_ID is empty in three
# different situations and LIVE_UNKNOWN is what tells them apart: a project
# whose deployment list is confirmed empty is a real observation (live moving
# off it is a provable race), while a failed lookup and a skipped guard
# observed nothing at all, so no id can be compared against them.
SNAPSHOT_GUARD_PASSED=false
SNAPSHOT_GUARD_LIVE_ID=""
SNAPSHOT_GUARD_LIVE_UNKNOWN=false
# Outcome of the last kv_get_key: ok | miss | denied | error. A denied read is
# not a missing record — telling the operator their hub is stale when the token
# simply cannot read KV refuses every publish forever, for the wrong reason.
KV_GET_STATUS=""
# Live deployment resolved by resolve_live_deployment (globals: command
# substitution would lose them in a subshell).
LIVE_RESOLVED_ID=""
LIVE_RESOLVED_UNKNOWN=true
cleanup() {
  if [ -n "${PUBLISH_LOCK_FD:-}" ]; then
    # Only GNU flock was used to take this FD (see acquire_publish_lock).
    flock -u "$PUBLISH_LOCK_FD" 2>/dev/null || true
    eval "exec ${PUBLISH_LOCK_FD}>&-" 2>/dev/null || true
  fi
  if [ -n "${PUBLISH_LOCK_DIR:-}" ]; then
    rmdir "$PUBLISH_LOCK_DIR" 2>/dev/null || true
  fi
  if [ -n "${WORK:-}" ]; then
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

require_forge_config() {
  if [ ! -f "$LIB_DIR/load_config.py" ]; then
    return 0
  fi
  # One python3 call: exit 0 when doctor().ok, else print the issues on stdout.
  local diag line
  if diag=$(PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 -c \
    'import sys
from load_config import doctor
d = doctor()
if d.get("ok"):
    sys.exit(0)
for i in d.get("issues") or []:
    print(i)
sys.exit(1)'); then
    return 0
  fi
  warn "forge config KO — publish stopped before touching Cloudflare"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    echo "  ✗ $line" >&2
  done <<<"$diag"
  die "forge config incomplete — run the forge-setup skill (forge-doctor.sh for the full report)"
}

usage() {
  cat <<EOF
Usage:
  publish.sh <slug> [path] [--share] [--title T] [--type TYPE] [--desc D] [--dry-run]
  publish.sh --share <slug>
  publish.sh --unshare <slug>
  publish.sh --list | --remove <slug> | --rebuild-index
  publish.sh --reanchor-snapshot

  --dry-run : accepted anywhere in argv, for every command — builds and
              validates everything (engine, hub snapshot, wrangler.toml)
              without deploying and without mutating KV.

  --allow-removals : proceed even when the deploy would delete artifacts that
              are live but absent from the local hub. Without it, that case
              refuses — a hub copy behind the shared artifacts directory
              would otherwise silently remove other people's artifacts.

  --allow-unverified : proceed even when the guard cannot verify what is
              live (no/unreadable KV record, live lookup failed, or a
              record anchored on another deployment). Without it, that
              case refuses — a full-snapshot deploy from an unverified
              hub can delete a teammate's artifact. Also required on top
              of --allow-removals when the record no longer describes the
              live site: an unanchored record cannot list every removal.

  --reanchor-snapshot : re-point the KV snapshot record at the deployment the
              live site is serving, keeping its slug set verbatim. The
              recovery when a post-deploy record write failed and the guard
              now refuses as "record anchored on another deployment": it
              builds nothing, deploys nothing, and never rebuilds the slug
              set from the local hub (which is what --allow-unverified does,
              and how the 2026-09-06 loss was baselined).

  SSOT   : \$ARTIFACTS_ROOT/<slug>/  (hub, forge.config)
  Deploy : wrangler pages deploy (token ~/.config/silex/forge.env)
  Engine : main (plugins/functions — no HTML, no payload branch)

  Team    : https://${PUBLIC_HOST}/${INTERNAL_PREFIX}/<slug>/
  Share   : https://${PUBLIC_HOST}/s/<slug>/<key>/
EOF
}

validate_slug() {
  local s="${1-}"
  case "$s" in
    '' )            die "empty slug" ;;
    */*|*..*|. ) die "invalid slug (path): '$s'" ;;
  esac
  [[ "$s" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || die "invalid slug: '$s'"
  case "$s" in
    index|404|robots|registry|site|a|p|s|images|public|_headers) die "reserved slug: '$s'" ;;
  esac
}

whoami_id() { git config user.email 2>/dev/null || echo "${USER:-unknown}@$(hostname)"; }

materialize_engine() {
  [ -n "${WORK:-}" ] || die "materialize_engine: WORK unset"
  if [ -d "$FORGE_REPO" ] && [ -f "$FORGE_REPO/site/404.html" ]; then
    [ "$(GIT -C "$FORGE_REPO" rev-parse --is-inside-work-tree 2>/dev/null)" = true ] \
      || die "FORGE_REPO is not a git work tree — use the HTTPS URL or a git checkout"
    mkdir -p "$WORK/repo"
    GIT -C "$FORGE_REPO" archive HEAD | tar -x -C "$WORK/repo" \
      || die "git archive HEAD failed for $FORGE_REPO"
    rm -rf "$WORK/repo/site/a" "$WORK/repo/registry"
    info "engine local $FORGE_REPO (HEAD)"
  else
    info "clone engine $FORGE_REPO (main)"
    GIT clone --depth 1 --branch main --quiet "$FORGE_REPO" "$WORK/repo" \
      || die "clone failed: $FORGE_REPO (branch main) — check GitHub access, or set forge_repo to a local checkout in ~/.config/silex/forge.config.json"
  fi
  [ -d "$WORK/repo/site" ] || die "engine checkout has no site/ skeleton — $FORGE_REPO is not a silex-forge engine"
  [ -f "$WORK/repo/site/404.html" ] || die "site/404.html missing"
}

clone_engine() {
  WORK="$(mktemp -d)"
  materialize_engine
}

# Dry run: the real hub must come out of the run byte-identical — including the
# vault notes hub-index.py writes outside the artifacts dir. So the sandbox is
# a fake *hub root* under $WORK holding a copy of the artifacts subtree only
# (never a cp -a of the real hub root — that is a full Obsidian vault).
#
# The hub root has three independent consumers: this shell (ARTIFACTS_ROOT),
# build-site-from-hub.py and hub-index.py (both via load_config). The config is
# the one seam that covers all three plus any future consumer, so the sandbox
# dumps the *resolved* config with hub_root rewritten and exports FORGE_CONFIG.
# Every other key is copied verbatim: preflight, patch_wrangler and the
# project/host resolution behave exactly as in a wet run.
#
# Runs after WORK exists and before the first hub write; no-op on the wet path.
# require_forge_config and preflight_before_live deliberately run *before* it,
# against the real config, so the gate still validates the real deploy target.
enter_dry_run_sandbox() {
  $DRY_RUN || return 0
  [ -n "${WORK:-}" ] || die "enter_dry_run_sandbox: WORK unset"
  local root="$WORK/hub-root"
  mkdir -p "$root" || die "dry run: cannot create hub sandbox $root"
  local sandbox
  sandbox=$(FORGE_DRY_RUN_HUB_ROOT="$root" \
    PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 -c 'import json, os
from load_config import load_config
root = os.environ["FORGE_DRY_RUN_HUB_ROOT"]
cfg = load_config()
for k in ("_config_source", "_config_fallback"):
    cfg.pop(k, None)
rel = (cfg.get("artifacts_dir") or "artifacts").strip()
cfg["hub_root"] = root
cfg["artifacts_dir"] = rel
os.makedirs(os.path.join(root, rel), exist_ok=True)
with open(os.path.join(root, "forge.config.json"), "w", encoding="utf-8") as fh:
    json.dump(cfg, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
print(os.path.join(root, rel))') \
    || die "dry run: cannot write the sandbox config $root/forge.config.json"
  [ -n "$sandbox" ] || die "dry run: sandbox artifacts dir unresolved"
  if [ -n "${ARTIFACTS_ROOT:-}" ] && [ -d "$ARTIFACTS_ROOT" ]; then
    cp -a "$ARTIFACTS_ROOT"/. "$sandbox"/ \
      || die "dry run: hub snapshot failed ($ARTIFACTS_ROOT → $sandbox)"
  fi
  export FORGE_CONFIG="$root/forge.config.json"
  ARTIFACTS_ROOT="$sandbox"
  info "dry run — hub sandboxed at $root (real hub untouched)"
}

SCRIPTS() {
  # prefer scripts inside cloned engine (version matching deploy)
  if [ -n "${WORK:-}" ] && [ -d "$WORK/repo/plugins/silex-forge/scripts" ]; then
    echo "$WORK/repo/plugins/silex-forge/scripts"
  else
    echo "$SCRIPT_DIR"
  fi
}

# Single resolution point for the share-bar pair (inject-share-bar.py reads its
# sibling share-bar.js). share-bar.js is inlined into every artifact, so two
# callers resolving it differently flip the content hash of the whole catalogue.
share_bar_script() {
  local p
  p="$(SCRIPTS)/inject-share-bar.py"
  [ -f "$p" ] || p="$SCRIPT_DIR/inject-share-bar.py"
  [ -f "$p" ] || die "inject-share-bar.py missing — reinstall the silex-forge plugin, then forge-doctor.sh"
  echo "$p"
}

# Build site/a + registry from hub into the engine clone
build_from_hub() {
  local build_py
  build_py="$(SCRIPTS)/build-site-from-hub.py"
  [ -f "$build_py" ] || build_py="$SCRIPT_DIR/build-site-from-hub.py"
  [ -f "$build_py" ] || die "build-site-from-hub.py missing — reinstall the silex-forge plugin, then forge-doctor.sh"
  info "build site from hub SSOT → $WORK/repo"
  PYTHONPATH="$(dirname "$build_py")/lib${PYTHONPATH:+:$PYTHONPATH}" \
    python3 "$build_py" --repo-root "$WORK/repo" \
    || die "build-site-from-hub failed — check the hub artifacts under ${ARTIFACTS_ROOT:-<artifacts root>} (each slug needs <slug>/index.html), then retry"
}

# Load token + account from ~/.config/silex/forge.env (never print values)
forge_env_mode() {
  local f="${FORGE_ENV_FILE:-$HOME/.config/silex/forge.env}"
  [ -f "$f" ] || return 0
  stat -c '%a' "$f" 2>/dev/null || stat -f '%OLp' "$f" 2>/dev/null || echo ""
}

require_forge_env_secure() {
  local f="${FORGE_ENV_FILE:-$HOME/.config/silex/forge.env}"
  [ -f "$f" ] || return 0
  local mode
  mode=$(forge_env_mode)
  case "$mode" in
    600|400) return 0 ;;
    * ) die "forge.env permissions ${mode:-unknown} — chmod 600 required before publish" ;;
  esac
}

source_cf_credentials() {
  local f="${FORGE_ENV_FILE:-$HOME/.config/silex/forge.env}"
  [ -f "$f" ] || return 0
  local mode
  mode=$(forge_env_mode)
  case "$mode" in
    600|400|"" ) ;;
    *) warn "forge.env mode $mode — chmod 600 recommended" ;;
  esac
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      ''|\#*) continue ;;
    esac
    key="${line%%=*}"
    val="${line#*=}"
    val="${val#\"}"
    val="${val%\"}"
    val="${val#\'}"
    val="${val%\'}"
    # Credentials plus the Access/Shlink Pages vars only. PUBLIC_HOST and
    # FORGE_PAGES_PROJECT are deliberately absent: forge.config.json owns
    # them, and a stale forge.env line here used to decide which Pages
    # project the deploy landed in while the doctor validated the config.
    case "$key" in
      CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_KEY|CLOUDFLARE_EMAIL|FORGE_SHARES_KV_ID|CF_ACCESS_TEAM_DOMAIN|CF_ACCESS_AUD|SHLINK_API_URL|SHLINK_DOMAIN)
        export "$key=$val"
        ;;
    esac
  done < "$f"
}

# Fetch remote plain Pages vars for deploy patch (raises on API failure — no silent wipe)
fetch_pages_plain_var() {
  local name="$1"
  source_cf_credentials
  PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 -c \
    'import sys
from load_config import PagesEnvFetchError, fetch_pages_plain_var as f
try:
    sys.stdout.write(f(sys.argv[1]))
except PagesEnvFetchError as e:
    print(f"✗ Pages env fetch failed ({e.kind}): {e.message}", file=sys.stderr)
    sys.exit(2)' \
    "$name"
}

preflight_cf_mutations() {
  require_forge_env_secure
  source_cf_credentials
  local pf_json
  pf_json=$(PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 -c \
    'import json; from load_config import preflight_mutations; print(json.dumps(preflight_mutations(require_kv=False)))')
  if python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("ok") else 1)' <<<"$pf_json"; then
    python3 -c 'import json,sys; d=json.load(sys.stdin); [print("  ⚠", w, file=sys.stderr) for w in d.get("warnings",[])]' <<<"$pf_json" || true
    return 0
  fi
  PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 -c \
    'import json, sys
from load_config import doctor
d = json.load(sys.stdin)
for e in d.get("errors", []):
    print("✗", e, file=sys.stderr)
blockers = doctor().get("deploy_blockers") or []
if blockers:
    print("  deploy blockers:", ", ".join(blockers), file=sys.stderr)' <<<"$pf_json"
  echo "  → forge-doctor.sh              # per-blocker fix commands" >&2
  echo "  → forge-discover.sh --write    # account id / KV id / CF_ACCESS_* from the live account" >&2
  echo "  → CLOUDFLARE_API_TOKEN goes in ~/.config/silex/forge.env (chmod 600)" >&2
  echo "  → /forge-setup                 # rebuild the whole local install" >&2
  die "Cloudflare preflight failed — nothing was mutated"
}

preflight_before_live() {
  source_cf_credentials
  preflight_cf_mutations
  snapshot_guard
}

# Hub drift guard.
#
# Every deploy is a FULL snapshot of the Pages project built from the LOCAL
# hub, and that hub must be a directory shared between everyone who publishes
# to this forge — by whatever sync mechanism the operator chose, none of which
# gives cross-machine locking. A local copy that is behind therefore publishes
# a snapshot which silently DELETES the artifacts other people added — the
# live site has no other source of truth.
#
# This runs in the preflight, not in deploy_pages, because the preflight is the
# one point every command reaches BEFORE any mutation: cmd_remove clears KV and
# rm -rf's the hub artifact well before it reaches deploy_pages, so a guard
# sitting there would abort after the destruction it was meant to prevent.
#
# A full-snapshot deploy that cannot see what is live can delete a teammate's
# artifact. The 2026-09-06 loss happened exactly through the old bootstrap
# branch (no KV record yet → warn and proceed → wipe baselined). Unverifiable
# states therefore fail closed; --allow-unverified is the explicit override.
live_deployment_json() {
  PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 "$LIB_DIR/snapshot.py" live-deployment
}

# Resolve the live deployment into two facts — is it known, and which id — in
# LIVE_RESOLVED_UNKNOWN / LIVE_RESOLVED_ID. Globals rather than stdout: the
# pre-upload re-assert in deploy_pages needs the same two facts the guard
# decided on, and a command substitution would compute them in a subshell.
#
# live_deployment() returns ok:false/error_kind=no_deployment only for a Pages
# project whose deployment list is confirmed empty — a known-empty live state,
# not a failed lookup. Conflating the two would refuse the first publish of a
# new forge (the 2026-09-06 hole, inverted). Every other ok:false is unknown,
# including a missing latest_deployment.id the list could not confirm.
resolve_live_deployment() {
  local live="" live_ok="false" live_kind="" live_id=""
  LIVE_RESOLVED_ID=""
  LIVE_RESOLVED_UNKNOWN=true
  if ! live=$(live_deployment_json 2>/dev/null); then
    live="${live:-}"
  fi
  live_ok=$(printf '%s' "$live" | python3 -c 'import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
print("true" if d.get("ok") is True else "false")' 2>/dev/null) || live_ok="false"
  live_id=$(printf '%s' "$live" | python3 -c 'import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
sys.stdout.write(str(d.get("deployment_id") or ""))' 2>/dev/null) || live_id=""
  live_kind=$(printf '%s' "$live" | python3 -c 'import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
sys.stdout.write(str(d.get("error_kind") or ""))' 2>/dev/null) || live_kind=""
  if [ "$live_ok" = "true" ]; then
    LIVE_RESOLVED_UNKNOWN=false
    LIVE_RESOLVED_ID="$live_id"
  elif [ "$live_kind" = "no_deployment" ]; then
    LIVE_RESOLVED_UNKNOWN=false
    LIVE_RESOLVED_ID=""
  else
    LIVE_RESOLVED_UNKNOWN=true
    LIVE_RESOLVED_ID=""
  fi
}

# Arm what deploy_pages re-asserts immediately before the upload. $1 = the live
# deployment id this decision was made against, $2 = whether the live state was
# UNKNOWN when the decision was taken ("true" / "false"). Both facts, never the
# id alone: an empty id means "this project verifiably has no deployment" on
# one path and "live could not be read" on another, and only the first turns a
# later non-empty live state into a provable race.
snapshot_guard_pass() {
  SNAPSHOT_GUARD_PASSED=true
  SNAPSHOT_GUARD_LIVE_ID="${1-}"
  SNAPSHOT_GUARD_LIVE_UNKNOWN="${2-false}"
}

snapshot_guard() {
  local snap="$LIB_DIR/snapshot.py"
  local unverified_reason=""
  # Set only for the one unverified row a dry run cannot turn into a verdict:
  # a REST read the real publish would retry over wrangler OAuth. Everything
  # else keeps the "would refuse" wording below.
  local unverified_no_verdict=false
  local live_id=""
  SNAPSHOT_GUARD_PASSED=false
  SNAPSHOT_GUARD_LIVE_ID=""
  SNAPSHOT_GUARD_LIVE_UNKNOWN=false
  # Nothing observed yet. The snapshot.py-missing branch below never reaches
  # resolve_live_deployment and falls through to the shared unverified
  # handling, which arms the sentinels from these two: "unknown" is the only
  # honest starting value, and re-setting them here keeps a previous call in
  # the same process from lending it a live state it never looked at.
  LIVE_RESOLVED_ID=""
  LIVE_RESOLVED_UNKNOWN=true
  if [ -z "${ARTIFACTS_ROOT:-}" ]; then
    # Returning silently here was indistinguishable from a clean pass in the
    # logs. build_from_hub dies later (build-site-from-hub.py resolves the
    # artifacts root itself), but the skip is named where it happens.
    warn "hub drift guard skipped — artifacts root unresolved, so there is no local hub to compare against the live site"
    # Unknown, not known-empty: this path never looked at live at all.
    snapshot_guard_pass "" true
    return 0
  fi

  if [ ! -f "$snap" ]; then
    unverified_reason="snapshot.py missing from the plugin"
  else
    local record="" rec_tmp
    # Redirect, not a command substitution: kv_get_key classifies the read in
    # KV_GET_STATUS and a subshell would discard it, which is what made a
    # token denied Workers KV read look exactly like "no record yet" and
    # refuse every publish with a stale-hub story that was not true.
    rec_tmp=$(mktemp)
    if kv_get_key "$SNAPSHOT_KV_KEY" >"$rec_tmp" 2>/dev/null; then
      record=$(cat "$rec_tmp")
    fi
    rm -f "$rec_tmp"
    if [ -z "$record" ]; then
      # A miss (404) is a genuine absence — the verdict decides. An unset
      # status means the caller replaced kv_get_key (test suites do), so it
      # keeps the same meaning as a miss.
      #
      # A dry run gets its own wording on both failure rows: kv_get_key skips
      # the wrangler-OAuth fallback there (three spawns, possibly through
      # `npx --yes wrangler`, possibly interactive), so a REST denial is NOT
      # the whole story and this run cannot know the real verdict.
      case "${KV_GET_STATUS:-}" in
        denied)
          if $DRY_RUN; then
            unverified_reason="KV record read denied over REST — the API token lacks Workers KV read; a real publish retries that read through wrangler OAuth, which this dry run does not invoke"
            unverified_no_verdict=true
          else
            unverified_reason="KV record read denied — the API token lacks Workers KV read, or wrangler OAuth is unavailable"
          fi
          ;;
        error)
          if $DRY_RUN; then
            unverified_reason="KV record read failed over REST — a real publish retries that read through wrangler OAuth, which this dry run does not invoke"
            unverified_no_verdict=true
          else
            unverified_reason="KV record read failed"
          fi
          ;;
      esac
    fi

    resolve_live_deployment
    live_id="$LIVE_RESOLVED_ID"
    local live_unknown_flag=""
    if $LIVE_RESOLVED_UNKNOWN; then
      live_unknown_flag="--live-unknown"
    fi

    local rc=0 cmp_json="" verifiable="false"
    # shellcheck disable=SC2086  # live_unknown_flag is empty or one flag
    cmp_json=$(printf '%s' "$record" | PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" \
      python3 "$snap" compare \
        --record - \
        --live-deployment-id "$live_id" \
        --expected-removals "$EXPECTED_REMOVALS" \
        $live_unknown_flag) || rc=$?
    # The payload, not just the exit code: compare returns 3 on a non-empty
    # removal list whether or not the record is anchored on what is live, so
    # reading only the code let --allow-removals clear an untrusted record.
    # Unparseable output counts as NOT verifiable — fail closed.
    verifiable=$(printf '%s' "$cmp_json" | python3 -c 'import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
print("true" if d.get("verifiable") is True else "false")' 2>/dev/null) || verifiable="false"
    [ -n "$verifiable" ] || verifiable="false"
    case "$rc" in
      0)
        snapshot_guard_pass "$live_id" "$LIVE_RESOLVED_UNKNOWN"
        return 0
        ;;
      3)
        if $ALLOW_REMOVALS && { [ "$verifiable" = "true" ] || $ALLOW_UNVERIFIED; }; then
          if [ "$verifiable" = "true" ]; then
            warn "hub drift: removing live artifacts because --allow-removals was passed"
          else
            warn "hub drift: removing live artifacts because --allow-removals was passed, and accepting an unanchored record because --allow-unverified was passed — the record no longer describes the live site, so live artifacts it never listed can be deleted without being named"
          fi
          snapshot_guard_pass "$live_id" "$LIVE_RESOLVED_UNKNOWN"
          return 0
        fi
        if $ALLOW_REMOVALS; then
          die "hub drift — the record no longer describes the live site, so the removal list cannot be trusted: live artifacts absent from both the record and this hub would be deleted without ever being named. Refresh this machine's copy of the shared artifacts directory, then re-run; or pass --allow-unverified in addition to --allow-removals"
        fi
        die "hub drift — this deploy would remove artifacts that are live. Refresh this machine's copy of the shared artifacts directory (whatever syncs it), then re-run; or pass --allow-removals to delete them on purpose"
        ;;
      4)
        : # fall through to unverified handling below
        ;;
      *)
        # This reason replaces whatever the KV read left: the compare failing
        # is a verdict a dry run CAN predict, so drop the no-verdict marker.
        unverified_reason="snapshot compare failed (exit $rc)"
        unverified_no_verdict=false
        ;;
    esac
  fi

  if $ALLOW_UNVERIFIED; then
    if [ -n "$unverified_reason" ]; then
      warn "hub drift unverified ($unverified_reason) — proceeding because --allow-unverified was passed"
    else
      warn "hub drift unverified — proceeding because --allow-unverified was passed"
    fi
    snapshot_guard_pass "$live_id" "$LIVE_RESOLVED_UNKNOWN"
    return 0
  fi
  if $DRY_RUN; then
    if $unverified_no_verdict; then
      # No "would refuse" here, deliberately. The REST read was refused, and
      # the real publish retries it over wrangler OAuth — which this dry run
      # skipped on purpose. Announcing a refusal the real publish may never
      # make is what teaches operators to ignore a dry-run refusal.
      warn "hub drift unverified ($unverified_reason) — so this dry run cannot predict the real verdict: a real deploy refuses only if that OAuth retry fails too"
    elif [ -n "$unverified_reason" ]; then
      warn "would refuse: hub drift unverified ($unverified_reason) — a real deploy needs a synced hub or --allow-unverified"
    else
      warn "would refuse: hub drift unverified — a real deploy needs a synced hub or --allow-unverified"
    fi
    snapshot_guard_pass "$live_id" "$LIVE_RESOLVED_UNKNOWN"
    return 0
  fi
  if [ -n "$unverified_reason" ]; then
    die "hub drift unverified ($unverified_reason) — refresh this machine's copy of the shared artifacts directory (whatever syncs it), then re-run; or pass --allow-unverified to deploy anyway"
  fi
  die "hub drift unverified — refresh this machine's copy of the shared artifacts directory (whatever syncs it), then re-run; or pass --allow-unverified to deploy anyway"
}

# Record the snapshot AFTER a successful deploy, keyed on the deployment the
# live site is actually serving — that anchor is what lets the next run tell a
# trustworthy record from one describing a rollback or a dashboard deploy.
# Best-effort: the deploy already succeeded, so a failed record write is a
# stale-bookkeeping warning, never a rollback.
snapshot_record() {
  local snap="$LIB_DIR/snapshot.py"
  [ -f "$snap" ] || return 0
  [ -n "${ARTIFACTS_ROOT:-}" ] || return 0
  local live dep engine payload
  live=$(PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 "$snap" live-deployment 2>/dev/null) || {
    warn "snapshot record skipped — live deployment id unreadable"
    return 0
  }
  dep=$(printf '%s' "$live" | python3 -c 'import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
sys.stdout.write(str(d.get("deployment_id") or ""))' 2>/dev/null) || dep=""
  engine=$(printf '%s' "$live" | python3 -c 'import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
sys.stdout.write(str(d.get("engine_commit") or ""))' 2>/dev/null) || engine=""
  if [ -z "$dep" ]; then
    warn "snapshot record skipped — live deployment id unreadable"
    return 0
  fi
  payload=$(PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 "$snap" record \
    --deployment-id "$dep" \
    --engine-commit "$engine" \
    --by "$(whoami_id)" 2>/dev/null) || {
    warn "snapshot record skipped — fingerprint failed"
    return 0
  }
  [ -n "$payload" ] || { warn "snapshot record skipped — empty payload"; return 0; }
  kv_put_value "$SNAPSHOT_KV_KEY" "$payload" \
    || warn "snapshot record not written to KV — the next publish cannot verify hub drift"
}

acquire_publish_lock() {
  local slug="${1:-_global}"
  [ -n "${ARTIFACTS_ROOT:-}" ] || return 0
  local lock_dir="${ARTIFACTS_ROOT}/.forge-locks"
  mkdir -p "$lock_dir"
  local lockfile="${lock_dir}/${slug}.lock"
  # util-linux/BSD flock accepts -w (wait timeout). BusyBox flock does not —
  # `command -v flock` is true on Alpine, then `flock -w 120` errors as
  # "unrecognized option" and we mis-report a lock timeout. Probe first;
  # fall through to the mkdir lockdir if -w is missing.
  if command -v flock >/dev/null 2>&1 \
     && flock -w 0 /dev/null true >/dev/null 2>&1; then
    # bash 3.2: fixed FD (not `exec {var}>`, which needs 4.1+)
    exec 9>"$lockfile" || die "cannot open publish lock: $slug"
    PUBLISH_LOCK_FD=9
    if ! flock -w 120 9; then
      die "publish lock timeout: $slug (another machine/process?)"
    fi
    return 0
  fi
  local waited=0
  local candidate="${lock_dir}/${slug}.lockdir"
  while ! mkdir "$candidate" 2>/dev/null; do
    waited=$((waited + 1))
    if [ "$waited" -ge 120 ]; then
      die "publish lock timeout: $slug (another machine/process?) — if none is running, remove $candidate"
    fi
    sleep 1
  done
  PUBLISH_LOCK_DIR="$candidate"
}

# Patch cloned wrangler.toml: KV id + Access/Shlink vars from forge.env, host
# from forge.config.json (+ API fallback for vars absent locally)
patch_wrangler_for_deploy() {
  local toml="$1"
  # $2 = --no-fetch-remote: dry run patches from local vars only, so the
  # validation path needs no network.
  local kv="${FORGE_SHARES_KV_ID:-}"
  local team="${CF_ACCESS_TEAM_DOMAIN:-}"
  local aud="${CF_ACCESS_AUD:-}"
  local host="${PUBLIC_HOST:-}"
  local shlink_url="${SHLINK_API_URL:-}"
  [ -n "$kv" ] || die \
    "FORGE_SHARES_KV_ID missing — set in ~/.config/silex/forge.env (see .env.example)"
  [ -n "$team" ] || die \
    "CF_ACCESS_TEAM_DOMAIN missing — set in ~/.config/silex/forge.env (see .env.example)"
  [ -n "$aud" ] || die \
    "CF_ACCESS_AUD missing — set in ~/.config/silex/forge.env (see .env.example)"
  [ -n "$host" ] || die \
    "public_host missing — set it in forge.config.json (forge.env no longer holds the host), then retry"
  [ -f "$toml" ] || die "wrangler.toml missing: $toml"
  # --fetch-remote: preserve all Pages plain_text vars; local managed vars
  # override. The wet path must keep it or the deploy wipes the vars that live
  # only on Pages.
  if [ "${2-}" = "--no-fetch-remote" ]; then
    PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" \
      python3 "$LIB_DIR/patch_wrangler.py" "$toml" "$kv" "$team" "$aud" "$host" "${shlink_url:-}"
    return
  fi
  PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" \
    python3 "$LIB_DIR/patch_wrangler.py" --fetch-remote "$toml" "$kv" "$team" "$aud" "$host" "${shlink_url:-}"
}

# Dry-run plan: what the wet deploy would push. cwd is $WORK/repo.
print_deploy_plan() {
  local project="$1" acct="$2"
  local files slugs
  # wc -l pads with spaces on macOS — trim before printing.
  files=$(find site -type f | wc -l | tr -d '[:space:]')
  slugs=$(find "site/${INTERNAL_PREFIX}" -mindepth 1 -maxdepth 1 -type d 2>/dev/null \
    | wc -l | tr -d '[:space:]')
  info "dry run — no deploy, no KV mutation"
  echo "  project : ${project}"
  echo "  account : ${acct:0:8}…"
  echo "  host    : ${PUBLIC_HOST}"
  echo "  branch  : main"
  echo "  dir     : ${WORK}/repo/site"
  echo "  files   : ${files}"
  echo "  slugs   : ${slugs} under /${INTERNAL_PREFIX}/"
  echo "  wrangler.toml : patched (local vars only; --fetch-remote skipped)"
  ok "dry run OK — nothing deployed"
}

# Direct Upload — HTML never touches git
deploy_pages() {
  preflight_cf_mutations
  source_cf_credentials
  # Gate on the *exported* env wrangler will consume, not on the resolved
  # config: an empty CLOUDFLARE_API_TOKEN makes wrangler fall back to its own
  # OAuth session, i.e. deploy to whatever account that session owns.
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die \
    "CLOUDFLARE_API_TOKEN not in the publish environment — put it in ~/.config/silex/forge.env (chmod 600), then forge-doctor.sh"
  local acct="${CLOUDFLARE_ACCOUNT_ID:-}"
  [ -n "$acct" ] || die \
    "CLOUDFLARE_ACCOUNT_ID not in the publish environment — add it to ~/.config/silex/forge.env (forge-discover.sh prints it), then forge-doctor.sh"
  # Frozen from the config at startup: never re-read after forge.env is sourced.
  local project="$PAGES_PROJECT"
  export CLOUDFLARE_ACCOUNT_ID="$acct"
  cd "$WORK/repo"
  [ -d site ] || die "site/ missing in engine clone"
  [ -f wrangler.toml ] || die "wrangler.toml missing"
  if $DRY_RUN; then
    # Every wet precondition has been checked above; a dry run is a gate, not
    # a preview, so it stops here with the plan and never calls wrangler.
    patch_wrangler_for_deploy "$WORK/repo/wrangler.toml" --no-fetch-remote
    print_deploy_plan "$project" "$acct"
    return 0
  fi
  patch_wrangler_for_deploy "$WORK/repo/wrangler.toml"
  info "wrangler pages deploy site → ${project} (${acct:0:8}…)"
  local wr_cmd
  wr_cmd=$(forge_wrangler) || die "wrangler / npx missing — npm i -g wrangler (or install Node so npx wrangler works), then retry"
  # Re-assert the guard immediately before the upload. It ran in the preflight,
  # minutes ago: the engine clone, the OG rendering and (on --rebuild-index)
  # every slug's images sit in between, and acquire_publish_lock cannot help —
  # flock is per-slug and kernel-local, so two machines holding their own copy
  # of the shared hub never contend. Without this, a teammate deploying inside
  # that window has their artifact deleted by this older snapshot, and
  # snapshot_record then re-baselines the loss.
  #
  # An empty SNAPSHOT_GUARD_LIVE_ID is NOT automatically "unknown", which is
  # why the guard reports the two separately: a Pages project whose deployment
  # list was confirmed empty (bootstrap) is a real observation, so live turning
  # into a deployment id since then IS a teammate's deploy and must refuse. A
  # guard that never saw live is the opposite case — comparing its empty id
  # against a live id proves nothing, and claiming "someone else deployed"
  # there is a fabricated accusation that no flag could override.
  [ "${SNAPSHOT_GUARD_PASSED:-false}" = true ] || die \
    "internal error — deploy reached wrangler without snapshot_guard: every deploy_pages caller must run preflight_before_live first"
  if [ "${SNAPSHOT_GUARD_LIVE_UNKNOWN:-false}" = true ]; then
    # Nothing to compare against: re-resolving live cannot tell a deploy inside
    # the window from the state the guard already could not see.
    if $ALLOW_UNVERIFIED; then
      warn "hub drift unverified — the guard never observed the live deployment, so a deploy inside this window cannot be ruled out; proceeding because --allow-unverified was passed"
    else
      die "hub drift unverified — the hub drift guard could not see the live deployment when it ran, so there is no id to compare the current live state against and a deploy inside this window cannot be ruled out. Re-run when the Pages API answers (and with a resolved artifacts root); or pass --allow-unverified to deploy anyway"
    fi
  else
    resolve_live_deployment
    if $LIVE_RESOLVED_UNKNOWN; then
      if $ALLOW_UNVERIFIED; then
        warn "hub drift unverified — the live deployment could not be re-checked before the upload; proceeding because --allow-unverified was passed"
      else
        die "hub drift unverified — the live deployment could not be re-checked immediately before the upload (the guard saw '${SNAPSHOT_GUARD_LIVE_ID:-<none>}'), so a deploy inside this window cannot be ruled out. Re-run when the Pages API answers; or pass --allow-unverified to deploy anyway"
      fi
    elif [ "$LIVE_RESOLVED_ID" != "$SNAPSHOT_GUARD_LIVE_ID" ]; then
      die "hub drift — the live deployment changed while this publish was building (the guard checked '${SNAPSHOT_GUARD_LIVE_ID:-<none>}', live is now '${LIVE_RESOLVED_ID:-<none>}'): someone else deployed, so this snapshot no longer describes the live site and would delete their artifacts. Refresh this machine's copy of the shared artifacts directory, then re-run"
    fi
  fi
  # shellcheck disable=SC2086
  $wr_cmd pages deploy site \
    --project-name="$project" \
    --branch=main \
    --commit-dirty=true \
    || die "wrangler pages deploy failed"
  ok "live https://${PUBLIC_HOST}/"
  snapshot_record
}

write_hub_meta() {
  # env: SLUG TITLE TYP DESC DAY SHARED OUT INTERNAL_PREFIX
  [ -n "${ARTIFACTS_ROOT:-}" ] || return 0
  mkdir -p "${ARTIFACTS_ROOT}/${SLUG}"
  python3 - <<'PY'
import json, os
from pathlib import Path
slug = os.environ["SLUG"]
prefix = os.environ.get("INTERNAL_PREFIX", "a")
p = Path(os.environ["OUT"])
old = {}
if p.is_file():
    try:
        old = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        old = {}
shared = bool(old.get("shared"))
if os.environ.get("SHARED", "") != "":
    shared = os.environ["SHARED"].lower() == "true"
data = {
  "slug": slug,
  "title": os.environ.get("TITLE") or slug,
  "description": os.environ.get("DESC", ""),
  "type": os.environ.get("TYP", "html"),
  "date": os.environ.get("DAY", ""),
  "path": f"/{prefix}/{slug}/",
  "list_on_index": True,
  "visibility": "internal",
  "shared": shared,
}
p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("hub meta", p)
PY
}

resolve_source() {
  local input="$1"
  [ -e "$input" ] || die "source not found: $input — pass an existing .html file or a directory containing index.html"
  if [ -f "$input" ]; then
    case "$input" in *.html|*.htm) ;; *) die "expected a .html file: $input" ;; esac
    STAGE="$WORK/src"
    mkdir -p "$STAGE"
    cp -f "$input" "$STAGE/index.html"
    SRC_DIR="$STAGE"
  elif [ -d "$input" ]; then
    [ -f "$input/index.html" ] || die "directory has no index.html: $input — an artifact directory must contain index.html"
    SRC_DIR="$input"
  else
    die "invalid source: $input — expected a .html file or a directory containing index.html"
  fi
}

write_source_to_hub() {
  local slug="$1"
  [ -n "${ARTIFACTS_ROOT:-}" ] || die "ARTIFACTS_ROOT is empty — set artifacts_dir in ~/.config/silex/forge.config.json, then run forge-doctor.sh"
  local dest="${ARTIFACTS_ROOT}/${slug}"
  mkdir -p "$dest"
  # if source is already the hub dir, skip wipe
  if [ "$(cd "$SRC_DIR" && pwd)" = "$(cd "$dest" 2>/dev/null && pwd)" ]; then
    info "source = hub SSOT (in-place)"
    return 0
  fi
  # replace content but keep meta until write_hub_meta
  find "$dest" -mindepth 1 -maxdepth 1 ! -name 'meta.json' -exec rm -rf {} +
  cp -a "$SRC_DIR"/. "$dest"/
  date -u +%Y%m%dT%H%M%SZ > "$dest/build-id.txt"
  ok "hub SSOT ← $dest"
}

gen_og_images() {
  local slug="${1-}"
  local args=()
  [ -n "$slug" ] && args+=(--slug "$slug")
  local sh
  sh="$(SCRIPTS)/gen-og-images.sh"
  if [ -f "$sh" ]; then
    # bash 3.2 + set -u: a bare "${args[@]}" on an empty array is a fatal
    # expansion error, not an empty list. `${a[@]+"${a[@]}"}` is the 3.2-safe form.
    if (cd "$WORK/repo" && bash "$sh" ${args[@]+"${args[@]}"}); then
      ok "og thumbs"
    else
      warn "gen-og-images skip/failed (publish continues)"
    fi
  fi
}

# gen_og_images writes og.jpg plus a two-hash og.src proof under site/. The
# proof binds the canonical source HTML to the exact JPEG bytes; it is required
# before anything is copied back to the hub.
sha256_file() {
  python3 - "$1" <<'PY'
import hashlib
import sys
from pathlib import Path

print(hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest())
PY
}

# Use the same exact overlay inverses as gen-og-images.sh. This makes a hub
# source comparable to the deploy HTML that was actually checked/rendered,
# while keeping share-bar and OG metadata changes outside thumbnail identity.
canonical_og_source_digest() {
  local html="$1" tmp="$WORK/.og-source-persist-$$.html"
  local share_inj="" og_inj="" digest=""
  og_inj="$(SCRIPTS)/inject-og.py"
  [ -f "$html" ] && [ -f "$og_inj" ] || return 0
  if ! share_inj="$(share_bar_script)"; then
    return 0
  fi
  if ! cp -f "$html" "$tmp"; then
    return 0
  fi
  if python3 "$share_inj" "$tmp" --strip >/dev/null 2>&1 \
      && python3 "$og_inj" "$tmp" --strip >/dev/null 2>&1; then
    digest="$(sha256_file "$tmp")" || digest=""
  fi
  rm -f "$tmp"
  printf '%s\n' "$digest"
}

persist_og_to_hub() {
  local slug="$1"
  [ -n "${ARTIFACTS_ROOT:-}" ] || return 0
  local dir="$WORK/repo/site/${INTERNAL_PREFIX}/${slug}"
  local src="$dir/og.jpg" proof="$dir/og.src"
  local hub_dir="${ARTIFACTS_ROOT}/${slug}"
  # build_from_hub excludes og.src. Its presence therefore proves that this run
  # checked the existing source/image pair or completed a render. Missing
  # Chrome/ffmpeg and failed renders never produce one.
  [ -f "$src" ] && [ -f "$proof" ] || return 0
  [ -d "$hub_dir" ] && [ -f "$hub_dir/index.html" ] || return 0

  local proof_source="" proof_image="" hub_source="" deploy_image=""
  proof_source="$(awk 'NR == 1 {print $1}' "$proof" 2>/dev/null)"
  proof_image="$(awk 'NR == 1 {print $2}' "$proof" 2>/dev/null)"
  hub_source="$(canonical_og_source_digest "$hub_dir/index.html")"
  deploy_image="$(sha256_file "$src")" || deploy_image=""
  if [ -z "$proof_source" ] || [ -z "$proof_image" ] \
      || [ "$hub_source" != "$proof_source" ] \
      || [ "$deploy_image" != "$proof_image" ]; then
    warn "OG persist skipped for $slug — source/image proof changed while the hub was syncing"
    return 0
  fi

  # Copy the image first. If the second copy is interrupted, the old sidecar's
  # image digest no longer matches and the next publish fails stale rather than
  # blessing a mixed generation.
  cp -f "$src" "$hub_dir/og.jpg"
  cp -f "$proof" "$hub_dir/og.src"
}


inject_og_for_slug() {
  local slug="$1" title="$2" desc="$3" path_url="$4"
  local html="$WORK/repo/site/${INTERNAL_PREFIX}/${slug}/index.html"
  [ -f "$html" ] || return 0
  local img_args=() og_img=""
  if [ -f "$WORK/repo/site/${INTERNAL_PREFIX}/${slug}/og.jpg" ]; then
    og_img="https://${PUBLIC_HOST}/${INTERNAL_PREFIX}/${slug}/og.jpg"
  elif [ -f "$WORK/repo/site/${INTERNAL_PREFIX}/${slug}/og.png" ]; then
    og_img="https://${PUBLIC_HOST}/${INTERNAL_PREFIX}/${slug}/og.png"
  fi
  [ -n "$og_img" ] && img_args=(--image "$og_img")
  python3 "$(SCRIPTS)/inject-og.py" "$html" \
    --title "$title" \
    --description "${desc:-$title}" \
    --url "https://${PUBLIC_HOST}${path_url}" \
    ${img_args[@]+"${img_args[@]}"} \
    || die "inject-og failed"
  # Write the OG-enhanced HTML back to the hub SSOT, bar stripped. The share
  # bar belongs to the deploy tree only: persisting it turned it into craft
  # input for the next build, and since strip+inject was not an exact inverse
  # the artifact changed content hash on every republish and Cloudflare
  # re-uploaded a page whose craft content had not moved. The image and its
  # two-hash proof are persisted after this write-back, so the proof can bind
  # the exact final hub HTML without treating engine-owned metadata as a craft
  # change on the next publish.
  #
  # The strip MUST come from the same script that injected the bar, so an
  # engine clone predating --strip cannot be substituted with the local
  # plugin: a mismatched inverse is the very cross-version drift this change
  # removes. When the clone cannot strip, skip the write-back — the hub keeps
  # its previous content and inject-og re-runs next publish (one file of
  # churn). Never die, and never write a barred HTML into the hub.
  if [ -n "${ARTIFACTS_ROOT:-}" ] && [ -d "${ARTIFACTS_ROOT}/${slug}" ]; then
    local hub_html="$WORK/hub-writeback-${slug}.html" inj strip_out strip_rc=0
    # Resolve the path BEFORE the strip, like every other call site: die() inside
    # a $(...) only exits the subshell, so an inline `python3 "$(share_bar_script)"`
    # would run `python3 ""` when the script is missing — and python3 exits 2 on
    # "can't open file", the very code reserved below for an old engine. A
    # missing script would then be reported as a stale clone.
    inj="$(share_bar_script)"
    if ! cp -f "$html" "$hub_html" 2>/dev/null; then
      warn "hub write-back skipped for $slug — cannot stage $hub_html"
      return 0
    fi
    strip_out=$(python3 "$inj" "$hub_html" --strip 2>&1) || strip_rc=$?
    if [ "$strip_rc" -eq 0 ]; then
      cp -f "$hub_html" "${ARTIFACTS_ROOT}/${slug}/index.html" \
        || warn "hub write-back failed for $slug — OG meta re-injected next publish"
    elif [ "$strip_rc" -eq 2 ]; then
      # argparse rejects an unknown flag with 2: this engine really predates
      # --strip. Every other code is a different fault and must not send the
      # operator to update a clone that is already current.
      warn "engine clone predates inject-share-bar --strip — hub write-back skipped for $slug (update main, or point forge_repo at a current checkout)"
    else
      warn "share-bar strip failed for $slug (exit $strip_rc): ${strip_out##*$'\n'}"
    fi
    rm -f "$hub_html"
  fi
}

hub_index_update() {
  local slug="${1-}"
  local reg="$WORK/repo/registry"
  [ -d "$reg" ] || return 0
  local hub_args=(--registry "$reg" --host "$PUBLIC_HOST")
  [ -n "$slug" ] && hub_args+=(--slug "$slug")
  if python3 "$(SCRIPTS)/hub-index.py" ${hub_args[@]+"${hub_args[@]}"}; then
    ok "hub index notes"
  else
    warn "hub-index skip"
  fi
}

kv_auth_ok() {
  { [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { [ -n "${CLOUDFLARE_API_KEY:-}" ] && [ -n "${CLOUDFLARE_EMAIL:-}" ]; }; }
}

wrangler_bin() {
  forge_wrangler
}

kv_curl() {
  local method="$1" path="$2"
  shift 2
  local acct="${CLOUDFLARE_ACCOUNT_ID:-}"
  local ns="${FORGE_SHARES_KV_ID:-}"
  [ -n "$acct" ] || die "CLOUDFLARE_ACCOUNT_ID missing for KV"
  [ -n "$ns" ] || die "FORGE_SHARES_KV_ID missing for KV"
  local url="https://api.cloudflare.com/client/v4/accounts/${acct}/storage/kv/namespaces/${ns}${path}"
  local -a auth=()
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    auth=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
  else
    auth=(-H "X-Auth-Email: ${CLOUDFLARE_EMAIL}" -H "X-Auth-Key: ${CLOUDFLARE_API_KEY}")
  fi
  curl -sS -w '\n%{http_code}' -X "$method" "$url" ${auth[@]+"${auth[@]}"} "$@"
}

kv_api_success() {
  python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("success") else 1)' 2>/dev/null
}

# Reads a KV value on stdout; non-zero when no value was obtained. The outcome
# is also classified in KV_GET_STATUS (ok | miss | denied | error) because the
# hub drift guard READS snapshot:live through here: collapsing a 403 into the
# same failure as a 404 told the operator their hub was stale — and refused
# every publish forever — when the token simply lacks Workers KV read.
#
# Pages deploy tokens routinely lack that scope, which is why the preflight
# admits them with a warning; the OAuth fallback that warning promises has to
# exist on the read path too, not only in kv_put_value / kv_delete_key.
kv_get_key() {
  local key="$1"
  local acct="${CLOUDFLARE_ACCOUNT_ID:-}"
  local ns="${FORGE_SHARES_KV_ID:-}"
  local url tmp http_code=""
  KV_GET_STATUS="error"
  tmp=$(mktemp)
  url="https://api.cloudflare.com/client/v4/accounts/${acct}/storage/kv/namespaces/${ns}/values/${key}"
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    http_code=$(curl -sS -o "$tmp" -w '%{http_code}' -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" "$url" 2>/dev/null) || http_code=""
  elif [ -n "${CLOUDFLARE_API_KEY:-}" ] && [ -n "${CLOUDFLARE_EMAIL:-}" ]; then
    http_code=$(curl -sS -o "$tmp" -w '%{http_code}' \
      -H "X-Auth-Email: ${CLOUDFLARE_EMAIL}" -H "X-Auth-Key: ${CLOUDFLARE_API_KEY}" \
      "$url" 2>/dev/null) || http_code=""
  fi
  case "$http_code" in
    200)
      KV_GET_STATUS="ok"
      cat "$tmp"
      rm -f "$tmp"
      return 0
      ;;
    404) KV_GET_STATUS="miss" ;;
    401|403) KV_GET_STATUS="denied" ;;
    *) KV_GET_STATUS="error" ;;
  esac
  rm -f "$tmp"
  # A 404 is the API answering: the key is not there, and no other credential
  # can find it. Only a denial or a failure is worth a second opinion.
  if [ "$KV_GET_STATUS" = "miss" ]; then
    return 1
  fi
  # A dry run stops here, because this fallback is anything but free:
  # kv_wrangler routes through kv_wrangler_verify, which spawns
  # `wrangler whoami` and `wrangler kv namespace list` before the read itself
  # — three wrangler invocations for one rehearsed read — and forge_wrangler
  # resolves to `npx --yes wrangler` when no global wrangler is installed, so
  # the rehearsal goes through npm: measured at ~8 s per invocation on a
  # machine with no global binary. It does not hang (a logged-out
  # `wrangler whoami` prints "You are not authenticated" and never opens a
  # browser — verified), it is simply a cost with no payoff: the fallback can
  # only tell the dry run what snapshot_guard already says without it. So a
  # dry run keeps the REST classification and reports it WITHOUT claiming a
  # verdict: the read was denied over REST, and a real publish retries it
  # through wrangler OAuth.
  if $DRY_RUN; then
    return 1
  fi
  local out
  if out=$(kv_wrangler kv key get "$key" 2>/dev/null); then
    KV_GET_STATUS="ok"
    printf '%s' "$out"
    return 0
  fi
  return 1
}

_KV_WRANGLER_OK=0
kv_wrangler_verify() {
  local wb="$1" acct="$2" ns="$3"
  [ "$_KV_WRANGLER_OK" -eq 1 ] && return 0
  local out
  if ! out=$(env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_API_KEY -u CLOUDFLARE_EMAIL \
    CLOUDFLARE_ACCOUNT_ID="$acct" \
    $wb whoami 2>&1); then
    warn "wrangler OAuth not available — run: wrangler login"
    return 1
  fi
  if ! echo "$out" | grep -qF "$acct"; then
    warn "wrangler OAuth account mismatch (expected ${acct:0:8}…)"
    return 1
  fi
  if ! env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_API_KEY -u CLOUDFLARE_EMAIL \
    CLOUDFLARE_ACCOUNT_ID="$acct" \
    $wb kv namespace list 2>/dev/null | grep -qF "$ns"; then
    warn "wrangler OAuth cannot see KV namespace ${ns:0:8}…"
    return 1
  fi
  _KV_WRANGLER_OK=1
  return 0
}

# Pages deploy tokens often lack KV API scope; wrangler OAuth may still work.
kv_wrangler() {
  local wb ns="${FORGE_SHARES_KV_ID:-}" acct="${CLOUDFLARE_ACCOUNT_ID:-}"
  [ -n "$ns" ] || return 1
  [ -n "$acct" ] || return 1
  wb=$(wrangler_bin) || return 1
  kv_wrangler_verify "$wb" "$acct" "$ns" || return 1
  # shellcheck disable=SC2086
  env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_API_KEY -u CLOUDFLARE_EMAIL \
    CLOUDFLARE_ACCOUNT_ID="$acct" \
    $wb "$@" --remote --namespace-id="$ns"
}

kv_put_value() {
  local key="$1" val="$2"
  # Last line of defense: the named dry-run paths refuse before reaching this,
  # so a dry run here is a bug — refuse anyway (no wrangler kv, no HTTP).
  if $DRY_RUN; then
    info "dry run — would put KV ${key} (no mutation)" >&2
    return 0
  fi
  if kv_auth_ok; then
    local resp body code
    resp=$(kv_curl PUT "/values/${key}" -H "Content-Type: text/plain" --data "$val" 2>/dev/null) || true
    body="${resp%$'\n'*}"
    code="${resp##*$'\n'}"
    if [ "$code" = "200" ] && echo "$body" | kv_api_success; then
      return 0
    fi
    warn "KV API token rejected — trying wrangler OAuth"
  fi
  if ! kv_wrangler kv key put "$key" "$val" >/dev/null 2>&1; then
    return 1
  fi
  local got
  got=$(kv_get_key "$key" 2>/dev/null || true)
  if [ -n "$got" ] && [ "$got" != "$val" ]; then
    warn "KV post-read mismatch for $key"
    return 1
  fi
}

kv_delete_key() {
  local key="$1"
  if $DRY_RUN; then
    info "dry run — would delete KV ${key} (no mutation)" >&2
    return 0
  fi
  if kv_auth_ok; then
    local resp body code
    resp=$(kv_curl DELETE "/values/${key}" 2>/dev/null) || true
    body="${resp%$'\n'*}"
    code="${resp##*$'\n'}"
    if [ "$code" = "200" ] && echo "$body" | kv_api_success; then
      return 0
    fi
    warn "KV API token rejected — trying wrangler OAuth"
  fi
  if ! kv_wrangler kv key delete "$key" >/dev/null 2>&1; then
    return 1
  fi
  if kv_get_key "$key" >/dev/null 2>&1; then
    warn "KV post-read: $key still present after delete"
    return 1
  fi
}

kv_put_share() {
  kv_put_value "share:$1" "$2"
}

kv_delete_share() {
  kv_delete_key "share:$1"
}

kv_set_visibility() {
  kv_put_value "vis:$1" "$2"
}

kv_activate_share() {
  local slug="$1" key="$2"
  kv_put_share "$slug" "$key" || return 1
  if ! kv_set_visibility "$slug" "shared"; then
    kv_delete_share "$slug" || true
    return 1
  fi
}

kv_revoke_share() {
  local slug="$1"
  if $DRY_RUN; then
    info "dry run — would revoke KV share:${slug} + set vis:${slug}=private (no KV mutation)"
    return 0
  fi
  kv_set_visibility "$slug" "private" || return 1
  kv_delete_share "$slug" || return 1
}

# Fail-closed clear for slug removal/reuse:
#   1) delete share key (link stops working)
#   2) set vis:private tombstone (kept intentionally — NOT deleted)
kv_clear_artifact_auth() {
  local slug="$1"
  if $DRY_RUN; then
    info "dry run — would clear KV share:${slug} + set vis:${slug}=private (no KV mutation)"
    return 0
  fi
  if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ] || [ -z "${FORGE_SHARES_KV_ID:-}" ]; then
    warn "KV credentials missing — cannot clear share/vis for $slug"
    return 1
  fi
  kv_delete_key "share:${slug}" || return 1
  kv_set_visibility "$slug" "private" || return 1
  local v
  v=$(kv_get_key "share:${slug}" 2>/dev/null || true)
  [ -z "$v" ] || { warn "post-read: share:${slug} still present"; return 1; }
  v=$(kv_get_key "vis:${slug}" 2>/dev/null || true)
  [ "$v" = "private" ] || { warn "post-read: vis:${slug} tombstone missing"; return 1; }
  return 0
}

mint_key() {
  python3 -c "import secrets; print(secrets.token_urlsafe(18))"
}

maybe_shortlink() {
  local long_url="$1" slug="$2"
  local short_slug="f-${slug}"
  if $DRY_RUN; then
    info "dry run — would mint shortlink https://${SHLINK_DOMAIN}/${short_slug}" >&2
    return 1
  fi
  if ! command -v shlink &>/dev/null; then
    warn "shlink CLI missing — no auto shortlink"
    return 1
  fi
  # Upsert: edit existing short code when possible (no API key in output)
  if shlink short-url:edit --long-url="$long_url" "$short_slug" >/dev/null 2>&1 \
    || shlink update -- "$short_slug" "$long_url" >/dev/null 2>&1; then
    echo "https://${SHLINK_DOMAIN}/${short_slug}"
    return 0
  fi
  if shlink short -- "$long_url" "$short_slug" >/dev/null 2>&1; then
    echo "https://${SHLINK_DOMAIN}/${short_slug}"
    return 0
  fi
  local r
  r=$(python3 -c "import secrets; print(secrets.token_hex(2))")
  if shlink short -- "$long_url" "${short_slug}-${r}" >/dev/null 2>&1; then
    echo "https://${SHLINK_DOMAIN}/${short_slug}-${r}"
    return 0
  fi
  return 1
}

set_hub_shared() {
  local slug="$1" shared="$2"
  local meta="${ARTIFACTS_ROOT}/${slug}/meta.json"
  [ -f "$meta" ] || return 0
  python3 - "$meta" "$shared" <<'PY'
import json, sys
p, shared = sys.argv[1], sys.argv[2].lower() == "true"
d = json.load(open(p, encoding="utf-8"))
for k in ("share_key", "share_path", "share_url", "share_url_query", "short_url"):
    d.pop(k, None)
d["shared"] = shared
json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
open(p, "a", encoding="utf-8").write("\n")
PY
}

create_share_kv() {
  local slug="$1"
  local key share_path share_url short_url
  key=$(mint_key)
  share_path="/s/${slug}/${key}/"
  share_url="https://${PUBLIC_HOST}${share_path}"
  [ -d "${ARTIFACTS_ROOT}/${slug}" ] || die "hub artifact missing: $slug"

  if kv_activate_share "$slug" "$key"; then
    info "KV share:${slug} + vis:shared OK" >&2
  else
    return 1
  fi
  set_hub_shared "$slug" true
  short_url=""
  if su=$(maybe_shortlink "$share_url" "$slug"); then
    short_url="$su"
  fi
  if [ -n "$short_url" ]; then
    printf '%s\n' "$short_url"
  else
    printf '%s\n' "$share_url"
  fi
}

# Deploy first, then activate share KV — rollback on activation failure after deploy.
create_share_after_deploy() {
  local slug="$1"
  local url
  if $DRY_RUN; then
    # stdout of this function is the share URL its callers print — the refusal
    # goes to stderr, and no key is minted, no KV written, no shortlink called.
    info "dry run — would mint a share key for ${slug} (KV share:${slug} + vis:shared, shortlink https://${SHLINK_DOMAIN}/f-${slug})" >&2
    printf '%s' "https://${PUBLIC_HOST}/s/${slug}/<dry-run-key>/"
    return 0
  fi
  if ! url=$(create_share_kv "$slug"); then
    warn "share KV activation failed after deploy — rolling back"
    kv_revoke_share "$slug" || true
    set_hub_shared "$slug" false
    die "share activation failed — set CLOUDFLARE_API_TOKEN with Workers KV Edit, or wrangler login (OAuth)"
  fi
  printf '%s' "$url"
}

cmd_list() {
  require_forge_config
  info "hub artifacts SSOT ($PUBLIC_HOST)"
  if [ -z "${ARTIFACTS_ROOT:-}" ] || [ ! -d "$ARTIFACTS_ROOT" ]; then
    die "ARTIFACTS_ROOT missing — forge-setup"
  fi
  local d
  for d in "$ARTIFACTS_ROOT"/*/; do
    [ -d "$d" ] || continue
    [ -f "${d}index.html" ] || continue
    python3 - "$d" <<'PY'
import json, sys
from pathlib import Path
d = Path(sys.argv[1])
meta = d / "meta.json"
title = d.name
shared = False
typ = "html"
if meta.is_file():
    try:
        m = json.loads(meta.read_text(encoding="utf-8"))
        title = m.get("title") or title
        shared = bool(m.get("shared"))
        typ = m.get("type") or typ
    except Exception:
        pass
flag = "share" if shared else "     "
print(f"  catalog {flag:5}  /a/{d.name:28}  [{typ}] {title}")
PY
  done
}

# Re-anchor the KV snapshot record on the deployment the live site is serving,
# keeping its slug set verbatim.
#
# snapshot_record is best-effort: the deploy already succeeded, so one refused
# KV write leaves the record anchored on the PREVIOUS deployment while live has
# moved on. The guard then reads that as untrusted and refuses — and the only
# other way out is --allow-unverified, which rebuilds the record from this
# machine's possibly-stale hub. That is exactly how the 2026-09-06 loss was
# baselined. The record conflates two independent facts, WHAT is live and WHICH
# deployment it describes, and only the second one broke; this rewrites only
# that one.
cmd_reanchor_snapshot() {
  require_forge_config
  source_cf_credentials
  # preflight_cf_mutations, NOT preflight_before_live: this command is the
  # recovery from a guard refusal, so it must not be gated by the guard it
  # repairs. It builds nothing, deploys nothing, and writes one KV key.
  preflight_cf_mutations
  local snap="$LIB_DIR/snapshot.py"
  [ -f "$snap" ] || die "snapshot.py missing from the plugin — cannot re-anchor the record"
  local record="" rec_tmp
  rec_tmp=$(mktemp)
  if kv_get_key "$SNAPSHOT_KV_KEY" >"$rec_tmp" 2>/dev/null; then
    record=$(cat "$rec_tmp")
  fi
  rm -f "$rec_tmp"
  if [ -z "$record" ]; then
    case "${KV_GET_STATUS:-}" in
      denied)
        die "snapshot record read denied — the API token lacks Workers KV read and wrangler OAuth is unavailable; fix the credentials (forge-doctor.sh), then re-run"
        ;;
      error)
        die "snapshot record read failed — re-anchoring cannot rewrite a record it could not read; retry when KV answers"
        ;;
      *)
        die "no snapshot record in KV (${SNAPSHOT_KV_KEY}) — there is nothing to re-anchor: publish once so the record is created"
        ;;
    esac
  fi
  resolve_live_deployment
  if $LIVE_RESOLVED_UNKNOWN; then
    die "live deployment lookup failed — re-anchoring needs the deployment the live site is serving; retry when the Pages API answers"
  fi
  [ -n "$LIVE_RESOLVED_ID" ] || die \
    "the Pages project has no deployment — there is no anchor to move the record to: publish once first"
  local old_id payload
  old_id=$(printf '%s' "$record" | python3 -c 'import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
sys.stdout.write(str(d.get("deployment_id") or ""))' 2>/dev/null) || old_id=""
  # snapshot.py reanchor never invents a record: an empty, null or slug-less
  # one is exit 1, so a failure here leaves KV untouched.
  payload=$(printf '%s' "$record" | PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" \
    python3 "$snap" reanchor --record - --deployment-id "$LIVE_RESOLVED_ID") \
    || die "snapshot reanchor refused — the KV record was left untouched"
  [ -n "$payload" ] || die "snapshot reanchor produced an empty record — refusing to write it to KV"
  if $DRY_RUN; then
    info "dry run — would re-anchor ${SNAPSHOT_KV_KEY} from deployment ${old_id:-<none>} to ${LIVE_RESOLVED_ID} (slug set unchanged, no KV mutation)"
    return 0
  fi
  kv_put_value "$SNAPSHOT_KV_KEY" "$payload" \
    || die "snapshot record re-anchor not written to KV — set a token with Workers KV Edit (or wrangler login), then re-run"
  ok "snapshot record re-anchored: ${old_id:-<none>} → ${LIVE_RESOLVED_ID} (slug set preserved)"
}

cmd_remove() {
  local slug="$1"
  validate_slug "$slug"
  require_forge_config
  [ -n "${ARTIFACTS_ROOT:-}" ] || die "ARTIFACTS_ROOT missing"
  # The one command whose snapshot is regressive by design.
  EXPECTED_REMOVALS="$slug"
  acquire_publish_lock "$slug"
  source_cf_credentials
  preflight_before_live
  kv_clear_artifact_auth "$slug" || die "KV clear failed for $slug — abort remove (fix credentials and retry)"
  $DRY_RUN || info "KV cleared for $slug (share + vis)"
  if $DRY_RUN; then
    info "dry run — would remove hub artifact ${ARTIFACTS_ROOT}/${slug}"
  else
    rm -rf "${ARTIFACTS_ROOT:?}/${slug}"
    ok "removed from hub SSOT: $slug"
  fi
  clone_engine
  enter_dry_run_sandbox
  build_from_hub
  if deploy_pages; then
    hub_index_update
  fi
}

cmd_unshare() {
  local slug="$1"
  validate_slug "$slug"
  require_forge_config
  acquire_publish_lock "$slug"
  source_cf_credentials
  preflight_before_live
  if kv_revoke_share "$slug"; then
    $DRY_RUN || info "KV share:${slug} revoked + vis:private"
  else
    die "KV revoke failed — share link may still work; fix credentials and retry"
  fi
  if $DRY_RUN; then
    info "dry run — would set hub meta shared=false for ${slug}"
  else
    set_hub_shared "$slug" false
  fi
  clone_engine
  enter_dry_run_sandbox
  build_from_hub
  local html inj
  html="$WORK/repo/site/${INTERNAL_PREFIX}/${slug}/index.html"
  if [ -f "$html" ]; then
    inj="$(share_bar_script)"
    python3 "$inj" "$html" --slug "$slug" || true
  fi
  deploy_pages || die "deploy failed after unshare"
  ok "share revoked for $slug"
}

cmd_share_only() {
  local slug="$1"
  validate_slug "$slug"
  require_forge_config
  # Fail before any clone/build/deploy: --share on an unpublished slug used to
  # redeploy the whole site and only then die on the missing hub artifact.
  if [ -n "${ARTIFACTS_ROOT:-}" ] && [ ! -f "${ARTIFACTS_ROOT}/${slug}/index.html" ]; then
    die "hub artifact missing: ${ARTIFACTS_ROOT}/${slug}/index.html — publish the HTML first (publish.sh ${slug} <file.html>), then publish.sh --share ${slug}"
  fi
  acquire_publish_lock "$slug"
  source_cf_credentials
  preflight_before_live
  clone_engine
  enter_dry_run_sandbox
  build_from_hub
  local html inj
  html="$WORK/repo/site/${INTERNAL_PREFIX}/${slug}/index.html"
  if [ -f "$html" ]; then
    inj="$(share_bar_script)"
    python3 "$inj" "$html" --slug "$slug" || true
  fi
  deploy_pages || die "deploy failed — share not activated"
  local url
  url=$(create_share_after_deploy "$slug")
  ok "share mint"
  echo "  URL:   $url"
  hub_index_update "$slug"
}

inject_share_bars() {
  # Overlay on the deploy tree only (hub stays craft SSOT).
  # Clone first, installed plugin as fallback — the same resolution order as
  # build_from_hub (SCRIPTS() tests the directory, not the file, so a clone
  # whose main lacks the script still needs the fallback). Preferring
  # SCRIPT_DIR here made --rebuild-index inject a different share-bar.js from
  # the one publish injects, flipping the hash of every artifact between the
  # two commands.
  local inj
  inj="$(share_bar_script)"
  local s slug html missing=0
  for s in "$WORK/repo/site/${INTERNAL_PREFIX}"/*/; do
    [ -d "$s" ] || continue
    slug=$(basename "$s")
    html="${s}index.html"
    [ -f "$html" ] || continue
    python3 "$inj" "$html" --slug "$slug" || warn "share-bar inject failed $slug"
  done
  for s in "$WORK/repo/site/${INTERNAL_PREFIX}"/*/; do
    [ -d "$s" ] || continue
    slug=$(basename "$s")
    html="${s}index.html"
    [ -f "$html" ] || continue
    if grep -qF '<!-- forge-share-bar -->' "$html"; then
      continue
    fi
    warn "share-bar missing after inject: $slug"
    missing=$((missing + 1))
  done
  [ "$missing" -eq 0 ] || die "share-bar missing on $missing page(s) — abort deploy"
}

cmd_rebuild_index() {
  require_forge_config
  acquire_publish_lock "_global"
  source_cf_credentials
  preflight_before_live
  clone_engine
  enter_dry_run_sandbox
  build_from_hub
  gen_og_images
  # og.jpg is written under site/; persist to the hub before rebuilding
  local s
  for s in "$WORK/repo/site/${INTERNAL_PREFIX}"/*/; do
    [ -d "$s" ] || continue
    persist_og_to_hub "$(basename "$s")"
  done
  build_from_hub
  inject_share_bars
  if deploy_pages; then
    ok "index rebuilt + live on Pages"
    hub_index_update
  fi
}

cmd_publish() {
  local slug="$1"
  shift
  local source="" do_share=false title="" typ="html" desc=""
  if [ $# -gt 0 ] && [[ "${1-}" != --* ]]; then
    source="$1"
    shift
  fi
  while [ $# -gt 0 ]; do
    case "$1" in
      --share)  do_share=true; shift ;;
      --public) die "--public and /p/ are gone. Use --share." ;;
      --title)  title="${2-}"; shift 2 ;;
      --type)   typ="${2-}"; shift 2 ;;
      --desc)   desc="${2-}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option: $1 — see publish.sh --help" ;;
    esac
  done
  validate_slug "$slug"
  require_forge_config
  acquire_publish_lock "$slug"
  source_cf_credentials
  preflight_before_live
  [ -n "$title" ] || title="$slug"

  # resolve source → always land in hub first
  if [ -z "$source" ]; then
    if [ -n "${ARTIFACTS_ROOT:-}" ] && [ -f "${ARTIFACTS_ROOT}/${slug}/index.html" ]; then
      source="${ARTIFACTS_ROOT}/${slug}"
      info "source hub SSOT: $source"
    else
      die "no source for '${slug}': pass an HTML path (publish.sh ${slug} <file.html>) or write ${ARTIFACTS_ROOT:-<artifacts root>}/${slug}/index.html first"
    fi
  fi

  WORK="$(mktemp -d)"
  enter_dry_run_sandbox
  resolve_source "$source"
  write_source_to_hub "$slug"

  local day
  day="$(date -u +%Y-%m-%d)"
  export SLUG="$slug" TITLE="$title" TYP="$typ" DESC="$desc" DAY="$day"
  export INTERNAL_PREFIX="$INTERNAL_PREFIX"
  export SHARED=""   # preserve existing meta.shared
  export OUT="${ARTIFACTS_ROOT}/${slug}/meta.json"
  write_hub_meta

  # WORK already set; do not call clone_engine (it would reset WORK)
  materialize_engine

  build_from_hub

  local dest path_url
  path_url="/${INTERNAL_PREFIX}/${slug}/"
  dest="$WORK/repo/site/${INTERNAL_PREFIX}/${slug}"
  [ -f "$dest/index.html" ] || die "build missing index for $slug"

  # Finalize the title before hashing/rendering. inject-og may update <title>
  # outside its own block; doing that afterwards would make the proof describe
  # the previous source. The forge OG block itself is excluded from identity.
  inject_og_for_slug "$slug" "$title" "$desc" "$path_url"
  gen_og_images "$slug"
  # Repeat after generation so a first publish gains og:image. This only changes
  # the excluded engine-owned block, so the source/image proof remains valid.
  inject_og_for_slug "$slug" "$title" "$desc" "$path_url"
  persist_og_to_hub "$slug"
  # Second chance for the published slug: build-site-from-hub only warns when
  # its own inject fails, so this is the one call that must land.
  local publish_inj
  publish_inj="$(share_bar_script)"
  python3 "$publish_inj" "$dest/index.html" --slug "$slug" || true
  # rebuild registry/index after og inject (og.jpg may be new)
  build_from_hub

  local share_url=""
  if deploy_pages; then
    ok "published (hub SSOT + wrangler Pages)"
    echo "  Team: https://${PUBLIC_HOST}${path_url}  (Access)"
    if $do_share; then
      share_url=$(create_share_after_deploy "$slug")
      echo "  Share:   $share_url  (public, unlisted)"
    fi
    hub_index_update "$slug"
  elif $do_share; then
    warn "deploy failed — share not activated (no KV mutation)"
  fi
}

if [ -n "${FORGE_PUBLISH_LIB_ONLY:-}" ]; then
  # `return` succeeds when sourced; the `exit` runs only when executed.
  # shellcheck disable=SC2317  # reachable via the execute path, not statically
  return 0 2>/dev/null || exit 0
fi
source_cf_credentials

# --dry-run, --allow-removals and --allow-unverified are global: accepted
# anywhere in argv, for every command. Strip them here, before the dispatch,
# so no per-command parser ever sees them.
_dry_run_args=()
for _arg in "$@"; do
  case "$_arg" in
    --dry-run) DRY_RUN=true ;;
    --allow-removals) ALLOW_REMOVALS=true ;;
    --allow-unverified) ALLOW_UNVERIFIED=true ;;
    *) _dry_run_args+=("$_arg") ;;
  esac
done
set -- ${_dry_run_args[@]+"${_dry_run_args[@]}"}
unset _arg _dry_run_args

case "${1-}" in
  ""|-h|--help) usage; exit 0 ;;
  --list) cmd_list ;;
  --remove)
    [ -n "${2-}" ] || die "usage: --remove <slug>"
    cmd_remove "$2"
    ;;
  --unshare)
    [ -n "${2-}" ] || die "usage: --unshare <slug>"
    cmd_unshare "$2"
    ;;
  --rebuild-index) cmd_rebuild_index ;;
  --reanchor-snapshot) cmd_reanchor_snapshot ;;
  --share)
    if [ -n "${2-}" ] && [ -z "${3-}" ]; then
      cmd_share_only "$2"
    else
      die "usage: --share <slug>   or   publish.sh <slug> [path] --share"
    fi
    ;;
  *)
    [ -n "${1-}" ] || { usage; exit 1; }
    cmd_publish "$@"
    ;;
esac
