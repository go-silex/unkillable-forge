#!/usr/bin/env bash
# Operator verify / deploy / rollback for CI-qualified forge-engine releases.
# Instance configs live outside git. Never prints tokens, vars, or raw Wrangler output.
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
# Exact matrix legs are required; prefixes can hide missing jobs.
DEFAULT_CHECKS="check,test,test-os / macos-bash32,test-bash32,test-py39,TruffleHog"
LOCK_DIR=""
DEFAULT_REPO="${FORGE_RELEASE_REPO:-go-silex/unkillable-forge}"
SIGNER_WORKFLOW="${FORGE_SIGNER_WORKFLOW:-go-silex/unkillable-forge/.github/workflows/ci.yml}"

# Session temp root — every temporary file lives here; cleaned on EXIT.
WORK=""
cleanup() {
  if [ -n "$LOCK_DIR" ]; then rmdir "$LOCK_DIR" || info "could not remove instance lock $LOCK_DIR"; fi
  if [ -n "${WORK:-}" ] && [ -d "$WORK" ]; then
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

ensure_work() {
  if [ -z "${WORK:-}" ]; then
    WORK="$(mktemp -d "${TMPDIR:-/tmp}/forge-deploy.XXXXXX")"
    chmod 700 "$WORK"
  fi
}

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

semver_max() {
  if semver_ge "$1" "$2"; then printf '%s\n' "$1"; else printf '%s\n' "$2"; fi
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

# Validate manage/read JSON; print account_id, name, d1_database_id, r2_bucket_name, r2_jurisdiction
validate_role_config() {
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
db_id = None
for row in cfg.get("d1_databases") or []:
    if isinstance(row, dict) and row.get("binding") == "DB":
        db_id = row.get("database_id")
        break
if not isinstance(db_id, str) or not db_id.strip():
    raise SystemExit("missing d1_databases[].database_id for binding DB")
r2 = None
r2_jurisdiction = ""
allowed_jurisdictions = {"eu", "fedramp", "us"}
for row in cfg.get("r2_buckets") or []:
    if isinstance(row, dict) and row.get("binding") == "REVISION_BYTES":
        r2 = row.get("bucket_name")
        if "jurisdiction" not in row:
            r2_jurisdiction = ""
        else:
            # Present means Wrangler sends it: only an exact known string is valid
            # (null, "" and aliases would bind differently from an absent field).
            j = row["jurisdiction"]
            if not isinstance(j, str) or j not in allowed_jurisdictions:
                raise SystemExit(
                    "r2_buckets[].jurisdiction must be absent or exactly eu|fedramp|us "
                    f"(got {j!r}; no null, empty, whitespace or aliases)"
                )
            r2_jurisdiction = j
        break
if not isinstance(r2, str) or not r2.strip():
    raise SystemExit("missing r2_buckets[].bucket_name for binding REVISION_BYTES")
print(account)
print(name)
print(db_id)
print(r2)
print(r2_jurisdiction)
PY
}

load_role() {
  local dir="$1" role="$2"
  ROLE_CFG_PATH="$dir/${role}.json"
  [ -f "$ROLE_CFG_PATH" ] || die "missing $ROLE_CFG_PATH"
  local out
  if ! out="$(validate_role_config "$ROLE_CFG_PATH" 2>"$WORK/cfg.err")"; then
    die "invalid ${role} config: $(tr '\n' ' ' <"$WORK/cfg.err")"
  fi
  ROLE_ACCOUNT="$(printf '%s\n' "$out" | sed -n '1p')"
  ROLE_NAME="$(printf '%s\n' "$out" | sed -n '2p')"
  ROLE_D1_ID="$(printf '%s\n' "$out" | sed -n '3p')"
  ROLE_R2="$(printf '%s\n' "$out" | sed -n '4p')"
  ROLE_R2_JURISDICTION="$(printf '%s\n' "$out" | sed -n '5p')"
}

lock_instance() {
  LOCK_DIR="$1/.forge-deploy.lock"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    LOCK_DIR=""
    die "instance locked; inspect and remove stale .forge-deploy.lock only after confirming no deployment is running"
  fi
  [ ! -e "$1/.forge-migration-pending" ] || die "migration interrupted; reconcile remote D1 and ledger before removing .forge-migration-pending"
}

validate_instance_pair() {
  # args: m_acct m_name m_d1 m_r2 m_jur r_acct r_name r_d1 r_r2 r_jur
  if [ "$1" != "$6" ] || [ "$3" != "$8" ] || [ "$4" != "$9" ] || [ "$5" != "${10}" ]; then
    die "manage and read must share account, D1 and R2"
  fi
  [ "$2" != "$7" ] || die "manage and read Worker names must differ"
}

load_instance_meta() {
  local dir="$1"
  local path="$dir/instance.json"
  [ -f "$path" ] || die "missing $path (required: {\"readVariant\":\"generic\"|\"unkillable\"})"
  READ_VARIANT="$(python3 - "$path" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], encoding="utf-8"))
if not isinstance(cfg, dict) or set(cfg) - {"readVariant"}:
    raise SystemExit("instance.json must contain only readVariant")
v = cfg.get("readVariant")
if v not in ("generic", "unkillable"):
    raise SystemExit("readVariant must be generic|unkillable")
print(v)
PY
)" || die "invalid instance.json"
}

ledger_last_json() {
  python3 - "$1" <<'PY'
import json, sys
path = sys.argv[1]
try:
    lines = [ln for ln in open(path, encoding="utf-8").read().splitlines() if ln.strip()]
except FileNotFoundError:
    print("{}")
    raise SystemExit(0)
print(lines[-1] if lines else "{}")
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
  local tarball="$1" repo="$2" sha="$3"
  gh attestation verify "$tarball" --repo "$repo" --signer-workflow "$SIGNER_WORKFLOW" \
    --source-digest "$sha" --source-ref "refs/heads/main" >/dev/null
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
  [ -f "$extract_to/release.json" ] || die "release.json missing after extract"
}

check_runs_ok() {
  local repo="$1" sha="$2"
  local payload="$WORK/check-runs.json"
  gh api "repos/${repo}/commits/${sha}/check-runs" --paginate >"$payload" || return 1
  CHECKS_CSV="$DEFAULT_CHECKS" python3 - "$payload" <<'PY'
import json, os, sys
raw = open(sys.argv[1], encoding="utf-8").read()
runs = []
try:
    data = json.loads(raw)
    runs = data.get("check_runs") if isinstance(data, dict) else data
except json.JSONDecodeError:
    dec = json.JSONDecoder(); idx = 0
    while idx < len(raw):
        while idx < len(raw) and raw[idx].isspace():
            idx += 1
        if idx >= len(raw):
            break
        obj, end = dec.raw_decode(raw, idx); idx = end
        if isinstance(obj, dict) and "check_runs" in obj:
            runs.extend(obj["check_runs"] or [])
by_name = {}
for r in runs or []:
    if not isinstance(r, dict):
        continue
    n = r.get("name") or ""
    prev = by_name.get(n)
    if prev is None or (r.get("id") or 0) > (prev.get("id") or 0):
        by_name[n] = r
required = [x.strip() for x in os.environ.get("CHECKS_CSV", "").split(",") if x.strip()]
required += [f"publisher-committed ({runner}, {node})"
             for runner in ("ubuntu-22.04", "ubuntu-22.04-arm", "macos-15-intel", "macos-15")
             for node in ("22", "26")]
required += [f"publisher-native-producer ({runner}, {target})"
             for runner, target in (("ubuntu-22.04", "linux-x64"), ("ubuntu-22.04-arm", "linux-arm64"),
                                    ("macos-15-intel", "darwin-x64"), ("macos-15", "darwin-arm64"))]
errors = []
for name in required:
    r = by_name.get(name)
    if not r:
        errors.append(f"missing:{name}")
    elif r.get("conclusion") != "success":
        errors.append(f"{name}:{r.get('conclusion') or r.get('status')}")
if errors:
    raise SystemExit("; ".join(errors))
PY
}

# Full artifact verification used by verify/deploy/rollback.
verify_release_bundle() {
  local tag="$1" repo="$2" archive_dir="$3" extract_to="$4"
  download_release "$tag" "$repo" "$archive_dir"
  verify_checksums "$archive_dir"
  local tarball
  tarball="$(find "$archive_dir" -maxdepth 1 -name 'forge-engine-*.tar.gz' | head -n 1)"
  [ -n "$tarball" ] || die "tarball missing after download"
  local tag_sha version source expected_version
  tag_sha="$(resolve_tag_commit "$repo" "$tag")"
  attest_tarball "$tarball" "$repo" "$tag_sha"
  extract_release "$archive_dir" "$extract_to"
  version="$(json_field "$extract_to/release.json" engineVersion)"
  source="$(json_field "$extract_to/release.json" sourceCommit)"
  expected_version="$(parse_tag_version "$tag")"
  [ "$version" = "$expected_version" ] || die "release.json engineVersion $version ≠ tag $expected_version"
  [ "$source" = "$tag_sha" ] || die "release.json sourceCommit ${source:0:7} ≠ peeled tag ${tag_sha:0:7}"

  local default_branch default_sha status
  default_branch="$(gh api "repos/${repo}" --jq '.default_branch')"
  default_sha="$(gh api "repos/${repo}/commits/${default_branch}" --jq '.sha')"
  status="$(gh api "repos/${repo}/compare/${tag_sha}...${default_sha}" --jq '.status')"
  case "$status" in
    ahead|identical) ;;
    *) die "tag commit ${tag_sha:0:7} is not an ancestor of ${default_branch} (status=$status)" ;;
  esac

  if ! check_runs_ok "$repo" "$tag_sha" 2>"$WORK/checks.err"; then
    die "required checks not green on ${tag_sha:0:7}: $(tr '\n' ' ' <"$WORK/checks.err")"
  fi
  VERIFIED_TAG_SHA="$tag_sha"
  # Retained for callers/tests that inspect verify_release_bundle side effects.
  VERIFIED_VERSION="$version"
  VERIFIED_SOURCE="$source"
  export VERIFIED_TAG_SHA VERIFIED_VERSION VERIFIED_SOURCE
}

