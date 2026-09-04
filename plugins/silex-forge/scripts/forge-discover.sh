#!/usr/bin/env bash
# forge-discover.sh — derive forge.env from an existing Cloudflare Pages forge.
#
#   forge-discover.sh [--project NAME] [--json] [--write]
#
# Works under `wrangler login` OAuth alone — no CLOUDFLARE_API_TOKEN. Scopes
# used: pages (write), workers_kv (write).
#
# Exit: 0 forge found and values discovered
#       1 wrangler missing, or not logged in
#       2 named project missing (other names → --project; empty → provision; unparsed → no provision)
#
# Never discoverable: hub_root (local vault path) and CLOUDFLARE_API_TOKEN
# (a secret; publish.sh still requires one to deploy).
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

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2-}"; [ -n "$PROJECT" ] || die "--project needs a name"; shift 2 ;;
    --json) MODE="json"; shift ;;
    --write) MODE="write"; shift ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

command -v python3 >/dev/null 2>&1 || die "python3 required"
[ -f "$LIB_DIR/discover.py" ] || die "lib missing: $LIB_DIR/discover.py"

# Default project: forge.config pages_project, else silex-forge.
if [ -z "$PROJECT" ]; then
  if [ -f "$LIB_DIR/load_config.py" ]; then
    eval "$(PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" \
      python3 -c 'from load_config import export_env; print(export_env())' 2>/dev/null || true)"
  fi
  PROJECT="${FORGE_PAGES_PROJECT:-silex-forge}"
fi
case "$PROJECT" in
  *[!A-Za-z0-9._-]*) die "invalid project name: $PROJECT" ;;
esac

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

cls_out="$(
  PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 -c '
import sys
from discover import classify_pages_projects
kind, others = classify_pages_projects(sys.stdin.read(), sys.argv[1])
print(kind)
for name in others:
    print(name)
' "$PROJECT" < "$TD/projects.txt"
)" || die "discovery parse failed"
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
    echo "✗ no Pages project '${PROJECT}' on this account" >&2
    echo "  could not parse Pages project list — not creating a new forge" >&2
    echo "retry: forge-discover.sh --project NAME" >&2
    exit 2
    ;;
  *) die "discovery classify: unexpected ${kind:-empty}" ;;
esac

# `pages download config` writes ./wrangler.toml in the working directory.
if ! (cd "$TD" && $WR pages download config "$PROJECT" >download.log 2>&1); then
  echo "✗ wrangler pages download config ${PROJECT} failed" >&2
  tail -5 "$TD/download.log" >&2 || true
  exit 1
fi
[ -f "$TD/wrangler.toml" ] || die "wrangler produced no config for ${PROJECT}"

PAYLOAD="$TD/payload.json"
PYTHONPATH="$LIB_DIR${PYTHONPATH:+:$PYTHONPATH}" python3 "$LIB_DIR/discover.py" \
  "$TD/wrangler.toml" "$TD/whoami.txt" "$PROJECT" > "$PAYLOAD" \
  || die "discovery parse failed"

case "$MODE" in
  json)
    cat "$PAYLOAD"
    ;;
  report)
    PAYLOAD="$PAYLOAD" python3 - <<'PY'
import json, os
d = json.load(open(os.environ["PAYLOAD"], encoding="utf-8"))
print(f"forge-discover — project {d['project']}")
for k in sorted(d["values"]):
    v = d["values"][k]
    print(f"  {k} = " + (f"<set:{len(v)}>" if len(v) > 12 else v))
for k in d["missing"]:
    print(f"  ! {k} not set on this project")
print("\nStill manual: CLOUDFLARE_API_TOKEN (deploy), hub_root (local vault path)")
PY
    ;;
  write)
    ENV_PATH="${FORGE_ENV:-$HOME/.config/silex/forge.env}"
    mkdir -p "$(dirname "$ENV_PATH")"
    chmod 700 "$(dirname "$ENV_PATH")" 2>/dev/null || true
    PAYLOAD="$PAYLOAD" ENV_PATH="$ENV_PATH" LIB_DIR="$LIB_DIR" python3 - <<'PY'
import json, os
from pathlib import Path
import sys
sys.path.insert(0, os.environ["LIB_DIR"])
from discover import merge_env

d = json.load(open(os.environ["PAYLOAD"], encoding="utf-8"))
p = Path(os.environ["ENV_PATH"])
existing = p.read_text(encoding="utf-8") if p.is_file() else ""
p.write_text(merge_env(existing, d["values"]), encoding="utf-8")
for k in sorted(d["values"]):
    print(f"  wrote {k}")
for k in d["missing"]:
    print(f"  ! {k} not set on this project")
PY
    chmod 600 "$ENV_PATH"
    echo "✓ ${ENV_PATH} (chmod 600)"
    echo "  still manual: CLOUDFLARE_API_TOKEN (deploy), hub_root (local vault path)"
    ;;
esac
