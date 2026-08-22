#!/usr/bin/env python3
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

LIB = Path(__file__).resolve().parents[2] / "plugins" / "silex-forge" / "scripts" / "lib"
sys.path.insert(0, str(LIB))

from load_config import (  # noqa: E402
    PagesEnvFetchError,
    doctor,
    fetch_pages_plain_var,
    forge_env_permissions,
    load_config,
    parse_forge_env,
)

PAGES_FIXTURE = {
    "success": True,
    "result": {
        "deployment_configs": {
            "production": {
                "env_vars": {
                    "SHLINK_API_URL": {
                        "type": "plain_text",
                        "value": "https://s.example.com/rest/v3/short-urls",
                    },
                    "FORGE_SHARE_SECRET": {"type": "secret_text"},
                }
            }
        }
    },
}


class LoadConfigTests(unittest.TestCase):
    def test_example_config_loads(self) -> None:
        cfg = load_config()
        self.assertIn("version", cfg)
        self.assertIn("public_host", cfg)

    def test_doctor_never_returns_secret_values(self) -> None:
        d = doctor()
        blob = str(d)
        self.assertNotIn("CLOUDFLARE_API_TOKEN=", blob)
        self.assertNotIn("cfut_", blob)
        self.assertNotIn("cfk_", blob)

    def test_parse_forge_env_redacts_secrets(self) -> None:
        public, has_token = parse_forge_env(Path("/nonexistent"))
        self.assertFalse(has_token)
        self.assertNotIn("CLOUDFLARE_API_TOKEN", public)

    def test_forge_env_permissions_missing_file_ok(self) -> None:
        perm = forge_env_permissions(Path("/nonexistent/forge.env"))
        self.assertTrue(perm["ok"])

    def test_forge_env_permissions_rejects_world_readable(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            env_path = Path(td) / "forge.env"
            env_path.write_text("CLOUDFLARE_API_TOKEN=x\n", encoding="utf-8")
            env_path.chmod(0o644)
            perm = forge_env_permissions(env_path)
            self.assertFalse(perm["ok"])
            self.assertIn("600", perm.get("issue") or "")

    @patch("load_config._cf_api")
    @patch("load_config.resolve_api_token", return_value="test-token")
    @patch("load_config.resolved_account_id", return_value="acct123")
    def test_fetch_pages_plain_var_returns_plain_text(
        self, _acct: object, _token: object, mock_api: object
    ) -> None:
        mock_api.return_value = (200, PAGES_FIXTURE, "")
        val = fetch_pages_plain_var("SHLINK_API_URL")
        self.assertEqual(val, "https://s.example.com/rest/v3/short-urls")

    @patch("load_config._cf_api")
    @patch("load_config.resolve_api_token", return_value="test-token")
    @patch("load_config.resolved_account_id", return_value="acct123")
    def test_fetch_pages_plain_var_ignores_secret_text(
        self, _acct: object, _token: object, mock_api: object
    ) -> None:
        mock_api.return_value = (200, PAGES_FIXTURE, "")
        self.assertEqual(fetch_pages_plain_var("FORGE_SHARE_SECRET"), "")

    @patch("load_config.resolve_api_token", return_value="")
    def test_fetch_pages_plain_var_without_token_raises(self, _token: object) -> None:
        with self.assertRaises(PagesEnvFetchError) as ctx:
            fetch_pages_plain_var("SHLINK_API_URL")
        self.assertEqual(ctx.exception.kind, "auth_missing")


if __name__ == "__main__":
    unittest.main()