write_temp_wrangler_config() {
  # Always .json suffix so Wrangler uses JSON parser (bare mktemp → {}).
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
            if isinstance(row, dict) and row.get("binding") == "DB":
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
  python3 - "$1" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
m = re.search(r"Current Version ID:\s*([0-9a-fA-F-]{36})", text)
if not m:
    m = re.search(r"Version ID:\s*([0-9a-fA-F-]{36})", text)
if not m:
    sys.stderr.write("could not parse Worker Version ID\n")
    sys.exit(1)
print(m.group(1))
PY
}

# Wrangler `d1 migrations list --remote` prints ONLY unapplied filenames (or
# "No migrations to apply" / empty). Fail closed on command errors.
list_unapplied_migrations() {
  local wrangler="$1" instance_dir="$2" account="$3" config="$4" out_file="$5"
  local raw rc
  raw="$WORK/mig-raw.txt"
  set +e
  with_deploy_env "$instance_dir" "$account" -- \
    "$wrangler" d1 migrations list DB --remote --config "$config" >"$raw" 2>"$WORK/mig-err.txt"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    die "d1 migrations list failed (exit $rc) — not treating as empty; dry-run also initializes the migrations table"
  fi
  python3 - "$raw" "$out_file" "$WORK/release/release.json" <<'PY'
import json, re, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
if "no migrations" in text.lower() and "to apply" in text.lower():
    Path(sys.argv[2]).write_text("", encoding="utf-8")
    raise SystemExit(0)
expected = [m["name"] for m in json.load(open(sys.argv[3], encoding="utf-8"))["migrations"]]
names = re.findall(r"(?<![\w.-])([^\s│|]+\.sql)(?![\w.-])", text)
if not names or any(n not in expected for n in names):
    raise SystemExit("unrecognized migrations list output")
out = list(dict.fromkeys(names))
Path(sys.argv[2]).write_text("\n".join(out) + "\n", encoding="utf-8")
PY
}

