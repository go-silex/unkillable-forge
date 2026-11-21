#!/usr/bin/env bash
# Build a deterministic forge-engine-<version>.tar.gz from the locked checkout.
# Usage: scripts/build-engine-release.sh <outdir>
# Requires: npm ci already done; wrangler via the repo-locked path (or $WRANGLER).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

die() { echo "build-engine-release: $*" >&2; exit 1; }

[ "$#" -eq 1 ] || die "usage: $0 <outdir>"
OUTDIR="$1"
[ -n "$OUTDIR" ] || die "outdir required"
mkdir -p "$OUTDIR"
OUTDIR="$(cd "$OUTDIR" && pwd)"

command -v python3 >/dev/null 2>&1 || die "python3 required"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum required"
command -v tar >/dev/null 2>&1 || die "tar required"

ENGINE_JSON="$ROOT/engine.json"
[ -f "$ENGINE_JSON" ] || die "missing engine.json"
VERSION="$(python3 "$ROOT/scripts/check_plugin_versions.py" --print-engine-version)"
ROLLBACK="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["rollbackCompatibleFrom"])' "$ENGINE_JSON")"
SOURCE_SHA="$(git -C "$ROOT" rev-parse HEAD)"

DEFAULT_W="$ROOT/node_modules/@cloudflare/vitest-plugin/node_modules/.bin/wrangler"
WRANGLER_BIN="${WRANGLER:-$DEFAULT_W}"
[ -x "$WRANGLER_BIN" ] || die "wrangler not executable at $WRANGLER_BIN (run npm ci or set WRANGLER)"

WRANGLER_VERSION="$("$WRANGLER_BIN" --version 2>/dev/null | head -n 1 | tr -d '\r' || true)"
[ -n "$WRANGLER_VERSION" ] || die "could not read wrangler version"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"
mkdir "$WORK/home" "$WORK/manage" "$WORK/read" "$WORK/stage"
: >"$WORK/empty.env"
umask 077

# Offline dry-run packaging — same env isolation as docs/forge-manual-ops.md.
env -i \
  PATH="$PATH" \
  HOME="$WORK/home" \
  CI=1 \
  WRANGLER_SEND_METRICS=false \
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
  "$WRANGLER_BIN" deploy --dry-run \
  --config "$ROOT/wrangler.manage.toml" \
  --env-file "$WORK/empty.env" \
  --outdir "$WORK/manage"

env -i \
  PATH="$PATH" \
  HOME="$WORK/home" \
  CI=1 \
  WRANGLER_SEND_METRICS=false \
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
  "$WRANGLER_BIN" deploy --dry-run \
  --config "$ROOT/wrangler.read.toml" \
  --env-file "$WORK/empty.env" \
  --outdir "$WORK/read"

STAGE="$WORK/stage"
mkdir -p "$STAGE/manage" "$STAGE/read" "$STAGE/migrations"

# Keep every emitted module (read has Data/Text siblings).
find "$WORK/manage" -type f -print0 | while IFS= read -r -d '' f; do
  rel="${f#"$WORK/manage/"}"
  mkdir -p "$STAGE/manage/$(dirname "$rel")"
  cp -p "$f" "$STAGE/manage/$rel"
done
find "$WORK/read" -type f -print0 | while IFS= read -r -d '' f; do
  rel="${f#"$WORK/read/"}"
  mkdir -p "$STAGE/read/$(dirname "$rel")"
  cp -p "$f" "$STAGE/read/$rel"
done

