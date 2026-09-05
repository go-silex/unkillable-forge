#!/usr/bin/env python3
"""Contracts for deriving forge.env from an existing Cloudflare Pages forge.

Fixtures mirror the real shape of `wrangler pages download config` and
`wrangler whoami` output (captured against the live silex-forge project, with
identifiers replaced by same-length dummies).
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

LIB = Path(__file__).resolve().parents[2] / "plugins" / "silex-forge" / "scripts" / "lib"
sys.path.insert(0, str(LIB))

from discover import (  # noqa: E402
    account_id_from_whoami,
    classify_pages_projects,
    discovered_env,
    merge_env,
    pages_project_names,
    parse_pages_config,
    render_env,
)

ACCT = "a" * 32
KV_ID = "b" * 32
PREVIEW_KV_ID = "c" * 32

CONFIG = f'''name = "silex-forge"
pages_build_output_dir = "site"
compatibility_date = "2026-07-17"

[vars]
SHLINK_BASE = "https://s.example.com"

[env.production]
compatibility_date = "2026-01-01"

[env.production.vars]
CF_ACCESS_AUD = "{"d" * 64}"
CF_ACCESS_TEAM_DOMAIN = "example.cloudflareaccess.com"
PUBLIC_HOST = "forge.example.com"
SHLINK_API_URL = "https://s.example.com/rest/v3/short-urls"

[[env.production.kv_namespaces]]
id = "{KV_ID}"
binding = "SHARES"
'''

WHOAMI = f'''
 ⛅️ wrangler 4.0.0
👋 You are logged in with an OAuth Token, associated with the email user@example.com.
┌────────────────┬──────────────────────────────────┐
│ Account Name   │ Account ID                       │
├────────────────┼──────────────────────────────────┤
│ Example Inc    │ {ACCT} │
└────────────────┴──────────────────────────────────┘
Scope (Access)
- pages (write)
- workers_kv (write)
'''


class ParsePagesConfigTests(unittest.TestCase):
    def test_reads_production_vars_and_shares_kv(self) -> None:
        parsed = parse_pages_config(CONFIG)
        self.assertEqual(parsed["name"], "silex-forge")
        self.assertEqual(parsed["vars"]["PUBLIC_HOST"], "forge.example.com")
        self.assertEqual(
            parsed["vars"]["CF_ACCESS_TEAM_DOMAIN"], "example.cloudflareaccess.com"
        )
        self.assertEqual(parsed["kv"]["SHARES"], KV_ID)

    def test_production_overrides_top_level(self) -> None:
        """`pages deploy` targets production, so production values are the live ones."""
        text = (
            '[vars]\nPUBLIC_HOST = "stale.example.com"\n\n'
            '[env.production.vars]\nPUBLIC_HOST = "forge.example.com"\n'
        )
        self.assertEqual(
            parse_pages_config(text)["vars"]["PUBLIC_HOST"], "forge.example.com"
        )

    def test_preview_kv_does_not_shadow_production(self) -> None:
        text = (
            f'[[env.production.kv_namespaces]]\nid = "{KV_ID}"\nbinding = "SHARES"\n\n'
            f'[[env.preview.kv_namespaces]]\nid = "{PREVIEW_KV_ID}"\nbinding = "SHARES"\n'
        )
        self.assertEqual(parse_pages_config(text)["kv"]["SHARES"], KV_ID)

    def test_comments_and_blank_lines_ignored(self) -> None:
        text = '# comment = "trap"\n\n[vars]\n# PUBLIC_HOST = "commented"\nA = "b"\n'
        self.assertEqual(parse_pages_config(text)["vars"], {"A": "b"})

    def test_unrelated_binding_is_not_shares(self) -> None:
        text = f'[[kv_namespaces]]\nid = "{KV_ID}"\nbinding = "CACHE"\n'
        self.assertNotIn("SHARES", parse_pages_config(text)["kv"])


class WhoamiTests(unittest.TestCase):
    def test_reads_account_id_from_table(self) -> None:
        self.assertEqual(account_id_from_whoami(WHOAMI), ACCT)

    def test_absent_account_id_is_empty(self) -> None:
        self.assertEqual(account_id_from_whoami("not logged in"), "")

    def test_email_hex_outside_table_is_not_an_account_id(self) -> None:
        """A 32-hex string in prose must not be mistaken for the account id."""
        text = f"cache key {'e' * 32}\n│ Acme │ {ACCT} │\n"
        self.assertEqual(account_id_from_whoami(text), ACCT)


class DiscoveredEnvTests(unittest.TestCase):
    def test_maps_every_discoverable_forge_env_key(self) -> None:
        d = discovered_env(CONFIG, WHOAMI, "silex-forge")
        self.assertEqual(d["project"], "silex-forge")
        self.assertEqual(d["values"]["CLOUDFLARE_ACCOUNT_ID"], ACCT)
        self.assertEqual(d["values"]["FORGE_SHARES_KV_ID"], KV_ID)
        self.assertEqual(d["values"]["CF_ACCESS_AUD"], "d" * 64)
        self.assertEqual(d["missing"], [])

    def test_never_carries_the_host_back_from_pages(self) -> None:
        """public_host lives in forge.config.json; the config is pushed *to*
        Pages at deploy, so a PUBLIC_HOST var must never land in forge.env."""
        d = discovered_env(CONFIG, WHOAMI, "silex-forge")
        self.assertNotIn("PUBLIC_HOST", d["values"])
        self.assertNotIn("PUBLIC_HOST", d["missing"])

    def test_never_invents_the_api_token(self) -> None:
        """The token is a secret; discovery must not fabricate or carry one."""
        d = discovered_env(CONFIG, WHOAMI, "silex-forge")
        self.assertNotIn("CLOUDFLARE_API_TOKEN", d["values"])

    def test_unset_access_vars_are_reported_missing(self) -> None:
        text = f'name = "f"\n[[env.production.kv_namespaces]]\nid = "{KV_ID}"\nbinding = "SHARES"\n'
        d = discovered_env(text, WHOAMI, "f")
        self.assertIn("CF_ACCESS_AUD", d["missing"])
        self.assertIn("CF_ACCESS_TEAM_DOMAIN", d["missing"])
        self.assertNotIn("FORGE_SHARES_KV_ID", d["missing"])

    def test_project_falls_back_to_config_name(self) -> None:
        self.assertEqual(discovered_env(CONFIG, WHOAMI)["project"], "silex-forge")


class RenderAndMergeTests(unittest.TestCase):
    def test_render_env_is_sorted_key_value_lines(self) -> None:
        self.assertEqual(render_env({"B": "2", "A": "1"}), "A=1\nB=2\n")

    def test_merge_rewrites_in_place_and_keeps_comments(self) -> None:
        existing = "# creds\nCLOUDFLARE_API_TOKEN=keepme\nPUBLIC_HOST=old.example.com\n"
        out = merge_env(existing, {"PUBLIC_HOST": "forge.example.com"})
        self.assertIn("# creds", out)
        self.assertIn("CLOUDFLARE_API_TOKEN=keepme", out)
        self.assertIn("PUBLIC_HOST=forge.example.com", out)
        self.assertNotIn("old.example.com", out)

    def test_merge_never_drops_an_existing_token(self) -> None:
        """--write must not cost the operator the one value it cannot rediscover."""
        existing = "CLOUDFLARE_API_TOKEN=secret-value\n"
        out = merge_env(existing, {"PUBLIC_HOST": "h", "FORGE_SHARES_KV_ID": KV_ID})
        self.assertIn("CLOUDFLARE_API_TOKEN=secret-value", out)

    def test_merge_appends_absent_keys(self) -> None:
        out = merge_env("A=1\n", {"B": "2"})
        self.assertIn("A=1", out)
        self.assertIn("B=2", out)

    def test_merge_into_empty_file(self) -> None:
        self.assertEqual(merge_env("", {"A": "1"}), "A=1\n")

    def test_merge_is_idempotent(self) -> None:
        values = {"PUBLIC_HOST": "forge.example.com"}
        once = merge_env("PUBLIC_HOST=forge.example.com\n", values)
        self.assertEqual(once, merge_env(once, values))


PAGES_TABLE = """
┌──────────────┬────────────┐
│ Project Name │ Created    │
├──────────────┼────────────┤
│ silex-forge  │ 2024-01-01 │
│ client-site  │ 2024-02-02 │
└──────────────┴────────────┘
"""

PAGES_JSON_LIST = '[{"name": "silex-forge"}, {"name": "client-site"}]'


class PagesProjectNamesTests(unittest.TestCase):
    def test_reads_two_names_from_unicode_table(self) -> None:
        self.assertEqual(
            pages_project_names(PAGES_TABLE),
            ["silex-forge", "client-site"],
        )

    def test_reads_two_names_from_json_list(self) -> None:
        self.assertEqual(
            pages_project_names(PAGES_JSON_LIST),
            ["silex-forge", "client-site"],
        )

    def test_reads_name_from_json_object(self) -> None:
        self.assertEqual(
            pages_project_names('{"name": "only-one"}'),
            ["only-one"],
        )

    def test_skips_headers_and_account_ids(self) -> None:
        text = f"""
│ Project │ Account ID │
│ Name    │ {ACCT} │
│ other-site │ {ACCT} │
"""
        self.assertEqual(pages_project_names(text), ["other-site"])

    def test_unique_file_order(self) -> None:
        text = "│ alpha │\n│ beta │\n│ alpha │\n"
        self.assertEqual(pages_project_names(text), ["alpha", "beta"])

    def test_classify_hit_and_others(self) -> None:
        self.assertEqual(
            classify_pages_projects(PAGES_TABLE, "silex-forge"),
            ("hit", ["client-site"]),
        )
        self.assertEqual(
            classify_pages_projects(PAGES_TABLE, "missing"),
            ("others", ["silex-forge", "client-site"]),
        )

    def test_classify_empty_vs_unparsed(self) -> None:
        self.assertEqual(classify_pages_projects("", "silex-forge"), ("empty", []))
        self.assertEqual(classify_pages_projects("  \n\n", "x"), ("empty", []))
        header_only = """
┌──────────────┐
│ Project Name │
└──────────────┘
"""
        self.assertEqual(
            classify_pages_projects(header_only, "silex-forge"),
            ("unparsed", []),
        )



if __name__ == "__main__":
    unittest.main()
