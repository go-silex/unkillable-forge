#!/usr/bin/env python3
"""Inject forge share toolbar into an HTML artifact (internal /a/ view).

External link is minted on click via POST /api/share; internal link = /a/<slug>/ (Access).
Replaces any previous injection (avoids stacked bars).
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

MARKER_START = "<!-- forge-share-bar -->"
MARKER_END = "<!-- /forge-share-bar -->"


def strip_old(html: str) -> str:
    """Remove prior forge share-bar injections (marked or legacy)."""
    # Marked block (preferred)
    html = re.sub(
        re.escape(MARKER_START) + r"[\s\S]*?" + re.escape(MARKER_END),
        "",
        html,
        flags=re.I,
    )
    # Legacy: __FORGE_SHARE__ config + following share-bar script(s)
    html = re.sub(
        r"\s*<script>\s*window\.__FORGE_SHARE__\s*=[\s\S]*?</script>"
        r"(?:\s*<script>[\s\S]*?__FORGE_SHARE_BAR__[\s\S]*?</script>)+",
        "",
        html,
        flags=re.I,
    )
    # Orphan toast/bar nodes if ever serialized (unlikely)
    html = re.sub(r'\s*<div[^>]*data-forge-share-bar[^>]*>[\s\S]*?</div>', "", html, flags=re.I)
    html = re.sub(r'\s*<div[^>]*data-forge-toast[^>]*>[\s\S]*?</div>', "", html, flags=re.I)
    return html


def inject(html: str, slug: str, share_url: str = "", short_url: str = "") -> str:
    """Inject share bar. Never embed share keys/URLs — mint via authenticated API."""
    html = strip_old(html)
    # slug only — shareUrl/shortUrl must not be baked into static /a/ HTML
    _ = (share_url, short_url)  # accepted for CLI compat, intentionally ignored
    cfg: dict = {"slug": slug}
    bar_src = Path(__file__).with_name("share-bar.js").read_text(encoding="utf-8")
    snippet = (
        f"\n{MARKER_START}\n"
        f"<script>window.__FORGE_SHARE__={json.dumps(cfg, ensure_ascii=False)};</script>\n"
        f"<script>\n{bar_src}\n</script>\n"
        f"{MARKER_END}\n"
    )
    if "</body>" in html:
        return html.replace("</body>", snippet + "</body>", 1)
    return html + snippet


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("html_file")
    ap.add_argument("--slug", required=True)
    ap.add_argument("--share-url", default="")
    ap.add_argument("--short-url", default="")
    args = ap.parse_args()
    p = Path(args.html_file)
    p.write_text(
        inject(p.read_text(encoding="utf-8"), args.slug, args.share_url, args.short_url),
        encoding="utf-8",
    )
    print(f"injected share bar → {p}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
