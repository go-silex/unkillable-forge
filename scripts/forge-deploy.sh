#!/usr/bin/env bash
# Operator verify / deploy / rollback for CI-qualified forge-engine releases.
# Instance configs live outside git. Never prints tokens or config vars.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { echo "forge-deploy: $*" >&2; exit 1; }
info() { echo "forge-deploy: $*" >&2; }

usage() {
  cat <<'EOF'
Usage:
  forge-deploy.sh verify --tag engine/vX.Y.Z [--repo owner/name]
  forge-deploy.sh deploy --instance-dir <dir> --tag engine/vX.Y.Z [--apply-migrations] [--dry-run]
  forge-deploy.sh rollback --instance-dir <dir> --to engine/vX.Y.Z [--dry-run]
EOF
}

DEFAULT_W="$ROOT/node_modules/@cloudflare/vitest-plugin/node_modules/.bin/wrangler"
DEFAULT_CHECKS="${FORGE_REQUIRED_CHECKS:-check,test,test-os / macos-bash32,test-bash32,test-py39}"
DEFAULT_REPO="${FORGE_RELEASE_REPO:-go-silex/unkillable-forge}"

resolve_wrangler() {
  if [ -n "${WRANGLER:-}" ]; then
    [ -x "$WRANGLER" ] || die "WRANGLER is not executable: $WRANGLER"
    printf '%s\n' "$WRANGLER"
    return
  fi
  [ -x "$DEFAULT_W" ] || die "repo-locked wrangler missing at $DEFAULT_W (npm ci or set WRANGLER)"
  printf '%s\n' "$DEFAULT_W"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

parse_tag_version() {
  local tag="$1"
  case "$tag" in
    engine/v[0-9]*.[0-9]*.[0-9]*)
      printf '%s\n' "${tag#engine/v}"
      ;;
    *)
      die "tag must look like engine/vX.Y.Z (got $tag)"
      ;;
  esac
}

semver_ge() {
  python3 - "$1" "$2" <<'PY'
import sys
def t(v):
    a, b, c = v.split(".")
    return int(a), int(b), int(c)
sys.exit(0 if t(sys.argv[1]) >= t(sys.argv[2]) else 1)
PY
}

json_field() {
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1],encoding="utf-8")); print(d[sys.argv[2]])' "$1" "$2"
}

json_nested() {
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1],encoding="utf-8")); cur=d
for k in sys.argv[2].split("."):
  cur=cur[k]
print(cur)' "$1" "$2"
}

validate_role_config() {
  # prints account_id\nname\ndb on success
  python3 - "$1" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding="utf-8"))
if not isinstance(cfg, dict):
    raise SystemExit("config must be a JSON object")
if "build" in cfg:
    raise SystemExit("config has a build key — refuse")
if "main" in cfg:
    raise SystemExit("config must not set main (deploy supplies the release entry)")
account = cfg.get("account_id")
if not isinstance(account, str) or not account.strip():
    raise SystemExit("missing account_id")
name = cfg.get("name")
if not isinstance(name, str) or not name.strip():
    raise SystemExit("missing name")
db = None
for row in cfg.get("d1_databases") or []:
    if isinstance(row, dict) and row.get("binding") == "DB":
        db = row.get("database_name") or row.get("id")
        break
if not isinstance(db, str) or not db:
    raise SystemExit("missing d1_databases entry with binding DB")
print(account)
print(name)
print(db)
PY
}

load_role() {
  local dir="$1" role="$2"
  ROLE_CFG_PATH="$dir/${role}.json"
  [ -f "$ROLE_CFG_PATH" ] || die "missing $ROLE_CFG_PATH"
  local out
  out="$(validate_role_config "$ROLE_CFG_PATH")" || die "invalid ${role} config: $(validate_role_config "$ROLE_CFG_PATH" 2>&1 || true)"
  ROLE_ACCOUNT="$(printf '%s\n' "$out" | sed -n '1p')"
  ROLE_NAME="$(printf '%s\n' "$out" | sed -n '2p')"
  ROLE_DB="$(printf '%s\n' "$out" | sed -n '3p')"
}

