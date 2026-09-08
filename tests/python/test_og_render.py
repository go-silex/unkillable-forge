"""Unit tests for lib/og_render.py — digest v2, payload, Browser Run probe.

No network: the one class that exercises the HTTP path (ProbeTests) stubs
urllib.request.urlopen and inspects the recorded request. What is pinned is
the identity contract gen-og-images.sh and persist_og_to_hub must share, the
payload invariants that decide what Cloudflare actually receives, and the fact
that the doctor probe reaches the very endpoint render() posts to.
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
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

    Every case pins FORGE_ENV, FORGE_ENV_FILE *and* FORGE_CONFIG at temp paths
    and clears the CLOUDFLARE_* pair, so a run on a real operator machine can
    never fall through to ~/.config/silex/forge.env — nor, since _credentials()
    gained its config fallback, to ~/.config/silex/forge.config.json, whose
    cloudflare_account_id would make a refusal case pass in CI and fail here.
    An earlier revision resolved load_config.forge_env_path() first, which
    reads FORGE_ENV only, ignored the FORGE_ENV_FILE these tests set, read the
    real credentials file and printed the production token in an assertion
    message. Assertions here therefore compare booleans, never a credential
    value.
    """

    def _isolated(self, env: Path) -> dict[str, str]:
        return {
            "FORGE_ENV_FILE": str(env),
            "FORGE_ENV": str(env),
            # Absent on purpose: _merged_config() then falls back to the
            # example config, whose cloudflare_account_id is empty.
            "FORGE_CONFIG": str(self.td / "absent.config.json"),
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

    def test_no_account_anywhere_is_still_refused(self) -> None:
        """The config fallback must not reach the operator's own config here.

        FORGE_CONFIG is pinned at an absent path, so the fallback resolves the
        example config's empty cloudflare_account_id and the refusal is the
        same in CI and on a configured publisher machine. Written without
        FORGE_CONFIG, this case would pass in CI and fail here — and its
        assertion message would carry a real account id.
        """
        env = self.td / "token-only.env"
        env.write_text("CLOUDFLARE_API_TOKEN=tok\n", encoding="utf-8")
        env.chmod(0o600)
        with patch.dict("os.environ", self._isolated(env)):
            og_render.load_forge_env()
            with self.assertRaises(og_render.OgRenderError) as ctx:
                og_render._credentials()
        message = str(ctx.exception)
        self.assertIn("CLOUDFLARE_ACCOUNT_ID missing", message)
        self.assertIsNone(re.search(r"[0-9a-f]{32}", message))

    def test_render_refuses_before_it_inlines_the_payload(self) -> None:
        """Ordering, not decoration: inlining first costs up to 45 MB per slug.

        _screenshot() re-resolves the credential, so render()'s own check reads
        as redundant — a cleanup that drops it would still pass every other
        test while moving the refusal to after a full inline pass, once per
        slug in gen-og-images.sh.
        """
        html = _artifact(self.td / "a", "<html><head></head><body>x</body></html>")
        env = self._isolated(self.td / "absent.env")

        def never(*_a: object, **_k: object) -> dict:
            self.fail("render() inlined the payload before refusing")

        with patch.dict("os.environ", env):
            with patch.object(og_render, "build_payload", never):
                with self.assertRaises(og_render.OgRenderError) as ctx:
                    og_render.render(html)
        self.assertIn("CLOUDFLARE_API_TOKEN missing", str(ctx.exception))


class _Response:
    """Minimal urlopen stand-in: a context manager with read()."""

    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *_exc: object) -> bool:
        return False


