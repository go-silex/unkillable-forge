#!/usr/bin/env bash
# Build a deterministic forge-engine-<version>.tar.gz from the locked checkout.
# Usage: scripts/build-engine-release.sh <outdir>
# Requires: npm ci already done; wrangler via the repo-locked path (or $WRANGLER).
# Portable: Python writes the tar/gz (BusyBox tar lacks GNU owner/mtime flags).
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
mkdir "$WORK/home" "$WORK/manage" "$WORK/read" "$WORK/read-unkillable" "$WORK/stage"
: >"$WORK/empty.env"
umask 077

dry_run_build() {
  local config="$1" outdir="$2"
  env -i \
    PATH="$PATH" \
    HOME="$WORK/home" \
    CI=1 \
    WRANGLER_SEND_METRICS=false \
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
    "$WRANGLER_BIN" deploy --dry-run \
    --config "$config" \
    --env-file "$WORK/empty.env" \
    --outdir "$outdir"
}

# manage + generic read + Unkillable read (shell assets differ per instance).
dry_run_build "$ROOT/wrangler.manage.toml" "$WORK/manage"
dry_run_build "$ROOT/wrangler.read.generic.toml" "$WORK/read"
dry_run_build "$ROOT/wrangler.read.toml" "$WORK/read-unkillable"

STAGE="$WORK/stage"
mkdir -p "$STAGE/manage" "$STAGE/read" "$STAGE/read-unkillable" "$STAGE/migrations"

# Wrangler's README and source maps contain timestamps or build-specific paths.
copy_modules() {
  local src="$1" dest="$2"
  find "$src" -type f -print0 | while IFS= read -r -d '' f; do
    rel="${f#"$src/"}"
    case "$rel" in
      README.md|*/README.md|*.map) continue ;;
    esac
    mkdir -p "$dest/$(dirname "$rel")"
    cp -p "$f" "$dest/$rel"
  done
}

copy_modules "$WORK/manage" "$STAGE/manage"
copy_modules "$WORK/read" "$STAGE/read"
copy_modules "$WORK/read-unkillable" "$STAGE/read-unkillable"

for mig in "$ROOT"/migrations/*.sql; do
  [ -f "$mig" ] || continue
  cp -p "$mig" "$STAGE/migrations/$(basename "$mig")"
done

pick_entry() {
  local root="$1" prefer="$2"
  python3 - "$root" "$prefer" <<'PY'
import sys
from pathlib import Path
root = Path(sys.argv[1])
prefer = sys.argv[2]
cands = sorted(p for p in root.rglob("*.js") if p.is_file())
pref = [p for p in cands if prefer in p.name]
pick = pref[0] if pref else (cands[0] if cands else None)
if pick is None:
    sys.exit(f"no JS module under {root}")
print(pick.relative_to(root).as_posix())
PY
}

MANAGE_ENTRY="$(pick_entry "$STAGE/manage" "manageWorker")"
READ_ENTRY="$(pick_entry "$STAGE/read" "readWorker")"
READ_UNK_ENTRY="$(pick_entry "$STAGE/read-unkillable" "unkillableReadWorker")"

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
flags = re.findall(r'"([^"]+)"', m.group(1)) if m else []
print(json.dumps(flags))
PY
)"

RELEASE_JSON="$STAGE/release.json"
python3 - "$STAGE" "$VERSION" "$ROLLBACK" "$SOURCE_SHA" "$WRANGLER_VERSION" "$COMPAT_DATE" "$COMPAT_FLAGS" \
  "$MANAGE_ENTRY" "$READ_ENTRY" "$READ_UNK_ENTRY" "$RELEASE_JSON" <<'PY'
import hashlib, json, sys
from pathlib import Path

stage = Path(sys.argv[1])
version, rollback, source_sha, wrangler_version = sys.argv[2:6]
compat_date = sys.argv[6]
compat_flags = json.loads(sys.argv[7])
manage_entry, read_entry, read_unk_entry = sys.argv[8:11]
out = Path(sys.argv[11])

def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

roles = (
    ("manage", manage_entry),
    ("read", read_entry),
    ("read-unkillable", read_unk_entry),
)
modules = []
for role, entry in roles:
    root = stage / role
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        rel_inside = path.relative_to(root).as_posix()
        modules.append({
            "path": f"{role}/{rel_inside}",
            "sha256": sha256(path),
            "entry": rel_inside == entry,
            "role": role,
        })

migrations = [{"name": p.name, "sha256": sha256(p)} for p in sorted((stage / "migrations").glob("*.sql"))]

doc = {
    "engineVersion": version,
    "rollbackCompatibleFrom": rollback,
    "sourceCommit": source_sha,
    "wranglerVersion": wrangler_version,
    "compatibilityDate": compat_date,
    "compatibilityFlags": compat_flags,
    "entries": {
        "manage": f"manage/{manage_entry}",
        "read": f"read/{read_entry}",
        "read-unkillable": f"read-unkillable/{read_unk_entry}",
    },
    "readVariants": {"generic": "read", "unkillable": "read-unkillable"},
    "modules": modules,
    "migrations": migrations,
}
out.write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

TARBALL_NAME="forge-engine-${VERSION}.tar.gz"
TARBALL="$OUTDIR/$TARBALL_NAME"

# Deterministic archive via Python (works on BusyBox hosts without GNU tar).
python3 - "$STAGE" "$TARBALL" <<'PY'
import gzip, io, os, sys, tarfile
from pathlib import Path

stage = Path(sys.argv[1])
tarball = Path(sys.argv[2])
members = []
for path in sorted(p for p in stage.rglob("*") if p.is_file()):
    members.append(path.relative_to(stage).as_posix())

buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w") as tar:
    for name in members:
        path = stage / name
        info = tarfile.TarInfo(name=name)
        info.size = path.stat().st_size
        info.mtime = 0
        info.uid = 0
        info.gid = 0
        info.uname = ""
        info.gname = ""
        info.mode = 0o644
        with path.open("rb") as f:
            tar.addfile(info, f)
raw = buf.getvalue()
with gzip.GzipFile(filename="", mode="wb", fileobj=open(tarball, "wb"), mtime=0) as gz:
    gz.write(raw)
PY

cp -p "$RELEASE_JSON" "$OUTDIR/release.json"

{
  sha256sum "$TARBALL" | awk -v name="$TARBALL_NAME" '{print $1 "  " name}'
  sha256sum "$OUTDIR/release.json" | awk '{print $1 "  release.json"}'
} | LC_ALL=C sort >"$OUTDIR/SHA256SUMS"

echo "built $TARBALL"
echo "wrote $OUTDIR/release.json"
echo "wrote $OUTDIR/SHA256SUMS"
