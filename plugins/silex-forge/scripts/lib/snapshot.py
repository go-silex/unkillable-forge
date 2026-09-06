#!/usr/bin/env python3
"""Fingerprint the local artifact hub and guard a forge deploy against stale-hub deletions.

Why this exists: a forge publish deploys a FULL snapshot of the Pages project,
built from the LOCAL artifact hub -- a directory that must be shared between
everyone who publishes to this forge, by whatever sync mechanism the operator
chose. No mechanism is assumed, and none of them gives cross-machine locking.
A hub copy that is behind therefore deploys a site missing the artifacts a
teammate published in the meantime, and Pages replaces the whole site, so
those artifacts silently disappear from production.

The Cloudflare Pages API exposes no per-file manifest for a deployment (the
project payload carries `canonical_deployment` / `latest_deployment` and nothing
that lists files), so we cannot ask Cloudflare what is live. Instead we keep our
own fingerprint record in the existing KV namespace and anchor its
trustworthiness on the live deployment id: a record written for a different
deployment id no longer describes what is live (rollback, or a deploy made
out of band from the dashboard), so compare refuses (exit 4) until
`--allow-unverified`. Unexpected removals still outrank that (exit 3).

Subcommands -- JSON on stdout, human-readable lines on stderr:

  fingerprint      per-slug sha256 of the local hub
  live-deployment  id + engine commit of the live Pages deployment
  compare          record vs local hub -> verdict (+ exit 3 on unexpected
                   removals, exit 4 when the live content cannot be verified)
  record           the JSON record to store in KV after a successful deploy
  reanchor         re-point an existing record at another deployment id,
                   keeping its slug set verbatim

`reanchor` exists because the record conflates two independent facts: WHAT is
live (the slug set) and WHICH deployment it describes (the anchor). A refused
KV write after a successful deploy breaks only the anchor, and rebuilding the
record with `record` would re-derive the slug set from a hub that may itself
be behind -- exactly the deletion this guard exists to prevent. Re-anchoring
keeps the baseline and costs one command instead of `--allow-unverified`.

Exit codes: 0 = safe to deploy, 3 = unexpected removals (the caller refuses),
4 = cannot verify what is live (no/unreadable record, live lookup failed, or
record anchored on another deployment), 1 = usage or internal error -- which
for `reanchor` also covers a record it refuses to invent (empty, not an
object, or carrying no slug map) and an empty deployment id.
`live-deployment` exits 0 even when the lookup fails: the caller decides what
an unknown live deployment means. It claims `no_deployment` only for a project
whose deployment list is confirmed empty; an unresolvable latest deployment is
`live_unresolved`, which the caller must read as unknown, never as empty.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shlex
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_LIB = Path(__file__).resolve().parent
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from load_config import (  # noqa: E402
    _cf_api,
    artifacts_root,
    load_config,
    resolve_api_token,
    resolved_account_id,
)

# Sync noise, never part of an artifact's state.
SKIP_NAMES = frozenset({".DS_Store", "Thumbs.db", "__pycache__"})

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_REMOVALS = 3
EXIT_UNVERIFIED = 4


def _say(line: str) -> None:
    print(line, file=sys.stderr)


def _emit(payload: dict[str, Any]) -> None:
    """One JSON line on stdout -- consumed by publish.sh and by a KV put."""
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))


def _quoted(path: Path | None) -> str:
    """Shell-pasteable path for a remedy line, or a placeholder when unresolved."""
    return shlex.quote(str(path)) if path is not None else "<artifacts-root>"


# ---------------------------------------------------------------- fingerprint


def slug_dirs(root: Path) -> list[Path]:
    """Immediate subdirectories holding an index.html, sorted by name.

    Same selection rule as build-site-from-hub.py: a directory without
    index.html is not deployable, and dotted directories are hub-local
    (.obsidian, .git, Drive scratch), so neither is part of the snapshot.
    """
    out: list[Path] = []
    for child in sorted(root.iterdir(), key=lambda p: p.name):
        if not child.is_dir() or child.name.startswith("."):
            continue
        if not (child / "index.html").is_file():
            continue
        out.append(child)
    return out


def _slug_files(slug_dir: Path) -> list[tuple[str, Path]]:
    """(relative posix path, path) for every hashable file under a slug, sorted.

    meta.json is included on purpose: it is part of the artifact's state (title,
    type, client, share intent), so editing it must change the slug digest even
    though build-site-from-hub.py copies it into registry/ instead of site/.
    """
    out: list[tuple[str, Path]] = []
    for path in slug_dir.rglob("*"):
        rel = path.relative_to(slug_dir)
        if any(part in SKIP_NAMES for part in rel.parts):
            continue
        if not path.is_file():
            continue
        out.append((rel.as_posix(), path))
    out.sort(key=lambda item: item[0])
    return out


def slug_digest(slug_dir: Path) -> str:
    """sha256 over the sorted (relative path, bytes) pairs of the slug.

    The relative path is fed into the digest next to the bytes, so a rename
    inside an artifact is a change; and because the path is relative to the
    slug directory, two teammates whose hubs live at different absolute paths
    compute the same digest for the same content.
    """
    h = hashlib.sha256()
    for rel, path in _slug_files(slug_dir):
        data = path.read_bytes()
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(str(len(data)).encode("ascii"))
        h.update(b"\0")
        h.update(data)
    return h.hexdigest()


def fingerprint(root: Path) -> dict[str, str]:
    """{slug: sha256hex} for the whole artifacts root."""
    return {d.name: slug_digest(d) for d in slug_dirs(root)}


def _local_fingerprint() -> tuple[dict[str, str], Path | None, str]:
    """(slugs, artifacts root, error). Error is non-empty when the root is unusable.

    The root travels with the result so the removal guard can name the exact
    directory the operator has to re-sync.
    """
    try:
        cfg = load_config()
    except SystemExit as exc:  # missing packaged defaults
        return {}, None, f"cannot load config: {exc}"
    root = artifacts_root(cfg)
    if root is None:
        return {}, None, "artifacts root unresolved: set hub_root and artifacts_dir (forge-setup)"
    if not root.is_dir():
        return {}, root, f"artifacts root missing: {root} -- forge-setup?"
    try:
        return fingerprint(root), root, ""
    except OSError as exc:
        return {}, root, f"cannot read artifacts root {root}: {exc}"


def cmd_fingerprint(_args: argparse.Namespace) -> int:
    slugs, _root, err = _local_fingerprint()
    if err:
        _say(f"✗ {err}")
        _emit({"ok": False, "error": err})
        return EXIT_ERROR
    _emit({"ok": True, "count": len(slugs), "slugs": slugs})
    _say(f"fingerprinted {len(slugs)} slug(s)")
    return EXIT_OK


# ------------------------------------------------------------ live deployment


def _confirm_no_deployment(acct: str, project: str, token: str) -> dict[str, Any]:
    """Verify that a project without a `latest_deployment.id` is genuinely empty.

    `no_deployment` is the one live state the caller may bootstrap from, and
    bootstrap is the one verdict that lets an unrestricted full-snapshot deploy
    through with no record at all. Inferring it from a single nullable field in
    the project payload makes the blast radius of one absent field total, so
    confirm emptiness against the deployments list instead. Anything the list
    does not prove empty -- deployments present, or a list we cannot read -- is
    an unresolved live deployment, which the caller must treat as unknown.
    """
    code, data, err = _cf_api(
        "GET",
        f"/accounts/{acct}/pages/projects/{project}/deployments?per_page=1",
        token,
    )
    if code == 200 and data and data.get("success"):
        result = data.get("result")
        if isinstance(result, list) and not result:
            return {
                "ok": False,
                "error_kind": "no_deployment",
                "error": f"Pages project {project} has no deployment yet",
            }
        return {
            "ok": False,
            "error_kind": "live_unresolved",
            "error": (
                f"Pages project {project} has deployments but no resolvable "
                "latest one -- live content cannot be assumed empty"
            ),
        }
    detail = err or f"HTTP {code}"
    return {
        "ok": False,
        "error_kind": "live_unresolved",
        "error": (
            f"Pages project {project} reports no latest deployment and its "
            f"deployment list is unreadable ({detail})"
        ),
    }


def live_deployment(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    """Live Pages deployment id + engine commit, or a structured failure.

    Never returns or logs the API token.
    """
    cfg = cfg or load_config()
    project = str(cfg.get("pages_project") or "silex-forge")
    token = resolve_api_token()
    if not token:
        return {
            "ok": False,
            "error_kind": "auth_missing",
            "error": "CLOUDFLARE_API_TOKEN missing",
        }
    acct = resolved_account_id(cfg)
    if not acct:
        return {
            "ok": False,
            "error_kind": "auth_missing",
            "error": "CLOUDFLARE_ACCOUNT_ID missing",
        }
    code, data, err = _cf_api(
        "GET", f"/accounts/{acct}/pages/projects/{project}", token
    )
    if code == 0:
        return {
            "ok": False,
            "error_kind": "unreachable",
            "error": err or "network error",
        }
    if code != 200 or not data or not data.get("success"):
        errors = (data or {}).get("errors") or [{}]
        first = errors[0] if isinstance(errors[0], dict) else {}
        return {
            "ok": False,
            "error_kind": "api_error",
            "error": str(first.get("message") or err or f"HTTP {code}"),
        }
    latest = (data.get("result") or {}).get("latest_deployment") or {}
    dep_id = str(latest.get("id") or "")
    trigger = latest.get("deployment_trigger") or {}
    meta = trigger.get("metadata") or {}
    commit = str(meta.get("commit_hash") or "")
    if not dep_id:
        return _confirm_no_deployment(acct, project, token)
    return {"ok": True, "deployment_id": dep_id, "engine_commit": commit}


def cmd_live_deployment(_args: argparse.Namespace) -> int:
    result = live_deployment()
    _emit(result)
    if result["ok"]:
        _say(
            "live deployment {} (engine commit {})".format(
                result["deployment_id"], result["engine_commit"] or "unset"
            )
        )
    else:
        _say(
            "! live deployment unknown ({}): {}".format(
                result["error_kind"], result["error"]
            )
        )
        _say("! the stale-hub guard cannot anchor its record on a live deployment")
    # Exit 0 in both cases: whether an unknown live deployment blocks a publish
    # is the caller's policy, not ours.
    return EXIT_OK


# -------------------------------------------------------------------- compare


def parse_expected_removals(raw: str) -> list[str]:
    """Split a whitespace- or comma-separated slug list, deduplicated and sorted."""
    return sorted({tok for tok in raw.replace(",", " ").split() if tok})


def load_record(spec: str) -> tuple[dict[str, Any], str]:
    """(record, error). '-' reads stdin; empty content or JSON null is an empty record.

    A missing file is an error, not an empty record: a wrong path would
    otherwise disable the removal guard without anyone noticing. A KV miss is
    expressed by piping empty input through '-'.
    """
    if spec == "-":
        raw = sys.stdin.read()
    else:
        try:
            raw = Path(spec).expanduser().read_text(encoding="utf-8")
        except OSError as exc:
            return {}, f"cannot read record {spec}: {exc}"
    text = raw.strip()
    if not text or text == "null":
        return {}, ""
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        return {}, f"record is not valid JSON: {exc}"
    if data is None:
        return {}, ""
    if not isinstance(data, dict):
        return {}, "record must be a JSON object"
    return data, ""


def compare_record(
    record: dict[str, Any],
    local: dict[str, str],
    live_deployment_id: str,
    expected_removals: list[str],
    live_unknown: bool = False,
) -> dict[str, Any]:
    """Classify the local hub against a fingerprint record.

    `verifiable` is false when the live content cannot be determined
    (`unverified`) or the record is anchored on another deployment
    (`untrusted`). `ok` is safe-to-deploy: false when there are unexpected
    removals or the result is not verifiable. `verdict` names the strongest
    concern, and an unverifiable state outranks its own removal list in that
    field -- the removals are still reported, because an out-of-date record
    plus missing artifacts is the very situation that loses other people's
    work.
    """
    raw_slugs = record.get("slugs")
    recorded: dict[str, str] = {}
    if isinstance(raw_slugs, dict):
        recorded = {str(k): str(v) for k, v in raw_slugs.items()}
    record_deployment_id = str(record.get("deployment_id") or "")

    removals = sorted(slug for slug in recorded if slug not in local)
    expected = set(expected_removals)
    unexpected = [slug for slug in removals if slug not in expected]
    additions = sorted(slug for slug in local if slug not in recorded)
    changed = sorted(
        slug for slug, digest in local.items()
        if slug in recorded and recorded[slug] != digest
    )

    if not recorded:
        if (not live_unknown) and live_deployment_id == "":
            verdict = "bootstrap"
        else:
            verdict = "unverified"
    elif live_unknown:
        verdict = "unverified"
    elif record_deployment_id != live_deployment_id:
        verdict = "untrusted"
    elif unexpected:
        verdict = "removals"
    elif removals or additions or changed:
        verdict = "drift"
    else:
        verdict = "match"

    verifiable = verdict not in ("unverified", "untrusted")
    return {
        "ok": not unexpected and verifiable,
        "verifiable": verifiable,
        "live_unknown": bool(live_unknown),
        "verdict": verdict,
        "removals": removals,
        "unexpected_removals": unexpected,
        "additions": additions,
        "changed": changed,
        "record_deployment_id": record_deployment_id,
        "live_deployment_id": live_deployment_id,
    }


def _narrate(result: dict[str, Any], root: Path | None) -> None:
    verdict = result["verdict"]
    if verdict == "bootstrap":
        _say(
            "no fingerprint record yet -- this Pages project has no live "
            "deployment, so there is nothing to delete"
        )
    if verdict == "unverified":
        _say(
            "! cannot determine what is live on forge "
            "(no fingerprint record, unreadable KV, broken record, or live "
            "deployment lookup failed)"
        )
        _say(
            "! a full-snapshot deploy from this machine could therefore "
            "delete artifacts a teammate published"
        )
        _say("  make sure this machine's hub copy is up to date, then re-run:")
        _say(
            "    1. refresh this machine's copy of the shared artifacts "
            "directory {}, whatever syncs it".format(_quoted(root))
        )
        _say("    2. to deploy anyway, knowingly, re-run with --allow-unverified")
    if verdict == "untrusted":
        _say(
            "! record describes deployment {} but the live deployment is {}".format(
                result["record_deployment_id"] or "(none)",
                result["live_deployment_id"] or "(unknown)",
            )
        )
        _say(
            "! a rollback or an out-of-band dashboard deploy happened: this "
            "record no longer describes the live site"
        )
        _say(
            "! refusing to deploy until the live content can be verified "
            "(or you pass --allow-unverified)"
        )
        _say("  make sure this machine's hub copy is up to date, then re-run:")
        _say(
            "    1. refresh this machine's copy of the shared artifacts "
            "directory {}, whatever syncs it".format(_quoted(root))
        )
        _say("    2. to deploy anyway, knowingly, re-run with --allow-unverified")
    if result["removals"]:
        _say("recorded slug(s) absent from the local hub: " + " ".join(result["removals"]))
    if result["additions"]:
        _say("new slug(s): " + " ".join(result["additions"]))
    if result["changed"]:
        _say("changed slug(s): " + " ".join(result["changed"]))
    if verdict == "match":
        _say("hub matches the record -- nothing added, changed or removed")
    if result["unexpected_removals"]:
        _say(
            "✗ refusing to deploy: {} artifact(s) would be deleted from the live site: {}".format(
                len(result["unexpected_removals"]),
                " ".join(result["unexpected_removals"]),
            )
        )
        _say("  the local hub is very likely behind the team copy. Fix it, then publish again:")
        _say(
            "    1. refresh this machine's copy of the shared artifacts "
            "directory {}, whatever syncs it, then re-run".format(
                _quoted(root)
            )
        )
        _say("    2. if the deletion is intended, re-run publish with --allow-removals")


def cmd_compare(args: argparse.Namespace) -> int:
    record, err = load_record(args.record)
    if err:
        _say(f"✗ {err}")
        _emit({"ok": False, "error": err})
        return EXIT_ERROR
    local, root, err = _local_fingerprint()
    if err:
        _say(f"✗ {err}")
        _emit({"ok": False, "error": err})
        return EXIT_ERROR
    result = compare_record(
        record,
        local,
        args.live_deployment_id,
        parse_expected_removals(args.expected_removals),
        live_unknown=bool(args.live_unknown),
    )
    _emit(result)
    _narrate(result, root)
    if result["unexpected_removals"]:
        return EXIT_REMOVALS
    if not result["verifiable"]:
        return EXIT_UNVERIFIED
    return EXIT_OK



# --------------------------------------------------------------------- record


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_record(
    deployment_id: str, engine_commit: str, by: str, slugs: dict[str, str]
) -> dict[str, Any]:
    return {
        "deployment_id": deployment_id,
        "engine_commit": engine_commit,
        "by": by,
        "at": _utc_now(),
        "slugs": slugs,
    }


def cmd_record(args: argparse.Namespace) -> int:
    slugs, _root, err = _local_fingerprint()
    if err:
        _say(f"✗ {err}")
        _emit({"ok": False, "error": err})
        return EXIT_ERROR
    _emit(build_record(args.deployment_id, args.engine_commit, args.by, slugs))
    _say(f"record for deployment {args.deployment_id}: {len(slugs)} slug(s)")
    return EXIT_OK


# ------------------------------------------------------------------- reanchor


def reanchor_record(
    record: dict[str, Any], deployment_id: str
) -> tuple[dict[str, Any], str]:
    """(re-anchored record, error). Only the anchor moves; the slug set is kept.

    Every other key -- `slugs`, `by`, and anything a future writer adds -- is
    carried over verbatim. The record is never invented: an operator recovering
    from a lost KV write must not be handed an empty slug set, because the next
    compare would then read the whole live site as an addition-free match and
    authorise a full-snapshot deploy that wipes it.
    """
    dep = deployment_id.strip()
    if not dep:
        return {}, "--deployment-id is empty"
    if not record:
        return {}, (
            "no record to re-anchor: KV holds no snapshot for this project, "
            "so publish once to create one"
        )
    if not isinstance(record.get("slugs"), dict):
        return {}, (
            "record has no slugs object: refusing to re-anchor a record whose "
            "slug set is unknown"
        )
    out = dict(record)
    out["deployment_id"] = dep
    out["at"] = _utc_now()
    return out, ""


def cmd_reanchor(args: argparse.Namespace) -> int:
    record, err = load_record(args.record)
    if not err:
        record, err = reanchor_record(record, args.deployment_id)
    if err:
        _say(f"✗ {err}")
        _emit({"ok": False, "error": err})
        return EXIT_ERROR
    _emit(record)
    _say(
        "re-anchored on deployment {}: {} slug(s) preserved".format(
            record["deployment_id"], len(record["slugs"])
        )
    )
    return EXIT_OK


# ------------------------------------------------------------------------ CLI


class _Parser(argparse.ArgumentParser):
    """argparse exits 2 on a usage error; our callers expect 1."""

    def error(self, message: str) -> None:  # type: ignore[override]
        _emit({"ok": False, "error": message})
        self.exit(EXIT_ERROR, f"{self.prog}: {message}\n")


def build_parser() -> argparse.ArgumentParser:
    ap = _Parser(prog="snapshot.py", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser(
        "fingerprint", help="per-slug sha256 of the local artifacts root"
    ).set_defaults(func=cmd_fingerprint)

    sub.add_parser(
        "live-deployment", help="id + engine commit of the live Pages deployment"
    ).set_defaults(func=cmd_live_deployment)

    cmp_ap = sub.add_parser(
        "compare",
        help=(
            "record vs local hub; exit 3 on unexpected removals, "
            "exit 4 when live content cannot be verified"
        ),
    )
    cmp_ap.add_argument(
        "--record", required=True, help="record JSON path, or - for stdin"
    )
    cmp_ap.add_argument(
        "--live-deployment-id",
        default="",
        help="deployment id the record must match to be trusted",
    )
    cmp_ap.add_argument(
        "--live-unknown",
        action="store_true",
        help="live deployment lookup failed; cannot anchor the record",
    )
    cmp_ap.add_argument(
        "--expected-removals",
        default="",
        help="slugs the operator knowingly deletes, whitespace-separated",
    )
    cmp_ap.set_defaults(func=cmd_compare)

    rec_ap = sub.add_parser("record", help="record JSON for a KV put")
    rec_ap.add_argument("--deployment-id", required=True)
    rec_ap.add_argument("--engine-commit", required=True)
    rec_ap.add_argument("--by", required=True, help="who published")
    rec_ap.set_defaults(func=cmd_record)

    ra_ap = sub.add_parser(
        "reanchor",
        help=(
            "re-point an existing record at a deployment id, keeping its "
            "slug set verbatim"
        ),
    )
    ra_ap.add_argument(
        "--record", required=True, help="record JSON path, or - for stdin"
    )
    ra_ap.add_argument(
        "--deployment-id",
        required=True,
        help="deployment id the record should be anchored on",
    )
    ra_ap.set_defaults(func=cmd_reanchor)

    return ap


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv[1:])
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
