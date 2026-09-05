#!/usr/bin/env bash
# forge-discover.sh — derive forge.env from an existing Cloudflare Pages forge.
#
#   forge-discover.sh [--project NAME] [--json] [--write]
#
# Works under `wrangler login` OAuth alone — no CLOUDFLARE_API_TOKEN. Scopes
# used: pages (write), workers_kv (write).
#
# --write merges the discovered credentials into ~/.config/silex/forge.env
# (chmod 600) and remembers pages_project in an *existing*
# ~/.config/silex/forge.config.json — it never creates that file, and it never
# writes public_host: the config is pushed to Pages at deploy time, never the
# other way round.
#
# Exit: 0 forge found — values may still be missing; every missing one is
#         reported with the command that fixes it, and forge-doctor.sh keeps
#         exiting 2 until they are set
#       1 wrangler missing, not logged in, or a local prerequisite failed
#       2 named project missing (other names → --project; empty → provision;
#         unparsed → no provision, the wrangler output was not understood)
#
# Never discoverable: hub_root (local vault path) and CLOUDFLARE_API_TOKEN
# (a secret; publish.sh still requires one to deploy). Never read from Pages
# either: public_host and pages_project, which forge.config.json owns.
#
# bash 3.2-safe.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"

MODE="report"
PROJECT=""

# shellcheck source=/dev/null
. "$LIB_DIR/forge_common.sh"
die() { forge_die "$@"; }
info() { forge_info "$@"; }
warn() { forge_warn "$@"; }

# Credentials file (secrets only) and the config file that owns pages_project.
# forge.env never holds pages_project or public_host.
ENV_PATH="${FORGE_ENV:-$HOME/.config/silex/forge.env}"
CONFIG_PATH="${FORGE_CONFIG:-$HOME/.config/silex/forge.config.json}"
RELINK="reinstall or relink the plugin (\`omp plugin install silex-forge@silex-forge\`, or \`omp plugin link ./plugins/silex-forge\` from a checkout)"

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2-}"; [ -n "$PROJECT" ] || die "--project needs a name"; shift 2 ;;
    --json) MODE="json"; shift ;;
    --write) MODE="write"; shift ;;
    -h|--help) sed -n '2,24p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

command -v python3 >/dev/null 2>&1 || die "python3 required — install Python 3.9+ (macOS \`brew install python3\`, Debian/Ubuntu \`sudo apt install python3\`), then re-run forge-discover.sh"
[ -f "$LIB_DIR/discover.py" ] || die "lib missing: $LIB_DIR/discover.py — the plugin install is incomplete; $RELINK, then re-run forge-discover.sh"

# Default project: forge.config pages_project, else silex-forge.
if [ -z "$PROJECT" ]; then
  if [ -f "$LIB_DIR/load_config.py" ]; then
    eval "$(PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" \
      python3 -c 'from load_config import export_env; print(export_env())' 2>/dev/null || true)"
  fi
  PROJECT="${FORGE_PAGES_PROJECT:-silex-forge}"
fi
# Cloudflare Pages accepts lowercase letters, digits and dashes only, so a
# looser check here would persist a name the deploy later rejects.
case "$PROJECT" in
  ""|*[!a-z0-9-]*) die "invalid Pages project name: $PROJECT — Cloudflare Pages allows lowercase letters, digits and dashes only" ;;
esac

