#!/usr/bin/env python3
"""Read-only inventory of one forge instance.

This tool does not publish, reanchor, deploy, or write Cloudflare. It does not
import artifact HTML, execute scripts, or follow symlinks. Config and env paths
are explicit: the example config is not merged in, and the env file is never
sourced.

The legacy publisher is untouched. Its KV snapshot record is copied here only
as that record; it is not treated as the live file bytes. Pages file hashes are
stored as opaque strings. Tree-builder exclude rules are not applied: raw HTML
candidates are listed and the builder-selected set stays unknown.

Share values are never stored. Output is private machine evidence and is
refused inside any git worktree, including a linked worktree whose .git entry
is a file.
"""
from __future__ import annotations

import argparse
import codecs
import hashlib
import json
import os
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


SCHEMA_VERSION = 1
API_ORIGIN = "https://api.cloudflare.com"
API_PREFIX = "/client/v4"
SNAPSHOT_KEY = "snapshot:live"
VIS_VALUES = frozenset({"private", "shared", "public"})
FLAG_KEYS = (
    "existing_base",
    "root_relative_fetch",
    "location_href",
    "hardcoded_host",
)
_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_BASE_RE = re.compile(r"<base\b", re.IGNORECASE)
_FETCH_RE = re.compile(r"""fetch\s*\(\s*(['"`])/(?!/)""")
_LOC_RE = re.compile(r"location\.href")
_CHUNK = 1024 * 1024
_PAGE_CAP = 10000
_SHELL_META = "$`;|" + "&<>"


class EnvSyntaxError(Exception):
    """Env file line is not a plain assignment."""


class ConfigError(Exception):
    """Config file cannot be read as a JSON object."""


class CredentialMissing(Exception):
    """CLI has no bearer token. The message is never surfaced."""


def _utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _present(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, str):
        text = value.strip()
    elif isinstance(value, (int, float)):
        text = str(value).strip()
    else:
        return None
    return text or None


def _issue(issues, code, detail):
    item = {"code": code, "detail": detail}
    if item not in issues:
        issues.append(item)


def parse_env(text):
    """Parse KEY=value and export KEY=value lines. Never sources a shell."""
    out = {}
    for lineno, raw in enumerate(text.splitlines(), 1):
        if raw.endswith("\\") or "\x00" in raw:
            raise EnvSyntaxError(lineno)
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if any(ch in raw for ch in _SHELL_META):
            raise EnvSyntaxError(lineno)
        try:
            tokens = shlex.split(stripped, comments=True, posix=True)
        except ValueError as exc:
            raise EnvSyntaxError(lineno) from exc
        if not tokens:
            continue
        if tokens and tokens[0] == "export":
            tokens = tokens[1:]
        if len(tokens) == 1 and "=" in tokens[0]:
            key, value = tokens[0].split("=", 1)
        elif len(tokens) == 3 and tokens[1] == "=":
            key, value = tokens[0], tokens[2]
        elif len(tokens) == 2 and tokens[0].endswith("="):
            key, value = tokens[0][:-1], tokens[1]
        elif len(tokens) == 2 and tokens[1].startswith("="):
            key, value = tokens[0], tokens[1][1:]
        elif len(tokens) == 2 and tokens[1] == "=":
            key, value = tokens[0], ""
        else:
            raise EnvSyntaxError(lineno)
        if not _KEY_RE.fullmatch(key) or key in out:
            raise EnvSyntaxError(lineno)
        out[key] = value
    return out


def _read_env_file(path):
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError() from exc
    return parse_env(text)


def _read_config_file(path):
    try:
        text = path.read_text(encoding="utf-8-sig")
        data = json.loads(text) if text.strip() else None
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ConfigError() from exc
    if not isinstance(data, dict):
        raise ConfigError()
    return data


def _agree(left, right):
    """Return (value, match, mismatch). match is null unless both are set."""
    if left and right:
        if left != right:
            return None, False, True
        return left, True, False
    if left or right:
        return left or right, None, False
    return None, None, False


def _host_name(value):
    text = value.strip().lower()
    if "://" in text:
        text = text.split("://", 1)[1]
    text = text.split("/", 1)[0].split("?", 1)[0]
    if text.endswith("."):
        text = text[:-1]
    if text.startswith("[") and "]" in text:
        return text[1:text.index("]")]
    if ":" in text:
        text = text.split(":", 1)[0]
    return text


def _quote(part):
    return urllib.parse.quote(part, safe="")