ledger_last_name() {
  python3 - "$1" "$2" <<'PY'
import json, sys
path, role = sys.argv[1], sys.argv[2]
try:
    lines = open(path, encoding="utf-8").read().splitlines()
except FileNotFoundError:
    raise SystemExit(0)
for line in reversed(lines):
    if not line.strip():
        continue
    names = json.loads(line).get("workerNames") or {}
    if role in names:
        print(names[role])
        break
PY
}

ledger_last_field() {
  python3 - "$1" "$2" <<'PY'
import json, sys
path, field = sys.argv[1], sys.argv[2]
try:
    lines = open(path, encoding="utf-8").read().splitlines()
except FileNotFoundError:
    raise SystemExit(0)
for line in reversed(lines):
    if line.strip():
        print(json.loads(line).get(field, ""))
        break
PY
}

append_ledger() {
  umask 077
  printf '%s\n' "$2" >>"$1"
}

with_deploy_env() {
  local dir="$1" account="$2"
  shift 2
  [ "${1:-}" = "--" ] || die "with_deploy_env internal usage"
  shift
  local envfile="$dir/deploy.env"
  [ -f "$envfile" ] || die "missing $envfile"
  (
    set -a
    # shellcheck disable=SC1090
    . "$envfile"
    set +a
    [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "CLOUDFLARE_API_TOKEN unset after loading deploy.env"
    export CLOUDFLARE_ACCOUNT_ID="$account"
    "$@"
  )
}

download_release() {
  local tag="$1" repo="$2" dest="$3"
  require_cmd gh
  umask 077
  mkdir -p "$dest"
  (
    cd "$dest"
    gh release download "$tag" --repo "$repo" \
      --pattern 'forge-engine-*.tar.gz' \
      --pattern 'release.json' \
      --pattern 'SHA256SUMS'
  )
}

verify_checksums() {
  require_cmd sha256sum
  (
    cd "$1"
    [ -f SHA256SUMS ] || die "SHA256SUMS missing"
    sha256sum -c SHA256SUMS >/dev/null
  )
}

attest_tarball() {
  local tarball="$1" repo="$2"
  if gh attestation verify --help 2>&1 | grep -q -- '--signer-workflow'; then
    gh attestation verify "$tarball" --repo "$repo" --signer-workflow ".github/workflows/ci.yml" >/dev/null
  else
    gh attestation verify "$tarball" --repo "$repo" >/dev/null
  fi
}

resolve_tag_commit() {
  local repo="$1" tag="$2"
  local ref_json typ sha
  ref_json="$(gh api "repos/${repo}/git/ref/tags/${tag}")"
  typ="$(printf '%s' "$ref_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["object"]["type"])')"
  sha="$(printf '%s' "$ref_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["object"]["sha"])')"
  if [ "$typ" = "tag" ]; then
    sha="$(gh api "repos/${repo}/git/tags/${sha}" --jq '.object.sha')"
  fi
  printf '%s\n' "$sha"
}

extract_release() {
  local archive_dir="$1" extract_to="$2"
  local tarball
  tarball="$(find "$archive_dir" -maxdepth 1 -name 'forge-engine-*.tar.gz' | head -n 1)"
  [ -n "$tarball" ] || die "tarball missing"
  mkdir -p "$extract_to"
  tar -xzf "$tarball" -C "$extract_to"
  if [ ! -f "$extract_to/release.json" ] && [ -f "$archive_dir/release.json" ]; then
    cp -p "$archive_dir/release.json" "$extract_to/release.json"
  fi
  [ -f "$extract_to/release.json" ] || die "release.json missing after extract"
}