# Follow-up command for a key the Pages project did not provide. Pages [vars]
# are pushed from forge.env at deploy time (publish.sh patches wrangler.toml),
# so the fix is a local edit plus a re-deploy, never a dashboard-only change.
missing_hint() {
  case "$1" in
    CLOUDFLARE_ACCOUNT_ID)
      echo "\`wrangler login\` again, then check \`wrangler whoami\` prints an account id" ;;
    FORGE_SHARES_KV_ID)
      echo "create the namespace — \`wrangler kv namespace create SHARES\` — put its id in FORGE_SHARES_KV_ID in ${ENV_PATH}, then re-deploy with publish.sh (or re-run forge-provision.sh on a fresh account)" ;;
    CF_ACCESS_TEAM_DOMAIN)
      echo "set CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com in ${ENV_PATH}, then re-deploy with publish.sh" ;;
    CF_ACCESS_AUD)
      echo "Zero Trust → Access → the login application → copy its AUD into CF_ACCESS_AUD in ${ENV_PATH}, then re-deploy with publish.sh (Functions fail closed without it)" ;;
    SHLINK_API_URL)
      echo "only needed for s.gosilex.com shortlinks — set SHLINK_API_URL in ${ENV_PATH}, then re-deploy with publish.sh" ;;
    *)
      echo "set $1 in ${ENV_PATH}, then re-deploy with publish.sh" ;;
  esac
}

# A forge missing half its values is not a success: name the fix for each one.
report_missing() {
  local k
  # shellcheck disable=SC2086
  for k in $MISSING; do
    echo "  ! $k not set on this project"
    echo "    → $(missing_hint "$k")"
  done
  [ "$MISSING_N" -eq 0 ] || \
    echo "  forge-doctor.sh exits 2 while any of these is missing; re-run \`forge-discover.sh --write\` after fixing them"
}

summary_line() {
  if [ "$MISSING_N" -eq 0 ]; then
    forge_ok "forge found — all discoverable values present"
  else
    forge_ok "forge found — ${MISSING_N} value(s) still missing"
  fi
}

# C2: forge.config.json owns pages_project. Persist the confirmed name so the
# next run needs no --project. Never creates the file — doctor's "no local
# config" issue must stay meaningful, and the forge-setup skill owns creation.
# public_host is deliberately not touched: the config is the source pushed to
# Pages at deploy time, so reading it back from Pages would invert the truth.
remember_project() {
  if ! CONFIG_PATH="$CONFIG_PATH" PROJECT="$PROJECT" python3 - <<'PY'
import json, os, sys
from pathlib import Path

path = Path(os.path.expanduser(os.environ["CONFIG_PATH"]))
if not path.is_file():
    print(f"  ! no local config at {path} — the project name will not be remembered")
    print("    → run /forge-setup to write it (forge-discover.sh never creates it)")
    raise SystemExit(0)
try:
    cfg = json.loads(path.read_text(encoding="utf-8"))
except (OSError, ValueError) as exc:
    print(f"  ✗ cannot read {path}: {type(exc).__name__}", file=sys.stderr)
    raise SystemExit(1)
if not isinstance(cfg, dict):
    print(f"  ✗ {path} is not a JSON object", file=sys.stderr)
    raise SystemExit(1)

changed = []
if cfg.get("pages_project") != os.environ["PROJECT"]:
    cfg["pages_project"] = os.environ["PROJECT"]
    changed.append("pages_project")
if not changed:
    print(f"  pages_project already current in {path}")
    raise SystemExit(0)

# os.replace swaps the *name*, so writing through the given path would turn a
# symlinked config (a dotfiles checkout, common here) into a regular file and
# leave the real one stale. Resolve first, then rename inside its own dir.
try:
    real = path.resolve()
except OSError:
    real = path
tmp = real.with_name(real.name + ".forge-discover.tmp")
try:
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, os.stat(real).st_mode & 0o7777)
    os.replace(tmp, real)
except OSError as exc:
    try:
        tmp.unlink()
    except OSError:
        pass
    print(f"  ✗ cannot write {path}: {type(exc).__name__}", file=sys.stderr)
    raise SystemExit(1)
# Key names only — never the values.
print("  wrote " + ", ".join(changed) + f" → {path}")
PY
  then
    die "could not remember pages_project in ${CONFIG_PATH} — it must be a writable JSON object; fix it (or re-run /forge-setup to rewrite it), then re-run \`forge-discover.sh --write\`"
  fi
}