def _scrub(obj, paths, secrets):
    if isinstance(obj, str):
        for secret in secrets:
            if secret and secret in obj:
                obj = obj.replace(secret, "[redacted]")
        for path in paths:
            if path and path in obj:
                obj = obj.replace(path, "[redacted]")
        return obj
    if isinstance(obj, list):
        return [_scrub(item, paths, secrets) for item in obj]
    if isinstance(obj, dict):
        out = {}
        for key, value in obj.items():
            if key == "sha256":
                out[key] = value
            elif key == "files" and isinstance(value, dict):
                out[key] = {
                    _scrub(path_key, paths, secrets): hash_text
                    for path_key, hash_text in value.items()
                }
            else:
                out[key] = _scrub(value, paths, secrets)
        return out
    return obj


def _classify_symlink(path, root):
    seen = set()
    current = path
    for _ in range(_PAGE_CAP):
        key = os.path.normpath(str(current))
        if key in seen:
            return "cycle"
        seen.add(key)
        try:
            mode = os.lstat(current).st_mode
        except OSError:
            return "broken"
        if not stat.S_ISLNK(mode):
            try:
                Path(key).relative_to(root)
            except ValueError:
                return "external"
            return "broken" if not os.path.lexists(current) else "internal"
        try:
            raw = os.readlink(current)
        except OSError:
            return "broken"
        nxt = Path(raw) if os.path.isabs(raw) else Path(current).parent / raw
        nxt_s = os.path.normpath(str(nxt))
        try:
            Path(nxt_s).relative_to(root)
        except ValueError:
            return "external"
        current = Path(nxt_s)
    return "cycle"