prepare_verified_release() {
  local tag="$1" repo="$2" work="$3"
  download_release "$tag" "$repo" "$work/dl"
  verify_checksums "$work/dl"
  local tarball
  tarball="$(find "$work/dl" -maxdepth 1 -name 'forge-engine-*.tar.gz' | head -n 1)"
  [ -n "$tarball" ] || die "tarball missing after download"
  attest_tarball "$tarball" "$repo"
  extract_release "$work/dl" "$work/release"
}

write_temp_wrangler_config() {
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import json, sys
src, main, migrations_dir, out = sys.argv[1:5]
cfg = json.load(open(src, encoding="utf-8"))
if "build" in cfg:
    raise SystemExit("build key present")
if "account_id" not in cfg:
    raise SystemExit("missing account_id")
cfg = dict(cfg)
cfg["main"] = main
if migrations_dir:
    dbs = cfg.get("d1_databases")
    if isinstance(dbs, list):
        rewritten = []
        for row in dbs:
            if isinstance(row, dict):
                r = dict(row)
                r["migrations_dir"] = migrations_dir
                rewritten.append(r)
            else:
                rewritten.append(row)
        cfg["d1_databases"] = rewritten
with open(out, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, sort_keys=True)
    f.write("\n")
PY
}

parse_version_id() {
  # Arg is a file path — do not read stdin (heredoc would steal it).
  python3 - "$1" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
m = re.search(r"Current Version ID:\s*([0-9a-fA-F-]{36})", text)
if not m:
    m = re.search(r"Version ID:\s*([0-9a-fA-F-]{36})", text)
if not m:
    sys.stderr.write("could not parse Worker Version ID from wrangler output\n")
    sys.exit(1)
print(m.group(1))
PY
}

compute_unapplied_migrations() {
  python3 - "$1" "$2" <<'PY'
import json, re, sys
rel = json.load(open(sys.argv[1], encoding="utf-8"))
text = open(sys.argv[2], encoding="utf-8").read()
pending, applied = set(), set()
for line in text.splitlines():
    m = re.search(r"([0-9]{4}_[\w.-]+\.sql)", line)
    if not m:
        continue
    name = m.group(1)
    low = line.lower()
    if "not applied" in low or "pending" in low or "❌" in line or "not yet" in low:
        pending.add(name)
    elif "applied" in low or "✅" in line or "complete" in low:
        applied.add(name)
    else:
        applied.add(name)
if pending:
    needed = [row["name"] for row in rel.get("migrations") or [] if row["name"] in pending]
else:
    needed = [row["name"] for row in rel.get("migrations") or [] if row["name"] not in applied]
for name in needed:
    print(name)
PY
}

unknown_remote_migrations() {
  python3 - "$1" "$2" <<'PY'
import json, re, sys
known = {row["name"] for row in json.load(open(sys.argv[1], encoding="utf-8")).get("migrations") or []}
text = open(sys.argv[2], encoding="utf-8").read()
for name in sorted(set(re.findall(r"([0-9]{4}_[\w.-]+\.sql)", text)) - known):
    print(name)
PY
}