assert_compatibility_floor() {
  local target_version="$1" floor="$2"
  [ -n "$floor" ] || return 0
  if ! semver_ge "$target_version" "$floor"; then
    die "target engine $target_version < schema floor $floor — refuse (code-only rollback cannot lower D1 floor)"
  fi
}

# Refuse migrations while a partial ledger is unresolved, and require every
# running role's engineVersion (newest non-pending Worker) to meet new_floor.
# Last ledger row is passed via FORGE_LAST_LEDGER_JSON (argv mangles large JSON).
assert_roles_meet_migration_floor() {
  local ledger_path="$1" floor="$2"
  python3 - "$ledger_path" "$floor" <<'PY'
import json, os, sys

def semver(v):
    a, b, c = v.split(".")
    return int(a), int(b), int(c)

path, floor = sys.argv[1:3]
last = json.loads(os.environ.get("FORGE_LAST_LEDGER_JSON") or "{}")
if not last or not floor:
    raise SystemExit(0)
mode = last.get("mode") or ""
if mode in ("partial-manage", "partial-rollback-manage", "pending-migration"):
    raise SystemExit(
        f"unresolved ledger mode {mode} — refuse migrations until both Workers are reconciled"
    )
try:
    lines = [ln for ln in open(path, encoding="utf-8").read().splitlines() if ln.strip()]
except FileNotFoundError:
    lines = []
versions = {"manage": None, "read": None}
for ln in reversed(lines):
    row = json.loads(ln)
    ver = row.get("engineVersion") or ""
    vids = row.get("workerVersionIds") or {}
    for role in versions:
        if versions[role] is None:
            vid = vids.get(role)
            if isinstance(vid, str) and vid and vid != "pending":
                versions[role] = ver
    if all(versions.values()):
        break
missing = [role for role, ver in versions.items() if not ver]
if missing:
    raise SystemExit(
        "cannot determine running version for "
        + ",".join(missing)
        + " — refuse migrations"
    )
weak_role = min(versions, key=lambda role: semver(versions[role]))
if semver(versions[weak_role]) < semver(floor):
    raise SystemExit(
        f"running Workers manage={versions['manage']} read={versions['read']} "
        f"< new schema floor {floor} — deploy a compatible intermediate release "
        "before applying contract migrations"
    )
PY
}