def _hash_file(path):
    digest = hashlib.sha256()
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(str(path), flags)
    except OSError:
        return None
    try:
        with os.fdopen(fd, "rb") as handle:
            while True:
                chunk = handle.read(_CHUNK)
                if not chunk:
                    break
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def _scan_flags(path, host):
    flags = {key: False for key in FLAG_KEYS}
    host_re = None
    if host:
        host_re = re.compile(
            r"(?<![A-Za-z0-9.-])" + re.escape(host) + r"(?![A-Za-z0-9.-])",
            re.IGNORECASE,
        )
    overlap = ""
    decoder = codecs.getincrementaldecoder("utf-8")("replace")

    def apply(text):
        if not flags["existing_base"] and _BASE_RE.search(text):
            flags["existing_base"] = True
        if not flags["root_relative_fetch"] and _FETCH_RE.search(text):
            flags["root_relative_fetch"] = True
        if not flags["location_href"] and _LOC_RE.search(text):
            flags["location_href"] = True
        if host_re is not None and not flags["hardcoded_host"] and host_re.search(text):
            flags["hardcoded_host"] = True

    try:
        fd = os.open(str(path), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return flags
    try:
        with os.fdopen(fd, "rb") as handle:
            while True:
                chunk = handle.read(_CHUNK)
                text = overlap + decoder.decode(chunk, final=not chunk)
                if not chunk:
                    apply(text)
                    break
                if len(text) > 400:
                    apply(text[:-400])
                    overlap = text[-400:]
                else:
                    overlap = text
    except OSError:
        return flags
    return flags


def _empty_local():
    return {
        "readable": False,
        "files": [],
        "slug_index_html": [],
        "tree_candidates": [],
        "tree_builder_selected": None,
        "html_flags": {
            "counts": {key: 0 for key in FLAG_KEYS},
            "files": [],
        },
    }


def _local_selection(config, issues, host):
    selection = _empty_local()
    scrub_paths = []
    hub_text = _present(config.get("hub_root"))
    art_text = _present(config.get("artifacts_dir"))
    if not hub_text or not art_text:
        _issue(issues, "config_missing", "hub_root or artifacts_dir missing")
        return selection, scrub_paths
    try:
        hub = Path(hub_text).expanduser().resolve()
    except OSError:
        _issue(issues, "unreadable", "artifacts root is unreadable")
        return selection, scrub_paths
    scrub_paths.append(str(hub))
    art_path = Path(art_text).expanduser()
    try:
        root = art_path.resolve() if art_path.is_absolute() else (hub / art_path).resolve()
    except OSError:
        _issue(issues, "unreadable", "artifacts root is unreadable")
        return selection, scrub_paths
    scrub_paths.append(str(root))
    try:
        root.relative_to(hub)
    except ValueError:
        _issue(issues, "unreadable", "artifacts root is outside the hub")
        return selection, scrub_paths
    if not root.is_dir():
        _issue(issues, "unreadable", "artifacts root is unreadable")
        return selection, scrub_paths

    files = []
    slugs = []
    trees = []
    flag_rows = []
    entry_error = False
    stack = [root]
    seen_dirs = set()
    while stack:
        current = stack.pop()
        try:
            current_stat = os.lstat(current)
        except OSError:
            entry_error = True
            continue
        dir_key = (current_stat.st_dev, current_stat.st_ino)
        if dir_key in seen_dirs:
            continue
        seen_dirs.add(dir_key)
        try:
            entries = list(os.scandir(current))
        except OSError:
            entry_error = True
            continue
        child_dirs = []
        for entry in entries:
            entry_path = Path(entry.path)
            try:
                rel = entry_path.relative_to(root).as_posix()
            except ValueError:
                entry_error = True
                continue
            try:
                info = entry.stat(follow_symlinks=False)
            except OSError:
                files.append(
                    {
                        "path": rel,
                        "size": 0,
                        "sha256": None,
                        "symlink": False,
                        "diagnostic": "unreadable",
                    }
                )
                entry_error = True
                continue
            if stat.S_ISLNK(info.st_mode):
                kind = _classify_symlink(entry_path, root)
                files.append(
                    {
                        "path": rel,
                        "size": int(info.st_size),
                        "sha256": None,
                        "symlink": True,
                        "diagnostic": kind,
                    }
                )
                continue
            if stat.S_ISDIR(info.st_mode):
                child_dirs.append(entry.path)
                continue
            if not stat.S_ISREG(info.st_mode):
                files.append(
                    {
                        "path": rel,
                        "size": int(info.st_size),
                        "sha256": None,
                        "symlink": False,
                        "diagnostic": "special",
                    }
                )
                continue
            digest = _hash_file(entry_path)
            row = {
                "path": rel,
                "size": int(info.st_size),
                "sha256": digest,
                "symlink": False,
                "diagnostic": None if digest is not None else "unreadable",
            }
            if digest is None:
                entry_error = True
            files.append(row)
            lowered = entry.name.lower()
            if digest is not None and (
                lowered.endswith(".html") or lowered.endswith(".htm")
            ):
                trees.append(rel)
                scanned = _scan_flags(entry_path, host or "")
                flag_rows.append({"path": rel, **scanned})
        if current == root:
            for entry in entries:
                name = entry.name
                if name.startswith("."):
                    continue
                try:
                    info = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
                    continue
                index = Path(entry.path) / "index.html"
                try:
                    index_stat = index.lstat()
                except OSError:
                    continue
                if stat.S_ISREG(index_stat.st_mode) or stat.S_ISLNK(index_stat.st_mode):
                    slugs.append(name)
        stack.extend(child_dirs)

    if entry_error:
        _issue(issues, "unreadable", "artifacts entry unreadable")
    files.sort(key=lambda item: item["path"])
    flag_rows.sort(key=lambda item: item["path"])
    counts = {key: sum(1 for row in flag_rows if row[key]) for key in FLAG_KEYS}
    selection["readable"] = not entry_error
    selection["files"] = files
    selection["slug_index_html"] = sorted(slugs)
    selection["tree_candidates"] = sorted(trees)
    selection["html_flags"] = {"counts": counts, "files": flag_rows}
    return selection, scrub_paths


def _empty_observed():
    return {
        "skipped": False,
        "project": {"configured": None, "resolved": None, "source": None},
        "identity": {
            "host_match": None,
            "account_match": None,
            "namespace_match": None,
        },
        "canonical": {"id": None},
        "latest": {"id": None},
        "deployment_drift": None,
        "files": None,
        "history": {
            "skipped": False,
            "pages_read": 0,
            "total_pages": None,
            "deployments": [],
        },
        "kv": {"key_count": 0, "keys": []},
        "visibility": [],
        "shares": [],
    }


def _call(get, path, slot, issues, tolerate=()):
    try:
        status, body = get(path)
    except CredentialMissing:
        _issue(issues, "config_missing", "credential missing")
        return None, b""
    except Exception:
        _issue(issues, "network", "network")
        return None, b""
    if isinstance(status, bool) or not isinstance(status, int) or not isinstance(body, (bytes, bytearray)):
        _issue(issues, "network", "network")
        return None, b""
    body_bytes = bytes(body)
    if status == 0:
        _issue(issues, "network", "network")
        return None, b""
    if status != 200 and status not in tolerate:
        _issue(issues, "http_status", "GET %s %s" % (slot, status))
        return status, b""
    return status, body_bytes


def _envelope(get, path, slot, issues):
    status, body = _call(get, path, slot, issues)
    if status != 200:
        return None
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        _issue(issues, "malformed_json", "GET %s malformed json" % slot)
        return None
    if not isinstance(data, dict) or data.get("success") is not True:
        _issue(issues, "http_status", "GET %s rejected" % slot)
        return None
    return data


def _result_info(payload):
    info = payload.get("result_info")
    return info if isinstance(info, dict) else {}


def _deployment_id(value):
    if not isinstance(value, dict):
        return None
    dep = value.get("id")
    if isinstance(dep, str) and dep:
        return dep
    return None


def _domain_names(project):
    raw = project.get("domains")
    if not isinstance(raw, list):
        return []
    names = []
    for item in raw:
        if isinstance(item, str):
            names.append(item)
        elif isinstance(item, dict):
            for key in ("name", "domain", "hostname"):
                if isinstance(item.get(key), str):
                    names.append(item[key])
                    break
    return names


def _page_row_id(item):
    """Deployment rows use id. Project list rows use name and have no id."""
    for key in ("id", "name"):
        value = item.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _page_items(get, path_for, slot, issues, incomplete_detail, cycle_detail):
    pages = []
    seen_ids = []
    total = None
    page = 1
    while page <= _PAGE_CAP:
        payload = _envelope(get, path_for(page), slot, issues)
        if payload is None:
            return pages, None
        info = _result_info(payload)
        reported = info.get("total_pages")
        if isinstance(reported, bool) or not isinstance(reported, int) or reported < 0:
            _issue(issues, "pagination_incomplete", incomplete_detail)
            return pages, None
        if total is None:
            total = reported
        elif reported != total:
            _issue(issues, "pagination_incomplete", incomplete_detail)
            return pages, None
        reported_page = info.get("page")
        if reported_page is not None and reported_page != page:
            _issue(issues, "pagination_cycle", cycle_detail)
            return pages, None
        result = payload.get("result")
        if not isinstance(result, list) or not all(isinstance(item, dict) for item in result):
            _issue(issues, "malformed_json", "GET %s malformed json" % slot)
            return pages, None
        if total == 0:
            if result:
                _issue(issues, "pagination_incomplete", incomplete_detail)
                return [], None
            return [], 0
        idents = tuple(_page_row_id(item) for item in result)
        if idents and all(idents):
            if idents in seen_ids:
                _issue(issues, "pagination_cycle", cycle_detail)
                return pages, None
            seen_ids.append(idents)
        pages.append(result)
        if page >= total:
            return pages, total
        page += 1
    _issue(issues, "pagination_incomplete", incomplete_detail)
    return pages, None


def _discover_project(get, account, host, issues):
    wanted = _host_name(host)
    matches = []
    failed = False

    def path_for(page):
        return "/accounts/%s/pages/projects?page=%s" % (_quote(account), page)

    pages, total = _page_items(
        get,
        path_for,
        "projects",
        issues,
        "project list total_pages missing",
        "project list page repeated",
    )
    if total is None:
        return None
    for page in pages:
        for item in page:
            name = item.get("name")
            if not isinstance(name, str) or not name:
                continue
            current = item
            if "domains" not in item or not isinstance(item.get("domains"), list):
                detail = _envelope(
                    get,
                    "/accounts/%s/pages/projects/%s" % (_quote(account), _quote(name)),
                    "project",
                    issues,
                )
                if detail is None:
                    failed = True
                    break
                result = detail.get("result")
                current = result if isinstance(result, dict) else {}
            names = {_host_name(value) for value in _domain_names(current)}
            if wanted and wanted in names:
                matches.append(name)
        if failed:
            return None
    if len(matches) != 1:
        code = "project_ambiguous" if len(matches) > 1 else "project_missing"
        _issue(issues, code, "pages_project did not match exactly one project")
        return None
    return matches[0]


def _read_project(get, account, project, observed, issues):
    payload = _envelope(
        get,
        "/accounts/%s/pages/projects/%s" % (_quote(account), _quote(project)),
        "project",
        issues,
    )
    if payload is None:
        return False
    result = payload.get("result")
    if not isinstance(result, dict):
        _issue(issues, "malformed_json", "GET project malformed json")
        return False
    resolved = result.get("name") if isinstance(result.get("name"), str) else project
    observed["project"]["resolved"] = resolved
    canonical = _deployment_id(result.get("canonical_deployment"))
    latest = _deployment_id(result.get("latest_deployment"))
    observed["canonical"]["id"] = canonical
    observed["latest"]["id"] = latest
    both = canonical is not None and latest is not None and canonical == latest
    observed["deployment_drift"] = not both
    if canonical is None:
        _issue(issues, "canonical_missing", "canonical deployment id missing")
        return True
    files_payload = _envelope(
        get,
        "/accounts/%s/pages/projects/%s/deployments/%s/files"
        % (_quote(account), _quote(project), _quote(canonical)),
        "deployment_files",
        issues,
    )
    if files_payload is None:
        return True
    deployment = files_payload.get("result")
    files = deployment.get("files") if isinstance(deployment, dict) else None
    if not isinstance(files, dict) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in files.items()
    ):
        _issue(issues, "malformed_files", "deployment files payload is not an object")
        observed["files"] = None
        return True
    observed["files"] = dict(files)
    return True


