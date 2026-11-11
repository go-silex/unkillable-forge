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
_LIVE_PAGE = re.compile(r"^/a/([^/]+)/.+")
_PUBLIC_SHELL = frozenset((
    "/",
    "/index.html",
    "/login",
    "/login.html",
    "/robots.txt",
    "/favicon.ico",
    "/favicon.svg",
    "/favicon-32.png",
    "/apple-touch-icon.png",
))
_ENGINE_PAGE = frozenset(("404.html", "index.html", "login.html"))
_TREE_HTML = re.compile(r"^/[A-Za-z0-9._/-]+\.html$")
_TREE_DIR = re.compile(r"^/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*/$")
_TREE_BARE = re.compile(r"^/[A-Za-z0-9._/-]+$")
_PAGE_RE = re.compile(
    r"^(?!.*\.\.)[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*\.html$"
)

_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


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


def _scrub_text(text, paths, secrets):
    for secret in secrets:
        if secret and secret in text:
            text = text.replace(secret, "[redacted]")
    for path in paths:
        if path and path in text:
            text = text.replace(path, "[redacted]")
    return text


def _put_scrubbed(out, key, value, paths, secrets, collisions):
    """Store one mapping without dropping a redacted key on collision."""
    if not isinstance(key, str):
        if key in out:
            collisions.append(True)
            return
        out[key] = value
        return
    scrubbed = _scrub_text(key, paths, secrets)
    if scrubbed == key:
        chosen = key
    else:
        digest = hashlib.sha256(
            key.encode("utf-8", "surrogateescape")
        ).hexdigest()
        chosen = scrubbed + "#" + digest
    if chosen in out:
        collisions.append(True)
        suffix = 2
        while chosen + "#" + str(suffix) in out:
            suffix += 1
            if suffix > 1000:
                return
        chosen = chosen + "#" + str(suffix)
    out[chosen] = value


def _scrub(obj, paths, secrets, collisions=None):
    """Scrub every string. A key name such as sha256 is not an exemption."""
    if collisions is None:
        collisions = []
    if isinstance(obj, str):
        return _scrub_text(obj, paths, secrets)
    if isinstance(obj, list):
        return [_scrub(item, paths, secrets, collisions) for item in obj]
    if isinstance(obj, dict):
        out = {}
        for key, value in obj.items():
            _put_scrubbed(
                out,
                key,
                _scrub(value, paths, secrets, collisions),
                paths,
                secrets,
                collisions,
            )
        return out
    return obj


def _canonical_dir(path):
    """Resolve a configured directory once, including a trusted root alias."""
    raw = os.path.realpath(os.path.expanduser(str(path)))
    if not raw or not os.path.isdir(raw):
        raise OSError("not a directory")
    return raw


