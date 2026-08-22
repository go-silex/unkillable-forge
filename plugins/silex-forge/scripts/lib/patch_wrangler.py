#!/usr/bin/env python3
"""Patch cloned wrangler.toml for deploy (KV id + merged plain [vars]). Never commit output."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# Keys managed by publish — local forge.env overrides remote Pages values.
_MANAGED_VARS = frozenset(
    {
        "CF_ACCESS_TEAM_DOMAIN",
        "CF_ACCESS_AUD",
        "PUBLIC_HOST",
        "SHLINK_API_URL",
    }
)


def toml_basic_string(value: str) -> str:
    """Emit a TOML-safe double-quoted string."""
    return json.dumps(value, ensure_ascii=False)


def _unescape_toml_string(raw: str) -> str:
    try:
        return json.loads(f'"{raw}"')
    except json.JSONDecodeError:
        return raw.replace('\\"', '"').replace("\\\\", "\\")


def extract_vars_section(text: str) -> tuple[str, dict[str, str]]:
    """Return (text_without_vars_block, existing_vars)."""
    m = re.search(r"\n\[vars\][\s\S]*?(?=\n\[|\Z)", text)
    if not m:
        return text, {}
    block = m.group(0)
    prefix = text[: m.start()]
    suffix = text[m.end() :]
    existing: dict[str, str] = {}
    for line in block.splitlines()[1:]:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        vm = re.match(r'^(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$', stripped)
        if vm:
            existing[vm.group(1)] = _unescape_toml_string(vm.group(2))
    return prefix.rstrip() + suffix, existing


def render_vars_section(vars_map: dict[str, str]) -> str:
    if not vars_map:
        return ""
    lines = ["", "[vars]"]
    for key in sorted(vars_map):
        lines.append(f"{key} = {toml_basic_string(vars_map[key])}")
    lines.append("")
    return "\n".join(lines)


def merge_pages_vars(
    *,
    remote_plain_vars: dict[str, str] | None,
    existing_vars: dict[str, str],
    local_updates: dict[str, str],
) -> dict[str, str]:
    """Remote plain Pages vars as base; local managed vars win. Never includes secrets."""
    merged: dict[str, str] = {}
    if remote_plain_vars:
        merged.update(remote_plain_vars)
    merged.update(existing_vars)
    for key, val in local_updates.items():
        if not val.strip():
            if key in ("CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD"):
                continue
            continue
        merged[key] = val.strip()
    return merged


def patch_wrangler(
    path: Path,
    *,
    kv_id: str,
    team_domain: str,
    access_aud: str,
    public_host: str = "",
    shlink_api_url: str = "",
    remote_plain_vars: dict[str, str] | None = None,
    fetch_remote: bool = False,
) -> None:
    if fetch_remote:
        from load_config import PagesEnvFetchError, fetch_pages_plain_vars

        try:
            remote_plain_vars = fetch_pages_plain_vars()
        except PagesEnvFetchError as e:
            raise SystemExit(
                f"cannot fetch Pages plain vars ({e.kind}) — abort deploy to avoid env wipe: {e.message}"
            ) from e

    text = path.read_text(encoding="utf-8")

    needle = 'id = "YOUR_KV_NAMESPACE_ID"'
    if needle in text:
        text = text.replace(needle, f'id = "{kv_id}"')
    elif f'id = "{kv_id}"' not in text:
        text2, n = re.subn(
            r'(binding\s*=\s*"SHARES"\s*\nid\s*=\s*")[^"]*(")',
            rf"\g<1>{kv_id}\2",
            text,
            count=1,
        )
        if n == 0:
            raise SystemExit("could not patch SHARES kv id in wrangler.toml")
        text = text2

    text, existing_vars = extract_vars_section(text)

    local_updates = {
        "CF_ACCESS_TEAM_DOMAIN": team_domain.strip(),
        "CF_ACCESS_AUD": access_aud.strip(),
        "PUBLIC_HOST": public_host.strip(),
        "SHLINK_API_URL": shlink_api_url.strip(),
    }
    merged = merge_pages_vars(
        remote_plain_vars=remote_plain_vars,
        existing_vars=existing_vars,
        local_updates=local_updates,
    )

    for req in ("CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD"):
        if not merged.get(req, "").strip():
            raise SystemExit(
                f"missing required Pages var: {req} (forge.env, remote Pages, or wrangler.toml)"
            )

    vars_block = render_vars_section(merged)
    path.write_text(text.rstrip() + vars_block + "\n", encoding="utf-8")


def main() -> int:
    if len(sys.argv) < 5:
        print(
            "usage: patch_wrangler.py <wrangler.toml> <kv_id> <team_domain> <access_aud> "
            "[public_host] [shlink_api_url] [--fetch-remote]",
            file=sys.stderr,
        )
        return 2
    args = [a for a in sys.argv[1:] if a != "--fetch-remote"]
    fetch_remote = "--fetch-remote" in sys.argv[1:]
    path = Path(args[0])
    public_host = args[4] if len(args) > 4 else ""
    shlink_url = args[5] if len(args) > 5 else ""
    patch_wrangler(
        path,
        kv_id=args[1],
        team_domain=args[2],
        access_aud=args[3],
        public_host=public_host,
        shlink_api_url=shlink_url,
        fetch_remote=fetch_remote,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