WR=$(forge_wrangler) || die "wrangler / npx missing — install wrangler, then \`wrangler login\`"

TD="$(mktemp -d)"
trap 'rm -rf "$TD"' EXIT

if ! $WR whoami >"$TD/whoami.txt" 2>"$TD/whoami.err"; then
  echo "✗ wrangler not logged in — run \`wrangler login\`" >&2
  tail -3 "$TD/whoami.err" >&2 || true
  exit 1
fi

if ! $WR pages project list >"$TD/projects.txt" 2>"$TD/projects.err"; then
  echo "✗ cannot list Pages projects — run \`wrangler login\` (needs pages scope)" >&2
  tail -3 "$TD/projects.err" >&2 || true
  exit 1
fi

if ! cls_out="$(
  PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 -c '
import sys
from discover import classify_pages_projects
kind, others = classify_pages_projects(sys.stdin.read(), sys.argv[1])
print(kind)
for name in others:
    print(name)
' "$PROJECT" < "$TD/projects.txt" 2>"$TD/classify.err"
)"; then
  echo "✗ could not classify the Pages project list — the plugin's parser failed" >&2
  tail -5 "$TD/classify.err" >&2 || true
  echo "check: \`PYTHONPATH=${LIB_DIR} python3 -c 'import discover'\` imports; if not, $RELINK, then re-run forge-discover.sh" >&2
  exit 1
fi
kind=$(printf '%s\n' "$cls_out" | sed -n '1p')
others=$(printf '%s\n' "$cls_out" | sed '1d')
case "$kind" in
  hit) ;;
  others)
    echo "✗ no Pages project '${PROJECT}' on this account" >&2
    if [ -n "$others" ]; then
      printf '%s\n' "$others" | sed 's/^/  /' >&2
    fi
    echo "retry: forge-discover.sh --project NAME" >&2
    echo "none of these is a forge → ${SCRIPT_DIR}/forge-provision.sh" >&2
    exit 2
    ;;
  empty)
    echo "✗ no Pages project '${PROJECT}' on this account" >&2
    echo "none of these is a forge → ${SCRIPT_DIR}/forge-provision.sh" >&2
    exit 2
    ;;
  unparsed)
    # A parse failure says nothing about what exists: never provision here, and
    # never suggest --project — the same unreadable list would be re-parsed.
    echo "✗ could not parse \`wrangler pages project list\` output — not creating a new forge" >&2
    tail -5 "$TD/projects.txt" | sed 's/^/    /' >&2 || true
    echo "  a forge may already exist on this account; a second Pages project would split artifacts across two origins" >&2
    echo "check: run \`$WR pages project list\` yourself; if it prints your projects, the plugin's parser needs a fix — $RELINK (a wrangler version mismatch is the usual cause), then re-run forge-discover.sh" >&2
    exit 2
    ;;
  *) die "discovery classify: unexpected ${kind:-empty} — $RELINK, then re-run forge-discover.sh" ;;
esac

# `pages download config` writes ./wrangler.toml in the working directory.
if ! (cd "$TD" && $WR pages download config "$PROJECT" >download.log 2>&1); then
  echo "✗ wrangler pages download config ${PROJECT} failed" >&2
  tail -5 "$TD/download.log" >&2 || true
  echo "check: \`$WR pages project list\` still shows '${PROJECT}', then refresh scopes with \`wrangler login\` (needs pages write)" >&2
  exit 1
fi
if [ ! -f "$TD/wrangler.toml" ]; then
  echo "✗ wrangler wrote no config for ${PROJECT} (expected a wrangler.toml)" >&2
  tail -5 "$TD/download.log" >&2 || true
  echo "check: verify the name with \`$WR pages project list\`, then run \`$WR pages download config ${PROJECT}\` in an empty directory to see what it produces" >&2
  exit 1
fi

