"""build-site-from-hub must materialise the deploy tree from the hub.

This exists because the function broke twice, silently, while nothing covered
it: an edit landed in the slug-discovery loop and left `slugs` empty, so
`build()` returned "no artifacts with index.html" and every publish would have
failed. Both times the syntax stayed valid, so a lint could not see it.

What is asserted is only the observable contract: which files reach the deploy
tree and which stay hub bookkeeping.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "plugins" / "silex-forge" / "scripts"

_spec = importlib.util.spec_from_file_location(
    "build_site_from_hub", SCRIPTS / "build-site-from-hub.py"
)
assert _spec is not None and _spec.loader is not None
build_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build_mod)


class BuildFromHubTests(unittest.TestCase):
    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        td = Path(self._td.name)
        self.hub = td / "hub"
        self.art = self.hub / "artifacts"
        self.repo = td / "repo"
        (self.repo / "site").mkdir(parents=True)
        (self.repo / "registry").mkdir(parents=True)
        for slug in ("deck-a", "deck-b"):
            d = self.art / slug
            d.mkdir(parents=True)
            (d / "index.html").write_text(
                f"<html><head></head><body>{slug}</body></html>\n", encoding="utf-8"
            )
            (d / "meta.json").write_text(
                json.dumps(
                    {
                        "slug": slug,
                        "title": f"T {slug}",
                        "type": "deck",
                        "date": "2026-01-01",
                        "path": f"/a/{slug}/",
                        "list_on_index": True,
                    }
                ),
                encoding="utf-8",
            )
            (d / "og.jpg").write_bytes(b"FAKE_JPEG")
            (d / "og.src").write_text("aa bb\n", encoding="utf-8")
        # deck-b is pinned; the marker is hub bookkeeping, never a served asset.
        (self.art / "deck-b" / "og.keep").write_text("", encoding="utf-8")
        # An entry with no index.html is not an artifact.
        (self.art / "not-an-artifact").mkdir()

        self.cfg = td / "cfg.json"
        self.cfg.write_text(
            json.dumps(
                {
                    "version": 1,
                    "hub_root": str(self.hub),
                    "artifacts_dir": "artifacts",
                    "site_dir": "site",
                    "registry_dir": "registry",
                    "internal_prefix": "a",
                    "public_host": "forge.example.invalid",
                    "forge_repo": "https://example.invalid/r.git",
                    "vault_markers": [],
                }
            ),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self._td.cleanup()

    def _build(self) -> int:
        import os

        prev = os.environ.get("FORGE_CONFIG")
        os.environ["FORGE_CONFIG"] = str(self.cfg)
        try:
            # main() slices argv[1:], so the program name must be present.
            return build_mod.main(
                ["build-site-from-hub.py", "--repo-root", str(self.repo)]
            )
        finally:
            if prev is None:
                os.environ.pop("FORGE_CONFIG", None)
            else:
                os.environ["FORGE_CONFIG"] = prev

    def test_every_hub_artifact_reaches_the_deploy_tree(self) -> None:
        self.assertEqual(0, self._build())
        for slug in ("deck-a", "deck-b"):
            dest = self.repo / "site" / "a" / slug
            self.assertTrue((dest / "index.html").is_file(), f"{slug}: no index.html")
            self.assertTrue(dest.is_dir(), f"{slug}: no deploy directory")
            self.assertTrue((self.repo / "registry" / f"{slug}.json").is_file())

    def test_hub_thumbnail_is_copied_unconditionally(self) -> None:
        """A per-slug gate here would delete live cards on a full-snapshot deploy."""
        self.assertEqual(0, self._build())
        for slug in ("deck-a", "deck-b"):
            jpg = self.repo / "site" / "a" / slug / "og.jpg"
            self.assertTrue(jpg.is_file(), f"{slug}: og.jpg not copied")
            self.assertEqual(b"FAKE_JPEG", jpg.read_bytes())

    def test_hub_bookkeeping_never_ships(self) -> None:
        self.assertEqual(0, self._build())
        for slug in ("deck-a", "deck-b"):
            dest = self.repo / "site" / "a" / slug
            self.assertFalse((dest / "og.src").exists(), f"{slug}: og.src leaked")
            self.assertFalse((dest / "og.keep").exists(), f"{slug}: og.keep leaked")
            self.assertFalse((dest / "meta.json").exists(), f"{slug}: meta.json leaked")

    def test_directory_without_index_html_is_not_an_artifact(self) -> None:
        self.assertEqual(0, self._build())
        self.assertFalse((self.repo / "site" / "a" / "not-an-artifact").exists())
        self.assertFalse((self.repo / "registry" / "not-an-artifact.json").exists())


if __name__ == "__main__":
    unittest.main()