ledger_schema_floor() {
  python3 - "$1" <<'PY'
import json, sys
row = json.loads(sys.argv[1] or "{}")
print(row.get("schemaFloor") or row.get("rollbackCompatibleFrom") or "")
PY
}

preflight_bindings() {
  local ledger_json="$1" role="$2" account="$3" name="$4" d1="$5" r2="$6" r2j="$7"
  python3 - "$ledger_json" "$role" "$account" "$name" "$d1" "$r2" "$r2j" <<'PY'
import json, sys
row, role, account, name, d1, r2, r2j = sys.argv[1:8]
data = json.loads(row or "{}")
if not data:
    raise SystemExit(0)
names = data.get("workerNames") or {}
if role in names and names[role] != name:
    raise SystemExit(f"{role} name {name!r} ≠ ledger {names[role]!r}")
binds = (data.get("bindings") or {}).get(role) or {}
if binds.get("account_id") and binds["account_id"] != account:
    raise SystemExit(f"{role} account_id drift")
if binds.get("d1_database_id") and binds["d1_database_id"] != d1:
    raise SystemExit(f"{role} d1_database_id drift")
if binds.get("r2_bucket_name") and binds["r2_bucket_name"] != r2:
    raise SystemExit(f"{role} r2_bucket_name drift")
if "r2_jurisdiction" in binds and (binds.get("r2_jurisdiction") or "") != (r2j or ""):
    raise SystemExit(f"{role} r2_jurisdiction drift")
PY
}

ledger_has_completed() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys
path, tag, sha = sys.argv[1:4]
completed = {"deploy", "rollback"}
try:
    lines = [ln for ln in open(path, encoding="utf-8").read().splitlines() if ln.strip()]
except FileNotFoundError:
    raise SystemExit(1)
for ln in lines:
    row = json.loads(ln)
    if row.get("mode") in completed and row.get("tag") == tag and row.get("sourceCommit") == sha:
        raise SystemExit(0)
raise SystemExit(1)
PY
}