PAYLOAD="$TD/payload.json"
if ! PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 "$LIB_DIR/discover.py" \
  "$TD/wrangler.toml" "$TD/whoami.txt" "$PROJECT" > "$PAYLOAD" 2>"$TD/parse.err"; then
  echo "✗ could not parse the config downloaded for ${PROJECT}" >&2
  tail -5 "$TD/parse.err" >&2 || true
  echo "check: run \`$WR pages download config ${PROJECT}\` in an empty directory — if its wrangler.toml looks valid, the plugin's parser needs a fix, so $RELINK, then re-run forge-discover.sh" >&2
  exit 1
fi

MISSING=$(PAYLOAD="$PAYLOAD" python3 - <<'PY'
import json, os
d = json.load(open(os.environ["PAYLOAD"], encoding="utf-8"))
for key in d["missing"]:
    print(key)
PY
) || die "could not read the discovery payload for ${PROJECT} — run \`forge-discover.sh --project ${PROJECT} --json\` and check the output is JSON"
MISSING_N=0
# shellcheck disable=SC2086
for _k in $MISSING; do
  MISSING_N=$((MISSING_N + 1))
done

case "$MODE" in
  json)
    cat "$PAYLOAD"
    ;;
  report)
    if ! PAYLOAD="$PAYLOAD" python3 - <<'PY'
import json, os
d = json.load(open(os.environ["PAYLOAD"], encoding="utf-8"))
print(f"forge-discover — project {d['project']}")
for k in sorted(d["values"]):
    v = d["values"][k]
    print(f"  {k} = " + (f"<set:{len(v)}>" if len(v) > 12 else v))
PY
    then
      die "could not render the discovery payload — run \`forge-discover.sh --project ${PROJECT} --json\` to see the raw values"
    fi
    report_missing
    echo ""
    echo "Still manual: CLOUDFLARE_API_TOKEN (deploy), hub_root (local vault path)"
    summary_line
    ;;
  write)
    ENV_DIR=$(dirname "$ENV_PATH")
    mkdir -p "$ENV_DIR" || die "cannot create ${ENV_DIR} — create it yourself (\`mkdir -p ${ENV_DIR}\`), then re-run \`forge-discover.sh --write\`"
    chmod 700 "$ENV_DIR" 2>/dev/null || \
      warn "could not chmod 700 ${ENV_DIR} — it holds credentials; run \`chmod 700 ${ENV_DIR}\` yourself"
    if ! PAYLOAD="$PAYLOAD" ENV_PATH="$ENV_PATH" LIB_DIR="$LIB_DIR" python3 - <<'PY'
import json, os
from pathlib import Path
import sys
sys.path.insert(0, os.environ["LIB_DIR"])
from discover import merge_env

d = json.load(open(os.environ["PAYLOAD"], encoding="utf-8"))
p = Path(os.environ["ENV_PATH"])
try:
    existing = p.read_text(encoding="utf-8") if p.is_file() else ""
    p.write_text(merge_env(existing, d["values"]), encoding="utf-8")
except OSError as exc:
    print(f"  ✗ cannot write {p}: {type(exc).__name__}", file=sys.stderr)
    raise SystemExit(1)
# Key names only — never the values.
for k in sorted(d["values"]):
    print(f"  wrote {k}")
PY
    then
      die "could not write ${ENV_PATH} — check the directory is writable (\`ls -ld ${ENV_DIR}\`), then re-run \`forge-discover.sh --write\`"
    fi
    chmod 600 "$ENV_PATH" || die "${ENV_PATH} holds credentials but could not be chmod 600 — run \`chmod 600 ${ENV_PATH}\` now, then re-run \`forge-discover.sh --write\` to verify"
    forge_ok "${ENV_PATH} (chmod 600)"
    remember_project
    report_missing
    echo "  still manual: CLOUDFLARE_API_TOKEN (deploy), hub_root (local vault path)"
    summary_line
    ;;
esac
