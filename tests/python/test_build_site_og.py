#!/usr/bin/env python3
"""build-site-from-hub must not copy a stale hub og.jpg into the deploy tree.

A failed render used to leave the previous JPEG in the hub. The copy loop then
shipped it unconditionally, so a modified deck kept the old thumbnail forever.
Skipping a mismatched or missing og.src makes the deploy tree have no card,
which gen-og-images.sh is_stale treats as stale.
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "plugins" / "silex-forge" / "scripts"
LIB = SCRIPTS / "lib"

sys.path.insert(0, str(LIB))
from og_render import canonical_digest  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "build_site_from_hub", SCRIPTS / "build-site-from-hub.py"
)
assert _spec is not None and _spec.loader is not None
build_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build_mod)

SLUG = "deck"
HTML_V1 = "<html><head></head><body>v1</body></html>\n"
HTML_V2 = "<html><head></head><body>v2</body></html>\n"
FAKE_JPG = b"FAKE_JPEG"
FAKE_IMAGE_DIGEST = "ab" * 32


class BuildSiteOgTests(unittest.TestCase):
    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self.tmp = Path(self._td.name)
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.hub = self.tmp / "hub"
        self.artifacts = self.hub / "artifacts"
        self.slug_dir = self.artifacts / SLUG
        self.slug_dir.mkdir(parents=True)
        self.repo = self.tmp / "repo"
        (self.repo / "site").mkdir(parents=True)
        (self.repo / "registry").mkdir(parents=True)
        self.cfg_path = self.tmp / "forge.config.json"
        self.cfg_path.write_text(
            json.dumps(
                {
                    "hub_root": str(self.hub),
                    "artifacts_dir": "artifacts",
                    "site_dir": "site",
                    "registry_dir": "registry",
                    "internal_prefix": "a",
                }
            )
            + "\n",
            encoding="utf-8",
        )
        self._env = patch.dict(
            os.environ,
            {
                "HOME": str(self.home),
                "FORGE_CONFIG": str(self.cfg_path),
                "FORGE_ENV": str(self.home / "absent.env"),
            },
            clear=False,
        )
        self._env.start()
        for leak in (
            "HUB_ROOT",
            "CLOUDFLARE_API_TOKEN",
            "CLOUDFLARE_API_KEY",
            "CLOUDFLARE_ACCOUNT_ID",
            "FORGE_SHARES_KV_ID",
        ):
            os.environ.pop(leak, None)

    def tearDown(self) -> None:
        self._env.stop()
        self._td.cleanup()

    def _deploy(self) -> Path:
        return self.repo / "site" / "a" / SLUG

    def _write_html(self, html: str) -> Path:
        path = self.slug_dir / "index.html"
        path.write_text(html, encoding="utf-8")
        return path

    def _write_jpg(self) -> None:
        (self.slug_dir / "og.jpg").write_bytes(FAKE_JPG)

    def _write_proof(self, source_digest: str) -> None:
        (self.slug_dir / "og.src").write_text(
            f"{source_digest} {FAKE_IMAGE_DIGEST}\n", encoding="utf-8"
        )

    def _build(self) -> None:
        # gen-index resolves ROOT from its own path (the real worktree) and
        # would write site/index.html there. The OG copy predicate does not
        # depend on the catalogue, so skip that subprocess only.
        real_run = build_mod.subprocess.run

        def run(cmd, *args, **kwargs):
            if any(str(part).endswith("gen-index.py") for part in cmd):
                return subprocess.CompletedProcess(list(cmd), 0)
            return real_run(cmd, *args, **kwargs)

        with patch.object(build_mod.subprocess, "run", side_effect=run):
            rc = build_mod.main(
                ["build-site-from-hub.py", "--repo-root", str(self.repo)]
            )
        self.assertEqual(0, rc)

    def test_matching_proof_copies_jpg_not_src(self) -> None:
        html = self._write_html(HTML_V1)
        self._write_jpg()
        self._write_proof(canonical_digest(html))
        self._build()
        dest = self._deploy()
        self.assertEqual(FAKE_JPG, (dest / "og.jpg").read_bytes())
        self.assertFalse((dest / "og.src").exists())

    def test_changed_html_with_old_proof_skips_jpg(self) -> None:
        html = self._write_html(HTML_V1)
        self._write_jpg()
        self._write_proof(canonical_digest(html))
        html.write_text(HTML_V2, encoding="utf-8")
        self._build()
        dest = self._deploy()
        self.assertFalse((dest / "og.jpg").exists())
        self.assertFalse((dest / "og.src").exists())
        self.assertEqual(FAKE_JPG, (self.slug_dir / "og.jpg").read_bytes())

    def test_jpg_without_og_src_is_not_copied(self) -> None:
        self._write_html(HTML_V1)
        self._write_jpg()
        self._build()
        dest = self._deploy()
        self.assertFalse((dest / "og.jpg").exists())
        self.assertFalse((dest / "og.src").exists())
        self.assertEqual(FAKE_JPG, (self.slug_dir / "og.jpg").read_bytes())


if __name__ == "__main__":
    unittest.main()
