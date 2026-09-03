#!/usr/bin/env python3
"""Build deploy tree (site/a + registry + catalogue) from hub SSOT.

SSOT = $hub/$artifacts_dir/<slug>/{index.html, meta.json, …}
Output (in-repo layout, for wrangler pages deploy — not committed):
  site/a/<slug>/…
  registry/<slug>.json   (from meta.json — no secrets)
  site/index.html + manifest.json via gen-index.py

Usage:
  build-site-from-hub.py --repo-root /path/to/silex-forge
  build-site-from-hub.py --dry-run
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

_LIB = Path(__file__).resolve().parent / "lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from load_config import artifacts_root, load_config  # noqa: E402

SKIP_NAMES = {".DS_Store", "Thumbs.db", "__pycache__"}


def _inject_share_bar(html_path: Path, slug: str) -> None:
    """Overlay Interne/Externe bar on /a/<slug>/ — strip+reinject, no share keys."""
    inj = Path(__file__).resolve().parent / "inject-share-bar.py"
    if not inj.is_file():
        print(f"warn: inject-share-bar.py missing — skip {slug}", file=sys.stderr)
        return
    r = subprocess.run(
        [sys.executable, str(inj), str(html_path), "--slug", slug],
        check=False,
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        print(f"warn: share-bar inject failed {slug}: {r.stderr.strip()}", file=sys.stderr)
        return
    print(f"  share-bar → {slug}")


def _load_meta(slug_dir: Path, slug: str) -> dict:
    meta_path = slug_dir / "meta.json"
    if meta_path.is_file():
        try:
            data = json.loads(meta_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                data.setdefault("slug", slug)
                return data
        except Exception as e:
            print(f"warn: bad meta {meta_path}: {e}", file=sys.stderr)
    return {
        "slug": slug,
        "title": slug,
        "description": "",
        "type": "html",
        "date": date.today().isoformat(),
        "path": f"/a/{slug}/",
        "list_on_index": True,
        "visibility": "internal",
        "shared": False,
    }


def _sanitize_registry(meta: dict, slug: str, prefix: str) -> dict:
    """Strip secrets; enforce deploy path."""
    out = {
        "slug": slug,
        "title": meta.get("title") or slug,
        "description": meta.get("description") or "",
        "type": meta.get("type") or "html",
        "date": meta.get("date") or date.today().isoformat(),
        "path": f"/{prefix}/{slug}/",
        "list_on_index": bool(meta.get("list_on_index", True)),
        "visibility": meta.get("visibility") or "internal",
        "shared": bool(meta.get("shared", False)),
    }
    # never copy secrets into git/registry
    for k in ("share_key", "share_path", "share_url", "share_url_query", "short_url"):
        out.pop(k, None)
    return out


def build(
    repo_root: Path,
    dry_run: bool = False,
) -> int:
    cfg = load_config()
    art = artifacts_root(cfg)
    if art is None or not art.is_dir():
        print(f"✗ artifacts root missing: {art} — forge-setup?", file=sys.stderr)
        return 1

    prefix = str(cfg.get("internal_prefix") or "a")
    site_dir = repo_root / str(cfg.get("site_dir") or "site")
    reg_dir = repo_root / str(cfg.get("registry_dir") or "registry")
    a_dir = site_dir / prefix

    if not dry_run:
        # wipe previous deploy content (keep skeleton files under site/)
        if a_dir.is_dir():
            shutil.rmtree(a_dir)
        a_dir.mkdir(parents=True, exist_ok=True)
        reg_dir.mkdir(parents=True, exist_ok=True)
        # remove stale registry json
        for old in reg_dir.glob("*.json"):
            old.unlink()

    slugs: list[str] = []
    for child in sorted(art.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        if not (child / "index.html").is_file():
            print(f"skip {child.name}: no index.html", file=sys.stderr)
            continue
        slugs.append(child.name)

    if not slugs:
        print(f"✗ no artifacts with index.html under {art}", file=sys.stderr)
        return 1

    for slug in slugs:
        src = art / slug
        dest = a_dir / slug
        meta = _sanitize_registry(_load_meta(src, slug), slug, prefix)
        if dry_run:
            print(f"would copy {src} → {dest}")
            print(f"would write registry/{slug}.json title={meta['title']!r}")
            continue
        dest.mkdir(parents=True, exist_ok=True)
        for item in src.iterdir():
            if item.name in SKIP_NAMES:
                continue
            # meta.json stays hub-only name; registry is the deploy mirror
            if item.name == "meta.json":
                continue
            target = dest / item.name
            if item.is_dir():
                if target.exists():
                    shutil.rmtree(target)
                shutil.copytree(item, target, dirs_exist_ok=True)
            else:
                shutil.copy2(item, target)
        html_dest = dest / "index.html"
        if html_dest.is_file():
            # Overlay on the deploy tree only — hub remains craft SSOT.
            _inject_share_bar(html_dest, slug)
        reg_path = reg_dir / f"{slug}.json"
        reg_path.write_text(
            json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"✓ {slug} → site/{prefix}/{slug}/ + registry/{slug}.json")

    if dry_run:
        return 0

    # gen-index from scripts next to us (or in repo)
    gen = Path(__file__).resolve().parent / "gen-index.py"
    if not gen.is_file():
        gen = repo_root / "plugins/silex-forge/scripts/gen-index.py"
    if gen.is_file():
        # gen-index resolves ROOT from its path parents[3] when in plugins/.../scripts
        # When building a clone, run from repo so paths work if gen-index is copied
        r = subprocess.run(
            [sys.executable, str(gen)],
            cwd=str(repo_root),
            check=False,
        )
        if r.returncode != 0:
            # gen-index uses parents[3] from file location — if we're executing
            # the plugin script outside the target repo, inject via symlink layout.
            # Fallback: run with PYTHONPATH and patch by chdir + copy script... 
            # Prefer executing the copy inside the clone if present.
            gen_in_repo = repo_root / "plugins/silex-forge/scripts/gen-index.py"
            if gen_in_repo.is_file() and gen_in_repo != gen:
                r = subprocess.run(
                    [sys.executable, str(gen_in_repo)],
                    cwd=str(repo_root),
                    check=False,
                )
            if r.returncode != 0:
                print("✗ gen-index failed", file=sys.stderr)
                return r.returncode
    else:
        print("warn: gen-index.py missing — catalogue not regenerated", file=sys.stderr)

    print(f"✓ built {len(slugs)} artifact(s) from {art}")
    return 0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--repo-root",
        type=Path,
        default=None,
        help="silex-forge root (default: parents of this script)",
    )
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv[1:])
    if args.repo_root:
        root = args.repo_root.expanduser().resolve()
    else:
        # plugins/silex-forge/scripts → repo root
        root = Path(__file__).resolve().parents[3]
    if not root.is_dir():
        print(f"✗ repo root not a dir: {root}", file=sys.stderr)
        return 1
    return build(root, dry_run=args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