def _open_resolved(raw):
    """Open an already-canonical directory without following any component."""
    parts = [part for part in raw.split("/") if part]
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts:
            if part in (".", "..") or "/" in part or "\0" in part:
                raise OSError("path component is not a real directory")
            nxt = os.open(part, _DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = nxt
        if not stat.S_ISDIR(os.fstat(fd).st_mode):
            raise OSError("not a directory")
        return fd
    except Exception:
        os.close(fd)
        raise


def _open_dir_abs(path):
    """Resolve the configured root once, then bind it without following."""
    raw = _canonical_dir(path)
    return _open_resolved(raw), raw


def _lexical_inside(hub, root):
    try:
        return os.path.commonpath([hub, root]) == hub
    except ValueError:
        return False


def _open_rel(root_fd, rel):
    if not rel or rel == ".":
        return os.dup(root_fd)
    fd = os.dup(root_fd)
    try:
        for part in rel.split("/"):
            if not part or part == ".":
                continue
            if part == ".." or "/" in part or "\0" in part:
                raise OSError("path escapes the artifacts root")
            nxt = os.open(part, _DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except Exception:
        os.close(fd)
        raise


def _compose_link(root_path, parent_rel, raw):
    """Lexically join a readlink result. None means the target leaves the root."""
    if os.path.isabs(raw):
        target = os.path.normpath(raw)
        if not _lexical_inside(root_path, target):
            return None
        rel = os.path.relpath(target, root_path).replace(os.sep, "/")
    else:
        base = "" if parent_rel in ("", ".") else parent_rel
        rel = os.path.normpath(os.path.join(base, raw) if base else raw).replace(
            os.sep, "/"
        )
    if rel.startswith("../") or rel == ".." or os.path.isabs(rel):
        return None
    return rel


def _link_parts(key):
    if key in ("", "."):
        return []
    return [part for part in key.split("/") if part not in ("", ".")]


def _link_target(root_fd, root_path, key, seen):
    """Readlink key. Intermediate directory aliases are resolved, not opened."""
    remaining = _link_parts(key)
    if not remaining:
        return "broken", None
    for _ in range(64):
        fd = os.dup(root_fd)
        try:
            restarted = False
            for index, name in enumerate(remaining):
                if name in (".", "..") or "/" in name or "\0" in name:
                    return "external", None
                try:
                    info = os.lstat(name, dir_fd=fd)
                except OSError:
                    return "broken", None
                last = index == len(remaining) - 1
                if stat.S_ISLNK(info.st_mode):
                    try:
                        raw = os.readlink(name, dir_fd=fd)
                    except OSError:
                        return "broken", None
                    parent = "/".join(remaining[:index])
                    nxt = _compose_link(root_path, parent, raw)
                    if nxt is None:
                        return "external", None
                    if last:
                        return "link", nxt
                    tail = remaining[index + 1 :]
                    joined = nxt if not tail else nxt + "/" + "/".join(tail)
                    joined = os.path.normpath(joined).replace(os.sep, "/")
                    if (
                        joined.startswith("../")
                        or joined == ".."
                        or os.path.isabs(joined)
                    ):
                        return "external", None
                    if joined in seen:
                        return "cycle", None
                    seen.add(joined)
                    remaining = _link_parts(joined)
                    if not remaining:
                        return "broken", None
                    restarted = True
                    break
                if last:
                    return "internal", None
                if not stat.S_ISDIR(info.st_mode):
                    return "broken", None
                try:
                    nxt_fd = os.open(name, _DIR_FLAGS, dir_fd=fd)
                except OSError:
                    return "broken", None
                os.close(fd)
                fd = nxt_fd
            if not restarted:
                return "broken", None
        finally:
            os.close(fd)
    return "cycle", None


def _classify_link(root_fd, root_path, rel):
    """Classify a symlink by readlink only. Targets are not opened or hashed."""
    seen = set()
    current = rel.replace(os.sep, "/")
    for _ in range(64):
        key = os.path.normpath(current).replace(os.sep, "/")
        if key.startswith("../") or key == ".." or os.path.isabs(key):
            return "external"
        if key in seen:
            return "cycle"
        seen.add(key)
        kind, nxt = _link_target(root_fd, root_path, key, seen)
        if kind != "link":
            return kind
        current = nxt
    return "cycle"


def _collapse_ws(text, pending):
    out = []
    for char in text:
        if char.isspace():
            if not pending:
                out.append(" ")
                pending = True
            continue
        pending = False
        out.append(char)
    return "".join(out), pending


def _apply_flags(text, flags, host_re, final):
    """Commit a match only when its right context is real or this is EOF.

    A match that ends on the last character of a non-final window is deferred.
    End-of-string is not right context for a word boundary or a lookahead.
    """
    checks = (
        ("existing_base", _BASE_RE),
        ("root_relative_fetch", _FETCH_RE),
        ("location_href", _LOC_RE),
        ("hardcoded_host", host_re),
    )
    deferred = None
    for key, pattern in checks:
        if pattern is None or flags[key]:
            continue
        match = pattern.search(text)
        if match is None:
            continue
        if not final and match.end() == len(text):
            start = match.start()
            deferred = start if deferred is None else min(deferred, start)
            continue
        flags[key] = True
    return deferred

def _consume_regular(fd, host, scan):
    """Hash one regular file descriptor. HTML flags use the same read."""
    digest = hashlib.sha256()
    flags = None
    host_re = None
    decoder = None
    carry = ""
    pending = False
    tail = 64
    if scan:
        flags = {key: False for key in FLAG_KEYS}
        if host:
            host_re = re.compile(
                r"(?<![A-Za-z0-9.-])" + re.escape(host) + r"(?![A-Za-z0-9.-])",
                re.IGNORECASE,
            )
            tail = max(tail, len(host) + 8)
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
    while True:
        chunk = os.read(fd, _CHUNK)
        final = not chunk
        if chunk:
            digest.update(chunk)
        if scan:
            text, pending = _collapse_ws(decoder.decode(chunk, final=final), pending)
            window = carry + text
            deferred = _apply_flags(window, flags, host_re, final)
            start = len(window)
            if deferred is not None:
                start = min(start, max(0, deferred - 1))
            if len(window) > tail:
                start = min(start, len(window) - tail)
            else:
                start = 0
            carry = window[start:]
        if final:
            break
    return digest.hexdigest(), flags


def _rel_name(dirpath, name):
    base = dirpath.replace(os.sep, "/")
    if base in (".", ""):
        base = ""
    elif base.startswith("./"):
        base = base[2:]
    if not base:
        return name
    return base + "/" + name


def _bad_name(name):
    return (
        not name
        or name in (".", "..")
        or "/" in name
        or "\0" in name
    )


def _symlink_row(rel, info, root_fd, root_path):
    return {
        "path": rel,
        "size": int(info.st_size),
        "sha256": None,
        "symlink": True,
        "diagnostic": _classify_link(root_fd, root_path, rel),
    }


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
    if not hasattr(os, "fwalk"):
        _issue(issues, "unreadable", "artifacts root is unreadable")
        return selection, scrub_paths
    try:
        hub_fd, hub = _open_dir_abs(hub_text)
    except OSError:
        _issue(issues, "unreadable", "artifacts root is unreadable")
        return selection, scrub_paths
    os.close(hub_fd)
    scrub_paths.append(hub)
    configured_hub = os.path.abspath(os.path.expanduser(hub_text))
    if configured_hub != hub:
        scrub_paths.append(configured_hub)
    art_path = os.path.expanduser(art_text)
    if not os.path.isabs(art_path):
        art_path = os.path.join(hub, art_path)
    try:
        root_fd, root = _open_dir_abs(art_path)
    except OSError:
        _issue(issues, "unreadable", "artifacts root is unreadable")
        return selection, scrub_paths
    scrub_paths.append(root)
    if not _lexical_inside(hub, root):
        os.close(root_fd)
        _issue(issues, "unreadable", "artifacts root is outside the hub")
        return selection, scrub_paths

    files = []
    slugs = []
    trees = []
    flag_rows = []
    entry_error = False
    yielded = False

    def onerror(_err):
        nonlocal entry_error
        entry_error = True

    try:
        for dirpath, dirnames, filenames, dirfd in os.fwalk(
            ".",
            topdown=True,
            onerror=onerror,
            follow_symlinks=False,
            dir_fd=root_fd,
        ):
            yielded = True
            if dirpath in (".", ""):
                for name in dirnames:
                    if _bad_name(name) or name.startswith("."):
                        continue
                    try:
                        info = os.lstat(name, dir_fd=dirfd)
                    except OSError:
                        continue
                    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                        continue
                    try:
                        child = os.open(name, _DIR_FLAGS, dir_fd=dirfd)
                    except OSError:
                        continue
                    try:
                        index = os.lstat("index.html", dir_fd=child)
                    except OSError:
                        continue
                    finally:
                        os.close(child)
                    if stat.S_ISREG(index.st_mode) or stat.S_ISLNK(index.st_mode):
                        slugs.append(name)
            for name in dirnames:
                if _bad_name(name):
                    entry_error = True
                    continue
                rel = _rel_name(dirpath, name)
                try:
                    info = os.lstat(name, dir_fd=dirfd)
                except OSError:
                    entry_error = True
                    files.append(
                        {
                            "path": rel,
                            "size": 0,
                            "sha256": None,
                            "symlink": False,
                            "diagnostic": "unreadable",
                        }
                    )
                    continue
                if stat.S_ISLNK(info.st_mode):
                    files.append(_symlink_row(rel, info, root_fd, root))
            for name in filenames:
                if _bad_name(name):
                    entry_error = True
                    continue
                rel = _rel_name(dirpath, name)
                try:
                    info = os.lstat(name, dir_fd=dirfd)
                except OSError:
                    entry_error = True
                    files.append(
                        {
                            "path": rel,
                            "size": 0,
                            "sha256": None,
                            "symlink": False,
                            "diagnostic": "unreadable",
                        }
                    )
                    continue
                if stat.S_ISLNK(info.st_mode):
                    files.append(_symlink_row(rel, info, root_fd, root))
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
                try:
                    file_fd = os.open(
                        name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dirfd
                    )
                except OSError:
                    entry_error = True
                    files.append(
                        {
                            "path": rel,
                            "size": int(info.st_size),
                            "sha256": None,
                            "symlink": False,
                            "diagnostic": "unreadable",
                        }
                    )
                    continue
                try:
                    held = os.fstat(file_fd)
                    if not stat.S_ISREG(held.st_mode):
                        entry_error = True
                        files.append(
                            {
                                "path": rel,
                                "size": int(info.st_size),
                                "sha256": None,
                                "symlink": False,
                                "diagnostic": "unreadable",
                            }
                        )
                        continue
                    lowered = name.lower()
                    scan = lowered.endswith(".html") or lowered.endswith(".htm")
                    digest, scanned = _consume_regular(file_fd, host or "", scan)
                except OSError:
                    entry_error = True
                    files.append(
                        {
                            "path": rel,
                            "size": int(info.st_size),
                            "sha256": None,
                            "symlink": False,
                            "diagnostic": "unreadable",
                        }
                    )
                    continue
                finally:
                    os.close(file_fd)
                files.append(
                    {
                        "path": rel,
                        "size": int(held.st_size),
                        "sha256": digest,
                        "symlink": False,
                        "diagnostic": None,
                    }
                )
                if scan:
                    trees.append(rel)
                    flag_rows.append({"path": rel, **scanned})
    finally:
        os.close(root_fd)

    if not yielded:
        entry_error = True
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
    """A listed key is not present until its value GET returns 200."""
    vis_values = {}
    vis_present = set()
    share_present = set()
    listed_ids = set()
    shares = []
    snapshot_body = None
    snapshot_seen = False
    for item in observed["kv"]["keys"]:
        name = item["name"]
        page_id = name.split(":", 1)[1] if ":" in name else ""
        if (name.startswith("vis:") or name.startswith("share:")) and page_id:
            listed_ids.add(page_id)
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
        if status != 200 or not isinstance(body, bytes):
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
            if page_id:
                share_present.add(page_id)
        elif name.startswith("vis:"):
            try:
                text = body.decode("utf-8")
            except UnicodeError:
                _issue(issues, "unreadable", "visibility value unreadable")
                continue
            vis_values[page_id] = text
            vis_present.add(page_id)
        elif name == SNAPSHOT_KEY:
            snapshot_seen = True
            snapshot_body = body
    observed["shares"] = sorted(shares, key=lambda item: item["name"])
    observed["_vis_values"] = vis_values
    observed["_vis_present"] = vis_present
    observed["_share_present"] = share_present
    observed["_listed_ids"] = listed_ids
    observed["_snapshot_body"] = snapshot_body
    observed["_snapshot_seen"] = snapshot_seen


def _kv_list_cursor(payload, issues):
    """Return ('end', None), ('next', cursor), or ('bad', None).

    Primary list-keys contract: result_info is an optional object
    {count?, cursor?}. cursor is an optional string and is not nullable.
    Absence of result_info, or of cursor inside that object, is a verified
    end. A present null, a non-object result_info, or a non-string cursor
    is not an end. A string cursor is returned unchanged.
    """
    if "result_info" not in payload:
        return "end", None
    info = payload["result_info"]
    if not isinstance(info, dict):
        _issue(issues, "pagination_incomplete", "kv list did not terminate")
        return "bad", None
    if "cursor" not in info:
        return "end", None
    nxt = info["cursor"]
    if not isinstance(nxt, str):
        _issue(issues, "pagination_incomplete", "kv list did not terminate")
        return "bad", None
    return "next", nxt


def _read_kv(get, account, namespace, observed, issues, secrets):
    keys = []
    seen_cursors = set()
    cursor = None
    for _ in range(_PAGE_CAP):
        path = "/accounts/%s/storage/kv/namespaces/%s/keys" % (
            _quote(account),
            _quote(namespace),
        )
        if cursor is not None:
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
        kind, nxt = _kv_list_cursor(payload, issues)
        if kind == "bad":
            return False
        if kind == "end":
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


def _page_id_ok(slug):
    return (
        isinstance(slug, str)
        and bool(slug)
        and slug not in (".", "..")
        and not slug.startswith(".")
        and "/" not in slug
        and "\0" not in slug
    )


def _layout_tree(config):
    return isinstance(config, dict) and config.get("layout") == "tree"


def _tree_page_id(path):
    """Roxabi treePageId, then the stored PAGE_RE. Engine HTML is not an id."""
    if not isinstance(path, str) or ".." in path or path in _PUBLIC_SHELL:
        return None
    if path.startswith("/api/") or path.startswith("/s/") or path.startswith("/a/"):
        return None
    if path.endswith(".html"):
        ident = path[1:] if _TREE_HTML.match(path) else None
    elif path.endswith("/"):
        ident = (path[1:] + "index.html") if _TREE_DIR.match(path) else None
    else:
        last = path[path.rfind("/") + 1 :]
        if not last or "." in last or _TREE_BARE.match(path) is None:
            return None
        ident = path[1:] + ".html"
    if (
        not ident
        or ident in _ENGINE_PAGE
        or _PAGE_RE.match(ident) is None
    ):
        return None
    return ident


def _known_page_ids(config, local, files):
    ids = set()
    tree = _layout_tree(config)
    if tree:
        for path in local.get("tree_candidates") or []:
            if (
                not isinstance(path, str)
                or not path
                or path.startswith("/")
                or "\\" in path
            ):
                continue
            ident = _tree_page_id("/" + path)
            if ident:
                ids.add(ident)
    else:
        for name in local.get("slug_index_html") or []:
            if _page_id_ok(name):
                ids.add(name)
        for path in local.get("tree_candidates") or []:
            if not isinstance(path, str) or "/" not in path:
                continue
            slug = path.split("/", 1)[0]
            if _page_id_ok(slug):
                ids.add(slug)
    if isinstance(files, dict):
        for path in files:
            if not isinstance(path, str):
                continue
            match = _LIVE_PAGE.match(path)
            if match is not None and _page_id_ok(match.group(1)):
                ids.add(match.group(1))
                continue
            if not tree:
                continue
            request = path if path.startswith("/") else "/" + path
            ident = _tree_page_id(request)
            if ident:
                ids.add(ident)
    return ids


def _visibility_id_ok(page_id):
    if page_id in _ENGINE_PAGE:
        return False
    if _page_id_ok(page_id):
        return True
    return isinstance(page_id, str) and _PAGE_RE.match(page_id) is not None


def _classify(observed, known_ids, issues):
    vis_values = observed.pop("_vis_values", {})
    vis_present = observed.pop("_vis_present", set())
    share_present = observed.pop("_share_present", set())
    listed_ids = observed.pop("_listed_ids", set())
    ids = set(known_ids) | set(listed_ids) | set(vis_present) | set(share_present)
    rows = []
    for page_id in sorted(ids):
        if not _visibility_id_ok(page_id):
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
                "vis_present": page_id in vis_present,
                "share_present": page_id in share_present,
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
                        _known_page_ids(config, local, observed.get("files")),
                        issues,
                    )
    if not include_history or local_only:
        observed["history"]["skipped"] = True
    for private_key in (
        "_vis_values",
        "_vis_present",
        "_share_present",
        "_share_ids",
        "_listed_ids",
        "_snapshot_body",
        "_snapshot_seen",
    ):
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
    collisions = []
    report = _scrub(
        report, [path for path in scrub_paths if path], secrets, collisions
    )
    if collisions:
        _issue(report["issues"], "unreadable", "redacted key collision")
        report["complete"] = False
    return report


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


class OutputRefused(Exception):
    """Output path is not a safe private file. The message is fixed."""

    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


def _fd_has_git(dir_fd):
    cur = os.dup(dir_fd)
    try:
        while True:
            try:
                os.lstat(".git", dir_fd=cur)
                return True
            except OSError:
                pass
            try:
                parent = os.open("..", _DIR_FLAGS, dir_fd=cur)
            except OSError:
                return True
            try:
                if os.path.samestat(os.fstat(cur), os.fstat(parent)):
                    return False
            except OSError:
                os.close(parent)
                return True
            os.close(cur)
            cur = parent
    finally:
        try:
            os.close(cur)
        except OSError:
            pass


def _open_parent_nofollow(parent):
    """Resolve the output parent once, refuse a worktree, then bind no-follow."""
    expanded = os.path.expanduser(str(parent))
    raw = os.path.realpath(expanded)
    if os.path.isdir(raw):
        if _inside_git(Path(raw)):
            raise OutputRefused("output is inside a git worktree")
        return _open_resolved(raw)
    existing = raw
    missing = []
    while existing and existing != os.path.dirname(existing):
        if os.path.isdir(existing):
            break
        existing, name = os.path.split(existing)
        if not name:
            break
        missing.append(name)
    if not existing or not os.path.isdir(existing):
        raise OSError("not a directory")
    if _inside_git(Path(existing)):
        raise OutputRefused("output is inside a git worktree")
    fd = _open_resolved(existing)
    try:
        for name in reversed(missing):
            if name in (".", "..") or "/" in name or "\0" in name:
                raise OSError("path component is not a real directory")
            os.mkdir(name, 0o700, dir_fd=fd)
            os.chmod(name, 0o700, dir_fd=fd, follow_symlinks=False)
            nxt = os.open(name, _DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except Exception:
        os.close(fd)
        raise


def _write_private(path, payload):
    name = path.name
    if not name or name in (".", "..") or "/" in name or "\0" in name:
        raise OutputRefused("output is unreadable")
    try:
        parent_fd = _open_parent_nofollow(path.parent)
    except OutputRefused:
        raise
    except OSError as exc:
        raise OutputRefused("output is unreadable") from exc
    tmp_name = None
    try:
        if _fd_has_git(parent_fd):
            raise OutputRefused("output is inside a git worktree")
        try:
            os.lstat(name, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        else:
            raise FileExistsError(name)
        fd = None
        for _ in range(8):
            candidate = ".forge-inventory." + os.urandom(8).hex()
            try:
                fd = os.open(
                    candidate,
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
                    0o600,
                    dir_fd=parent_fd,
                )
            except FileExistsError:
                continue
            tmp_name = candidate
            break
        if fd is None:
            raise OutputRefused("output is unreadable")
        try:
            offset = 0
            while offset < len(payload):
                wrote = os.write(fd, payload[offset:])
                if wrote <= 0:
                    raise OSError("short write")
                offset += wrote
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            os.link(
                tmp_name,
                name,
                src_dir_fd=parent_fd,
                dst_dir_fd=parent_fd,
                follow_symlinks=False,
            )
        except FileExistsError as exc:
            raise FileExistsError(name) from exc
        os.fsync(parent_fd)
    finally:
        if tmp_name is not None:
            try:
                os.unlink(tmp_name, dir_fd=parent_fd)
            except OSError:
                pass
        os.close(parent_fd)


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
    except OutputRefused as exc:
        return _refuse(exc.reason)
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