class ProbeTests(_Tmp):
    """probe() — what forge-doctor.sh --online asks Browser Run.

    The credentials are pinned in the environment (both keys set, so
    load_forge_env() never reaches a real forge.env) and urlopen is stubbed:
    no request leaves the process. FORGE_CONFIG is pinned too: a case that
    blanks CLOUDFLARE_ACCOUNT_ID reaches _credentials()' config fallback,
    which would otherwise read the operator's own forge.config.json.
    """

    def _env(self) -> dict[str, str]:
        absent = str(self.td / "absent.env")
        return {
            "FORGE_ENV_FILE": absent,
            "FORGE_ENV": absent,
            "FORGE_CONFIG": str(self.td / "absent.config.json"),
            "CLOUDFLARE_API_TOKEN": "tok",
            "CLOUDFLARE_ACCOUNT_ID": "acct-1234",
        }

    def test_probe_hits_the_endpoint_render_uses_and_writes_nothing(self) -> None:
        """A probe against another endpoint would prove nothing about a render."""
        html = _artifact(self.td / "a", "<html><head></head><body>x</body></html>")
        seen: list[urllib.request.Request] = []

        def fake(request: urllib.request.Request, timeout: object = None) -> _Response:
            seen.append(request)
            return _Response(b"\xff\xd8\xff\xd9")

        with patch.dict("os.environ", self._env()):
            with patch("urllib.request.urlopen", fake):
                before = sorted(p.name for p in self.td.rglob("*"))
                self.assertIsNone(og_render.probe())
                after = sorted(p.name for p in self.td.rglob("*"))
                og_render.render(html)

        probe_req, render_req = seen
        # Same account and endpoint — the probe differs only by the cache knob,
        # so it still stands in for the render it is asked about.
        self.assertEqual(f"{render_req.full_url}?cacheTTL=0", probe_req.full_url)
        self.assertIn("browser-rendering/screenshot", probe_req.full_url)
        self.assertEqual("POST", probe_req.get_method())
        self.assertEqual("Bearer tok", probe_req.get_header("Authorization"))
        # The probe writes no file: doctor is a read-only check.
        self.assertEqual(before, after)

    def test_probe_payload_is_a_64px_blank_page_with_no_settle_wait(self) -> None:
        """One doctor run costs one render: SETTLE_MS buys nothing here."""
        seen: list[dict] = []

        def fake(request: urllib.request.Request, timeout: object = None) -> _Response:
            seen.append(json.loads(request.data))
            return _Response(b"\xff\xd8\xff\xd9")

        with patch.dict("os.environ", self._env()):
            with patch("urllib.request.urlopen", fake):
                og_render.probe()

        body = seen[0]
        self.assertEqual(
            {"html", "viewport", "gotoOptions", "screenshotOptions"}, set(body)
        )
        self.assertEqual({"width": 64, "height": 64}, body["viewport"])
        self.assertEqual("jpeg", body["screenshotOptions"]["type"])
        self.assertNotIn("clip", body["screenshotOptions"])
        self.assertEqual(og_render.PROBE_HTML, body["html"])

    def test_the_probe_disables_the_response_cache(self) -> None:
        """A replayed verdict is not a check.

        Quick Actions caches generated content ~5 s per account, and the API
        reference documents `cacheTTL` as a query parameter ("Set to 0 to
        disable"). Without it the probe is replayable: an invalid token is
        rejected ahead of the cache (measured HTTP 401), but a valid token
        stripped of the permission answers 403 and that ordering was never
        tested, so a cached 200 could report the pre-change verdict. The body
        stays constant — `cacheTTL` is rejected there (HTTP 400) — and
        render() keeps the default cache, where an identical payload deserves
        an identical card.
        """
        seen: list[urllib.request.Request] = []

        def fake(request: urllib.request.Request, timeout: object = None) -> _Response:
            seen.append(request)
            return _Response(b"\xff\xd8\xff\xd9")

        html = _artifact(self.td / "b", "<html><head></head><body>y</body></html>")
        with patch.dict("os.environ", self._env()):
            with patch("urllib.request.urlopen", fake):
                og_render.probe()
                og_render.probe()
                og_render.render(html)

        first, second, render_req = seen
        self.assertTrue(first.full_url.endswith("?cacheTTL=0"), first.full_url)
        self.assertEqual(first.full_url, second.full_url)
        self.assertEqual(json.loads(first.data), json.loads(second.data))
        self.assertNotIn("cacheTTL", json.loads(first.data))
        # The render is left cacheable on purpose.
        self.assertNotIn("cacheTTL", render_req.full_url)

    def test_in_band_failure_is_refused_with_the_api_reason(self) -> None:
        """A 200 carrying JSON means the API refused; doctor needs the reason."""

        def fake(request: urllib.request.Request, timeout: object = None) -> _Response:
            return _Response(b'{"errors":[{"message":"Unauthorized to render"}]}')

        with patch.dict("os.environ", self._env()):
            with patch("urllib.request.urlopen", fake):
                with self.assertRaises(og_render.OgRenderError) as ctx:
                    og_render.probe()
        message = str(ctx.exception)
        self.assertIn("no JPEG", message)
        self.assertIn("Unauthorized to render", message)

    def test_http_error_is_refused_with_the_api_reason(self) -> None:
        """A 403 is what a token without Browser Run · Edit returns."""

        def fake(request: urllib.request.Request, timeout: object = None) -> _Response:
            raise urllib.error.HTTPError(
                request.full_url,
                403,
                "Forbidden",
                {},
                io.BytesIO(b'{"errors":[{"message":"Actor lacks permission"}]}'),
            )

        with patch.dict("os.environ", self._env()):
            with patch("urllib.request.urlopen", fake):
                with self.assertRaises(og_render.OgRenderError) as ctx:
                    og_render.probe()
        message = str(ctx.exception)
        self.assertIn("HTTP 403", message)
        self.assertIn("Actor lacks permission", message)

    def test_probe_cli_reports_ok(self) -> None:
        def fake(request: urllib.request.Request, timeout: object = None) -> _Response:
            return _Response(b"\xff\xd8\xff\xd9")

        buf = StringIO()
        with patch.dict("os.environ", self._env()):
            with patch("urllib.request.urlopen", fake):
                with patch("sys.stdout", buf):
                    rc = og_render.main(["probe"])
        self.assertEqual(0, rc)
        self.assertEqual("browser run: ok", buf.getvalue().strip())

    def test_account_id_falls_back_to_the_local_config(self) -> None:
        """forge.config.json's cloudflare_account_id is a documented source.

        publish.sh exports the resolved id, but gen-og-images.sh only eval's
        export_env into shell variables, so a standalone run reaches this
        module with forge.env as its only source. Refusing here what
        load_config resolves would fail a machine the rest of the forge
        considers configured.
        """
        html = _artifact(self.td / "a", "<html><head></head><body>x</body></html>")
        cfg = self.td / "forge.config.json"
        cfg.write_text(
            json.dumps({"cloudflare_account_id": "acct-from-config"}), encoding="utf-8"
        )
        seen: list[str] = []

        def fake(request: urllib.request.Request, timeout: object = None) -> _Response:
            seen.append(request.full_url)
            return _Response(b"\xff\xd8\xff\xd9")

        env = self._env()
        env["CLOUDFLARE_ACCOUNT_ID"] = ""
        env["FORGE_CONFIG"] = str(cfg)
        with patch.dict("os.environ", env):
            with patch("urllib.request.urlopen", fake):
                og_render.probe()
                og_render.render(html)
        self.assertEqual(2, len(seen))
        for url in seen:
            self.assertIn("/accounts/acct-from-config/", url)

    def test_supplied_credentials_are_used_without_reading_forge_env(self) -> None:
        """forge-doctor.sh resolves the pair itself and owns the perms verdict.

        The designated forge.env is world-readable here: load_forge_env()
        refuses that mode, so a probe that still read it would report an
        env-permission problem as a Browser Run failure.
        """
        loose = self.td / "loose.env"
        loose.write_text("CLOUDFLARE_API_TOKEN=from-file\n", encoding="utf-8")
        loose.chmod(0o644)
        seen: list[urllib.request.Request] = []

        def fake(request: urllib.request.Request, timeout: object = None) -> _Response:
            seen.append(request)
            return _Response(b"\xff\xd8\xff\xd9")

        env = self._env()
        env["FORGE_ENV_FILE"] = str(loose)
        env["FORGE_ENV"] = str(loose)
        env["CLOUDFLARE_API_TOKEN"] = ""
        env["CLOUDFLARE_ACCOUNT_ID"] = ""
        with patch.dict("os.environ", env):
            with patch("urllib.request.urlopen", fake):
                self.assertIsNone(og_render.probe(token="tok-9", account="acct-9"))
        self.assertIn("/accounts/acct-9/", seen[0].full_url)
        self.assertEqual("Bearer tok-9", seen[0].get_header("Authorization"))


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