make_ledger_payload() {
  python3 - <<'PY'
import json, sys
# argv via env to avoid huge command lines
import os
print(json.dumps({
  "tag": os.environ["L_TAG"],
  "engineVersion": os.environ["L_VERSION"],
  "sourceCommit": os.environ["L_SOURCE"],
  "rollbackCompatibleFrom": os.environ["L_ROLLBACK"],
  "schemaFloor": os.environ["L_FLOOR"],
  "workerVersionIds": {"manage": os.environ["L_MVID"], "read": os.environ["L_RVID"]},
  "workerNames": {"manage": os.environ["L_MNAME"], "read": os.environ["L_RNAME"]},
  "bindings": {
    "manage": {
      "account_id": os.environ["L_MACCT"],
      "d1_database_id": os.environ["L_MD1"],
      "r2_bucket_name": os.environ["L_MR2"],
      "r2_jurisdiction": os.environ.get("L_MR2J", ""),
    },
    "read": {
      "account_id": os.environ["L_RACCT"],
      "d1_database_id": os.environ["L_RD1"],
      "r2_bucket_name": os.environ["L_RR2"],
      "r2_jurisdiction": os.environ.get("L_RR2J", ""),
    },
  },
  "readVariant": os.environ["L_VARIANT"],
  "timestamp": os.environ["L_TS"],
  "mode": os.environ["L_MODE"],
}, sort_keys=True))
PY
}

cmd_verify() {
  ensure_work
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
  verify_release_bundle "$tag" "$repo" "$WORK/dl" "$WORK/release"
  info "verified $tag (commit ${VERIFIED_TAG_SHA:0:7})"
}

deploy_one_role() {
  # Prints ONLY the Worker Version ID on stdout.
  # apply_migrations: 0|1|skip
  local wrangler="$1" instance_dir="$2" role="$3" release_dir="$4" dry_run="$5" apply_migrations="$6" entry_key="$7"
  local entry entry_abs migrations_dir="" tmpcfg mig_list
  entry="$(json_nested "$release_dir/release.json" "entries.$entry_key")"
  entry_abs="$release_dir/$entry"
  [ -f "$entry_abs" ] || die "missing release entry $entry"
  if [ "$role" = "manage" ]; then
    migrations_dir="$release_dir/migrations"
  fi
  tmpcfg="$WORK/${role}.wrangler.json"
  write_temp_wrangler_config "$ROLE_CFG_PATH" "$entry_abs" "$migrations_dir" "$tmpcfg"

  if [ "$role" = "manage" ] && [ "$apply_migrations" != "skip" ]; then
    mig_list="$WORK/unapplied.txt"
    # Listing initializes the remote migrations table, so every dry run skips it.
    if [ "$dry_run" = "1" ]; then
      info "dry-run: skipping remote migrations list (initializes table on fresh D1)"
      : >"$mig_list"
    else
      list_unapplied_migrations "$wrangler" "$instance_dir" "$ROLE_ACCOUNT" "$tmpcfg" "$mig_list"
    fi
    if [ -s "$mig_list" ]; then
      if [ "$apply_migrations" != "1" ]; then
        die "unapplied migrations require --apply-migrations: $(tr '\n' ' ' <"$mig_list")"
      fi
      # Contract migrations raise the floor; both running roles must already meet it.
      if [ -n "${new_floor:-}" ]; then
        if ! FORGE_LAST_LEDGER_JSON="${prev:-"{}"}" assert_roles_meet_migration_floor "${ledger:-}" "$new_floor" 2>"$WORK/mig-floor.err"; then
          die "$(tr '\n' ' ' <"$WORK/mig-floor.err")"
        fi
      fi
      if [ "$dry_run" = "1" ]; then
        info "dry-run: would apply migrations: $(tr '\n' ' ' <"$mig_list")"
      else
        # Persist the floor before Wrangler can commit the first migration.
        local pending_ts
        pending_ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
        export L_TAG="$tag" L_VERSION="$version" L_SOURCE="$source_sha" L_ROLLBACK="$rollback" L_FLOOR="$new_floor" \
          L_MVID="pending" L_RVID="pending" L_MNAME="$m_name" L_RNAME="$r_name" \
          L_MACCT="$m_account" L_MD1="$m_d1" L_MR2="$m_r2" L_MR2J="$m_r2j" L_RACCT="$r_account" L_RD1="$r_d1" L_RR2="$r_r2" L_RR2J="$r_r2j" \
          L_VARIANT="$READ_VARIANT" L_TS="$pending_ts" L_MODE="pending-migration"
        (umask 077; printf '%s\n' "Reconcile D1 and deploys.jsonl before removing this marker." >"$instance_dir/.forge-migration-pending")
        append_ledger "$ledger" "$(make_ledger_payload)"
        local mig_out="$WORK/mig-apply.txt"
        set +e
        with_deploy_env "$instance_dir" "$ROLE_ACCOUNT" -- \
          "$wrangler" d1 migrations apply DB --remote --config "$tmpcfg" >"$mig_out" 2>"$WORK/mig-apply.err"
        local mrc=$?
        set -e
        if [ "$mrc" -ne 0 ]; then
          die "d1 migrations apply failed (exit $mrc)"
        fi
      fi
    fi
  fi

  if [ "$dry_run" = "1" ]; then
    info "dry-run: would deploy $role entry $entry"
    printf '%s\n' "dry-run"
    return 0
  fi

  local deploy_out="$WORK/${role}-deploy.txt"
  set +e
  with_deploy_env "$instance_dir" "$ROLE_ACCOUNT" -- \
    "$wrangler" deploy "$entry_abs" --no-bundle --config "$tmpcfg" --keep-vars >"$deploy_out" 2>"$WORK/${role}-deploy.err"
  local rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    # Allowlisted summary only — never relay Wrangler bindings/vars.
    die "wrangler deploy failed for $role (exit $rc); see private log $WORK/${role}-deploy.err (not echoed)"
  fi
  parse_version_id "$deploy_out"
}