def _read_history(get, account, project, observed, issues):
    def path_for(page):
        return (
            "/accounts/%s/pages/projects/%s/deployments?env=production"
            + "&"
            + "page=%s"
        ) % (_quote(account), _quote(project), page)

    pages, total = _page_items(
        get,
        path_for,
        "deployments",
        issues,
        "history total_pages missing",
        "history page repeated",
    )
    observed["history"]["pages_read"] = len(pages)
    observed["history"]["total_pages"] = total
    rows = []
    for page in pages:
        for item in page:
            dep = item.get("id")
            created = item.get("created_on")
            environment = item.get("environment")
            rows.append(
                {
                    "id": dep if isinstance(dep, str) and dep else None,
                    "created_on": created if isinstance(created, str) else None,
                    "environment": environment if isinstance(environment, str) else None,
                }
            )
    observed["history"]["deployments"] = rows


def _metadata_v(item):
    meta = item.get("metadata")
    if not isinstance(meta, dict) or "v" not in meta:
        return None
    value = meta.get("v")
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return None


def _read_kv_values(get, account, namespace, observed, issues, secrets):
    vis_values = {}
    share_ids = set()
    shares = []
    snapshot_body = None
    snapshot_seen = False
    for item in observed["kv"]["keys"]:
        name = item["name"]
        if name.startswith("vis:"):
            vis_values.setdefault(name.split(":", 1)[1], None)
        elif name.startswith("share:"):
            share_ids.add(name.split(":", 1)[1])
        if not (
            name.startswith("vis:")
            or name.startswith("share:")
            or name.startswith("snapshot:")
        ):
            continue
        status, body = _call(
            get,
            "/accounts/%s/storage/kv/namespaces/%s/values/%s"
            % (_quote(account), _quote(namespace), _quote(name)),
            "kv_value",
            issues,
            tolerate=(404,),
        )
        if status == 404:
            if name.startswith("share:"):
                shares.append(
                    {"name": name, "present": False, "length": None, "sha256": None}
                )
            continue
        if status != 200:
            if name.startswith("share:"):
                shares.append(
                    {"name": name, "present": False, "length": None, "sha256": None}
                )
            continue
        if name.startswith("share:"):
            if len(body) >= 8:
                decoded = body.decode("utf-8", "ignore")
                if decoded:
                    secrets.append(decoded)
            shares.append(
                {
                    "name": name,
                    "present": True,
                    "length": len(body),
                    "sha256": hashlib.sha256(body).hexdigest(),
                }
            )
        elif name.startswith("vis:"):
            try:
                vis_values[name.split(":", 1)[1]] = body.decode("utf-8").strip()
            except UnicodeError:
                vis_values[name.split(":", 1)[1]] = None
                _issue(issues, "unreadable", "visibility value unreadable")
        elif name == SNAPSHOT_KEY:
            snapshot_seen = True
            snapshot_body = body
    observed["shares"] = sorted(shares, key=lambda item: item["name"])
    observed["_vis_values"] = vis_values
    observed["_share_ids"] = share_ids
    observed["_snapshot_body"] = snapshot_body
    observed["_snapshot_seen"] = snapshot_seen


