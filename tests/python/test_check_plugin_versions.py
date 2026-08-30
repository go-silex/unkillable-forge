#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from check_plugin_versions import (  # noqa: E402
    check,
    changelog_notes,
    collect,
)


PLUGIN = {
    "name": "silex-forge",
    "version": "1.8.1",
    "description": "test",
}
CATALOG = {
    "name": "silex-forge",
    "version": "1.8.1",
    "owner": {"name": "Silex"},
    "plugins": [{"name": "silex-forge", "version": "1.8.1", "source": "./plugins/silex-forge"}],
}
OMP_CATALOG = {
    "name": "silex-forge",
    "owner": {"name": "Silex"},
    "metadata": {"version": "1.8.1"},
    "plugins": [{"name": "silex-forge", "version": "1.8.1", "source": "./plugins/silex-forge"}],
}
CHANGELOG = """# Changelog

## [1.8.1] - 2026-08-30

### Added

- test notes

## [1.8.0] - 2026-08-25

### Added

- previous
"""


def _write_tree(base: Path, *, omp_version: str = "1.8.1", changelog: str = CHANGELOG) -> Path:
    (base / "plugins/silex-forge/.claude-plugin").mkdir(parents=True)
    (base / "plugins/silex-forge/.grok-plugin").mkdir(parents=True)
    (base / "plugins/silex-forge/.omp-plugin").mkdir(parents=True)
    (base / "plugins/silex-forge/.codex-plugin").mkdir(parents=True)
    (base / ".claude-plugin").mkdir()
    (base / ".grok-plugin").mkdir()
    (base / ".omp-plugin").mkdir()
    for rel in (
        "plugins/silex-forge/plugin.json",
        "plugins/silex-forge/.claude-plugin/plugin.json",
        "plugins/silex-forge/.grok-plugin/plugin.json",
        "plugins/silex-forge/.omp-plugin/plugin.json",
        "plugins/silex-forge/.codex-plugin/plugin.json",
        "plugins/silex-forge/package.json",
    ):
        (base / rel).write_text(json.dumps(PLUGIN), encoding="utf-8")
    (base / ".claude-plugin/marketplace.json").write_text(json.dumps(CATALOG), encoding="utf-8")
    (base / ".grok-plugin/marketplace.json").write_text(json.dumps(CATALOG), encoding="utf-8")
    omp = dict(OMP_CATALOG)
    omp["metadata"] = {"version": omp_version}
    omp["plugins"] = [{"name": "silex-forge", "version": omp_version, "source": "./x"}]
    (base / ".omp-plugin/marketplace.json").write_text(json.dumps(omp), encoding="utf-8")
    (base / "CHANGELOG.md").write_text(changelog, encoding="utf-8")
    return base


class CheckPluginVersionsTest(unittest.TestCase):
    def test_repo_head_is_consistent(self) -> None:
        version, errors = check(ROOT)
        self.assertEqual(errors, [])
        self.assertRegex(version, r"^\d+\.\d+\.\d+$")

    def test_fixture_ok(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = _write_tree(Path(tmp))
            version, errors = check(root)
            self.assertEqual(version, "1.8.1")
            self.assertEqual(errors, [])

    def test_drift_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = _write_tree(Path(tmp), omp_version="1.8.0")
            version, errors = collect(root)
            self.assertEqual(version, "1.8.1")
            self.assertTrue(any("1.8.0" in e and "canon" in e for e in errors))

    def test_missing_changelog_heading_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = _write_tree(Path(tmp), changelog="# Changelog\n\n## [1.8.0]\n\n- x\n")
            _, errors = check(root)
            self.assertTrue(any("missing ## [1.8.1]" in e for e in errors))

    def test_notes_extract(self) -> None:
        notes = changelog_notes(CHANGELOG, "1.8.1")
        self.assertIsNotNone(notes)
        self.assertIn("test notes", notes)
        self.assertNotIn("1.8.0", notes)


if __name__ == "__main__":
    unittest.main()
