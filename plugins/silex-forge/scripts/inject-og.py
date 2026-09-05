#!/usr/bin/env python3
"""Inject / refresh Open Graph + basic SEO meta in an HTML file.

Idempotent: replaces previous forge-og block if present.
Does not generate OG images (optional later).
"""
from __future__ import annotations

import argparse
import html
import re
from pathlib import Path

BLOCK_START = "<!-- forge-og:start -->"
BLOCK_END = "<!-- forge-og:end -->"


def strip_old_block(content: str) -> str:
    """Exact inverse of the two placements `inject` uses.

    `inject` adds either `"\\n" + block` (after `<head>`) or `block + "\\n"`
    (no `<head>`), so removing only BLOCK_START..BLOCK_END left one orphan
    newline behind per pass. The file then grew a byte on every publish, its
    content hash changed, and Cloudflare re-uploaded an artifact whose craft
    content was identical. The two placements put the newline on opposite
    sides, hence two anchored patterns rather than one `\\n?` on each side:
    a blind trailing `\\n?` would eat the document's own newline after
    `<head>`.
    """
    # No <head>: the block sits at position 0 and owns the newline after it.
    content = re.sub(
        r"\A" + re.escape(BLOCK_START) + r".*?" + re.escape(BLOCK_END) + r"\n?",
        "",
        content,
        flags=re.DOTALL,
    )
    # After <head>: the block owns the newline before it.
    return re.sub(
        r"\n?" + re.escape(BLOCK_START) + r".*?" + re.escape(BLOCK_END),
        "",
        content,
        flags=re.DOTALL,
    )


def ensure_title(content: str, title: str) -> str:
    if re.search(r"<title>[^<]*</title>", content, re.I):
        return re.sub(
            r"<title>[^<]*</title>",
            f"<title>{html.escape(title)}</title>",
            content,
            count=1,
            flags=re.I,
        )
    # inject after <head>
    return re.sub(
        r"(<head[^>]*>)",
        rf"\1\n  <title>{html.escape(title)}</title>",
        content,
        count=1,
        flags=re.I,
    )


def build_block(
    *,
    title: str,
    description: str,
    url: str,
    site_name: str = "Silex Forge",
    noindex: bool = True,
    image: str = "",
) -> str:
    t = html.escape(title)
    d = html.escape(description or title)
    u = html.escape(url)
    sn = html.escape(site_name)
    robots = "noindex, nofollow, noarchive" if noindex else "index, follow"
    img_block = ""
    if image:
        i = html.escape(image)
        img_block = f"""
  <meta property="og:image" content="{i}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:image" content="{i}">"""
    return f"""{BLOCK_START}
  <meta name="description" content="{d}">
  <meta name="robots" content="{robots}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="{sn}">
  <meta property="og:title" content="{t}">
  <meta property="og:description" content="{d}">
  <meta property="og:url" content="{u}">{img_block}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{t}">
  <meta name="twitter:description" content="{d}">
{BLOCK_END}"""


def inject(
    content: str,
    *,
    title: str,
    description: str,
    url: str,
    noindex: bool = True,
    image: str = "",
) -> str:
    content = strip_old_block(content)
    content = ensure_title(content, title)
    block = build_block(
        title=title,
        description=description,
        url=url,
        noindex=noindex,
        image=image,
    )
    if re.search(r"<head[^>]*>", content, re.I):
        return re.sub(
            r"(<head[^>]*>)",
            rf"\1\n{block}",
            content,
            count=1,
            flags=re.I,
        )
    return block + "\n" + content


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("html_file")
    ap.add_argument("--title", default="")
    ap.add_argument("--description", default="")
    ap.add_argument("--url", default="")
    ap.add_argument("--image", default="", help="Absolute og:image URL (optional)")
    ap.add_argument("--indexable", action="store_true", help="allow index (default: noindex)")
    ap.add_argument(
        "--strip",
        action="store_true",
        help="remove the forge OG block without injecting a replacement",
    )
    args = ap.parse_args()
    p = Path(args.html_file)
    content = p.read_text(encoding="utf-8")
    if args.strip:
        p.write_text(strip_old_block(content), encoding="utf-8")
        print(f"stripped OG block → {p}")
        return 0
    if not args.title or not args.url:
        ap.error("--title and --url are required unless --strip is used")
    out = inject(
        content,
        title=args.title,
        description=args.description or args.title,
        url=args.url,
        noindex=not args.indexable,
        image=args.image,
    )
    p.write_text(out, encoding="utf-8")
    print(f"og injected → {p}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
