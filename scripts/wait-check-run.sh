#!/usr/bin/env bash
# Poll GitHub check-runs until a named check concludes success (or fail closed).
# Usage: wait-check-run.sh --sha <sha> --name <check-run-name> [--repo owner/name] [--timeout-sec N]
set -euo pipefail

die() { echo "wait-check-run: $*" >&2; exit 1; }

SHA=""
NAME=""
REPO="${GITHUB_REPOSITORY:-go-silex/unkillable-forge}"
TIMEOUT="${FORGE_CHECK_WAIT_TIMEOUT_SEC:-600}"
INTERVAL=15

while [ "$#" -gt 0 ]; do
  case "$1" in
    --sha) SHA="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --timeout-sec) TIMEOUT="${2:-}"; shift 2 ;;
    *) die "unknown arg: $1" ;;
  esac
done

[ -n "$SHA" ] || die "--sha required"
[ -n "$NAME" ] || die "--name required"
command -v gh >/dev/null 2>&1 || die "gh required"
command -v python3 >/dev/null 2>&1 || die "python3 required"

deadline=$(( $(date +%s) + TIMEOUT ))
while :; do
  payload="$(gh api "repos/${REPO}/commits/${SHA}/check-runs" --paginate 2>/dev/null || echo '{}')"
  state="$(printf '%s' "$payload" | CHECK_NAME="$NAME" python3 -c '
import json, os, sys
name = os.environ["CHECK_NAME"]
raw = sys.stdin.read()
runs = []
try:
    data = json.loads(raw) if raw else {}
    if isinstance(data, dict):
        runs = data.get("check_runs") or []
    elif isinstance(data, list):
        runs = data
except json.JSONDecodeError:
    dec = json.JSONDecoder(); idx = 0
    while idx < len(raw):
        while idx < len(raw) and raw[idx].isspace():
            idx += 1
        if idx >= len(raw):
            break
        obj, end = dec.raw_decode(raw, idx); idx = end
        if isinstance(obj, dict) and "check_runs" in obj:
            runs.extend(obj.get("check_runs") or [])
        elif isinstance(obj, list):
            runs.extend(obj)
matches = [r for r in runs if isinstance(r, dict) and r.get("name") == name]
if not matches:
    print("missing")
else:
    matches.sort(key=lambda r: r.get("id") or 0, reverse=True)
    r = matches[0]
    status = r.get("status") or ""
    conclusion = r.get("conclusion") or ""
    if status != "completed":
        print("pending")
    elif conclusion == "success":
        print("success")
    else:
        print("failed:" + (conclusion or status))
')"
  case "$state" in
    success)
      echo "wait-check-run: $NAME success on ${SHA:0:7}"
      exit 0
      ;;
    failed:*)
      die "$NAME concluded ${state#failed:} on ${SHA:0:7}"
      ;;
    missing|pending)
      now="$(date +%s)"
      if [ "$now" -ge "$deadline" ]; then
        die "timed out waiting for $NAME on ${SHA:0:7} (last=$state)"
      fi
      sleep "$INTERVAL"
      ;;
    *)
      die "unexpected state $state"
      ;;
  esac
done