cmd_verify() {
  local tag="" repo="$DEFAULT_REPO"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --tag) tag="${2:-}"; shift 2 ;;
      --repo) repo="${2:-}"; shift 2 ;;
      *) die "unknown verify arg: $1" ;;
    esac
  done
  [ -n "$tag" ] || die "verify requires --tag"
  parse_tag_version "$tag" >/dev/null
  require_cmd gh

  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  chmod 700 "$tmp"
  download_release "$tag" "$repo" "$tmp"
  verify_checksums "$tmp"
  local tarball
  tarball="$(find "$tmp" -maxdepth 1 -name 'forge-engine-*.tar.gz' | head -n 1)"
  [ -n "$tarball" ] || die "tarball missing after download"
  attest_tarball "$tarball" "$repo"

  local tag_sha default_branch default_sha status
  tag_sha="$(resolve_tag_commit "$repo" "$tag")"
  default_branch="$(gh api "repos/${repo}" --jq '.default_branch')"
  default_sha="$(gh api "repos/${repo}/commits/${default_branch}" --jq '.sha')"
  status="$(gh api "repos/${repo}/compare/${tag_sha}...${default_sha}" --jq '.status')"
  case "$status" in
    ahead|identical) ;;
    *) die "tag commit ${tag_sha:0:7} is not an ancestor of ${default_branch} (compare status=$status)" ;;
  esac

  local checks_csv="$DEFAULT_CHECKS" name conclusion
  local IFS=','
  # shellcheck disable=SC2086
  set -- $checks_csv
  unset IFS
  for name in "$@"; do
    name="$(printf '%s' "$name" | sed 's/^ *//;s/ *$//')"
    [ -n "$name" ] || continue
    conclusion="$(gh api "repos/${repo}/commits/${tag_sha}/check-runs" --paginate \
      --jq ".check_runs[] | select(.name == \"$name\") | .conclusion" | head -n 1)"
    [ "$conclusion" = "success" ] || die "required check '$name' not success on ${tag_sha:0:7} (got ${conclusion:-missing})"
  done
  info "verified $tag (commit ${tag_sha:0:7})"
}

deploy_role() {
  # apply_migrations: 0=refuse unapplied, 1=apply, skip=do not gate (rollback)
  local wrangler="$1" instance_dir="$2" role="$3" release_dir="$4" dry_run="$5" apply_migrations="$6"
  load_role "$instance_dir" "$role"
  local ledger="$instance_dir/deploys.jsonl" prev_name
  prev_name="$(ledger_last_name "$ledger" "$role")"
  if [ -n "$prev_name" ] && [ "$prev_name" != "$ROLE_NAME" ]; then
    die "$role worker name '$ROLE_NAME' differs from ledger previous '$prev_name'"
  fi

  local entry entry_abs migrations_dir="" tmpcfg
  entry="$(json_nested "$release_dir/release.json" "entries.$role")"
  entry_abs="$release_dir/$entry"
  [ -f "$entry_abs" ] || die "missing release entry $entry"
  if [ "$role" = "manage" ]; then
    migrations_dir="$release_dir/migrations"
  fi
  tmpcfg="$(mktemp)"
  write_temp_wrangler_config "$ROLE_CFG_PATH" "$entry_abs" "$migrations_dir" "$tmpcfg"

  if [ "$role" = "manage" ] && [ "$apply_migrations" != "skip" ]; then
    local mig_list mig_unapplied
    mig_list="$(mktemp)"
    set +e
    with_deploy_env "$instance_dir" "$ROLE_ACCOUNT" -- \
      "$wrangler" d1 migrations list "$ROLE_DB" --remote --config "$tmpcfg" >"$mig_list" 2>&1
    set -e
    mig_unapplied="$(mktemp)"
    compute_unapplied_migrations "$release_dir/release.json" "$mig_list" >"$mig_unapplied"
    if [ -s "$mig_unapplied" ]; then
      if [ "$apply_migrations" != "1" ]; then
        die "unapplied migrations require --apply-migrations: $(tr '\n' ' ' <"$mig_unapplied")"
      fi
      if [ "$dry_run" = "1" ]; then
        info "dry-run: would apply migrations: $(tr '\n' ' ' <"$mig_unapplied")"
      else
        with_deploy_env "$instance_dir" "$ROLE_ACCOUNT" -- \
          "$wrangler" d1 migrations apply "$ROLE_DB" --remote --config "$tmpcfg"
      fi
    fi
    rm -f "$mig_list" "$mig_unapplied"
  fi

  local deploy_out version_id=""
  deploy_out="$(mktemp)"
  if [ "$dry_run" = "1" ]; then
    info "dry-run: would deploy $role entry $entry as worker (name redacted)"
    version_id="dry-run"
  else
    set +e
    with_deploy_env "$instance_dir" "$ROLE_ACCOUNT" -- \
      "$wrangler" deploy "$entry_abs" --no-bundle --config "$tmpcfg" --keep-vars >"$deploy_out" 2>&1
    local rc=$?
    set -e
    if [ "$rc" -ne 0 ]; then
      tail -n 20 "$deploy_out" | sed -e '/[Tt][Oo][Kk][Ee][Nn]/d' -e '/[Aa]uthorization/d' >&2
      rm -f "$tmpcfg" "$deploy_out"
      die "wrangler deploy failed for $role"
    fi
    version_id="$(parse_version_id "$deploy_out")"
  fi
  rm -f "$tmpcfg" "$deploy_out"
  printf '%s\n' "$version_id"
}