def _read_kv(get, account, namespace, observed, issues, secrets):
    keys = []
    seen_cursors = set()
    cursor = None
    for _ in range(_PAGE_CAP):
        path = "/accounts/%s/storage/kv/namespaces/%s/keys" % (
            _quote(account),
            _quote(namespace),
        )
        if cursor:
            path += "?cursor=%s" % _quote(cursor)
        payload = _envelope(get, path, "kv_keys", issues)
        if payload is None:
            return False
        result = payload.get("result")
        if not isinstance(result, list):
            _issue(issues, "malformed_json", "GET kv_keys malformed json")
            return False
        for item in result:
            if not isinstance(item, dict) or not isinstance(item.get("name"), str):
                _issue(issues, "malformed_json", "GET kv_keys malformed json")
                return False
            keys.append({"name": item["name"], "metadata_v": _metadata_v(item)})
        info = _result_info(payload)
        nxt = info.get("cursor") if "cursor" in info else None
        if not isinstance(nxt, str) or not nxt:
            observed["kv"]["keys"] = sorted(keys, key=lambda item: item["name"])
            observed["kv"]["key_count"] = len(keys)
            _read_kv_values(get, account, namespace, observed, issues, secrets)
            return True
        if nxt in seen_cursors:
            _issue(issues, "pagination_cycle", "pagination cursor repeated")
            return False
        seen_cursors.add(nxt)
        cursor = nxt
    _issue(issues, "pagination_incomplete", "kv list did not terminate")
    return False


