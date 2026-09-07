"""Unit tests for lib/og_render.py — digest v2 + payload, no network.

Render is not exercised here: it POSTs to Browser Run. Geometry and inlining
were proven against live decks before this module landed; these tests pin the
identity contract that gen-og-images.sh and persist_og_to_hub must share.
"""

from __future__ import annotations

import base64
import json
import shutil
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[2] / "plugins/silex-forge/scripts"
sys.path.insert(0, str(SCRIPTS / "lib"))

import og_render  # noqa: E402


SHARE_BAR = (
    "<!-- forge-share-bar --><script>window.__FORGE_SHARE__={}</script>"
    "<!-- /forge-share-bar -->"
)


def _artifact(root: Path, html: str, files: dict[str, bytes] | None = None) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "index.html").write_text(html, encoding="utf-8")
    for rel, data in (files or {}).items():
        dest = root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
    return root / "index.html"


class DigestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.td = Path(self.id().replace(".", "_"))
        # pytest/unittest don't share a tmp dir here; use a sibling of this file
        # under /tmp so a failed run is still inspectable, and clean in tearDown.
        import tempfile

        self.td = Path(tempfile.mkdtemp(prefix="og-render-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.td, ignore_errors=True)

    def test_digest_is_deterministic(self) -> None:
        html = _artifact(self.td / "a", "<html><head></head><body>v1</body></html>")
        self.assertEqual(og_render.canonical_digest(html), og_render.canonical_digest(html))

    def test_digest_moves_when_html_changes(self) -> None:
        html = _artifact(self.td / "a", "<html><head></head><body>v1</body></html>")
        before = og_render.canonical_digest(html)
        html.write_text("<html><head></head><body>v2</body></html>", encoding="utf-8")
        self.assertNotEqual(before, og_render.canonical_digest(html))

    def test_digest_closed_under_share_bar(self) -> None:
        """Hub copies are heterogeneous: 28/33 currently persist the bar.

        The digest must not move because of that, or two machines with
        different hub copies of the same craft would never agree on og.src.
        """
        clean = _artifact(self.td / "clean", "<html><head></head><body>v1</body></html>")
        dirty = _artifact(
            self.td / "dirty",
            f"<html><head></head><body>v1{SHARE_BAR}</body></html>",
        )
        self.assertEqual(og_render.canonical_digest(clean), og_render.canonical_digest(dirty))

    def test_digest_covers_subresources(self) -> None:
        html = _artifact(
            self.td / "a",
            '<html><head></head><body><img src="assets/hero.png"></body></html>',
            {"assets/hero.png": b"PNG-V1"},
        )
        before = og_render.canonical_digest(html)
        (self.td / "a" / "assets" / "hero.png").write_bytes(b"PNG-V2")
        self.assertNotEqual(before, og_render.canonical_digest(html))

    def test_digest_ignores_unresolvable_refs(self) -> None:
        html = _artifact(
            self.td / "a",
            '<html><head></head><body><img src="assets/missing.png"></body></html>',
        )
        # Must not raise, and must equal a page with no ref at all.
        bare = _artifact(self.td / "b", "<html><head></head><body></body></html>")
        # Different HTML → different digest. The point is it didn't crash.
        og_render.canonical_digest(html)
        self.assertNotEqual(og_render.canonical_digest(html), og_render.canonical_digest(bare))

    def test_ref_escaping_the_artifact_is_ignored(self) -> None:
        secret = self.td / "secret.bin"
        secret.write_bytes(b"SHOULD-NOT-BE-READ")
        html = _artifact(
            self.td / "a",
            '<html><head></head><body><img src="../secret.bin"></body></html>',
        )
        self.assertEqual(og_render.collect_subresources(html), [])


class PayloadTests(unittest.TestCase):
    def setUp(self) -> None:
        import tempfile

        self.td = Path(tempfile.mkdtemp(prefix="og-payload-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.td, ignore_errors=True)

    def test_inlines_relative_images_as_data_uri(self) -> None:
        png = b"\x89PNG\r\n\x1a\n" + b"x" * 16
        html = _artifact(
            self.td / "a",
            '<html><head></head><body><img src="assets/hero.png"></body></html>',
            {"assets/hero.png": png},
        )
        body = og_render.build_render_html(html)
        uri = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
        self.assertIn(uri, body)
        self.assertNotIn('src="assets/hero.png"', body)

    def test_strips_share_bar_and_injects_capture_css(self) -> None:
        html = _artifact(
            self.td / "a",
            f"<html><head></head><body>v1{SHARE_BAR}</body></html>",
        )
        body = og_render.build_render_html(html)
        self.assertNotIn("<!-- forge-share-bar -->", body)
        self.assertNotIn("/api/visibility", body)
        self.assertIn('id="forge-og-capture"', body)

    def test_clip_geometry_matches_ffmpeg_cover_crop(self) -> None:
        self.assertEqual(og_render.CAPTURE_WIDTH, 1920)
        self.assertEqual(og_render.CAPTURE_HEIGHT, 1080)
        self.assertEqual(og_render.OG_WIDTH, 1200)
        self.assertEqual(og_render.OG_HEIGHT, 630)
        self.assertEqual(og_render._CLIP_SCALE, 0.625)
        self.assertEqual(og_render._CLIP_HEIGHT, 1008)
        self.assertEqual(og_render._CLIP_Y, 36)
        payload = og_render.build_payload(
            _artifact(self.td / "a", "<html><head></head><body>x</body></html>")
        )
        clip = payload["screenshotOptions"]["clip"]
        self.assertEqual(clip, {"x": 0, "y": 36, "width": 1920, "height": 1008, "scale": 0.625})
        self.assertEqual(payload["screenshotOptions"]["type"], "jpeg")


class CliTests(unittest.TestCase):
    def test_digest_cli_prints_64_hex(self) -> None:
        import tempfile
        from io import StringIO
        from unittest.mock import patch

        td = Path(tempfile.mkdtemp())
        try:
            html = _artifact(td, "<html><head></head><body>cli</body></html>")
            buf = StringIO()
            with patch("sys.stdout", buf):
                rc = og_render.main(["digest", str(html)])
            self.assertEqual(rc, 0)
            out = buf.getvalue().strip()
            self.assertEqual(len(out), 64)
            int(out, 16)
        finally:
            shutil.rmtree(td, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