make_ledger_payload() {
  python3 - "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}" <<'PY'
import json, sys
tag, version, source, rollback, mvid, rvid, mname, rname, ts, mode = sys.argv[1:]
print(json.dumps({
    "tag": tag,
    "engineVersion": version,
    "sourceCommit": source,
    "rollbackCompatibleFrom": rollback,
    "workerVersionIds": {"manage": mvid, "read": rvid},
    "workerNames": {"manage": mname, "read": rname},
    "timestamp": ts,
    "mode": mode,
}, sort_keys=True))
PY
}

cmd_deploy() {
  local instance_dir="" tag="" apply_migrations=0 dry_run=0 repo="$DEFAULT_REPO"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --instance-dir) instance_dir="${2:-}"; shift 2 ;;
      --tag) tag="${2:-}"; shift 2 ;;
      --repo) repo="${2:-}"; shift 2 ;;
      --apply-migrations) apply_migrations=1; shift ;;
      --dry-run) dry_run=1; shift ;;
      *) die "unknown deploy arg: $1" ;;
    esac
  done
  [ -n "$instance_dir" ] || die "deploy requires --instance-dir"
  [ -n "$tag" ] || die "deploy requires --tag"
  [ -d "$instance_dir" ] || die "instance-dir not a directory"
  parse_tag_version "$tag" >/dev/null
  require_cmd gh
  require_cmd python3
  local wrangler
  wrangler="$(resolve_wrangler)"

  local work
  work="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$work'" RETURN
  chmod 700 "$work"
  prepare_verified_release "$tag" "$repo" "$work"

  local version source_sha rollback manage_vid read_vid
  version="$(json_field "$work/release/release.json" engineVersion)"
  source_sha="$(json_field "$work/release/release.json" sourceCommit)"
  rollback="$(json_field "$work/release/release.json" rollbackCompatibleFrom)"

  manage_vid="$(deploy_role "$wrangler" "$instance_dir" manage "$work/release" "$dry_run" "$apply_migrations")"
  read_vid="$(deploy_role "$wrangler" "$instance_dir" read "$work/release" "$dry_run" 0)"

  load_role "$instance_dir" manage
  local manage_name="$ROLE_NAME" manage_account="$ROLE_ACCOUNT"
  load_role "$instance_dir" read
  local read_name="$ROLE_NAME" ts mode payload
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  if [ "$dry_run" = "1" ]; then mode="dry-run"; else mode="deploy"; fi
  payload="$(make_ledger_payload "$tag" "$version" "$source_sha" "$rollback" "$manage_vid" "$read_vid" "$manage_name" "$read_name" "$ts" "$mode")"
  if [ "$dry_run" != "1" ]; then
    append_ledger "$instance_dir/deploys.jsonl" "$payload"
  fi
  info "deployed $tag manage=${manage_vid:0:8}… read=${read_vid:0:8}… account=${manage_account:0:4}…"
}