def _classify(observed, slugs, issues):
    vis_values = observed.pop("_vis_values", {})
    share_ids = observed.pop("_share_ids", set())
    ids = set(slugs) | set(vis_values) | set(share_ids)
    rows = []
    for page_id in sorted(ids):
        if not page_id:
            continue
        raw = vis_values.get(page_id)
        if raw in VIS_VALUES:
            classification = raw
        else:
            classification = "private"
        rows.append(
            {
                "id": page_id,
                "classification": classification,
                "vis_present": page_id in vis_values,
                "share_present": page_id in share_ids,
            }
        )
    observed["visibility"] = rows


def _snapshot_from(body, seen, canonical_id, issues):
    record = {
        "present": False,
        "schema_ok": False,
        "deployment_id": None,
        "anchor_matches_canonical": False,
        "anchor_drift": None,
        "slug_count": None,
        "slugs": None,
        "live_bytes_inferred": False,
    }
    if not seen:
        return record
    record["present"] = True
    try:
        data = json.loads(body.decode("utf-8") if body is not None else "")
    except (UnicodeError, json.JSONDecodeError, AttributeError):
        _issue(issues, "snapshot_unreadable", "snapshot value unreadable")
        return record
    if not isinstance(data, dict):
        _issue(issues, "snapshot_unreadable", "snapshot value unreadable")
        return record
    dep = data.get("deployment_id")
    dep_ok = isinstance(dep, str) and bool(dep)
    slugs = data.get("slugs")
    slugs_ok = isinstance(slugs, dict) and all(
        isinstance(key, str) and isinstance(value, str) for key, value in slugs.items()
    )
    record["deployment_id"] = dep if dep_ok else None
    record["schema_ok"] = bool(dep_ok and slugs_ok)
    if record["schema_ok"]:
        record["slugs"] = dict(slugs)
        record["slug_count"] = len(slugs)
    else:
        _issue(issues, "snapshot_schema", "snapshot record schema rejected")
    if dep_ok and canonical_id:
        record["anchor_drift"] = dep != canonical_id
        record["anchor_matches_canonical"] = bool(
            record["schema_ok"] and dep == canonical_id
        )
    return record


def _secret_strings(config, env):
    found = []
    for key in (
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_API_KEY",
        "CLOUDFLARE_ACCOUNT_ID",
        "FORGE_SHARES_KV_ID",
        "CF_ACCESS_AUD",
        "SHLINK_API_KEY",
    ):
        value = _present(env.get(key))
        if value and len(value) >= 8:
            found.append(value)
    for key in ("cloudflare_account_id", "shares_kv_namespace_id", "cf_access_aud"):
        value = _present(config.get(key))
        if value and len(value) >= 8:
            found.append(value)
    return found


