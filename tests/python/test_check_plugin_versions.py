#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
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
    (base / ".agents/plugins").mkdir(parents=True)
    (base / ".agents/plugins/marketplace.json").write_text(
        json.dumps({"name": "silex-forge", "plugins": [{"name": "silex-forge"}]}),
        encoding="utf-8",
    )
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


def _write_two_components(base: Path) -> Path:
    root = _write_tree(base, changelog=CHANGELOG + "\n## [1.0.0]\n\n- historical legacy notes\n")
    name = "unkillable-forge"
    for rel in (
        "plugin.json", ".claude-plugin/plugin.json", ".grok-plugin/plugin.json",
        ".omp-plugin/plugin.json", ".codex-plugin/plugin.json", "package.json",
    ):
        path = root / "plugins" / name / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"name": name, "version": "1.0.0"}), encoding="utf-8")
    (root / "plugins" / name / "CHANGELOG.md").write_text(
        "# Changelog\n\n## [1.0.0]\n\n- new component notes\n", encoding="utf-8"
    )
    for host in ("claude", "grok", "omp"):
        path = root / f".{host}-plugin/marketplace.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["name"] = name
        if host == "omp":
            data["metadata"]["version"] = "1.0.0"
        else:
            data["version"] = "1.0.0"
        data["plugins"].append({"name": name, "version": "1.0.0"})
        path.write_text(json.dumps(data), encoding="utf-8")
    path = root / ".agents/plugins/marketplace.json"
    path.write_text(json.dumps({"name": name, "plugins": [
        {"name": "silex-forge"}, {"name": name}
    ]}), encoding="utf-8")
    return root


def _cli(root: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(ROOT / "scripts/check_plugin_versions.py"), "--root", str(root), *args],
        text=True, capture_output=True, check=False,
    )


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

    def test_two_component_tree_and_selection(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = _write_two_components(Path(tmp))
            self.assertEqual(check(root), ("1.8.1", []))
            self.assertEqual(check(root, "unkillable-forge"), ("1.0.0", []))
            for args, expected in (
                (("--print-version",), "1.8.1\n"),
                (("--component", "silex-forge", "--print-version"), "1.8.1\n"),
                (("--component", "unkillable-forge", "--print-version"), "1.0.0\n"),
            ):
                result = _cli(root, *args)
                self.assertEqual((result.returncode, result.stdout), (0, expected))
            legacy = _cli(root, "--print-notes")
            explicit = _cli(root, "--component", "silex-forge", "--print-notes")
            new = _cli(root, "--component", "unkillable-forge", "--print-notes")
            self.assertEqual((legacy.returncode, explicit.returncode, new.returncode), (0, 0, 0))
            self.assertEqual(legacy.stdout, explicit.stdout)
            self.assertIn("test notes", legacy.stdout)
            self.assertIn("new component notes", new.stdout)
            self.assertNotIn("historical legacy notes", new.stdout)

    def test_component_drift_and_ownership_fail(self) -> None:
        cases = (
            ("plugins/unkillable-forge/package.json", lambda d: d.update(version="1.8.1")),
            ("plugins/silex-forge/.grok-plugin/plugin.json", lambda d: d.update(version="1.0.0")),
            (".omp-plugin/marketplace.json", lambda d: d["metadata"].update(version="1.8.1")),
            (".claude-plugin/marketplace.json", lambda d: d["plugins"][0].update(version="1.0.0")),
            (".grok-plugin/marketplace.json", lambda d: d.update(name="unknown")),
            (".agents/plugins/marketplace.json", lambda d: d["plugins"][0].pop("name")),
        )
        for rel, mutate in cases:
            with self.subTest(path=rel), tempfile.TemporaryDirectory() as tmp:
                root = _write_two_components(Path(tmp))
                path = root / rel
                data = json.loads(path.read_text(encoding="utf-8"))
                mutate(data)
                path.write_text(json.dumps(data), encoding="utf-8")
                self.assertTrue(check(root)[1])
                self.assertNotEqual(_cli(root, "--print-version").returncode, 0)

    def test_invalid_or_unavailable_selection_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = _write_tree(Path(tmp))
            self.assertTrue(check(root, "unknown")[1])
            self.assertTrue(check(root, "unkillable-forge")[1])
            for name in ("unknown", "", "unkillable-forge"):
                self.assertNotEqual(_cli(root, "--component", name, "--print-version").returncode, 0)

    def test_new_component_requires_its_own_changelog(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = _write_two_components(Path(tmp))
            (root / "plugins/unkillable-forge/CHANGELOG.md").write_text(
                "# Changelog\n\n## [0.9.0]\n", encoding="utf-8"
            )
            self.assertTrue(check(root)[1])
            self.assertNotEqual(_cli(root, "--component", "unkillable-forge", "--print-notes").returncode, 0)


if __name__ == "__main__":
    unittest.main()