cmd_deploy() {
  ensure_work
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

  load_instance_meta "$instance_dir"
  local read_entry_key
  if [ "$READ_VARIANT" = "generic" ]; then read_entry_key="read"; else read_entry_key="read-unkillable"; fi

  # Preflight both roles before any mutation.
  load_role "$instance_dir" manage
  local m_account="$ROLE_ACCOUNT" m_name="$ROLE_NAME" m_d1="$ROLE_D1_ID" m_r2="$ROLE_R2" m_r2j="$ROLE_R2_JURISDICTION" m_cfg="$ROLE_CFG_PATH"
  load_role "$instance_dir" read
  local r_account="$ROLE_ACCOUNT" r_name="$ROLE_NAME" r_d1="$ROLE_D1_ID" r_r2="$ROLE_R2" r_r2j="$ROLE_R2_JURISDICTION" r_cfg="$ROLE_CFG_PATH"
  validate_instance_pair "$m_account" "$m_name" "$m_d1" "$m_r2" "$m_r2j" "$r_account" "$r_name" "$r_d1" "$r_r2" "$r_r2j"
  lock_instance "$instance_dir"

  local ledger="$instance_dir/deploys.jsonl"
  local prev
  prev="$(ledger_last_json "$ledger")"
  preflight_bindings "$prev" manage "$m_account" "$m_name" "$m_d1" "$m_r2" "$m_r2j" || die "manage binding preflight failed"
  preflight_bindings "$prev" read "$r_account" "$r_name" "$r_d1" "$r_r2" "$r_r2j" || die "read binding preflight failed"

  verify_release_bundle "$tag" "$repo" "$WORK/dl" "$WORK/release"

  local version source_sha rollback floor
  version="$(json_field "$WORK/release/release.json" engineVersion)"
  source_sha="$(json_field "$WORK/release/release.json" sourceCommit)"
  rollback="$(json_field "$WORK/release/release.json" rollbackCompatibleFrom)"
  floor="$(ledger_schema_floor "$prev")"
  assert_compatibility_floor "$version" "$floor"

  local new_floor
  if [ -n "$floor" ]; then new_floor="$(semver_max "$floor" "$rollback")"; else new_floor="$rollback"; fi


  # Deploy manage then read; record partial state if read fails after manage.
  ROLE_CFG_PATH="$m_cfg" ROLE_ACCOUNT="$m_account"
  local manage_vid
  manage_vid="$(deploy_one_role "$wrangler" "$instance_dir" manage "$WORK/release" "$dry_run" "$apply_migrations" manage)"

  if [ "$dry_run" != "1" ]; then
    local partial_ts partial
    partial_ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    export L_TAG="$tag" L_VERSION="$version" L_SOURCE="$source_sha" L_ROLLBACK="$rollback" L_FLOOR="$new_floor" \
      L_MVID="$manage_vid" L_RVID="pending" L_MNAME="$m_name" L_RNAME="$r_name" \
      L_MACCT="$m_account" L_MD1="$m_d1" L_MR2="$m_r2" L_MR2J="$m_r2j" L_RACCT="$r_account" L_RD1="$r_d1" L_RR2="$r_r2" L_RR2J="$r_r2j" \
      L_VARIANT="$READ_VARIANT" L_TS="$partial_ts" L_MODE="partial-manage"
    partial="$(make_ledger_payload)"
    append_ledger "$ledger" "$partial"
  fi

  ROLE_CFG_PATH="$r_cfg" ROLE_ACCOUNT="$r_account"
  local read_vid
  read_vid="$(deploy_one_role "$wrangler" "$instance_dir" read "$WORK/release" "$dry_run" 0 "$read_entry_key")"

  local ts mode payload
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  if [ "$dry_run" = "1" ]; then mode="dry-run"; else mode="deploy"; fi
  export L_TAG="$tag" L_VERSION="$version" L_SOURCE="$source_sha" L_ROLLBACK="$rollback" L_FLOOR="$new_floor" \
    L_MVID="$manage_vid" L_RVID="$read_vid" L_MNAME="$m_name" L_RNAME="$r_name" \
    L_MACCT="$m_account" L_MD1="$m_d1" L_MR2="$m_r2" L_MR2J="$m_r2j" L_RACCT="$r_account" L_RD1="$r_d1" L_RR2="$r_r2" L_RR2J="$r_r2j" \
    L_VARIANT="$READ_VARIANT" L_TS="$ts" L_MODE="$mode"
  payload="$(make_ledger_payload)"
  if [ "$dry_run" != "1" ]; then
    append_ledger "$ledger" "$payload"
    rm -f "$instance_dir/.forge-migration-pending"
  fi
  info "deployed $tag manage=${manage_vid:0:8}… read=${read_vid:0:8}… variant=$READ_VARIANT"
}

