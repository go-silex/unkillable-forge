"""Unit tests for lib/og_render.py — digest v2 + payload, no network.

render() is not exercised here: it POSTs to Browser Run. What is pinned is the
identity contract gen-og-images.sh and persist_og_to_hub must share, and the
payload invariants that decide what Cloudflare actually receives.
"""

from __future__ import annotations

import base64
import os
import shutil
import sys
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import patch

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


class _Tmp(unittest.TestCase):
    def setUp(self) -> None:
        self.td = Path(tempfile.mkdtemp(prefix="og-render-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.td, ignore_errors=True)


class DigestTests(_Tmp):
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
        different hub copies of the same craft never agree on og.src.
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

    def test_unresolvable_ref_is_not_a_subresource(self) -> None:
        html = _artifact(
            self.td / "a",
            '<html><head></head><body><img src="assets/missing.png"></body></html>',
        )
        self.assertEqual([], og_render.collect_subresources(html))
        og_render.canonical_digest(html)

    def test_ref_escaping_the_artifact_is_ignored(self) -> None:
        (self.td / "secret.bin").write_bytes(b"SHOULD-NOT-BE-READ")
        html = _artifact(
            self.td / "a",
            '<html><head></head><body><img src="../secret.bin"></body></html>',
        )
        self.assertEqual([], og_render.collect_subresources(html))

    def test_absolute_ref_is_ignored(self) -> None:
        html = _artifact(
            self.td / "a",
            '<html><head></head><body><img src="/etc/hostname"></body></html>',
        )
        self.assertEqual([], og_render.collect_subresources(html))

    def test_nul_byte_ref_does_not_raise(self) -> None:
        """A crafted ref must stay a skipped subresource, not an exception.

        The kernel's callers only absorb OgRenderError, so a ValueError
        escaping from path resolution would abort a whole publish.
        """
        html = _artifact(
            self.td / "a",
            '<html><head></head><body><img src="as\x00sets/x.png"></body></html>',
        )
        self.assertEqual([], og_render.collect_subresources(html))

    def test_subresources_inside_the_share_bar_are_excluded(self) -> None:
        """The digest walks the canonical text, so an overlay ref cannot enter it.

        The payload never carries those bytes; hashing them would key the
        identity on more than what is rendered.
        """
        bar = (
            "<!-- forge-share-bar -->"
            '<script src="assets/bar.js"></script>'
            "<!-- /forge-share-bar -->"
        )
        html = _artifact(
            self.td / "a",
            f"<html><head></head><body>v1{bar}</body></html>",
            {"assets/bar.js": b"BAR"},
        )
        self.assertEqual([], og_render.collect_subresources(html))


class PayloadTests(_Tmp):
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

    def test_repeated_ref_is_encoded_once_and_substituted_everywhere(self) -> None:
        png = b"\x89PNG\r\n\x1a\n" + b"y" * 32
        html = _artifact(
            self.td / "a",
            "<html><head></head><body>" + '<img src="assets/hero.png">' * 3 + "</body></html>",
            {"assets/hero.png": png},
        )
        body = og_render.build_render_html(html)
        uri = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
        self.assertEqual(3, body.count(uri))
        self.assertNotIn("assets/hero.png", body)

    def test_nested_css_refs_are_rewritten_before_inlining(self) -> None:
        """A data: stylesheet has an opaque origin: its own refs must be inlined."""
        png = b"\x89PNG\r\n\x1a\n" + b"z" * 8
        html = _artifact(
            self.td / "a",
            '<html><head><link href="css/app.css" rel="stylesheet"></head><body>x</body></html>',
            {
                "css/app.css": b"body{background:url(../assets/bg.png)}",
                "assets/bg.png": png,
            },
        )
        css_uri = next(
            part
            for part in og_render.build_render_html(html).split('"')
            if part.startswith("data:text/css;base64,")
        )
        decoded = base64.b64decode(css_uri.split(",", 1)[1]).decode()
        self.assertIn("data:image/png;base64,", decoded)
        self.assertNotIn("../assets/bg.png", decoded)
        self.assertEqual(
            ["assets/bg.png", "css/app.css"],
            [rel for rel, _ in og_render.collect_subresources(html)],
        )

    def test_nested_html_is_not_inlined(self) -> None:
        """Inlining a nested document broke lgu-recap's remote video embed.

        A relative iframe is left alone: it fails to load in the payload,
        exactly as it already does for an anonymous visitor, instead of
        changing how the surrounding scripts run.
        """
        html = _artifact(
            self.td / "a",
            '<html><head></head><body><iframe src="deck.html"></iframe></body></html>',
            {"deck.html": b"<html><body>nested</body></html>"},
        )
        body = og_render.build_render_html(html)
        self.assertIn('src="deck.html"', body)
        self.assertNotIn("data:text/html", body)

    def test_strips_share_bar_and_injects_capture_css(self) -> None:
        html = _artifact(
            self.td / "a",
            f"<html><head></head><body>v1{SHARE_BAR}</body></html>",
        )
        body = og_render.build_render_html(html)
        self.assertNotIn("<!-- forge-share-bar -->", body)
        self.assertNotIn("__FORGE_SHARE__", body)
        self.assertIn('id="forge-og-capture"', body)

    def test_payload_carries_a_settle_wait(self) -> None:
        """networkidle0 fires ~500 ms in on an all-inline payload."""
        payload = og_render.build_payload(
            _artifact(self.td / "a", "<html><head></head><body>x</body></html>")
        )
        self.assertEqual(og_render.SETTLE_MS, payload["waitForTimeout"])
        self.assertGreaterEqual(payload["waitForTimeout"], 1000)

    def test_clip_geometry_matches_ffmpeg_cover_crop(self) -> None:
        self.assertEqual(1920, og_render.CAPTURE_WIDTH)
        self.assertEqual(1080, og_render.CAPTURE_HEIGHT)
        self.assertEqual(1200, og_render.OG_WIDTH)
        self.assertEqual(630, og_render.OG_HEIGHT)
        payload = og_render.build_payload(
            _artifact(self.td / "a", "<html><head></head><body>x</body></html>")
        )
        self.assertEqual(
            {"x": 0, "y": 36, "width": 1920, "height": 1008, "scale": 0.625},
            payload["screenshotOptions"]["clip"],
        )
        self.assertEqual("jpeg", payload["screenshotOptions"]["type"])

    def test_payload_carries_no_credential_field(self) -> None:
        html = _artifact(self.td / "a", "<html><head></head><body>x</body></html>")
        self.assertEqual(
            {"html", "viewport", "gotoOptions", "waitForTimeout", "screenshotOptions"},
            set(og_render.build_payload(html)),
        )

    def test_inlining_refuses_past_the_payload_ceiling(self) -> None:
        html = _artifact(
            self.td / "a",
            '<html><head></head><body><img src="assets/big.bin"></body></html>',
            {"assets/big.bin": b"A" * 4096},
        )
        with patch.object(og_render, "MAX_PAYLOAD_BYTES", 1024):
            with self.assertRaises(og_render.OgRenderError) as ctx:
                og_render.build_render_html(html)
        self.assertIn("ceiling", str(ctx.exception))


class ForgeEnvTests(_Tmp):
    """Credentials handling.

    Every case pins FORGE_ENV *and* FORGE_ENV_FILE at a temp file and clears
    the CLOUDFLARE_* pair, so a run on a real operator machine can never fall
    through to ~/.config/silex/forge.env. An earlier revision resolved
    load_config.forge_env_path() first, which reads FORGE_ENV only, ignored the
    FORGE_ENV_FILE these tests set, read the real credentials file and printed
    the production token in an assertion message. Assertions here therefore
    compare booleans, never a credential value.
    """

    def _isolated(self, env: Path) -> dict[str, str]:
        return {
            "FORGE_ENV_FILE": str(env),
            "FORGE_ENV": str(env),
            "CLOUDFLARE_API_TOKEN": "",
            "CLOUDFLARE_ACCOUNT_ID": "",
        }

    def _write_env(self, mode: int) -> Path:
        env = self.td / "forge.env"
        env.write_text("CLOUDFLARE_API_TOKEN=tok\nCLOUDFLARE_ACCOUNT_ID=acct\n")
        env.chmod(mode)
        return env

    def test_designated_file_wins_over_the_shared_resolution(self) -> None:
        env = self._write_env(0o600)
        with patch.dict("os.environ", {"FORGE_ENV_FILE": str(env), "FORGE_ENV": "/nope"}):
            self.assertEqual(env, og_render._forge_env_path())

    def test_loose_permissions_are_refused(self) -> None:
        """publish.sh dies on a loose mode; a second reader must not accept it."""
        env = self._write_env(0o644)
        with patch.dict("os.environ", self._isolated(env)):
            with self.assertRaises(og_render.OgRenderError) as ctx:
                og_render.load_forge_env()
        message = str(ctx.exception)
        self.assertIn("chmod 600", message)
        self.assertNotIn("tok", message)

    def test_tight_permissions_populate_the_environment(self) -> None:
        env = self._write_env(0o600)
        with patch.dict("os.environ", self._isolated(env)):
            og_render.load_forge_env()
            self.assertTrue(os.environ["CLOUDFLARE_API_TOKEN"] == "tok")
            self.assertTrue(os.environ["CLOUDFLARE_ACCOUNT_ID"] == "acct")


class CliTests(_Tmp):
    def test_digest_cli_prints_64_hex(self) -> None:
        html = _artifact(self.td / "a", "<html><head></head><body>cli</body></html>")
        buf = StringIO()
        with patch("sys.stdout", buf):
            rc = og_render.main(["digest", str(html)])
        self.assertEqual(0, rc)
        out = buf.getvalue().strip()
        self.assertEqual(64, len(out))
        int(out, 16)

    def test_payload_out_is_owner_only(self) -> None:
        html = _artifact(self.td / "a", "<html><head></head><body>cli</body></html>")
        out = self.td / "payload.json"
        buf = StringIO()
        with patch("sys.stdout", buf):
            rc = og_render.main(["payload", str(html), "--out", str(out)])
        self.assertEqual(0, rc)
        self.assertEqual(0o600, out.stat().st_mode & 0o777)


if __name__ == "__main__":
    unittest.main()
