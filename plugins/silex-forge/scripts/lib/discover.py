#!/usr/bin/env python3
"""Derive forge.env values from an existing Cloudflare Pages project.

Pure parsing — every Cloudflare call lives in forge-discover.sh, so this module
stays testable without network or credentials.

Inputs are the raw outputs of, respectively:
  wrangler pages download config <project>   → a Wrangler TOML config
  wrangler whoami                            → the account table

Both work under `wrangler login` OAuth alone; no CLOUDFLARE_API_TOKEN.

Not discoverable, by nature:
  hub_root              local silex-hub vault path, invisible to Cloudflare
  CLOUDFLARE_API_TOKEN  a secret; publish.sh still requires one to deploy
"""
from __future__ import annotations

import json
import re
import sys
from typing import Any

# forge.env keys sourced from the Pages project's plain vars.
VAR_KEYS = (
    "CF_ACCESS_TEAM_DOMAIN",
    "CF_ACCESS_AUD",
    "PUBLIC_HOST",
    "SHLINK_API_URL",
)
# Binding name of the KV namespace backing /s/<slug>/<key>/ share links.
SHARES_BINDING = "SHARES"
ACCOUNT_ID_RE = re.compile(r"\b[0-9a-f]{32}\b")
_HEADER_WORDS = frozenset(
    {
        "account",
        "account id",
        "account name",
        "created",
        "created on",
        "domains",
        "id",
        "last",
        "last modified",
        "modified",
        "name",
        "project",
        "project name",
    }
)
_BOX_LINE = re.compile(r"^[\s┌┐└┘├┤┬┴┼─│┃━┏┓┗┛┣┫┳┻╋]+$")
_CELL_SPLIT = re.compile(r"[│|]")
_PROJECT_NAME = re.compile(r"^[A-Za-z0-9._-]+$")


def _unquote(raw: str) -> str:
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        body = raw[1:-1]
        if raw[0] == '"':
            try:
                return json.loads(f'"{body}"')
            except json.JSONDecodeError:
                return body
        return body
    return raw


def _sections(text: str) -> list[tuple[str, list[tuple[str, str]]]]:
    """Split TOML into (header, [(key, value)]) in file order.

    Table arrays keep their `[[...]]` header so repeated blocks stay distinct.
    """
    out: list[tuple[str, list[tuple[str, str]]]] = []
    header = ""
    pairs: list[tuple[str, str]] = []
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if s.startswith("["):
            out.append((header, pairs))
            header = s
            pairs = []
            continue
        key, sep, value = s.partition("=")
        if sep:
            pairs.append((key.strip(), _unquote(value)))
    out.append((header, pairs))
    return out


def _is_vars(header: str) -> bool:
    """Match [vars] and [env.<environment>.vars]."""
    return re.fullmatch(r"\[(?:env\.[A-Za-z0-9_-]+\.)?vars\]", header) is not None


def _is_kv(header: str) -> bool:
    return (
        re.fullmatch(r"\[\[(?:env\.[A-Za-z0-9_-]+\.)?kv_namespaces\]\]", header)
        is not None
    )


def _prefers_production(header: str) -> bool:
    return header.startswith("[env.production")


def parse_pages_config(text: str) -> dict[str, Any]:
    """Return {'name', 'vars', 'kv'} from a Wrangler Pages config.

    Production tables win over top-level ones: `wrangler pages deploy` targets
    the production environment, so its values are the ones actually live.
    """
    name = ""
    variables: dict[str, str] = {}
    kv: dict[str, str] = {}
    for header, pairs in _sections(text):
        if not header:
            for key, value in pairs:
                if key == "name":
                    name = value
        elif _is_vars(header):
            for key, value in pairs:
                if key not in variables or _prefers_production(header):
                    variables[key] = value
        elif _is_kv(header):
            block = dict(pairs)
            binding, ident = block.get("binding", ""), block.get("id", "")
            if binding and ident and (binding not in kv or _prefers_production(header)):
                kv[binding] = ident
    return {"name": name, "vars": variables, "kv": kv}


def account_id_from_whoami(text: str) -> str:
    """First 32-hex id in the `wrangler whoami` account table, else empty."""
    for line in text.splitlines():
        if "│" not in line and "|" not in line:
            continue
        m = ACCOUNT_ID_RE.search(line)
        if m:
            return m.group(0)
    m = ACCOUNT_ID_RE.search(text)
    return m.group(0) if m else ""


def _looks_like_project_name(cell: str) -> bool:
    cell = cell.strip()
    if not cell or not _PROJECT_NAME.fullmatch(cell):
        return False
    if cell.lower() in _HEADER_WORDS:
        return False
    if ACCOUNT_ID_RE.fullmatch(cell):
        return False
    return True