for mig in "$ROOT"/migrations/*.sql; do
  [ -f "$mig" ] || continue
  cp -p "$mig" "$STAGE/migrations/$(basename "$mig")"
done

# Detect manage/read JS entry modules (primary .js without sibling-only assets).
MANAGE_ENTRY="$(python3 - "$STAGE/manage" <<'PY'
import sys
from pathlib import Path
root = Path(sys.argv[1])
cands = sorted(p for p in root.rglob("*.js") if p.is_file())
prefer = [p for p in cands if "manageWorker" in p.name or p.name == "index.js"]
pick = prefer[0] if prefer else (cands[0] if cands else None)
if pick is None:
    sys.exit("no manage JS module")
print(pick.relative_to(root).as_posix())
PY
)"

READ_ENTRY="$(python3 - "$STAGE/read" <<'PY'
import sys
from pathlib import Path
root = Path(sys.argv[1])
cands = sorted(p for p in root.rglob("*.js") if p.is_file())
prefer = [p for p in cands if "unkillableReadWorker" in p.name or "readWorker" in p.name or p.name == "index.js"]
pick = prefer[0] if prefer else (cands[0] if cands else None)
if pick is None:
    sys.exit("no read JS module")
print(pick.relative_to(root).as_posix())
PY
)"

COMPAT_DATE="$(python3 - <<'PY'
import re
from pathlib import Path
text = Path("wrangler.manage.toml").read_text(encoding="utf-8")
m = re.search(r'^compatibility_date\s*=\s*"([^"]+)"', text, re.M)
print(m.group(1) if m else "")
PY
)"
COMPAT_FLAGS="$(python3 - <<'PY'
import json, re
from pathlib import Path
text = Path("wrangler.manage.toml").read_text(encoding="utf-8")
m = re.search(r'^compatibility_flags\s*=\s*\[([^\]]*)\]', text, re.M)
flags = []
if m:
    flags = re.findall(r'"([^"]+)"', m.group(1))
print(json.dumps(flags))
PY
)"

RELEASE_JSON="$STAGE/release.json"
python3 - "$STAGE" "$VERSION" "$ROLLBACK" "$SOURCE_SHA" "$WRANGLER_VERSION" "$COMPAT_DATE" "$COMPAT_FLAGS" "$MANAGE_ENTRY" "$READ_ENTRY" "$RELEASE_JSON" <<'PY'
import hashlib, json, sys
from pathlib import Path

stage = Path(sys.argv[1])
version, rollback, source_sha, wrangler_version = sys.argv[2:6]
compat_date = sys.argv[6]
compat_flags = json.loads(sys.argv[7])
manage_entry, read_entry = sys.argv[8], sys.argv[9]
out = Path(sys.argv[10])

def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

modules = []
for role in ("manage", "read"):
    root = stage / role
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        rel = f"{role}/{path.relative_to(root).as_posix()}"
        entry = False
        if role == "manage" and path.relative_to(root).as_posix() == manage_entry:
            entry = True
        if role == "read" and path.relative_to(root).as_posix() == read_entry:
            entry = True
        modules.append({
            "path": rel,
            "sha256": sha256(path),
            "entry": entry,
            "role": role,
        })

migrations = []
mig_root = stage / "migrations"
for path in sorted(mig_root.glob("*.sql")):
    migrations.append({"name": path.name, "sha256": sha256(path)})

doc = {
    "engineVersion": version,
    "rollbackCompatibleFrom": rollback,
    "sourceCommit": source_sha,
    "wranglerVersion": wrangler_version,
    "compatibilityDate": compat_date,
    "compatibilityFlags": compat_flags,
    "entries": {"manage": f"manage/{manage_entry}", "read": f"read/{read_entry}"},
    "modules": modules,
    "migrations": migrations,
}
out.write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

TARBALL_NAME="forge-engine-${VERSION}.tar.gz"
TARBALL="$OUTDIR/$TARBALL_NAME"

# Deterministic archive: sorted members, fixed mtime/owner.
(
  cd "$STAGE"
  find . -type f | sed 's|^\./||' | LC_ALL=C sort | tar \
    --numeric-owner --owner=0 --group=0 \
    --mtime='UTC 1970-01-01' \
    --mode='u=rw,go=r' \
    -cf - -T - | gzip -n >"$TARBALL"
)

# Also place a copy of release.json beside the tarball for CI attestation subjects.
cp -p "$RELEASE_JSON" "$OUTDIR/release.json"

{
  sha256sum "$TARBALL" | awk -v name="$TARBALL_NAME" '{print $1 "  " name}'
  sha256sum "$OUTDIR/release.json" | awk '{print $1 "  release.json"}'
} | LC_ALL=C sort >"$OUTDIR/SHA256SUMS"

echo "built $TARBALL"
echo "wrote $OUTDIR/release.json"
echo "wrote $OUTDIR/SHA256SUMS"
