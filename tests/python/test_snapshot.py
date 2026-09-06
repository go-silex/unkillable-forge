#!/usr/bin/env python3
"""snapshot.py: hub fingerprint stability and the stale-hub removal guard.

Hermetic: every run drives the CLI in a subprocess with HOME, FORGE_CONFIG and
FORGE_ENV pointed inside a temp dir, and with the Cloudflare env unset, so no
test reads ~/.config/silex, touches the real hub, or reaches the network.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LIB = ROOT / "plugins" / "silex-forge" / "scripts" / "lib"
SNAPSHOT = LIB / "snapshot.py"

sys.path.insert(0, str(LIB))

import snapshot as snap  # noqa: E402


class SnapshotCLIBase(unittest.TestCase):
    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self.tmp = Path(self._td.name)
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.hub = self.tmp / "hub"
        self.artifacts = self.hub / "artifacts"
        self.artifacts.mkdir(parents=True)
        self.cfg_path = self.tmp / "forge.config.json"
        self._write_cfg(self.hub)

    def tearDown(self) -> None:
        self._td.cleanup()

    def _write_cfg(self, hub: Path) -> None:
        self.cfg_path.write_text(
            json.dumps({"hub_root": str(hub), "artifacts_dir": "artifacts"}) + "\n",
            encoding="utf-8",
        )

    def _artifact(
        self,
        root: Path,
        slug: str,
        html: str = "<html><body>x</body></html>",
        extra: dict[str, str] | None = None,
        index: bool = True,
    ) -> Path:
        d = root / slug
        d.mkdir(parents=True, exist_ok=True)
        if index:
            (d / "index.html").write_text(html, encoding="utf-8")
        for rel, content in (extra or {}).items():
            target = d / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        return d

    def _run(self, *args: str, stdin: str = "") -> subprocess.CompletedProcess:
        env = dict(os.environ)
        env["HOME"] = str(self.home)
        env["PYTHONPATH"] = str(LIB)
        env["FORGE_CONFIG"] = str(self.cfg_path)
        env["FORGE_ENV"] = str(self.home / "absent-forge.env")
        for leak in (
            "HUB_ROOT",
            "CLOUDFLARE_API_TOKEN",
            "CLOUDFLARE_API_KEY",
            "CLOUDFLARE_ACCOUNT_ID",
            "FORGE_SHARES_KV_ID",
        ):
            env.pop(leak, None)
        return subprocess.run(
            [sys.executable, str(SNAPSHOT), *args],
            input=stdin,
            env=env,
            cwd=str(self.tmp),
            capture_output=True,
            text=True,
        )

    def _json(self, proc: subprocess.CompletedProcess) -> dict:
        self.assertTrue(proc.stdout.strip(), f"no stdout; stderr={proc.stderr}")
        return json.loads(proc.stdout.strip().splitlines()[-1])

    def _fingerprint(self) -> dict:
        proc = self._run("fingerprint")
        self.assertEqual(0, proc.returncode, proc.stderr)
        return self._json(proc)


class FingerprintTests(SnapshotCLIBase):
    def test_stable_and_path_independent(self) -> None:
        """Same content, different absolute hub -> same per-slug digests.

        This is what makes a record written on one teammate's machine
        comparable with another's.
        """
        self._artifact(self.artifacts, "deck-a", extra={"meta.json": '{"title":"A"}'})
        self._artifact(self.artifacts, "deck-b", extra={"assets/app.css": "body{}"})

        first = self._fingerprint()
        second = self._fingerprint()
        self.assertTrue(first["ok"])
        self.assertEqual(2, first["count"])
        self.assertEqual({"deck-a", "deck-b"}, set(first["slugs"]))
        self.assertEqual(first, second)

        other_hub = self.tmp / "other" / "deeper" / "hub"
        other_art = other_hub / "artifacts"
        other_art.mkdir(parents=True)
        self._artifact(other_art, "deck-a", extra={"meta.json": '{"title":"A"}'})
        self._artifact(other_art, "deck-b", extra={"assets/app.css": "body{}"})
        self._write_cfg(other_hub)
        self.assertEqual(first["slugs"], self._fingerprint()["slugs"])

    def test_one_byte_edit_isolates_to_its_slug(self) -> None:
        self._artifact(self.artifacts, "deck-a")
        self._artifact(self.artifacts, "deck-b")
        before = self._fingerprint()["slugs"]

        (self.artifacts / "deck-a" / "index.html").write_text(
            "<html><body>y</body></html>", encoding="utf-8"
        )
        after = self._fingerprint()["slugs"]

        self.assertNotEqual(before["deck-a"], after["deck-a"])
        self.assertEqual(before["deck-b"], after["deck-b"])

    def test_added_file_changes_the_slug_digest(self) -> None:
        self._artifact(self.artifacts, "deck-a")
        before = self._fingerprint()["slugs"]["deck-a"]
        (self.artifacts / "deck-a" / "notes.txt").write_text("hi", encoding="utf-8")
        self.assertNotEqual(before, self._fingerprint()["slugs"]["deck-a"])

    def test_meta_json_is_part_of_the_state(self) -> None:
        self._artifact(self.artifacts, "deck-a", extra={"meta.json": '{"title":"A"}'})
        before = self._fingerprint()["slugs"]["deck-a"]
        (self.artifacts / "deck-a" / "meta.json").write_text(
            '{"title":"B"}', encoding="utf-8"
        )
        self.assertNotEqual(before, self._fingerprint()["slugs"]["deck-a"])

    def test_rename_inside_a_slug_is_detected(self) -> None:
        self._artifact(self.artifacts, "deck-a", extra={"assets/a.css": "body{}"})
        before = self._fingerprint()["slugs"]["deck-a"]
        (self.artifacts / "deck-a" / "assets" / "a.css").rename(
            self.artifacts / "deck-a" / "assets" / "b.css"
        )
        self.assertNotEqual(before, self._fingerprint()["slugs"]["deck-a"])

    def test_excludes_dotted_dirs_indexless_dirs_and_sync_noise(self) -> None:
        self._artifact(self.artifacts, "deck-a")
        self._artifact(self.artifacts, ".obsidian-scratch")
        self._artifact(self.artifacts, "draft-no-index", index=False)
        (self.artifacts / "draft-no-index" / "notes.md").write_text("wip", encoding="utf-8")

        payload = self._fingerprint()
        self.assertEqual(["deck-a"], sorted(payload["slugs"]))
        self.assertEqual(1, payload["count"])

        before = payload["slugs"]["deck-a"]
        (self.artifacts / "deck-a" / ".DS_Store").write_text("junk", encoding="utf-8")
        (self.artifacts / "deck-a" / "Thumbs.db").write_text("junk", encoding="utf-8")
        cache = self.artifacts / "deck-a" / "__pycache__"
        cache.mkdir()
        (cache / "x.pyc").write_text("junk", encoding="utf-8")
        self.assertEqual(before, self._fingerprint()["slugs"]["deck-a"])

    def test_missing_artifacts_root_is_an_error(self) -> None:
        self._write_cfg(self.tmp / "does-not-exist")
        proc = self._run("fingerprint")
        self.assertEqual(1, proc.returncode)
        self.assertFalse(self._json(proc)["ok"])


class CompareTests(SnapshotCLIBase):
    LIVE = "dep-live-1"

    def _record(self, slugs: dict[str, str], deployment_id: str = LIVE) -> Path:
        path = self.tmp / "record.json"
        path.write_text(
            json.dumps(
                {
                    "deployment_id": deployment_id,
                    "engine_commit": "abc1234",
                    "by": "tester",
                    "at": "2026-01-01T00:00:00Z",
                    "slugs": slugs,
                }
            ),
            encoding="utf-8",
        )
        return path

    def _compare(self, record: str, *extra: str, stdin: str = "") -> tuple[int, dict]:
        proc = self._run(
            "compare",
            "--record",
            record,
            "--live-deployment-id",
            self.LIVE,
            *extra,
            stdin=stdin,
        )
        return proc.returncode, self._json(proc)

    def test_empty_record_no_live_deployment_bootstraps(self) -> None:
        self._artifact(self.artifacts, "deck-a")
        proc = self._run(
            "compare",
            "--record",
            "-",
            "--live-deployment-id",
            "",
            stdin="",
        )
        payload = self._json(proc)
        self.assertEqual(0, proc.returncode)
        self.assertEqual("bootstrap", payload["verdict"])
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["verifiable"])
        self.assertFalse(payload["live_unknown"])
        self.assertEqual([], payload["removals"])

    def test_empty_record_with_live_deployment_is_unverified(self) -> None:
        self._artifact(self.artifacts, "deck-a")
        code, payload = self._compare("-", stdin="")
        self.assertEqual(4, code)
        self.assertEqual("unverified", payload["verdict"])
        self.assertFalse(payload["ok"])
        self.assertFalse(payload["verifiable"])
        self.assertFalse(payload["live_unknown"])

    def test_identical_tree_matches(self) -> None:
        self._artifact(self.artifacts, "deck-a")
        self._artifact(self.artifacts, "deck-b")
        record = self._record(self._fingerprint()["slugs"])
        code, payload = self._compare(str(record))
        self.assertEqual(0, code)
        self.assertEqual("match", payload["verdict"])
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["verifiable"])
        self.assertEqual([], payload["additions"])
        self.assertEqual([], payload["changed"])

    def test_valid_record_with_live_unknown_is_unverified(self) -> None:
        self._artifact(self.artifacts, "deck-a")
        record = self._record(self._fingerprint()["slugs"])
        code, payload = self._compare(str(record), "--live-unknown")
        self.assertEqual(4, code)
        self.assertEqual("unverified", payload["verdict"])
        self.assertFalse(payload["ok"])
        self.assertFalse(payload["verifiable"])
        self.assertTrue(payload["live_unknown"])

    def test_added_and_changed_slug_is_drift(self) -> None:
        self._artifact(self.artifacts, "deck-a")
        self._artifact(self.artifacts, "deck-b")
        record = self._record(self._fingerprint()["slugs"])
        (self.artifacts / "deck-b" / "index.html").write_text("<p>new</p>", encoding="utf-8")
        self._artifact(self.artifacts, "deck-c")

        code, payload = self._compare(str(record))
        self.assertEqual(0, code)
        self.assertEqual("drift", payload["verdict"])
        self.assertEqual(["deck-c"], payload["additions"])
        self.assertEqual(["deck-b"], payload["changed"])
        self.assertEqual([], payload["removals"])

    def test_unexpected_removal_refuses_with_exit_3(self) -> None:
        self._artifact(self.artifacts, "deck-a")
        self._artifact(self.artifacts, "teammate-deck")
        record = self._record(self._fingerprint()["slugs"])
        # The teammate's artifact is missing from this (stale) hub copy.
        for child in sorted((self.artifacts / "teammate-deck").iterdir()):
            child.unlink()
        (self.artifacts / "teammate-deck").rmdir()

        proc = self._run(
            "compare", "--record", str(record), "--live-deployment-id", self.LIVE
        )
        payload = self._json(proc)
        self.assertEqual(3, proc.returncode)
        self.assertEqual("removals", payload["verdict"])
        self.assertFalse(payload["ok"])
        self.assertTrue(payload["verifiable"])
        self.assertEqual(["teammate-deck"], payload["removals"])
        self.assertEqual(["teammate-deck"], payload["unexpected_removals"])
        self.assertIn("--allow-removals", proc.stderr)

    def test_expected_removal_is_allowed(self) -> None:
        self._artifact(self.artifacts, "deck-a")
        self._artifact(self.artifacts, "retired-deck")
        record = self._record(self._fingerprint()["slugs"])
        for child in sorted((self.artifacts / "retired-deck").iterdir()):
            child.unlink()
        (self.artifacts / "retired-deck").rmdir()

        code, payload = self._compare(
            str(record), "--expected-removals", "retired-deck other-slug"
        )
        self.assertEqual(0, code)
        self.assertTrue(payload["ok"])
        self.assertEqual(["retired-deck"], payload["removals"])
        self.assertEqual([], payload["unexpected_removals"])
        self.assertEqual("drift", payload["verdict"])

    def test_record_for_another_deployment_is_untrusted_and_still_lists_removals(self) -> None:
        self._artifact(self.artifacts, "deck-a")
        self._artifact(self.artifacts, "teammate-deck")
        record = self._record(self._fingerprint()["slugs"], deployment_id="dep-rolled-back")
        for child in sorted((self.artifacts / "teammate-deck").iterdir()):
            child.unlink()
        (self.artifacts / "teammate-deck").rmdir()

        proc = self._run(
            "compare", "--record", str(record), "--live-deployment-id", self.LIVE
        )
        payload = self._json(proc)
        self.assertEqual("untrusted", payload["verdict"])
        self.assertEqual(["teammate-deck"], payload["removals"])
        self.assertEqual(["teammate-deck"], payload["unexpected_removals"])
        self.assertEqual("dep-rolled-back", payload["record_deployment_id"])
        self.assertEqual(self.LIVE, payload["live_deployment_id"])
        self.assertFalse(payload["verifiable"])
        self.assertFalse(payload["ok"])
        # Precedence: proven removals (exit 3) outrank unverifiable (exit 4).
        self.assertEqual(3, proc.returncode)
        self.assertIn("dep-rolled-back", proc.stderr)
        self.assertIn("--allow-unverified", proc.stderr)

    def test_untrusted_record_without_removals_exits_unverified(self) -> None:
        self._artifact(self.artifacts, "deck-a")
        record = self._record(self._fingerprint()["slugs"], deployment_id="dep-rolled-back")
        code, payload = self._compare(str(record))
        self.assertEqual(4, code)
        self.assertEqual("untrusted", payload["verdict"])
        self.assertFalse(payload["ok"])
        self.assertFalse(payload["verifiable"])
        self.assertEqual([], payload["unexpected_removals"])

    def test_unreadable_record_path_is_an_error_not_a_bootstrap(self) -> None:
        self._artifact(self.artifacts, "deck-a")
        proc = self._run(
            "compare",
            "--record",
            str(self.tmp / "typo.json"),
            "--live-deployment-id",
            self.LIVE,
        )
        self.assertEqual(1, proc.returncode)
        self.assertFalse(self._json(proc)["ok"])


class RecordTests(SnapshotCLIBase):
    def test_record_round_trips_through_compare_stdin(self) -> None:
        self._artifact(self.artifacts, "deck-a", extra={"meta.json": '{"title":"A"}'})
        self._artifact(self.artifacts, "deck-b")

        proc = self._run(
            "record",
            "--deployment-id",
            "dep-42",
            "--engine-commit",
            "deadbee",
            "--by",
            "mickael",
        )
        self.assertEqual(0, proc.returncode, proc.stderr)
        record_line = proc.stdout.strip()
        self.assertEqual(1, len(record_line.splitlines()))
        record = json.loads(record_line)
        self.assertEqual("dep-42", record["deployment_id"])
        self.assertEqual("deadbee", record["engine_commit"])
        self.assertEqual("mickael", record["by"])
        self.assertTrue(record["at"].endswith("Z"))
        self.assertEqual(self._fingerprint()["slugs"], record["slugs"])

        code, payload = self._compare_stdin(record_line, "dep-42")
        self.assertEqual(0, code)
        self.assertEqual("match", payload["verdict"])

        (self.artifacts / "deck-b" / "index.html").write_text("<p>edited</p>", encoding="utf-8")
        code, payload = self._compare_stdin(record_line, "dep-42")
        self.assertEqual(0, code)
        self.assertEqual("drift", payload["verdict"])
        self.assertEqual(["deck-b"], payload["changed"])

    def _compare_stdin(self, record_line: str, live: str) -> tuple[int, dict]:
        proc = self._run(
            "compare", "--record", "-", "--live-deployment-id", live, stdin=record_line
        )
        return proc.returncode, self._json(proc)


class ReanchorTests(SnapshotCLIBase):
    """`reanchor` moves the anchor only -- the slug baseline must survive.

    A refused KV write after a successful deploy leaves the record anchored on
    the previous deployment. Rebuilding it with `record` would re-derive the
    slug set from a hub that may itself be behind, which is the deletion this
    whole guard exists to prevent, so recovery must keep the baseline.
    """

    STALE = {
        "deployment_id": "dep-old",
        "engine_commit": "abc1234",
        "by": "teammate",
        "at": "2020-01-01T00:00:00Z",
        "slugs": {"deck-a": "a" * 64, "deck-b": "b" * 64},
    }

    def _reanchor(self, record: str, deployment_id: str = "dep-new") -> tuple[int, dict]:
        proc = self._run(
            "reanchor",
            "--record",
            "-",
            "--deployment-id",
            deployment_id,
            stdin=record,
        )
        return proc.returncode, self._json(proc)

    def test_replaces_only_the_anchor(self) -> None:
        code, out = self._reanchor(json.dumps(self.STALE))
        self.assertEqual(0, code)
        self.assertEqual("dep-new", out["deployment_id"])
        self.assertEqual(self.STALE["slugs"], out["slugs"])
        self.assertEqual("teammate", out["by"])
        self.assertEqual("abc1234", out["engine_commit"])
        self.assertNotEqual(self.STALE["at"], out["at"])
        self.assertTrue(out["at"].endswith("Z"))
        self.assertEqual(
            {"deployment_id", "engine_commit", "by", "at", "slugs"}, set(out)
        )

    def test_never_fingerprints_the_local_hub(self) -> None:
        """The hub holds a different slug set; the record's must come through."""
        self._artifact(self.artifacts, "only-local")
        code, out = self._reanchor(json.dumps(self.STALE))
        self.assertEqual(0, code)
        self.assertEqual(self.STALE["slugs"], out["slugs"])
        self.assertNotIn("only-local", out["slugs"])

    def test_unknown_key_is_preserved(self) -> None:
        record = dict(self.STALE, shares={"deck-a": "k1"})
        code, out = self._reanchor(json.dumps(record))
        self.assertEqual(0, code)
        self.assertEqual({"deck-a": "k1"}, out["shares"])

    def test_empty_record_is_an_error_not_an_empty_slug_set(self) -> None:
        proc = self._run("reanchor", "--record", "-", "--deployment-id", "dep-new")
        self.assertEqual(1, proc.returncode)
        payload = self._json(proc)
        self.assertFalse(payload["ok"])
        self.assertNotIn("slugs", payload)
        self.assertTrue(payload["error"])

    def test_null_record_is_an_error(self) -> None:
        code, payload = self._reanchor("null")
        self.assertEqual(1, code)
        self.assertFalse(payload["ok"])
        self.assertNotIn("slugs", payload)

    def test_json_array_record_is_an_error(self) -> None:
        code, payload = self._reanchor('[{"deployment_id": "dep-old"}]')
        self.assertEqual(1, code)
        self.assertFalse(payload["ok"])

    def test_non_dict_slugs_is_an_error(self) -> None:
        code, payload = self._reanchor(
            json.dumps(dict(self.STALE, slugs=["deck-a", "deck-b"]))
        )
        self.assertEqual(1, code)
        self.assertFalse(payload["ok"])

    def test_empty_deployment_id_is_an_error(self) -> None:
        code, payload = self._reanchor(json.dumps(self.STALE), deployment_id="   ")
        self.assertEqual(1, code)
        self.assertFalse(payload["ok"])

    def test_reanchor_turns_untrusted_back_into_match(self) -> None:
        """The point of the subcommand: recover without --allow-unverified.

        The record is correct about what is live; only its anchor is stale
        because the KV write after the last deploy was refused.
        """
        self._artifact(self.artifacts, "deck-a", extra={"meta.json": '{"title":"A"}'})
        self._artifact(self.artifacts, "deck-b")
        proc = self._run(
            "record",
            "--deployment-id",
            "dep-old",
            "--engine-commit",
            "deadbee",
            "--by",
            "mickael",
        )
        self.assertEqual(0, proc.returncode, proc.stderr)
        stale = proc.stdout.strip()

        code, payload = self._compare_stdin(stale, "dep-new")
        self.assertEqual(4, code)
        self.assertEqual("untrusted", payload["verdict"])

        proc = self._run(
            "reanchor", "--record", "-", "--deployment-id", "dep-new", stdin=stale
        )
        self.assertEqual(0, proc.returncode, proc.stderr)
        fixed = proc.stdout.strip()
        self.assertEqual(1, len(fixed.splitlines()))

        code, payload = self._compare_stdin(fixed, "dep-new")
        self.assertEqual(0, code)
        self.assertEqual("match", payload["verdict"])
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["verifiable"])
        self.assertEqual([], payload["removals"])

    def _compare_stdin(self, record_line: str, live: str) -> tuple[int, dict]:
        proc = self._run(
            "compare", "--record", "-", "--live-deployment-id", live, stdin=record_line
        )
        return proc.returncode, self._json(proc)