def _unique_names(names: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for name in names:
        if name not in seen:
            seen.add(name)
            out.append(name)
    return out


def _names_from_json(data: Any) -> list[str]:
    out: list[str] = []
    if isinstance(data, list):
        for item in data:
            if isinstance(item, str):
                if _looks_like_project_name(item):
                    out.append(item.strip())
            elif isinstance(item, dict):
                name = item.get("name")
                if isinstance(name, str) and _looks_like_project_name(name):
                    out.append(name.strip())
    elif isinstance(data, dict):
        name = data.get("name")
        if isinstance(name, str) and _looks_like_project_name(name):
            out.append(name.strip())
    return out


def _names_from_table(text: str) -> list[str]:
    out: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or _BOX_LINE.fullmatch(stripped):
            continue
        if "│" not in line and "|" not in line:
            if _looks_like_project_name(stripped):
                out.append(stripped)
            continue
        cells = [cell.strip() for cell in _CELL_SPLIT.split(line)]
        names = [cell for cell in cells if _looks_like_project_name(cell)]
        if names:
            out.append(names[0])
    return out


def pages_project_names(text: str) -> list[str]:
    """Project names from `wrangler pages project list` (table or JSON).

    Skips box-drawing, header words (Project, Name, Account, Created, …)
    and 32-hex account ids. Unique, file order.
    """
    stripped = text.strip()
    if not stripped:
        return []
    if stripped[0] in "{[":
        try:
            return _unique_names(_names_from_json(json.loads(stripped)))
        except json.JSONDecodeError:
            pass
    return _unique_names(_names_from_table(text))


def classify_pages_projects(text: str, want: str) -> tuple[str, list[str]]:
    """Classify `wrangler pages project list` vs the name we looked up.

    Returns (kind, other_names):
      hit       — want is on the account
      others    — parsed names, want missing
      empty     — no non-empty lines (fresh account)
      unparsed  — output present but no names (do not provision)
    """
    names = pages_project_names(text)
    others = [n for n in names if n != want]
    if want in names:
        return "hit", others
    if names:
        return "others", others
    if any(line.strip() for line in text.splitlines()):
        return "unparsed", []
    return "empty", []



def discovered_env(
    config_toml: str,
    whoami: str,
    project: str = "",
) -> dict[str, Any]:
    """Map Cloudflare state onto forge.env keys.

    `missing` lists the keys the project did not provide — a forge whose Access
    vars were never set is a real, reportable state, not an error here.
    """
    parsed = parse_pages_config(config_toml)
    values: dict[str, str] = {}

    account = account_id_from_whoami(whoami)
    if account:
        values["CLOUDFLARE_ACCOUNT_ID"] = account

    shares = parsed["kv"].get(SHARES_BINDING, "")
    if shares:
        values["FORGE_SHARES_KV_ID"] = shares

    for key in VAR_KEYS:
        val = parsed["vars"].get(key, "")
        if val:
            values[key] = val

    expected = ("CLOUDFLARE_ACCOUNT_ID", "FORGE_SHARES_KV_ID") + VAR_KEYS
    return {
        "project": project or parsed["name"],
        "account_id": account,
        "values": values,
        "missing": [k for k in expected if k not in values],
    }


def render_env(values: dict[str, str]) -> str:
    """Emit `KEY=value` lines, sorted, for merging into forge.env."""
    return "".join(f"{k}={values[k]}\n" for k in sorted(values))


def merge_env(existing: str, values: dict[str, str]) -> str:
    """Overlay discovered values on a forge.env, preserving unrelated lines.

    An existing key is rewritten in place so comments and ordering survive; a
    key already holding the discovered value is left byte-identical.
    """
    lines = existing.splitlines()
    seen: set[str] = set()
    out: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            out.append(line)
            continue
        key = stripped.split("=", 1)[0].strip()
        if key in values:
            seen.add(key)
            out.append(f"{key}={values[key]}")
        else:
            out.append(line)
    added = [f"{k}={values[k]}" for k in sorted(values) if k not in seen]
    if added:
        if out and out[-1].strip():
            out.append("")
        out.extend(added)
    return "\n".join(out).rstrip("\n") + "\n"


def main(argv: list[str]) -> int:
    """CLI: discover.py <config.toml> <whoami.txt> [project] — JSON on stdout."""
    if len(argv) < 3:
        print("usage: discover.py <config.toml> <whoami.txt> [project]", file=sys.stderr)
        return 2
    with open(argv[1], encoding="utf-8") as fh:
        config_toml = fh.read()
    with open(argv[2], encoding="utf-8") as fh:
        whoami = fh.read()
    project = argv[3] if len(argv) > 3 else ""
    print(json.dumps(discovered_env(config_toml, whoami, project), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
