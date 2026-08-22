#!/usr/bin/env python3
"""Tests for patch_wrangler.py — TOML preservation and safe inject."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

LIB = Path(__file__).resolve().parents[2] / "plugins" / "silex-forge" / "scripts" / "lib"
sys.path.insert(0, str(LIB))

from patch_wrangler import (  # noqa: E402
    extract_vars_section,
    merge_pages_vars,
    patch_wrangler,
    render_vars_section,
    toml_basic_string,
)

SAMPLE = """\
name = "silex-forge"
compatibility_date = "2026-01-01"

[[kv_namespaces]]
binding = "SHARES"
id = "YOUR_KV_NAMESPACE_ID"

[build]
command = "echo keep-me"

# comment block
"""


class PatchWranglerTests(unittest.TestCase):
    def test_toml_basic_string_escapes_quotes(self) -> None:
        self.assertEqual(toml_basic_string('a"b'), '"a\\"b"')

    def test_preserves_unrelated_sections_and_merges_vars_block(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "wrangler.toml"
            path.write_text(
                SAMPLE
                + '\n[vars]\nOLD = "keep-me"\nSHLINK_API_URL = "https://old.example/rest"\n',
                encoding="utf-8",
            )
            patch_wrangler(
                path,
                kv_id="kv12345678901234567890123456789012",
                team_domain="team.example.com",
                access_aud="aud-one",
                public_host="forge.example.com",
                shlink_api_url="https://s.example.com/rest/v3/short-urls",
            )
            out = path.read_text(encoding="utf-8")
            self.assertIn('[build]\ncommand = "echo keep-me"', out)
            self.assertIn('id = "kv12345678901234567890123456789012"', out)
            self.assertIn('OLD = "keep-me"', out)
            self.assertIn("https://s.example.com/rest/v3/short-urls", out)
            self.assertNotIn("https://old.example/rest", out)
            self.assertEqual(out.count("[vars]"), 1)

    def test_kv_id_patch_when_placeholder_missing_uses_regex(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "wrangler.toml"
            path.write_text(
                'binding = "SHARES"\nid = "old-kv-id"\n',
                encoding="utf-8",
            )
            patch_wrangler(
                path,
                kv_id="new-kv-id",
                team_domain="t.example",
                access_aud="aud",
            )
            self.assertIn('id = "new-kv-id"', path.read_text(encoding="utf-8"))

    def test_merge_preserves_unknown_vars(self) -> None:
        src = """name = "test"
[[kv_namespaces]]
binding = "SHARES"
id = "YOUR_KV_NAMESPACE_ID"

[vars]
SHLINK_API_URL = "https://shlink.example/api/v3/short-urls"
CUSTOM_FLAG = "keep-me"
"""
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "wrangler.toml"
            path.write_text(src, encoding="utf-8")
            patch_wrangler(
                path,
                kv_id="ns-abc123",
                team_domain="team.cloudflareaccess.com",
                access_aud="aud-xyz",
                public_host="forge.example.com",
            )
            text = path.read_text(encoding="utf-8")
            self.assertIn('id = "ns-abc123"', text)
            self.assertIn("CUSTOM_FLAG", text)
            self.assertIn("https://shlink.example", text)
            self.assertIn("team.cloudflareaccess.com", text)

    def test_extract_and_render_vars(self) -> None:
        text = '[vars]\nA = "1"\nB = "two"\n\n[other]\n'
        stripped, existing = extract_vars_section("\n" + text)
        self.assertEqual(existing, {"A": "1", "B": "two"})
        self.assertNotIn("[vars]", stripped)
        block = render_vars_section({"A": "1", "C": "three"})
        self.assertIn('C = "three"', block)

    def test_merge_pages_vars_local_overrides_remote(self) -> None:
        merged = merge_pages_vars(
            remote_plain_vars={"SHLINK_API_URL": "https://remote.example/api"},
            existing_vars={},
            local_updates={"SHLINK_API_URL": "https://local.example/api", "PUBLIC_HOST": "forge.example.com"},
        )
        self.assertEqual(merged["SHLINK_API_URL"], "https://local.example/api")
        self.assertEqual(merged["PUBLIC_HOST"], "forge.example.com")

    @patch("load_config.fetch_pages_plain_vars")
    def test_patch_wrangler_fetch_remote_merges_pages_vars(self, mock_fetch: object) -> None:
        mock_fetch.return_value = {
            "CUSTOM_FLAG": "keep-me",
            "SHLINK_API_URL": "https://pages.example/shlink",
        }
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "wrangler.toml"
            path.write_text(SAMPLE, encoding="utf-8")
            patch_wrangler(
                path,
                kv_id="kv-id",
                team_domain="team.example.com",
                access_aud="aud-one",
                public_host="forge.example.com",
                fetch_remote=True,
            )
            out = path.read_text(encoding="utf-8")
            self.assertIn("CUSTOM_FLAG", out)
            self.assertIn("forge.example.com", out)
            self.assertIn("https://pages.example/shlink", out)


if __name__ == "__main__":
    unittest.main()
