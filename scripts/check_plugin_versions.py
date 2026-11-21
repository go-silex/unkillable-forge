#!/usr/bin/env python3
"""Validate independently versioned local plugin components and catalogues."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SEMVER = re.compile(r"^\d+\.\d+\.\d+$")
HEADING = re.compile(r"^## \[([^\]]+)\]")
LEGACY = "silex-forge"
ENGINE_MANIFEST = "engine.json"
ENGINE_CHANGELOG = "docs/engine-changelog.md"
COMPONENTS = {
    LEGACY: "CHANGELOG.md",
    "unkillable-forge": "plugins/unkillable-forge/CHANGELOG.md",
}
MANIFESTS = (
    "plugin.json",
    ".claude-plugin/plugin.json",
    ".grok-plugin/plugin.json",
    ".omp-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    "package.json",
)
CATALOGS = (
    (".claude-plugin/marketplace.json", "version"),
    (".grok-plugin/marketplace.json", "version"),
    (".omp-plugin/marketplace.json", "metadata.version"),
    (".agents/plugins/marketplace.json", None),
)
CANON = "plugins/silex-forge/plugin.json"


def _collect(root: Path) -> tuple[dict[str, str], list[str]]:
    errors: list[str] = []
    advertised = {LEGACY}
    found: list[tuple[str, str, str, object]] = []

    def load(rel: str) -> object:
        path = root / rel
        if not path.is_file():
            errors.append(f"{rel}: missing file")
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                errors.append(f"{rel}: expected object")
                return None
            return data
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            errors.append(f"{rel}: invalid JSON ({exc})")
            return None

    def owner(rel: str, field: str, value: object) -> str | None:
        if not isinstance(value, str) or not value:
            errors.append(f"{rel} {field}: missing or invalid component name")
            return None
        if value not in COMPONENTS:
            errors.append(f"{rel} {field}: unknown component {value!r}")
            return None
        advertised.add(value)
        return value

    for rel, version_field in CATALOGS:
        if version_field is None and not (root / rel).exists():
            continue
        data = load(rel)
        if not isinstance(data, dict):
            if data is not None:
                errors.append(f"{rel}: expected object")
            continue
        name = owner(rel, "name", data.get("name"))
        if version_field and name:
            if version_field == "metadata.version":
                meta = data.get("metadata")
                value = meta.get("version") if isinstance(meta, dict) else None
            else:
                value = data.get("version")
            found.append((rel, version_field, name, value))
        rows = data.get("plugins")
        if not isinstance(rows, list) or not rows:
            errors.append(f"{rel} plugins: missing or invalid list")
            continue
        for i, row in enumerate(rows):
            if not isinstance(row, dict):
                errors.append(f"{rel} plugins[{i}]: expected object")
                continue
            name = owner(rel, f"plugins[{i}].name", row.get("name"))
            if name and version_field:
                found.append((rel, f"plugins[{i}].version", name, row.get("version")))

    advertised.update(name for name in COMPONENTS if (root / "plugins" / name).exists())
    if "unkillable-forge" in advertised and not (root / CATALOGS[-1][0]).is_file():
        errors.append(f"{CATALOGS[-1][0]}: missing file")
    versions: dict[str, str] = {}
    for name in sorted(advertised):
        for manifest in MANIFESTS:
            rel = f"plugins/{name}/{manifest}"
            data = load(rel)
            if not isinstance(data, dict):
                if data is not None:
                    errors.append(f"{rel}: expected object")
                continue
            actual_name = data.get("name")
            if actual_name != name:
                errors.append(f"{rel} name: expected {name!r}, got {actual_name!r}")
            value = data.get("version")
            found.append((rel, "version", name, value))
            if manifest == "plugin.json" and isinstance(value, str) and SEMVER.fullmatch(value):
                versions[name] = value

    for rel, field, name, value in found:
        if not isinstance(value, str) or not SEMVER.fullmatch(value):
            errors.append(f"{rel} {field}={value!r} (need X.Y.Z)")
        elif name in versions and value != versions[name]:
            errors.append(f"{rel} {field}={value} ≠ {name} canon {versions[name]}")
    return versions, errors


def collect(root: Path, component: str = LEGACY) -> tuple[str, list[str]]:
    versions, errors = _collect(root)
    if component not in COMPONENTS:
        errors.append(f"unknown component {component!r}")
    elif component not in versions:
        errors.append(f"{component}: missing or invalid canonical version")
    return versions.get(component, ""), errors


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


def check_engine(root: Path) -> tuple[str, list[str]]:
    """Validate engine.json shape and a matching docs/engine-changelog.md entry."""
    errors: list[str] = []
    path = root / ENGINE_MANIFEST
    if not path.is_file():
        return "", [f"{ENGINE_MANIFEST}: missing file"]
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        return "", [f"{ENGINE_MANIFEST}: invalid JSON ({exc})"]
    if not isinstance(data, dict):
        return "", [f"{ENGINE_MANIFEST}: expected object"]
    allowed = {"version", "rollbackCompatibleFrom"}
    extra = sorted(set(data) - allowed)
    if extra:
        errors.append(f"{ENGINE_MANIFEST}: unexpected keys {extra}")
    version = data.get("version")
    rollback = data.get("rollbackCompatibleFrom")
    if not isinstance(version, str) or not SEMVER.fullmatch(version):
        errors.append(f"{ENGINE_MANIFEST} version={version!r} (need X.Y.Z)")
        version = ""
    if not isinstance(rollback, str) or not SEMVER.fullmatch(rollback):
        errors.append(f"{ENGINE_MANIFEST} rollbackCompatibleFrom={rollback!r} (need X.Y.Z)")
    elif version and _semver_tuple(rollback) > _semver_tuple(version):
        errors.append(
            f"{ENGINE_MANIFEST}: rollbackCompatibleFrom {rollback} > version {version}"
        )
    cl = root / ENGINE_CHANGELOG
    if not cl.is_file():
        errors.append(f"{ENGINE_CHANGELOG}: missing file")
    elif version:
        text = cl.read_text(encoding="utf-8")
        if not changelog_has_version(text, version):
            errors.append(f"{ENGINE_CHANGELOG}: missing ## [{version}]")
        elif not changelog_notes(text, version):
            errors.append(f"{ENGINE_CHANGELOG}: empty ## [{version}] section")
    return version, errors


def _semver_tuple(value: str) -> tuple[int, int, int]:
    major, minor, patch = value.split(".")
    return int(major), int(minor), int(patch)


def check(root: Path, component: str = LEGACY) -> tuple[str, list[str]]:
    versions, errors = _collect(root)
    if component not in COMPONENTS:
        errors.append(f"unknown component {component!r}")
    elif component not in versions:
        errors.append(f"{component}: missing or invalid canonical version")
    for name, version in versions.items():
        rel = COMPONENTS[name]
        cl = root / rel
        if not cl.is_file():
            errors.append(f"{rel}: missing file")
            continue
        text = cl.read_text(encoding="utf-8")
        if not changelog_has_version(text, version):
            errors.append(f"{rel}: missing ## [{version}]")
        elif not changelog_notes(text, version):
            errors.append(f"{rel}: empty ## [{version}] section")
    _, engine_errors = check_engine(root)
    errors.extend(engine_errors)
    return versions.get(component, ""), errors


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
    parser.add_argument("--print-engine-version", action="store_true")
    parser.add_argument("--component", choices=COMPONENTS, default=LEGACY)
    args = parser.parse_args(argv)
    root = args.root.resolve()
    if args.print_engine_version:
        engine_version, engine_errors = check_engine(root)
        if engine_errors:
            print("engine version check failed:", file=sys.stderr)
            for e in engine_errors:
                print(f"  {e}", file=sys.stderr)
            return 1
        print(engine_version)
        return 0
    version, errors = check(root, args.component)
    if errors:
        print("plugin version check failed:", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        return 1
    if args.print_notes:
        notes = changelog_notes((root / COMPONENTS[args.component]).read_text(encoding="utf-8"), version)
        assert notes is not None
        sys.stdout.write(notes)
        return 0
    if args.print_version:
        print(version)
        return 0
    print(f"plugin version {version} consistent (Claude/Grok/OMP/Codex + CHANGELOG); engine.json ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
