#!/usr/bin/env python3
"""inject-og must be idempotent, and strip_old_block its exact inverse.

`inject` places the block one of two ways: `"\\n" + block` after `<head>`, or
`block + "\\n"` when there is no `<head>`. `strip_old_block` used to remove only
BLOCK_START..BLOCK_END, so one orphan newline survived every pass and the file
grew a byte per publish. Since `inject_og_for_slug` writes the result back into
the hub SSOT, that byte changed the artifact's content hash on every publish and
Cloudflare re-uploaded a page whose craft content had not moved — defeating the
Pages delta upload entirely.

The two placements put the newline on opposite sides, so a blind `\\n?` on each
side would eat the document's own newline after `<head>`. Both shapes are
asserted here, including the whitespace-bearing one.
"""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

_SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "plugins"
    / "silex-forge"
    / "scripts"
    / "inject-og.py"
)


def _load():
    spec = importlib.util.spec_from_file_location("inject_og", _SCRIPT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


OG = _load()

META = {
    "title": "Title",
    "description": "Desc",
    "url": "https://forge.example.invalid/a/slug/",
    "image": "https://forge.example.invalid/a/slug/og.jpg",
}

DOCS = {
    "head_tight": "<html><head><title>Old</title></head><body>x</body></html>\n",
    "head_spaced": (
        '<html>\n<head>\n<meta charset="utf-8">\n<title>Old</title>\n</head>\n'
        "<body>x</body>\n</html>\n"
    ),
    "no_head": "<html><body>x</body></html>\n",
}


class InjectOgIdempotence(unittest.TestCase):
    def test_repeated_inject_does_not_grow(self) -> None:
        for name, doc in DOCS.items():
            with self.subTest(doc=name):
                sizes = []
                cur = doc
                for _ in range(5):
                    cur = OG.inject(cur, **META)
                    sizes.append(len(cur))
                self.assertEqual(
                    len(set(sizes)),
                    1,
                    f"{name}: document grew across injects: {sizes}",
                )

    def test_inject_is_fixpoint(self) -> None:
        for name, doc in DOCS.items():
            with self.subTest(doc=name):
                once = OG.inject(doc, **META)
                self.assertEqual(once, OG.inject(once, **META), name)

    def test_strip_is_exact_inverse(self) -> None:
        # inject() also normalises <title>, so the inverse target is the
        # post-ensure_title document, not the raw input.
        for name, doc in DOCS.items():
            with self.subTest(doc=name):
                base = OG.ensure_title(doc, META["title"])
                self.assertEqual(
                    OG.strip_old_block(OG.inject(doc, **META)),
                    base,
                    f"{name}: strip is not the exact inverse of inject",
                )

    def test_strip_preserves_document_newline_after_head(self) -> None:
        # The regression a blind trailing \n? would cause: eating the newline
        # that belongs to the document right after <head>.
        doc = DOCS["head_spaced"]
        stripped = OG.strip_old_block(OG.inject(doc, **META))
        self.assertIn('<head>\n<meta charset="utf-8">', stripped)

    def test_strip_is_noop_on_clean_input(self) -> None:
        for name, doc in DOCS.items():
            with self.subTest(doc=name):
                self.assertEqual(OG.strip_old_block(doc), doc, name)

    def test_injected_block_carries_the_meta(self) -> None:
        out = OG.inject(DOCS["head_tight"], **META)
        self.assertIn(OG.BLOCK_START, out)
        self.assertIn(OG.BLOCK_END, out)
        self.assertIn('property="og:title"', out)
        self.assertIn(META["url"], out)
        self.assertIn(META["image"], out)


if __name__ == "__main__":
    unittest.main()
