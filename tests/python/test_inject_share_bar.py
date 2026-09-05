#!/usr/bin/env python3
"""Tests for inject-share-bar.py — strip/inject must be a byte-exact round trip.

The injection is what makes an artifact's content hash change: `wrangler pages
deploy` dedupes by hash, so an `inject` that is not idempotent re-uploads every
HTML file on every publish. The previous `strip_old` left behind the two
newlines `inject` adds around its markers (+2 bytes per publish), so these
tests pin the round trip byte for byte rather than "looks stripped".
"""
from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "plugins"
    / "silex-forge"
    / "scripts"
    / "inject-share-bar.py"
)

# Hyphenated filename, not importable as a module name: load it by path.
_spec = importlib.util.spec_from_file_location("inject_share_bar", SCRIPT)
assert _spec is not None and _spec.loader is not None
isb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(isb)

SLUG = "demo-slug"

WITH_BODY = "<html>\n<head><title>t</title></head>\n<body>\n<h1>Hi</h1>\n</body>\n</html>\n"
NO_BODY = "<h1>Fragment</h1>\n<p>no body tag here</p>\n"
INDENTED_BODY = (
    "<html>\n"
    "  <body>\n"
    "    <main>content</main>\n"
    "    \n"
    "  </body>\n"
    "</html>\n"
)

LEGACY = (
    "<html><body>\n"
    "<p>keep me</p>\n"
    '<script>window.__FORGE_SHARE__={"slug":"legacy"};</script>\n'
    "<script>\n(function(){/* __FORGE_SHARE_BAR__ */ return 1;})();\n</script>\n"
    "</body></html>\n"
)

DOCS = {
    "with </body>": WITH_BODY,
    "without </body>": NO_BODY,
    "indentation before </body>": INDENTED_BODY,
}


class StripIsInverseOfInject(unittest.TestCase):
    def test_round_trip_is_byte_identical(self) -> None:
        for label, doc in DOCS.items():
            with self.subTest(doc=label):
                self.assertEqual(isb.strip_old(isb.inject(doc, SLUG)), doc)

    def test_strip_is_noop_on_never_injected_document(self) -> None:
        for label, doc in DOCS.items():
            with self.subTest(doc=label):
                self.assertEqual(isb.strip_old(doc), doc)


class InjectIsIdempotent(unittest.TestCase):
    def test_second_inject_changes_nothing(self) -> None:
        for label, doc in DOCS.items():
            with self.subTest(doc=label):
                once = isb.inject(doc, SLUG)
                self.assertEqual(isb.inject(once, SLUG), once)

    def test_five_injects_do_not_grow_the_document(self) -> None:
        # The regression: 9843 -> 9845 -> 9847 -> ... , +2 bytes per publish.
        for label, doc in DOCS.items():
            with self.subTest(doc=label):
                out = isb.inject(doc, SLUG)
                sizes = [len(out)]
                for _ in range(4):
                    out = isb.inject(out, SLUG)
                    sizes.append(len(out))
                self.assertEqual(sizes, [sizes[0]] * 5)
                self.assertEqual(isb.strip_old(out), doc)


class LegacyCleanup(unittest.TestCase):
    def test_legacy_config_and_bar_script_are_removed(self) -> None:
        out = isb.strip_old(LEGACY)
        self.assertNotIn("__FORGE_SHARE__", out)
        self.assertNotIn("__FORGE_SHARE_BAR__", out)
        self.assertIn("<p>keep me</p>", out)
        self.assertIn("</body></html>", out)

    def test_inject_over_legacy_leaves_a_single_config(self) -> None:
        out = isb.inject(LEGACY, SLUG)
        # share-bar.js mentions window.__FORGE_SHARE__ twice (doc comment + read),
        # so count assignments: exactly one config survives, the fresh one.
        self.assertEqual(out.count("window.__FORGE_SHARE__={"), 1)
        self.assertNotIn('"slug":"legacy"', out)
        self.assertIn('{"slug": "%s"}' % SLUG, out)


class InjectedPayload(unittest.TestCase):
    def test_markers_and_slug_config_present(self) -> None:
        out = isb.inject(WITH_BODY, SLUG)
        self.assertIn(isb.MARKER_START, out)
        self.assertIn(isb.MARKER_END, out)
        self.assertIn('window.__FORGE_SHARE__={"slug": "%s"};' % SLUG, out)
        self.assertLess(out.index(isb.MARKER_END), out.index("</body>"))

    def test_share_key_and_urls_are_never_baked_in(self) -> None:
        out = isb.inject(
            WITH_BODY,
            SLUG,
            share_url="https://forge.example.com/s/demo-slug/SECRETSHAREKEY/",
            short_url="https://s.example.com/abc123",
        )
        self.assertNotIn("SECRETSHAREKEY", out)
        self.assertNotIn("forge.example.com", out)
        self.assertNotIn("s.example.com", out)


class StripCli(unittest.TestCase):
    def test_strip_flag_restores_the_pre_injection_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "index.html"
            path.write_text(isb.inject(WITH_BODY, SLUG), encoding="utf-8")
            proc = subprocess.run(
                [sys.executable, str(SCRIPT), str(path), "--strip"],
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("stripped share bar", proc.stdout)
            self.assertEqual(path.read_bytes(), WITH_BODY.encode("utf-8"))

    def test_strip_accepts_slug_and_does_not_inject(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "index.html"
            path.write_text(isb.inject(WITH_BODY, SLUG), encoding="utf-8")
            proc = subprocess.run(
                [sys.executable, str(SCRIPT), str(path), "--strip", "--slug", SLUG],
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(path.read_bytes(), WITH_BODY.encode("utf-8"))

    def test_inject_path_still_requires_slug(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "index.html"
            path.write_text(WITH_BODY, encoding="utf-8")
            proc = subprocess.run(
                [sys.executable, str(SCRIPT), str(path)],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("--slug", proc.stderr)
            self.assertEqual(path.read_text(encoding="utf-8"), WITH_BODY)


if __name__ == "__main__":
    unittest.main()