def collect_inventory(config, env, get, include_history=True, local_only=False):
    """Collect one instance inventory.

    get is not called when local_only is set. It receives a relative API path
    and returns (status, body). A missing token must raise CredentialMissing
    before any network call.
    """
    issues = []
    if not isinstance(config, dict):
        config = {}
    if not isinstance(env, dict):
        env = {}

    def norm(source, key):
        return _present(source.get(key))

    host_value, host_match, host_bad = _agree(
        norm(config, "public_host"),
        norm(env, "PUBLIC_HOST"),
    )
    cfg_host = norm(config, "public_host")
    env_host = norm(env, "PUBLIC_HOST")
    cfg_norm = _host_name(cfg_host) if cfg_host else None
    env_norm = _host_name(env_host) if env_host else None
    if host_bad and cfg_norm and env_norm and cfg_norm == env_norm:
        host_value, host_match, host_bad = cfg_host, True, False

    account, account_match, account_bad = _agree(
        norm(config, "cloudflare_account_id"),
        norm(env, "CLOUDFLARE_ACCOUNT_ID"),
    )
    namespace, namespace_match, namespace_bad = _agree(
        norm(config, "shares_kv_namespace_id"),
        norm(env, "FORGE_SHARES_KV_ID"),
    )
    configured = _present(config.get("pages_project"))
    env_projects = [
        value
        for value in (
            _present(env.get("FORGE_PAGES_PROJECT")),
            _present(env.get("PAGES_PROJECT")),
        )
        if value
    ]
    project_bad = bool(env_projects) and (
        configured is None
        or configured not in env_projects
        or len(set(env_projects)) > 1
    )
    if account_bad:
        _issue(issues, "identity_mismatch", "account mismatch")
    if namespace_bad:
        _issue(issues, "identity_mismatch", "namespace mismatch")
    if host_bad:
        _issue(issues, "identity_mismatch", "host mismatch")
    if project_bad:
        _issue(issues, "identity_mismatch", "project mismatch")

    local, scrub_paths = _local_selection(config, issues, cfg_norm)
    observed = _empty_observed()
    observed["project"]["configured"] = configured
    observed["identity"] = {
        "host_match": host_match,
        "account_match": account_match,
        "namespace_match": namespace_match,
    }
    secrets = _secret_strings(config, env)
    snapshot_body = None
    snapshot_seen = False
    if local_only:
        _issue(issues, "local_only", "live reads skipped")
    if local_only or account_bad or namespace_bad or host_bad or project_bad:
        observed["skipped"] = True
        observed["history"]["skipped"] = True
    else:
        if not account:
            _issue(issues, "config_missing", "account id missing")
            observed["skipped"] = True
            observed["history"]["skipped"] = True
        else:
            project = configured
            source = "config" if configured else None
            if not configured:
                if not cfg_host:
                    _issue(issues, "project_missing", "pages_project did not match exactly one project")
                else:
                    project = _discover_project(get, account, cfg_host, issues)
                    if project:
                        source = "discovered"
            observed["project"]["resolved"] = project
            observed["project"]["source"] = source if project else None
            if project and _read_project(get, account, project, observed, issues):
                if include_history:
                    _read_history(get, account, project, observed, issues)
                else:
                    observed["history"]["skipped"] = True
            else:
                observed["history"]["skipped"] = True
            if not namespace:
                _issue(issues, "config_missing", "namespace id missing")
            else:
                if _read_kv(get, account, namespace, observed, issues, secrets):
                    snapshot_body = observed.pop("_snapshot_body", None)
                    snapshot_seen = observed.pop("_snapshot_seen", False)
                    _classify(
                        observed,
                        local["slug_index_html"],
                        issues,
                    )
    if not include_history or local_only:
        observed["history"]["skipped"] = True
    for private_key in ("_vis_values", "_share_ids", "_snapshot_body", "_snapshot_seen"):
        observed.pop(private_key, None)
    report = {
        "schema_version": SCHEMA_VERSION,
        "collected_at": _utc_now(),
        "local_selection": local,
        "snapshot_record": _snapshot_from(
            snapshot_body,
            snapshot_seen,
            observed["canonical"]["id"],
            issues,
        ),
        "observed_live": observed,
        "issues": issues,
        "complete": not issues,
    }
    return _scrub(report, [path for path in scrub_paths if path], secrets)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def production_get(token):
    """GET-only wrapper. Origin is fixed. The token is not logged."""

    def get(path):
        if not isinstance(path, str) or not path.startswith("/") or "://" in path or "\\" in path or "\n" in path or "\r" in path:
            return 0, b""
        url = API_ORIGIN + API_PREFIX + path
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or parsed.hostname != "api.cloudflare.com":
            return 0, b""
        request = urllib.request.Request(
            url,
            method="GET",
            headers={
                "Authorization": "Bearer " + token,
                "Accept": "application/json",
            },
        )
        opener = urllib.request.build_opener(_NoRedirect)
        try:
            with opener.open(request, timeout=60) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as exc:
            body = b""
            try:
                body = exc.read()
            except Exception:
                body = b""
            return exc.code, body if isinstance(body, bytes) else b""
        except Exception:
            return 0, b""

    return get


