#!/usr/bin/env python3
"""forge-inventory: provenance, redaction, and incomplete-read contracts.

Nested keys are the schema locked by the inventory CLI. Assertions avoid
incidental diagnostic sentences. No network and no live identifiers.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "plugins" / "silex-forge" / "scripts" / "forge-inventory.py"

_spec = importlib.util.spec_from_file_location("forge_inventory", SCRIPT)
assert _spec is not None and _spec.loader is not None
inv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(inv)

BEARER = "fxb-" + "inventory-bearer"
ACCOUNT = "acct" + "fixture"
NAMESPACE = "kvns" + "fixture"
AUDIENCE = "aud" + "fixture"
SHARE = "shk-" + "do-not-persist"
SHARE_GAMMA = "shk-" + "gamma-only"
HOST = "fixture.example"
PROJECT = "fixture-project"
CANON_ID = "dep-canon"
PREVIEW_ID = "dep-preview"
SNAP_ID = "dep-snap"
HIST_1 = "dep-hist-1"
HIST_2 = "dep-hist-2"
CANON_FILES = {"/a/deck/index.html": "opaque-canon"}
PREVIEW_FILES = {
    "/a/deck/index.html": "opaque-preview",
    "/only-preview.html": "opaque-preview-only",
}
SNAP_SLUGS = {"deck": "snap-slug-digest"}
HTML_MARKER = "body-marker-qq"
EXT_SENTINEL = "ext-sentinel-qq"
BOOM = "server-boom-marker"
MALFORMED = "malformed-body-marker"
HUB_MARK = "hub-fixture-zz"



def _json_bytes(payload: dict) -> bytes:
    return json.dumps(payload).encode("utf-8")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _record() -> dict:
    return {
        "deployment_id": SNAP_ID,
        "engine_commit": "snapcommit",
        "by": "fixture",
        "at": "2020-01-01T00:00:00Z",
        "slugs": dict(SNAP_SLUGS),
    }


def _project(name: str, host: str) -> dict:
    return {
        "name": name,
        "subdomain": "not-the-host",
        "domains": [host],
        "canonical_deployment": {
            "id": CANON_ID,
            "environment": "production",
            "created_on": "2024-06-01T00:00:00Z",
        },
        "latest_deployment": {
            "id": PREVIEW_ID,
            "environment": "preview",
            "created_on": "2026-01-01T00:00:00Z",
        },
    }


def _env() -> dict:
    return {
        "CLOUDFLARE_API_TOKEN": BEARER,
        "CLOUDFLARE_ACCOUNT_ID": ACCOUNT,
        "FORGE_SHARES_KV_ID": NAMESPACE,
        "CF_ACCESS_AUD": AUDIENCE,
    }


def _config(hub: Path, *, discover: bool) -> dict:
    cfg = {
        "hub_root": str(hub),
        "artifacts_dir": "artifacts",
        "public_host": HOST,
        "cloudflare_account_id": ACCOUNT,
        "shares_kv_namespace_id": NAMESPACE,
    }
    if not discover:
        cfg["pages_project"] = PROJECT
    return cfg


class Router:
    """Fake GET. Pages stay short while total_pages or cursor says more."""

    def __init__(self, mode: str, *, discover: bool, split: bool) -> None:
        self.mode = mode
        self.discover = discover
        self.split = split
        self.paths: list[str] = []
        self.kv_lists = 0
        self.max_calls = 48
        self.keys = [
            {"name": "vis:alpha", "metadata": {"v": "public"}},
            {"name": "share:alpha", "metadata": None},
            {"name": "vis:beta", "metadata": None},
            {"name": "share:gamma", "metadata": None},
            {"name": "vis:delta", "metadata": None},
            {"name": "snapshot:live", "metadata": None},
        ]
        self.values = {
            "vis:alpha": b"private",
            "vis:beta": b"public",
            "vis:delta": b"nope",
            "share:alpha": SHARE.encode("ascii"),
            "share:gamma": SHARE_GAMMA.encode("ascii"),
            "snapshot:live": _json_bytes(_record()),
        }

    def __call__(self, path: str) -> tuple[int, bytes]:
        self.paths.append(path)
        if len(self.paths) > self.max_calls:
            return 503, b"call-budget"
        decoded = unquote(path)
        parsed = urlsplit(decoded)
        query = parse_qs(parsed.query)
        raw = parsed.path
        if self.mode == "http_error" and "/pages/projects/" in raw and "/deployments" not in raw:
            body = (BOOM + " " + BEARER + " " + ACCOUNT).encode("ascii")
            return 500, body
        if raw.endswith("/tokens/verify"):
            return 200, _json_bytes({"success": True, "result": {"status": "active"}})
        if "/values/" in raw:
            key = unquote(raw.split("/values/", 1)[1])
            if key not in self.values:
                return 404, b"missing-key"
            return 200, self.values[key]
        if raw.rstrip("/").endswith("/keys"):
            return self._keys(query)
        if raw.endswith("/files"):
            return self._files(raw)
        if "/deployments" in raw:
            return self._history(query)
        if raw.rstrip("/").endswith("/pages/projects"):
            return self._project_list(query)
        if "/pages/projects/" in raw:
            return 200, _json_bytes({"success": True, "result": _project(PROJECT, HOST)})
        return 404, b"unknown-route"

    def _keys(self, query: dict) -> tuple[int, bytes]:
        self.kv_lists += 1
        if self.mode == "cursor":
            payload = {
                "success": True,
                "result": [self.keys[0]],
                "result_info": {"count": 1, "cursor": "cursor-repeat"},
            }
            return 200, _json_bytes(payload)
        prefix = query.get("prefix", [""])[0]
        cursor = query.get("cursor", [""])[0]
        rows = [row for row in self.keys if row["name"].startswith(prefix)]
        start = int(cursor) if cursor.isdigit() else 0
        size = 1 if self.split else len(rows) or 1
        chunk = rows[start : start + size]
        info: dict = {"count": len(chunk)}
        nxt = start + size
        if nxt < len(rows):
            info["cursor"] = str(nxt)
        return 200, _json_bytes({"success": True, "result": chunk, "result_info": info})

    def _files(self, raw: str) -> tuple[int, bytes]:
        dep_id = raw.split("/deployments/", 1)[1].split("/", 1)[0]
        if self.mode == "malformed" and dep_id == CANON_ID:
            payload = {
                "success": True,
                "result": {"id": CANON_ID, "files": MALFORMED},
            }
            return 200, _json_bytes(payload)
        files = CANON_FILES if dep_id == CANON_ID else PREVIEW_FILES
        if dep_id not in (CANON_ID, PREVIEW_ID):
            files = {}
        return 200, _json_bytes({"success": True, "result": {"id": dep_id, "files": files}})

    def _history(self, query: dict) -> tuple[int, bytes]:
        if query.get("env", [""])[0] != "production":
            return 200, _json_bytes(
                {"success": True, "result": [], "result_info": {"page": 1, "total_pages": 0}}
            )
        page = int(query.get("page", ["1"])[0] or "1")
        pages = {
            1: [{"id": HIST_1, "created_on": "2024-01-01T00:00:00Z", "environment": "production"}],
            2: [{"id": HIST_2, "created_on": "2024-02-01T00:00:00Z", "environment": "production"}],
        }
        return 200, _json_bytes(
            {
                "success": True,
                "result": pages.get(page, []),
                "result_info": {"page": page, "per_page": 1, "count": 1, "total_pages": 2},
            }
        )

    def _project_list(self, query: dict) -> tuple[int, bytes]:
        page = int(query.get("page", ["1"])[0] or "1")
        if not self.discover:
            rows = [_project(PROJECT, HOST)] if page == 1 else []
            total = 1
        elif page == 1:
            rows = [_project("decoy-project", "other.example")]
            total = 2
        elif page == 2:
            rows = [_project(PROJECT, HOST)]
            total = 2
        else:
            rows = []
            total = 2
        return 200, _json_bytes(
            {
                "success": True,
                "result": rows,
                "result_info": {"page": page, "per_page": 1, "count": len(rows), "total_pages": total},
            }
        )


def _collect(hub: Path, router: Router, *, discover: bool) -> dict:
    return inv.collect_inventory(_config(hub, discover=discover), _env(), router)


def _blob(result: dict) -> str:
    return json.dumps(result)


def _codes(result: dict) -> list[str]:
    return [item["code"] for item in result["issues"]]


class InventoryCase(unittest.TestCase):
    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self.tmp = Path(self._td.name)
        self.hub = self.tmp / HUB_MARK
        (self.hub / "artifacts").mkdir(parents=True)

    def tearDown(self) -> None:
        self._td.cleanup()


    def assertRedacted(self, result: dict) -> None:
        blob = _blob(result)
        for secret in (BEARER, ACCOUNT, NAMESPACE, AUDIENCE, SHARE, SHARE_GAMMA, HUB_MARK):
            self.assertNotIn(secret, blob, secret)
        for item in result["issues"]:
            detail = str(item.get("detail") or "")
            self.assertNotIn(BOOM, detail)
            self.assertNotIn(MALFORMED, detail)

    def assertEnvelope(self, result: dict) -> None:
        self.assertEqual(1, result["schema_version"])
        self.assertIsInstance(result["issues"], list)
        self.assertEqual(result["complete"], not result["issues"])
        self.assertFalse(result["snapshot_record"]["live_bytes_inferred"])


class CanonicalVersusPreviewTests(InventoryCase):
    def test_anchors_and_manifests_stay_distinct_and_share_is_redacted(self) -> None:
        router = Router("happy", discover=False, split=False)
        result = _collect(self.hub, router, discover=False)
        self.assertEnvelope(result)
        self.assertRedacted(result)
        self.assertTrue(result["complete"], _codes(result))
        self.assertEqual([], result["issues"])

        live = result["observed_live"]
        self.assertFalse(live["skipped"])
        self.assertEqual(CANON_ID, live["canonical"]["id"])
        self.assertEqual(PREVIEW_ID, live["latest"]["id"])
        self.assertNotEqual(live["canonical"]["id"], live["latest"]["id"])
        self.assertTrue(live["deployment_drift"])
        self.assertEqual(CANON_FILES, live["files"])
        self.assertNotIn("opaque-preview-only", live["files"].values())

        snap = result["snapshot_record"]
        self.assertTrue(snap["present"])
        self.assertTrue(snap["schema_ok"])
        self.assertEqual(SNAP_ID, snap["deployment_id"])
        self.assertNotEqual(snap["deployment_id"], CANON_ID)
        self.assertFalse(snap["anchor_matches_canonical"])
        self.assertTrue(snap["anchor_drift"])
        self.assertEqual(SNAP_SLUGS, snap["slugs"])
        self.assertEqual(1, snap["slug_count"])
        self.assertNotIn("opaque-canon", _blob(snap))

        digest = _sha256(SHARE.encode("ascii"))
        matched = [row for row in live["shares"] if row.get("sha256") == digest]
        self.assertEqual(1, len(matched), live["shares"])
        self.assertTrue(matched[0]["present"])
        self.assertEqual(len(SHARE), matched[0]["length"])
        self.assertNotIn(SHARE, matched[0]["name"])


class PaginationAndVisibilityTests(InventoryCase):
    def test_split_pages_aggregate_and_vis_value_wins(self) -> None:
        router = Router("happy", discover=True, split=True)
        result = _collect(self.hub, router, discover=True)
        self.assertEnvelope(result)
        self.assertRedacted(result)
        self.assertTrue(result["complete"], ( _codes(result), router.paths))

        project = result["observed_live"]["project"]
        self.assertIsNone(project["configured"])
        self.assertEqual(PROJECT, project["resolved"])
        self.assertEqual("discovered", project["source"])
        self.assertNotEqual("decoy-project", project["resolved"])

        identity = result["observed_live"]["identity"]
        self.assertIs(True, identity["account_match"])
        self.assertIs(True, identity["namespace_match"])
        self.assertNotEqual(False, identity["host_match"])

        history = result["observed_live"]["history"]
        self.assertFalse(history["skipped"])
        self.assertEqual(2, history["pages_read"])
        self.assertEqual(2, history["total_pages"])
        self.assertEqual(
            {HIST_1, HIST_2},
            {row["id"] for row in history["deployments"]},
        )
        for row in history["deployments"]:
            self.assertEqual("production", row["environment"])

        kv = result["observed_live"]["kv"]
        names = [row["name"] for row in kv["keys"]]
        self.assertEqual(
            {
                "vis:alpha",
                "share:alpha",
                "vis:beta",
                "share:gamma",
                "vis:delta",
                "snapshot:live",
            },
            set(names),
        )
        self.assertEqual(6, len(names))
        self.assertEqual(len(names), kv["key_count"])
        by_name = {row["name"]: row for row in kv["keys"]}
        self.assertEqual("public", by_name["vis:alpha"]["metadata_v"])
        self.assertIsNone(by_name["vis:beta"]["metadata_v"])

        vis = {}
        for row in result["observed_live"]["visibility"]:
            ident = str(row["id"])
            if ident.startswith("vis:") or ident.startswith("share:"):
                ident = ident.split(":", 1)[1]
            vis[ident] = row
        self.assertEqual("private", vis["alpha"]["classification"])
        self.assertTrue(vis["alpha"]["vis_present"])
        self.assertTrue(vis["alpha"]["share_present"])
        self.assertEqual("public", vis["beta"]["classification"])
        self.assertFalse(vis["beta"]["share_present"])
        self.assertEqual("private", vis["delta"]["classification"])
        self.assertTrue(vis["delta"]["vis_present"])
        self.assertEqual("private", vis["gamma"]["classification"])
        self.assertFalse(vis["gamma"]["vis_present"])
        self.assertTrue(vis["gamma"]["share_present"])
        self.assertNotEqual("shared", vis["gamma"]["classification"])

        for secret in (SHARE, SHARE_GAMMA):
            digest = _sha256(secret.encode("ascii"))
            rows = [row for row in result["observed_live"]["shares"] if row["sha256"] == digest]
            self.assertEqual(1, len(rows), secret)
            self.assertNotIn("value", rows[0])
        self.assertGreaterEqual(router.kv_lists, 2)


class RemoteFailureTests(InventoryCase):
    def test_http_error_is_incomplete_without_echoing_the_body(self) -> None:
        router = Router("http_error", discover=False, split=False)
        result = _collect(self.hub, router, discover=False)
        self.assertEnvelope(result)
        self.assertRedacted(result)
        self.assertFalse(result["complete"])
        self.assertIn("http_status", _codes(result))
        self.assertIsNone(result["observed_live"]["deployment_drift"])
        self.assertIsNone(result["observed_live"]["files"])
        self.assertIsNone(result["observed_live"]["canonical"]["id"])

    def test_repeated_cursor_is_incomplete(self) -> None:
        router = Router("cursor", discover=False, split=False)
        result = _collect(self.hub, router, discover=False)
        self.assertEnvelope(result)
        self.assertFalse(result["complete"])
        self.assertIn("pagination_cycle", _codes(result))
        self.assertLess(router.kv_lists, 5, router.paths)

    def test_malformed_files_are_not_an_empty_manifest(self) -> None:
        router = Router("malformed", discover=False, split=False)
        result = _collect(self.hub, router, discover=False)
        self.assertEnvelope(result)
        self.assertRedacted(result)
        self.assertFalse(result["complete"])
        self.assertIn("malformed_files", _codes(result))
        self.assertIsNone(result["observed_live"]["files"])
        self.assertNotIn("opaque-canon", _blob(result["observed_live"]))


class LocalSelectionTests(InventoryCase):
    def _build(self) -> dict[str, bytes]:
        art = self.hub / "artifacts"
        deck = art / "deck"
        notes = deck / "notes"
        notes.mkdir(parents=True)
        index = (
            "<html><body>" + HTML_MARKER + "<script>location.href='/a/deck/';</script></body></html>"
        ).encode("utf-8")
        extra = b"<html><body>plain</body></html>"
        blob = b"z" * (256 * 1024)
        (deck / "index.html").write_bytes(index)
        (notes / "extra.html").write_bytes(extra)
        (deck / "blob.bin").write_bytes(blob)
        external = self.tmp / "outside-root" / "ext.bin"
        external.parent.mkdir()
        external.write_bytes(EXT_SENTINEL.encode("ascii"))
        (deck / "outside.link").symlink_to(external)
        (deck / "loop-a").symlink_to("loop-b")
        (deck / "loop-b").symlink_to("loop-a")
        return {
            "deck/index.html": index,
            "deck/notes/extra.html": extra,
            "deck/blob.bin": blob,
        }

    def test_hashes_symlink_escape_and_source_unchanged(self) -> None:
        files = self._build()
        before = {
            path: (path.read_bytes(), path.stat().st_mtime_ns)
            for path in (
                self.hub / "artifacts" / "deck" / "index.html",
                self.hub / "artifacts" / "deck" / "blob.bin",
                self.tmp / "outside-root" / "ext.bin",
            )
        }
        router = Router("happy", discover=False, split=False)
        box: dict = {}

        def run() -> None:
            try:
                box["result"] = _collect(self.hub, router, discover=False)
            except Exception as exc:  # noqa: BLE001 — timeout must observe it
                box["error"] = exc

        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        worker.join(10)
        self.assertFalse(worker.is_alive(), "symlink cycle was followed")
        self.assertNotIn("error", box)
        result = box["result"]
        self.assertEnvelope(result)
        self.assertRedacted(result)

        local = result["local_selection"]
        self.assertTrue(local["readable"])
        self.assertIsNone(local["tree_builder_selected"])
        self.assertEqual(["deck"], local["slug_index_html"])
        self.assertNotIn("deck/notes/extra.html", local["slug_index_html"])

        by_path = {}
        for row in local["files"]:
            path = str(row["path"]).replace("\\", "/").lstrip("./")
            self.assertFalse(os.path.isabs(path), path)
            self.assertNotIn(HUB_MARK, path)
            by_path[path] = row
        for rel, data in files.items():
            self.assertIn(rel, by_path, sorted(by_path))
            self.assertFalse(by_path[rel]["symlink"])
            self.assertIsNone(by_path[rel]["diagnostic"])
            self.assertEqual(len(data), by_path[rel]["size"])
            self.assertEqual(_sha256(data), by_path[rel]["sha256"])

        outside = by_path["deck/outside.link"]
        self.assertTrue(outside["symlink"])
        self.assertEqual("external", outside["diagnostic"])
        self.assertIsNone(outside["sha256"])
        for name in ("deck/loop-a", "deck/loop-b"):
            self.assertTrue(by_path[name]["symlink"])
            self.assertEqual("cycle", by_path[name]["diagnostic"])
            self.assertIsNone(by_path[name]["sha256"])

        blob = _blob(result)
        self.assertNotIn(HTML_MARKER, blob)
        self.assertNotIn(EXT_SENTINEL, blob)
        self.assertNotIn(_sha256(EXT_SENTINEL.encode("ascii")), blob)
        self.assertNotIn("outside-root", blob)
        flags = local["html_flags"]
        self.assertEqual(1, flags["counts"]["location_href"])
        self.assertEqual(0, flags["counts"]["existing_base"])
        self.assertEqual(0, flags["counts"]["root_relative_fetch"])
        self.assertEqual(0, flags["counts"]["hardcoded_host"])

        for path, (data, mtime) in before.items():
            self.assertEqual(data, path.read_bytes())
            self.assertEqual(mtime, path.stat().st_mtime_ns)


class CliTests(unittest.TestCase):
    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self.tmp = Path(self._td.name)
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.hub = self.tmp / HUB_MARK
        deck = self.hub / "artifacts" / "deck"
        deck.mkdir(parents=True)
        self.index = (HTML_MARKER + "\n").encode("ascii")
        (deck / "index.html").write_bytes(self.index)
        external = self.tmp / "outside-root" / "ext.bin"
        external.parent.mkdir()
        external.write_bytes(EXT_SENTINEL.encode("ascii"))
        (deck / "outside.link").symlink_to(external)
        self.cfg = self.tmp / "forge.config.json"
        self.env_path = self.tmp / "forge.env"
        self.cfg.write_text(
            json.dumps(
                {
                    "hub_root": str(self.hub),
                    "artifacts_dir": "artifacts",
                    "public_host": HOST,
                }
            ),
            encoding="utf-8",
        )
        self.env_path.write_text(
            "CLOUDFLARE_API_TOKEN="
            + BEARER
            + "\nCLOUDFLARE_ACCOUNT_ID="
            + ACCOUNT
            + "\nFORGE_SHARES_KV_ID="
            + NAMESPACE
            + "\nCF_ACCESS_AUD="
            + AUDIENCE
            + "\n",
            encoding="utf-8",
        )
        self.env_path.chmod(0o600)
        self._umask = os.umask(0o022)

    def tearDown(self) -> None:
        os.umask(self._umask)
        self._td.cleanup()

    def _subprocess_env(self) -> dict[str, str]:
        return {
            "PATH": os.environ.get("PATH", ""),
            "HOME": str(self.home),
            "LANG": "C",
            "HTTP_PROXY": "http://127.0.0.1:9",
            "HTTPS_PROXY": "http://127.0.0.1:9",
            "http_proxy": "http://127.0.0.1:9",
            "https_proxy": "http://127.0.0.1:9",
            "ALL_PROXY": "http://127.0.0.1:9",
        }

    def _run(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            cwd=str(self.tmp),
            env=self._subprocess_env(),
            capture_output=True,
            text=True,
            timeout=20,
        )

    def _assert_silent_refusal(self, proc: subprocess.CompletedProcess) -> None:
        self.assertEqual(1, proc.returncode, proc.stderr)
        self.assertEqual("", proc.stdout)
        for secret in (BEARER, ACCOUNT, NAMESPACE, AUDIENCE, HUB_MARK, str(self.hub)):
            self.assertNotIn(secret, proc.stderr)
            self.assertNotIn(secret, proc.stdout)

    def test_local_only_writes_private_evidence_outside_git(self) -> None:
        parent = self.tmp / "private-out"
        output = parent / "report.json"
        before = (self.hub / "artifacts" / "deck" / "index.html").read_bytes()
        proc = self._run(
            "--config",
            str(self.cfg),
            "--env",
            str(self.env_path),
            "--output",
            str(output),
            "--local-only",
        )
        self.assertEqual(0, proc.returncode, proc.stderr)
        report = json.loads(output.read_text(encoding="utf-8"))
        for secret in (BEARER, ACCOUNT, NAMESPACE, AUDIENCE, HTML_MARKER, EXT_SENTINEL, HUB_MARK):
            self.assertNotIn(secret, proc.stdout)
            self.assertNotIn(secret, proc.stderr)
            self.assertNotIn(secret, output.read_text(encoding="utf-8"))
        self.assertEqual(["local_only"], [item["code"] for item in report["issues"]])
        self.assertFalse(report["complete"])
        self.assertTrue(report["observed_live"]["skipped"])
        hashed = {
            row["path"]: row["sha256"]
            for row in report["local_selection"]["files"]
            if row["path"] == "deck/index.html"
        }
        self.assertEqual(_sha256(self.index), hashed["deck/index.html"])
        self.assertEqual(0o600, stat.S_IMODE(output.stat().st_mode))
        self.assertEqual(0o700, stat.S_IMODE(parent.stat().st_mode))
        self.assertEqual(before, (self.hub / "artifacts" / "deck" / "index.html").read_bytes())

    def test_refuses_overwrite(self) -> None:
        output = self.tmp / "private-out" / "report.json"
        first = self._run(
            "--config",
            str(self.cfg),
            "--env",
            str(self.env_path),
            "--output",
            str(output),
            "--local-only",
        )
        self.assertEqual(0, first.returncode, first.stderr)
        original = output.read_bytes()
        second = self._run(
            "--config",
            str(self.cfg),
            "--env",
            str(self.env_path),
            "--output",
            str(output),
            "--local-only",
        )
        self._assert_silent_refusal(second)
        self.assertEqual(original, output.read_bytes())
        self.assertNotIn(str(output), second.stderr)

    @unittest.skipIf(shutil.which("git") is None, "git is required to build a linked worktree")
    def test_refuses_output_in_linked_worktree(self) -> None:
        repo = self.tmp / "repo"
        linked = self.tmp / "linked"
        repo.mkdir()
        git = ["git", "-C", str(repo)]
        subprocess.run([*git, "init"], check=True, capture_output=True, text=True)
        subprocess.run([*git, "config", "user.email", "t@example.com"], check=True, capture_output=True)
        subprocess.run([*git, "config", "user.name", "t"], check=True, capture_output=True)
        subprocess.run(
            [*git, "commit", "--allow-empty", "-m", "init"],
            check=True,
            capture_output=True,
            text=True,
        )
        subprocess.run(
            [*git, "worktree", "add", "--detach", str(linked)],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertTrue((linked / ".git").is_file())
        output = linked / "report.json"
        before = {path.relative_to(linked) for path in linked.rglob("*")}
        proc = self._run(
            "--config",
            str(self.cfg),
            "--env",
            str(self.env_path),
            "--output",
            str(output),
            "--local-only",
        )
        self._assert_silent_refusal(proc)
        self.assertFalse(output.exists())
        self.assertNotIn(str(linked), proc.stderr)
        after = {path.relative_to(linked) for path in linked.rglob("*")}
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