class LiveDeploymentTests(SnapshotCLIBase):
    def test_missing_token_reports_auth_missing_without_network(self) -> None:
        proc = self._run("live-deployment")
        payload = self._json(proc)
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertFalse(payload["ok"])
        self.assertEqual("auth_missing", payload["error_kind"])
        self.assertNotIn("deployment_id", payload)


class LiveDeploymentBranchTests(unittest.TestCase):
    """`no_deployment` is a verified-empty claim, not one nullable field.

    `no_deployment` is the only live state the caller may bootstrap from, and
    bootstrap is the only verdict that lets an unrestricted full-snapshot
    deploy through with no record at all. So it must be confirmed against the
    deployments list; anything else is unknown live content.

    In-process against the module loaded from LIB, with `_cf_api` stubbed: no
    socket is ever opened.
    """

    CFG = {"pages_project": "silex-forge"}
    PROJECT_NO_LATEST = {"success": True, "result": {"latest_deployment": None}}

    def setUp(self) -> None:
        self.calls: list[str] = []
        self._real_api = snap._cf_api
        self._real_token = snap.resolve_api_token
        self._real_acct = snap.resolved_account_id
        snap.resolve_api_token = lambda: "tok-test"  # type: ignore[assignment]
        snap.resolved_account_id = lambda cfg=None: "acct-test"  # type: ignore[assignment]

    def tearDown(self) -> None:
        snap._cf_api = self._real_api  # type: ignore[assignment]
        snap.resolve_api_token = self._real_token  # type: ignore[assignment]
        snap.resolved_account_id = self._real_acct  # type: ignore[assignment]

    def _stub(self, deployments: tuple[int, dict | None, str]) -> None:
        project = self.PROJECT_NO_LATEST

        def fake(method: str, path: str, token: str, **kw: object):
            self.calls.append(path)
            if path.endswith("/deployments?per_page=1"):
                return deployments
            return 200, project, ""

        snap._cf_api = fake  # type: ignore[assignment]

    def test_missing_latest_with_empty_list_is_verified_empty(self) -> None:
        self._stub((200, {"success": True, "result": []}, ""))
        result = snap.live_deployment(dict(self.CFG))
        self.assertFalse(result["ok"])
        self.assertEqual("no_deployment", result["error_kind"])
        self.assertTrue(
            any(p.endswith("/deployments?per_page=1") for p in self.calls),
            self.calls,
        )

    def test_missing_latest_with_deployments_present_is_unresolved(self) -> None:
        self._stub((200, {"success": True, "result": [{"id": "dep-1"}]}, ""))
        result = snap.live_deployment(dict(self.CFG))
        self.assertFalse(result["ok"])
        self.assertEqual("live_unresolved", result["error_kind"])
        self.assertIn("deployments", result["error"])

    def test_missing_latest_with_unreadable_list_is_unresolved(self) -> None:
        self._stub((403, {"success": False, "errors": [{"message": "denied"}]}, ""))
        result = snap.live_deployment(dict(self.CFG))
        self.assertFalse(result["ok"])
        self.assertEqual("live_unresolved", result["error_kind"])

    def test_missing_latest_with_unreachable_list_is_unresolved(self) -> None:
        self._stub((0, None, "connection refused"))
        result = snap.live_deployment(dict(self.CFG))
        self.assertFalse(result["ok"])
        self.assertEqual("live_unresolved", result["error_kind"])

    def test_resolvable_latest_keeps_the_payload_shape_and_asks_once(self) -> None:
        def fake(method: str, path: str, token: str, **kw: object):
            self.calls.append(path)
            return 200, {
                "success": True,
                "result": {
                    "latest_deployment": {
                        "id": "dep-live",
                        "deployment_trigger": {"metadata": {"commit_hash": "cafe123"}},
                    }
                },
            }, ""

        snap._cf_api = fake  # type: ignore[assignment]
        result = snap.live_deployment(dict(self.CFG))
        self.assertEqual(
            {"ok": True, "deployment_id": "dep-live", "engine_commit": "cafe123"},
            result,
        )
        self.assertEqual(1, len(self.calls), self.calls)

    def test_auth_missing_short_circuits_before_any_request(self) -> None:
        def explode(*a: object, **kw: object):
            raise AssertionError("live_deployment opened a request without a token")

        snap._cf_api = explode  # type: ignore[assignment]
        snap.resolve_api_token = lambda: ""  # type: ignore[assignment]
        result = snap.live_deployment(dict(self.CFG))
        self.assertEqual("auth_missing", result["error_kind"])

        snap.resolve_api_token = lambda: "tok-test"  # type: ignore[assignment]
        snap.resolved_account_id = lambda cfg=None: ""  # type: ignore[assignment]
        result = snap.live_deployment(dict(self.CFG))
        self.assertEqual("auth_missing", result["error_kind"])


if __name__ == "__main__":
    unittest.main()
