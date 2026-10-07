#!/usr/bin/env python3
"""Write/update hub memory notes for forge artefacts.

SSOT HTML: hub artifacts/ (forge.config). Deploy copy: silex-forge git site/a/.
Hub notes:
  - 00_COCKPIT/Forge_Catalogue.md  (index all list_on_index)
  - 00_COCKPIT/Forge/<slug>.md     (per artefact pointer)

Hub root resolution:
  1) --hub
  2) forge.config (local → example fallback) via load_config
  3) HUB_ROOT env / ~/.config/silex/hub-root (legacy bootstrap)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date
from pathlib import Path

_LIB = Path(__file__).resolve().parent / "lib"
if _LIB.is_dir() and str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))


def resolve_hub(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    try:
        from load_config import load_config

        cfg = load_config()
        hub = (cfg.get("hub_root") or "").strip()
        if hub:
            return Path(hub).expanduser().resolve()
    except Exception:
        pass
    env = os.environ.get("HUB_ROOT", "").strip()
    if env:
        return Path(env).expanduser().resolve()
    cfg_file = Path.home() / ".config/silex/hub-root"
    if cfg_file.is_file():
        return Path(cfg_file.read_text(encoding="utf-8").strip()).expanduser().resolve()
    return (Path.home() / "projects/gosilex/silex-hub").resolve()


def load_registry(reg_dir: Path) -> list[dict]:
    items = []
    for p in sorted(reg_dir.glob("*.json")):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if d.get("slug"):
            items.append(d)
    items.sort(key=lambda x: x.get("date") or "", reverse=True)
    return items


def write_slug_note(hub: Path, item: dict, host: str) -> Path:
    slug = item["slug"]
    out_dir = hub / "00_COCKPIT" / "Forge"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{slug}.md"
    title = item.get("title") or slug
    desc = item.get("description") or ""
    internal = f"https://{host}{item.get('path') or f'/a/{slug}/'}"
    share = item.get("share_url") or "_(générer via bouton Partager sur la page équipe)_"
    lines = [
        f"# Forge · {title}",
        "",
        f"> Index auto publish · {date.today().isoformat()}",
        "",
        f"**Slug :** `{slug}`  ",
        f"**Type :** {item.get('type', 'html')}  ",
        f"**Date :** {item.get('date', '—')}",
        "",
        "## Liens",
        "",
        f"| | |",
        f"|---|---|",
        f"| **Équipe (Access)** | {internal} |",
        f"| **Share** | {share} |",
        f"| **Catalogue** | https://{host}/ |",
        "",
        "## Description",
        "",
        desc or "—",
        "",
        "## SSOT",
        "",
        f"- HTML source : hub `00_COCKPIT/Forge/artifacts/{slug}/` (forge.config)",
        f"- Deploy live : repo `go-silex/silex-forge` → `site/a/{slug}/`",
        f"- Registry : `registry/{slug}.json`",
        "",
        "Éditer le HTML dans le hub ; republier via forge-publish pour le live.",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def write_catalogue(hub: Path, items: list[dict], host: str) -> Path:
    out = hub / "00_COCKPIT" / "Forge_Catalogue.md"
    listed = [i for i in items if i.get("list_on_index", True)]
    lines = [
        "# Forge — catalogue artefacts",
        "",
        f"> Généré auto par `hub-index.py` · {date.today().isoformat()}  ",
        f"> Host : https://{host}/ (Access équipe)  ",
        f"> SSOT HTML : [go-silex/silex-forge](https://github.com/go-silex/silex-forge)",
        "",
        "Les liens **share** ne sont pas listés ici en détail (clés) — voir fiche slug ou bouton Partager.",
        "",
        "| Slug | Titre | Type | Date | Fiche |",
        "|---|---|---|---|---|",
    ]
    for i in listed:
        slug = i["slug"]
        title = (i.get("title") or slug).replace("|", "\\|")
        lines.append(
            f"| `{slug}` | {title} | {i.get('type', 'html')} | {i.get('date', '')} | [[Forge/{slug}]] |"
        )
    lines += [
        "",
        f"**{len(listed)}** artefact(s) au catalogue · **{sum(1 for i in items if i.get('share_key') or i.get('share_url'))}** avec share minté (registry).",
        "",
        "## Marketplaces",
        "",
        "Voir [[Plugins_Marketplaces]].",
        "",
    ]
    out.write_text("\n".join(lines), encoding="utf-8")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--registry", required=True, help="path to registry/ dir")
    ap.add_argument("--hub", default=None)
    ap.add_argument("--host", default=os.environ.get("PUBLIC_HOST", "forge.unkillablecompanies.com"))
    ap.add_argument("--slug", default="", help="only update this slug (+ always rewrite catalogue)")
    args = ap.parse_args()

    hub = resolve_hub(args.hub)
    if not hub.is_dir():
        print(f"hub missing (skip): {hub}")
        return 0

    reg = Path(args.registry)
    items = load_registry(reg)
    if not items:
        print("no registry items")
        return 0

    if args.slug:
        items_write = [i for i in items if i["slug"] == args.slug]
        if not items_write:
            print(f"slug not in registry: {args.slug}")
            return 1
    else:
        items_write = items

    for i in items_write:
        p = write_slug_note(hub, i, args.host)
        print(f"hub note → {p}")

    cat = write_catalogue(hub, items, args.host)
    print(f"hub catalogue → {cat}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
