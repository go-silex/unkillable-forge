#!/usr/bin/env python3
"""Assert one SemVer across Claude / Grok / OMP / Codex plugin manifests + CHANGELOG.

Canon: plugins/silex-forge/plugin.json  (Agent Plugins root — OMP marketplace).
Codex catalog (.agents/plugins/marketplace.json) has no version field.

Usage:
  python3 scripts/check-plugin-versions.py
  python3 scripts/check-plugin-versions.py --print-version
  python3 scripts/check-plugin-versions.py --print-notes
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Callable

SEMVER = re.compile(r"^\d+\.\d+\.\d+$")
HEADING = re.compile(r"^## \[([^\]]+)\]")

Extract = Callable[[object], list[tuple[str, str]]]


def _load_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def _plugin_version(data: object) -> list[tuple[str, str]]:
    if not isinstance(data, dict):
        return [("(root)", f"expected object, got {type(data).__name__}")]
    v = data.get("version")
    if not isinstance(v, str) or not v:
        return [("version", "missing")]
    return [("version", v)]


def _catalog_claude_grok(data: object) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    if not isinstance(data, dict):
        return [("(root)", f"expected object, got {type(data).__name__}")]
    v = data.get("version")
    out.append(("version", v if isinstance(v, str) and v else "missing"))
    plugins = data.get("plugins")
    if not isinstance(plugins, list) or not plugins:
        out.append(("plugins[]", "missing"))
        return out
    for i, row in enumerate(plugins):
        if not isinstance(row, dict):
            out.append((f"plugins[{i}]", "not an object"))
            continue
        pv = row.get("version")
        label = row.get("name") or i
        out.append(
            (f"plugins[{label}].version", pv if isinstance(pv, str) and pv else "missing")
        )
    return out


def _catalog_omp(data: object) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    if not isinstance(data, dict):
        return [("(root)", f"expected object, got {type(data).__name__}")]
    meta = data.get("metadata")
    mv = meta.get("version") if isinstance(meta, dict) else None
    out.append(
        ("metadata.version", mv if isinstance(mv, str) and mv else "missing")
    )
    plugins = data.get("plugins")
    if not isinstance(plugins, list) or not plugins:
        out.append(("plugins[]", "missing"))
        return out
    for i, row in enumerate(plugins):
        if not isinstance(row, dict):
            out.append((f"plugins[{i}]", "not an object"))
            continue
        pv = row.get("version")
        label = row.get("name") or i
        out.append(
            (f"plugins[{label}].version", pv if isinstance(pv, str) and pv else "missing")
        )
    return out


SOURCES: list[tuple[str, Extract]] = [
    ("plugins/silex-forge/plugin.json", _plugin_version),
    ("plugins/silex-forge/.claude-plugin/plugin.json", _plugin_version),
    ("plugins/silex-forge/.grok-plugin/plugin.json", _plugin_version),
    ("plugins/silex-forge/.omp-plugin/plugin.json", _plugin_version),
    ("plugins/silex-forge/.codex-plugin/plugin.json", _plugin_version),
    ("plugins/silex-forge/package.json", _plugin_version),
    (".claude-plugin/marketplace.json", _catalog_claude_grok),
    (".grok-plugin/marketplace.json", _catalog_claude_grok),
    (".omp-plugin/marketplace.json", _catalog_omp),
]

CANON = "plugins/silex-forge/plugin.json"


def collect(root: Path) -> tuple[str, list[str]]:
    errors: list[str] = []
    found: list[tuple[str, str, str]] = []
    for rel, extract in SOURCES:
        path = root / rel
        if not path.is_file():
            errors.append(f"{rel}: missing file")
            continue
        try:
            data = _load_json(path)
        except json.JSONDecodeError as e:
            errors.append(f"{rel}: invalid JSON ({e})")
            continue
        for field, value in extract(data):
            found.append((rel, field, value))
            if value == "missing" or not SEMVER.match(value):
                errors.append(f"{rel} {field}={value!r} (need X.Y.Z)")

    canon_vals = [v for rel, _, v in found if rel == CANON]
    if not canon_vals:
        errors.append(f"{CANON}: no version (canon)")
        return "", errors
    canon = canon_vals[0]
    for rel, field, value in found:
        if SEMVER.match(value) and value != canon:
            errors.append(f"{rel} {field}={value} ≠ canon {canon}")
    return canon, errors


def changelog_has_version(text: str, version: str) -> bool:
    return f"## [{version}]" in text


def changelog_notes(text: str, version: str) -> str | None:
    lines = text.splitlines()
    start = None
    for i, line in enumerate(lines):
        m = HEADING.match(line)
        if m and m.group(1) == version:
            start = i
            break
    if start is None:
        return None
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if HEADING.match(lines[j]):
            end = j
            break
    body = "\n".join(lines[start:end]).strip()
    return body + "\n"


def check(root: Path) -> tuple[str, list[str]]:
    version, errors = collect(root)
    cl = root / "CHANGELOG.md"
    if not cl.is_file():
        errors.append("CHANGELOG.md: missing file")
    elif version:
        text = cl.read_text(encoding="utf-8")
        if not changelog_has_version(text, version):
            errors.append(f"CHANGELOG.md: missing ## [{version}]")
        else:
            notes = changelog_notes(text, version)
            if notes is None or not notes.strip():
                errors.append(f"CHANGELOG.md: empty ## [{version}] section")
    return version, errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parent.parent,
        help="repository root",
    )
    parser.add_argument("--print-version", action="store_true")
    parser.add_argument("--print-notes", action="store_true")
    args = parser.parse_args(argv)
    root = args.root.resolve()
    version, errors = check(root)
    if errors:
        print("plugin version check failed:", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        return 1
    if args.print_notes:
        notes = changelog_notes((root / "CHANGELOG.md").read_text(encoding="utf-8"), version)
        assert notes is not None
        sys.stdout.write(notes)
        return 0
    if args.print_version:
        print(version)
        return 0
    print(f"plugin version {version} consistent (Claude/Grok/OMP/Codex + CHANGELOG)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