cmd_rollback() {
  ensure_work
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

  load_instance_meta "$instance_dir"
  local read_entry_key
  if [ "$READ_VARIANT" = "generic" ]; then read_entry_key="read"; else read_entry_key="read-unkillable"; fi

  load_role "$instance_dir" manage
  local m_account="$ROLE_ACCOUNT" m_name="$ROLE_NAME" m_d1="$ROLE_D1_ID" m_r2="$ROLE_R2" m_r2j="$ROLE_R2_JURISDICTION" m_cfg="$ROLE_CFG_PATH"
  load_role "$instance_dir" read
  local r_account="$ROLE_ACCOUNT" r_name="$ROLE_NAME" r_d1="$ROLE_D1_ID" r_r2="$ROLE_R2" r_r2j="$ROLE_R2_JURISDICTION" r_cfg="$ROLE_CFG_PATH"
  validate_instance_pair "$m_account" "$m_name" "$m_d1" "$m_r2" "$m_r2j" "$r_account" "$r_name" "$r_d1" "$r_r2" "$r_r2j"
  lock_instance "$instance_dir"

  local ledger="$instance_dir/deploys.jsonl"
  local prev floor
  prev="$(ledger_last_json "$ledger")"
  [ "$prev" != "{}" ] || die "ledger empty — cannot determine schema floor"
  floor="$(ledger_schema_floor "$prev")"
  preflight_bindings "$prev" manage "$m_account" "$m_name" "$m_d1" "$m_r2" "$m_r2j" || die "manage binding preflight failed"
  preflight_bindings "$prev" read "$r_account" "$r_name" "$r_d1" "$r_r2" "$r_r2j" || die "read binding preflight failed"

  verify_release_bundle "$to" "$repo" "$WORK/dl" "$WORK/release"
  local target_version source_sha rollback
  target_version="$(json_field "$WORK/release/release.json" engineVersion)"
  source_sha="$(json_field "$WORK/release/release.json" sourceCommit)"
  rollback="$(json_field "$WORK/release/release.json" rollbackCompatibleFrom)"

  local prev_mode prev_tag prev_source resume_partial=0
  prev_mode="$(printf '%s' "$prev" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("mode") or "")')"
  prev_tag="$(printf '%s' "$prev" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tag") or "")')"
  prev_source="$(printf '%s' "$prev" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("sourceCommit") or "")')"
  if [ "$prev_mode" = "partial-rollback-manage" ] && [ "$prev_tag" = "$to" ] && [ "$prev_source" = "$source_sha" ]; then
    resume_partial=1
  fi

  if [ "$resume_partial" != "1" ]; then
    local current_version
    current_version="$(printf '%s' "$prev" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("engineVersion", ""))')"
    if [ -z "$current_version" ] || ! semver_ge "$current_version" "$target_version" || [ "$current_version" = "$target_version" ]; then
      die "rollback target must be older than the current release"
    fi
    ledger_has_completed "$ledger" "$to" "$source_sha" || die "rollback target $to must match a completed deployment on this instance"
  fi
  floor="$(semver_max "$floor" "$rollback")"
  assert_compatibility_floor "$target_version" "$floor"

  # Target must not require applying migrations (code-only rollback).
  ROLE_CFG_PATH="$m_cfg" ROLE_ACCOUNT="$m_account"
  local tmpcfg="$WORK/rollback.wrangler.json" entry
  entry="$(json_nested "$WORK/release/release.json" entries.manage)"
  write_temp_wrangler_config "$m_cfg" "$WORK/release/$entry" "$WORK/release/migrations" "$tmpcfg"
  if [ "$dry_run" != "1" ]; then
    local mig_list="$WORK/unapplied.txt"
    list_unapplied_migrations "$wrangler" "$instance_dir" "$m_account" "$tmpcfg" "$mig_list"
    # Unapplied relative to *target* means target expects migrations not on D1.
    # For rollback to older code, list should be empty (all target migrations already applied).
    if [ -s "$mig_list" ]; then
      die "target $to has unapplied migrations on remote ($(tr '\n' ' ' <"$mig_list")) — refuse code-only rollback"
    fi
  else
    info "dry-run: skipping migrations list on rollback (list mutates empty remotes)"
  fi

  local manage_vid read_vid
  if [ "$resume_partial" = "1" ]; then
    manage_vid="$(printf '%s' "$prev" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("workerVersionIds") or {}).get("manage") or "")')"
    if [ -z "$manage_vid" ] || [ "$manage_vid" = "pending" ]; then
      die "partial rollback ledger missing manage version id"
    fi
    info "resuming partial rollback: manage already at $to"
  else
    ROLE_CFG_PATH="$m_cfg" ROLE_ACCOUNT="$m_account"
    manage_vid="$(deploy_one_role "$wrangler" "$instance_dir" manage "$WORK/release" "$dry_run" skip manage)"
    if [ "$dry_run" != "1" ]; then
      local partial_rollback_ts
      partial_rollback_ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
      export L_TAG="$to" L_VERSION="$target_version" L_SOURCE="$source_sha" L_ROLLBACK="$rollback" L_FLOOR="$floor" \
        L_MVID="$manage_vid" L_RVID="pending" L_MNAME="$m_name" L_RNAME="$r_name" \
        L_MACCT="$m_account" L_MD1="$m_d1" L_MR2="$m_r2" L_MR2J="$m_r2j" L_RACCT="$r_account" L_RD1="$r_d1" L_RR2="$r_r2" L_RR2J="$r_r2j" \
        L_VARIANT="$READ_VARIANT" L_TS="$partial_rollback_ts" L_MODE="partial-rollback-manage"
      append_ledger "$ledger" "$(make_ledger_payload)"
    fi
  fi
  ROLE_CFG_PATH="$r_cfg" ROLE_ACCOUNT="$r_account"
  read_vid="$(deploy_one_role "$wrangler" "$instance_dir" read "$WORK/release" "$dry_run" skip "$read_entry_key")"

  local ts mode payload
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  if [ "$dry_run" = "1" ]; then mode="dry-run-rollback"; else mode="rollback"; fi
  # schemaFloor preserved from previous ledger (never lowered).
  export L_TAG="$to" L_VERSION="$target_version" L_SOURCE="$source_sha" L_ROLLBACK="$rollback" L_FLOOR="$floor" \
    L_MVID="$manage_vid" L_RVID="$read_vid" L_MNAME="$m_name" L_RNAME="$r_name" \
    L_MACCT="$m_account" L_MD1="$m_d1" L_MR2="$m_r2" L_MR2J="$m_r2j" L_RACCT="$r_account" L_RD1="$r_d1" L_RR2="$r_r2" L_RR2J="$r_r2j" \
    L_VARIANT="$READ_VARIANT" L_TS="$ts" L_MODE="$mode"
  payload="$(make_ledger_payload)"
  if [ "$dry_run" != "1" ]; then
    append_ledger "$ledger" "$payload"
  fi
  info "rolled back to $to manage=${manage_vid:0:8}… read=${read_vid:0:8}… floor=$floor"
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
cleanup
trap - EXIT