def _inside_git(path):
    raw = path if path.is_absolute() else Path.cwd() / path
    starts = [raw, raw.parent]
    try:
        starts.append(raw.resolve(strict=False))
    except OSError:
        pass
    for start in starts:
        cur = start
        seen = set()
        while cur not in seen:
            seen.add(cur)
            marker = cur / ".git"
            if marker.is_file() or marker.is_dir() or marker.is_symlink():
                return True
            if cur.parent == cur:
                break
            cur = cur.parent
    probe = raw.parent if raw.parent != raw else raw
    if probe.exists() and not probe.is_dir():
        return False
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env["LC_ALL"] = "C"
    try:
        proc = subprocess.run(
            ["git", "-C", str(probe), "rev-parse", "--is-inside-work-tree"],
            cwd=str(probe),
            env=env,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        return proc.returncode == 0 and proc.stdout.strip() == "true"
    except (OSError, subprocess.TimeoutExpired):
        return False


def _mk_dir_private(parent):
    missing = []
    cur = parent
    while cur.parent != cur and not cur.exists():
        missing.append(cur)
        cur = cur.parent
    for directory in reversed(missing):
        try:
            directory.mkdir(mode=0o700)
        except FileExistsError:
            continue
        os.chmod(directory, 0o700)


def _write_private(path, payload):
    parent = path.parent
    _mk_dir_private(parent)
    fd, tmp_name = tempfile.mkstemp(prefix=".forge-inventory.", dir=str(parent))
    tmp = Path(tmp_name)
    try:
        os.chmod(tmp, 0o600)
        with os.fdopen(fd, "wb") as handle:
            offset = 0
            while offset < len(payload):
                offset += handle.write(payload[offset:])
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(tmp_name, str(path))
        except FileExistsError as exc:
            raise FileExistsError(str(path)) from exc
        finally:
            os.unlink(tmp_name)
    except Exception:
        if tmp.exists():
            os.unlink(tmp_name)
        raise
    dir_fd = os.open(str(parent), os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def _refuse(reason):
    print("forge-inventory: %s" % reason, file=sys.stderr)
    return 1


def _print_summary(report, output):
    local = report["local_selection"]
    live = report["observed_live"]
    files = live.get("files")
    lines = [
        "files=%s" % len(local["files"]),
        "slug_index_html=%s" % len(local["slug_index_html"]),
        "tree_candidates=%s" % len(local["tree_candidates"]),
        "live_files=%s" % (0 if not isinstance(files, dict) else len(files)),
        "history_pages=%s" % live["history"]["pages_read"],
        "kv_keys=%s" % live["kv"]["key_count"],
        "complete=%s" % ("true" if report["complete"] else "false"),
        "output=%s" % output,
    ]
    print(" ".join(lines))


def main(argv=None):
    parser = argparse.ArgumentParser(prog="forge-inventory.py", add_help=False)
    parser.add_argument("--config", required=True)
    parser.add_argument("--env", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--without-history", action="store_true")
    parser.add_argument("--local-only", action="store_true")
    try:
        args = parser.parse_args([] if argv is None else argv)
    except SystemExit:
        print("forge-inventory: usage", file=sys.stderr)
        raise SystemExit(1)
    output = Path(args.output)
    if _inside_git(output):
        return _refuse("output is inside a git worktree")
    if output.exists() or output.is_symlink():
        return _refuse("output already exists")
    try:
        config = _read_config_file(Path(args.config))
    except ConfigError:
        return _refuse("config is unreadable")
    try:
        env = _read_env_file(Path(args.env))
    except ConfigError:
        return _refuse("env is unreadable")
    except EnvSyntaxError:
        return _refuse("env syntax is unexpected")
    token = env.get("CLOUDFLARE_API_TOKEN")
    history = not args.without_history
    if args.local_only or not token:
        getter = lambda _path: (_ for _ in ()).throw(CredentialMissing())
        report = collect_inventory(
            config,
            env,
            getter,
            include_history=history,
            local_only=True,
        )
        if not args.local_only:
            for item in report["issues"]:
                if item["code"] == "local_only":
                    item["code"] = "config_missing"
                    item["detail"] = "credential missing"
            report["complete"] = False
    else:
        report = collect_inventory(
            config,
            env,
            production_get(token),
            include_history=history,
            local_only=False,
        )
    payload = json.dumps(report, indent=2, sort_keys=True).encode("utf-8") + b"\n"
    try:
        _write_private(output, payload)
    except FileExistsError:
        return _refuse("output already exists")
    except OSError:
        return _refuse("output is unreadable")
    codes = {item["code"] for item in report["issues"]}
    if not codes or codes == {"local_only"}:
        _print_summary(report, output)
        return 0
    _print_summary(report, output)
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