cmd_rollback() {
  local instance_dir="" to="" dry_run=0 repo="$DEFAULT_REPO"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --instance-dir) instance_dir="${2:-}"; shift 2 ;;
      --to) to="${2:-}"; shift 2 ;;
      --repo) repo="${2:-}"; shift 2 ;;
      --dry-run) dry_run=1; shift ;;
      *) die "unknown rollback arg: $1" ;;
    esac
  done
  [ -n "$instance_dir" ] || die "rollback requires --instance-dir"
  [ -n "$to" ] || die "rollback requires --to"
  [ -d "$instance_dir" ] || die "instance-dir not a directory"
  parse_tag_version "$to" >/dev/null
  require_cmd gh
  require_cmd python3
  local wrangler
  wrangler="$(resolve_wrangler)"

  local ledger="$instance_dir/deploys.jsonl" current_tag current_rollback
  current_tag="$(ledger_last_field "$ledger" tag)"
  [ -n "$current_tag" ] || die "ledger empty — cannot determine current release"
  current_rollback="$(ledger_last_field "$ledger" rollbackCompatibleFrom)"

  local work
  work="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$work'" RETURN
  chmod 700 "$work"
  prepare_verified_release "$to" "$repo" "$work"

  local target_version
  target_version="$(json_field "$work/release/release.json" engineVersion)"

  load_role "$instance_dir" manage
  local tmpcfg entry mig_list unknown
  entry="$(json_nested "$work/release/release.json" entries.manage)"
  tmpcfg="$(mktemp)"
  write_temp_wrangler_config "$ROLE_CFG_PATH" "$work/release/$entry" "$work/release/migrations" "$tmpcfg"
  mig_list="$(mktemp)"
  set +e
  with_deploy_env "$instance_dir" "$ROLE_ACCOUNT" -- \
    "$wrangler" d1 migrations list "$ROLE_DB" --remote --config "$tmpcfg" >"$mig_list" 2>&1
  set -e
  unknown="$(unknown_remote_migrations "$work/release/release.json" "$mig_list")"
  rm -f "$tmpcfg" "$mig_list"
  if [ -n "$unknown" ]; then
    if [ -z "$current_rollback" ] || ! semver_ge "$target_version" "$current_rollback"; then
      die "remote D1 has migrations unknown to $to ($unknown); refuse rollback (need target >= current rollbackCompatibleFrom ${current_rollback:-unset})"
    fi
  fi

  local manage_vid read_vid
  manage_vid="$(deploy_role "$wrangler" "$instance_dir" manage "$work/release" "$dry_run" skip)"
  read_vid="$(deploy_role "$wrangler" "$instance_dir" read "$work/release" "$dry_run" skip)"

  load_role "$instance_dir" manage
  local manage_name="$ROLE_NAME" manage_account="$ROLE_ACCOUNT"
  load_role "$instance_dir" read
  local read_name="$ROLE_NAME" version source_sha rollback ts mode payload
  version="$(json_field "$work/release/release.json" engineVersion)"
  source_sha="$(json_field "$work/release/release.json" sourceCommit)"
  rollback="$(json_field "$work/release/release.json" rollbackCompatibleFrom)"
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  if [ "$dry_run" = "1" ]; then mode="dry-run-rollback"; else mode="rollback"; fi
  payload="$(make_ledger_payload "$to" "$version" "$source_sha" "$rollback" "$manage_vid" "$read_vid" "$manage_name" "$read_name" "$ts" "$mode")"
  if [ "$dry_run" != "1" ]; then
    append_ledger "$instance_dir/deploys.jsonl" "$payload"
  fi
  info "rolled back to $to manage=${manage_vid:0:8}… read=${read_vid:0:8}… account=${manage_account:0:4}…"
}

main() {
  [ "$#" -gt 0 ] || { usage; exit 2; }
  local cmd="$1"
  shift
  case "$cmd" in
    verify) cmd_verify "$@" ;;
    deploy) cmd_deploy "$@" ;;
    rollback) cmd_rollback "$@" ;;
    -h|--help|help) usage ;;
    *) die "unknown command: $cmd" ;;
  esac
}

main "$@"
