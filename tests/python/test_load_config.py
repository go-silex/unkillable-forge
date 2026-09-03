#!/usr/bin/env python3
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

LIB = Path(__file__).resolve().parents[2] / "plugins" / "silex-forge" / "scripts" / "lib"
sys.path.insert(0, str(LIB))

from load_config import (  # noqa: E402
    PagesEnvFetchError,
    VAULT_MARKERS,
    _verify_api_token,
    doctor,
    fetch_pages_plain_var,
    forge_env_permissions,
    load_config,
    parse_forge_env,
    resolve_vault_markers,
    vault_ok,
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
        self.assertNotIn("cfat_", blob)
        self.assertNotIn("cfk_", blob)

    def test_parse_forge_env_redacts_secrets(self) -> None:
        public, has_token = parse_forge_env(Path("/nonexistent"))
        self.assertFalse(has_token)
        self.assertNotIn("CLOUDFLARE_API_TOKEN", public)

    def test_forge_env_permissions_missing_file_ok(self) -> None:
        perm = forge_env_permissions(Path("/nonexistent/forge.env"))
        self.assertTrue(perm["ok"])

    @unittest.skipIf(os.name == "nt", "forge.env mode bits are Unix-only")
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

    @patch("load_config._cf_api")
    def test_verify_user_token(self, mock_api: object) -> None:
        mock_api.return_value = (200, {"success": True}, "")
        kind, err = _verify_api_token("cfut_x", "acct123")
        self.assertEqual(kind, "user")
        self.assertEqual(err, "")
        mock_api.assert_called_once_with("GET", "/user/tokens/verify", "cfut_x")

    @patch("load_config._cf_api")
    def test_verify_account_token_fallback(self, mock_api: object) -> None:
        def side(method: str, path: str, token: str, **_kw: object) -> tuple:
            if path == "/user/tokens/verify":
                return (
                    401,
                    {"success": False, "errors": [{"message": "Invalid API Token"}]},
                    "",
                )
            if path == "/accounts/acct123/tokens/verify":
                return 200, {"success": True}, ""
            raise AssertionError(path)

        mock_api.side_effect = side
        kind, err = _verify_api_token("cfat_x", "acct123")
        self.assertEqual(kind, "account")
        self.assertEqual(err, "")

    @patch("load_config._cf_api")
    def test_verify_token_both_endpoints_fail(self, mock_api: object) -> None:
        mock_api.return_value = (
            401,
            {"success": False, "errors": [{"message": "Invalid API Token"}]},
            "",
        )
        kind, err = _verify_api_token("bad", "acct123")
        self.assertIsNone(kind)
        self.assertIn("token verify failed", err)
        self.assertIn("user 401", err)
        self.assertIn("account 401", err)
        self.assertEqual(mock_api.call_count, 2)


    def _minimal_cfg(self, hub_root: str, **over: object) -> dict:
        cfg: dict = {
            "version": 1,
            "hub_root": hub_root,
            "artifacts_dir": "artifacts",
            "public_host": "forge.example.com",
            "forge_repo": "git@example.com:org/forge.git",
            "site_dir": "site",
            "registry_dir": "registry",
            "internal_prefix": "a",
        }
        cfg.update(over)
        return cfg

    def test_vault_ok_absent_key_keeps_silex_markers(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            hub = Path(td)
            self.assertFalse(vault_ok(hub))
            markers, err = resolve_vault_markers(self._minimal_cfg(str(hub)))
            self.assertIsNone(err)
            self.assertEqual(markers, VAULT_MARKERS)
            d = doctor(self._minimal_cfg(str(hub)))
            vault_issues = [i for i in d["issues"] if "vault" in i or "00_COCKPIT" in i]
            self.assertTrue(vault_issues)
            self.assertIn("00_COCKPIT", vault_issues[0])
            self.assertIn("01_COMPANY", vault_issues[0])

    def test_vault_ok_custom_markers(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            hub = Path(td)
            (hub / "client_docs").mkdir()
            (hub / "client_data").mkdir()
            custom = ["client_docs", "client_data"]
            self.assertTrue(vault_ok(hub, custom))
            self.assertFalse(vault_ok(hub, ["client_docs", "missing"]))
            ok = doctor(self._minimal_cfg(str(hub), vault_markers=custom))
            self.assertFalse(any("vault" in i for i in ok["issues"]))
            missing = doctor(
                self._minimal_cfg(str(hub), vault_markers=["client_docs", "missing"])
            )
            vault_issues = [i for i in missing["issues"] if "markers" in i]
            self.assertEqual(len(vault_issues), 1)
            self.assertIn("client_docs", vault_issues[0])
            self.assertIn("missing", vault_issues[0])
            self.assertNotIn("00_COCKPIT", vault_issues[0])
            self.assertNotIn("01_COMPANY", vault_issues[0])

    def test_vault_ok_empty_markers_any_existing_dir(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            hub = Path(td)
            self.assertTrue(vault_ok(hub, []))
            d = doctor(self._minimal_cfg(str(hub), vault_markers=[]))
            self.assertFalse(any("vault" in i for i in d["issues"]))
        missing = Path("/nonexistent/silex-forge-hub-xyz")
        self.assertFalse(vault_ok(missing, []))
        d_missing = doctor(self._minimal_cfg(str(missing), vault_markers=[]))
        found = [i for i in d_missing["issues"] if "hub_root" in i]
        self.assertTrue(found)
        self.assertTrue(any("not found" in i for i in found))
        self.assertFalse(any("vault" in i for i in d_missing["issues"]))

    def test_resolve_vault_markers_null_is_historical(self) -> None:
        markers, err = resolve_vault_markers({"vault_markers": None})
        self.assertIsNone(err)
        self.assertEqual(markers, VAULT_MARKERS)

    def test_vault_markers_wrong_type_no_exception(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            hub = Path(td)
            for raw in ("00_COCKPIT", 1, {"a": 1}, ["ok", 2]):
                cfg = self._minimal_cfg(str(hub), vault_markers=raw)
                markers, err = resolve_vault_markers(cfg)
                self.assertIsNone(markers)
                self.assertIsNotNone(err)
                self.assertIn("vault_markers", err)
                d = doctor(cfg)
                self.assertTrue(any("vault_markers" in i for i in d["issues"]))
                self.assertFalse(any("silex-hub vault" in i for i in d["issues"]))


if __name__ == "__main__":
    unittest.main()
