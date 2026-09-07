#!/usr/bin/env python3
"""Canonical OG source digest + Cloudflare Browser Run render for one artifact.

Single resolution point for BOTH halves, on purpose:

  * gen-og-images.sh records "<source_digest> <image_digest>" in og.src and
    decides staleness from that pair.
  * publish.sh recomputes the source digest from the hub copy inside
    persist_og_to_hub and refuses to persist when the two disagree.

Two implementations of either half would flip the identity of every thumbnail
in the catalogue at once -- the same failure mode the single
share_bar_script() resolution point exists to prevent. Callers MUST shell out
to this module and MUST NOT re-derive a digest or a payload.

Digest contract (v2)::

    sha256(
        b"forge-og-v2\\n"
        + sha256(canonical html bytes)
        + for each resolvable subresource, sorted by relative path:
              relpath.encode() + b"\\x00" + sha256(file bytes)
    )

Canonical html is the artifact with both engine-owned overlays removed, using
the exact inverses that injected them (inject-share-bar.py --strip, then
inject-og.py --strip). The capture stylesheet is deliberately NOT part of the
digest: it is engine-owned too, so bumping it must not invalidate all 31
thumbnails in one publish.

Subresources ARE part of it. The pre-v2 pipeline hashed index.html alone, so
editing assets/hero.png without touching the HTML never re-rendered the card.
Those files now travel inside the render payload, so keying the digest on less
than what is actually rendered would be incoherent.

The "v2" prefix forces exactly one full re-render at cutover, deliberately and
once: v1 digests recorded by the Chrome pipeline can never collide with these.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

DIGEST_VERSION = b"forge-og-v2\n"

# Deck stage geometry. The capture stylesheet pins .deck-stage to 1920x1080, so
# the viewport must match it: a 1200-wide viewport would crop the left third of
# a pinned 1920px stage instead of scaling it.
CAPTURE_WIDTH = 1920
CAPTURE_HEIGHT = 1080
OG_WIDTH = 1200
OG_HEIGHT = 630
DEFAULT_QUALITY = 80
DEFAULT_TIMEOUT = 90

# Cover-crop, computed once so it always matches the old ffmpeg filter
# (scale=increase then crop): keep the full width, crop the height to the OG
# aspect ratio, centre it, then scale to 1200x630 in the same request.
_CLIP_SCALE = OG_WIDTH / CAPTURE_WIDTH
_CLIP_HEIGHT = round(OG_HEIGHT / _CLIP_SCALE)
_CLIP_Y = (CAPTURE_HEIGHT - _CLIP_HEIGHT) // 2

# 50 MB is the documented cap on the sibling /pdf endpoint; stay clear of it.
# The largest real artifact payload measured 3.5 MiB, so this only ever fires
# on a pathological artifact -- and a named refusal beats an opaque HTTP 413.
MAX_PAYLOAD_BYTES = 45 * 1024 * 1024

CAPTURE_CSS = """<style id="forge-og-capture">
  html,body{margin:0!important;padding:0!important;overflow:hidden!important}
  .edit-toggle,.edit-hotzone,[data-forge-share-bar],[data-forge-toast]{display:none!important}
  .deck-viewport{background:transparent!important;inset:0!important}
  /* pin stage 1:1 at 1920x1080 -- no letterbox scale from fit() */
  .deck-stage{transform:none!important;left:0!important;top:0!important;width:1920px!important;height:1080px!important}
  .slide.active{visibility:visible!important;opacity:1!important;pointer-events:auto!important}
</style>
"""

SHARE_BAR_BLOCK = re.compile(
    r"<!-- forge-share-bar -->.*?<!-- /forge-share-bar -->",
    re.DOTALL,
)

# Relative subresource references: src=/href= attributes and CSS url().
# Absolute, protocol-relative, data:, fragment and scripted values are excluded
# here rather than downstream, so the digest and the inliner can never disagree
# about what counts as a subresource.
_REF = re.compile(
    r"""(?:(?:src|href)\s*=\s*(?P<q>["'])(?P<attr>[^"']+)(?P=q))"""
    r"""|(?:url\(\s*(?P<cq>["']?)(?P<css>[^"')]+)(?P=cq)\s*\))""",
    re.IGNORECASE,
)

_SKIP_PREFIXES = ("http://", "https://", "//", "#", "data:", "mailto:", "tel:", "javascript:")

# Text formats whose own relative refs must be rewritten before they are
# inlined. A data: URI has an opaque origin, so an iframe or stylesheet that
# still carried a relative ref would resolve it against the data: URL and fail
# silently -- the exact failure class this payload exists to remove.
_TEXT_INLINE_EXTS = {".css", ".html", ".htm"}
_MAX_REF_DEPTH = 3

mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/avif", ".avif")
mimetypes.add_type("font/woff2", ".woff2")


class OgRenderError(RuntimeError):
    """Any failure that must abort this artifact without killing the batch."""


def _scripts_dir() -> Path:
    return Path(__file__).resolve().parent.parent


def load_forge_env() -> None:
    """Fill CLOUDFLARE_* from forge.env when the caller did not export them.

    publish.sh already sources forge.env and exports both keys, so this only
    matters for a standalone gen-og-images.sh run. Only the two keys this
    module needs are read; nothing is printed.
    """
    if os.environ.get("CLOUDFLARE_API_TOKEN") and os.environ.get("CLOUDFLARE_ACCOUNT_ID"):
        return
    path = Path(os.environ.get("FORGE_ENV_FILE", Path.home() / ".config/silex/forge.env"))
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return
    wanted = {"CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"}
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export ") :].strip()
        if key not in wanted or os.environ.get(key):
            continue
        val = val.strip().strip("'\"")
        if val:
            os.environ[key] = val


def _is_relative_ref(value: str) -> bool:
    v = value.strip()
    if not v or "${" in v:
        return False
    return not v.lower().startswith(_SKIP_PREFIXES)


def _resolve_ref(origin_dir: Path, root: Path, value: str) -> Path | None:
    """Resolve a relative ref to a real file inside the artifact directory."""
    clean = value.strip().split("?", 1)[0].split("#", 1)[0]
    if not clean or clean.endswith("/"):
        return None
    try:
        target = (origin_dir / clean).resolve()
        root_resolved = root.resolve()
    except OSError:
        return None
    # Never follow a ref out of the artifact: og.src is per-slug, and a payload
    # is not a licence to read the rest of the hub.
    if root_resolved != target and root_resolved not in target.parents:
        return None
    return target if target.is_file() else None


def _iter_refs(text: str):
    for m in _REF.finditer(text):
        value = m.group("attr") if m.group("attr") is not None else m.group("css")
        if value is None or not _is_relative_ref(value):
            continue
        start, end = (m.span("attr") if m.group("attr") is not None else m.span("css"))
        yield start, end, value


def collect_subresources(html_path: Path) -> list[tuple[str, Path]]:
    """Every file the render payload will carry, transitively through CSS.

    Returned paths are relative to the artifact directory so the digest is
    identical on every machine regardless of where the hub is mounted.
    """
    root = html_path.parent
    found: dict[str, Path] = {}
    queue: list[tuple[str, Path, int]] = []

    try:
        html = html_path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise OgRenderError(f"cannot read {html_path}: {exc}") from exc

    for _, _, value in _iter_refs(html):
        target = _resolve_ref(root, root, value)
        if target is None:
            continue
        rel = target.relative_to(root.resolve()).as_posix()
        if rel not in found:
            found[rel] = target
            queue.append((rel, target, 1))

    while queue:
        rel, path, depth = queue.pop()
        if depth >= _MAX_REF_DEPTH or path.suffix.lower() not in _TEXT_INLINE_EXTS:
            continue
        try:
            nested = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for _, _, value in _iter_refs(nested):
            target = _resolve_ref(path.parent, root, value)
            if target is None:
                continue
            nrel = target.relative_to(root.resolve()).as_posix()
            if nrel not in found:
                found[nrel] = target
                queue.append((nrel, target, depth + 1))

    return sorted(found.items())


def canonical_html_bytes(html_path: Path) -> bytes:
    """The artifact with both engine-owned overlays stripped by their inverses."""
    scripts = _scripts_dir()
    share_inj = scripts / "inject-share-bar.py"
    og_inj = scripts / "inject-og.py"
    if not share_inj.is_file() or not og_inj.is_file():
        raise OgRenderError("inject-share-bar.py / inject-og.py missing from scripts/")
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / "canonical.html"
        shutil.copyfile(html_path, tmp)
        for script in (share_inj, og_inj):
            proc = subprocess.run(
                [sys.executable, str(script), str(tmp), "--strip"],
                capture_output=True,
                text=True,
            )
            if proc.returncode != 0:
                raise OgRenderError(f"{script.name} --strip failed: {proc.stderr.strip()}")
        return tmp.read_bytes()


def canonical_digest(html_path: Path) -> str:
    """The v2 source digest: canonical HTML plus every payload subresource."""
    outer = hashlib.sha256()
    outer.update(DIGEST_VERSION)
    outer.update(hashlib.sha256(canonical_html_bytes(html_path)).digest())
    for rel, path in collect_subresources(html_path):
        outer.update(rel.encode("utf-8"))
        outer.update(b"\x00")
        try:
            outer.update(hashlib.sha256(path.read_bytes()).digest())
        except OSError as exc:
            raise OgRenderError(f"cannot read subresource {rel}: {exc}") from exc
    return outer.hexdigest()


def _data_uri(path: Path, payload: bytes) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return f"data:{mime};base64,{base64.b64encode(payload).decode('ascii')}"


def _inline_text(text: str, origin_dir: Path, root: Path, depth: int) -> str:
    """Rewrite every resolvable relative ref in `text` into a data: URI."""
    if depth >= _MAX_REF_DEPTH:
        return text
    out: list[str] = []
    cursor = 0
    for start, end, value in _iter_refs(text):
        target = _resolve_ref(origin_dir, root, value)
        if target is None:
            continue
        try:
            raw = target.read_bytes()
        except OSError:
            continue
        if target.suffix.lower() in _TEXT_INLINE_EXTS:
            nested = _inline_text(
                raw.decode("utf-8", errors="replace"), target.parent, root, depth + 1
            )
            raw = nested.encode("utf-8")
        out.append(text[cursor:start])
        out.append(_data_uri(target, raw))
        cursor = end
    out.append(text[cursor:])
    return "".join(out)


def build_render_html(html_path: Path) -> str:
    """Payload HTML: overlays out, subresources inlined, capture CSS in.

    The share bar is removed by pattern rather than by inject-share-bar.py
    --strip because this copy is thrown away after the POST; the digest is the
    only thing that needs the exact inverse.
    """
    root = html_path.parent
    text = html_path.read_text(encoding="utf-8", errors="replace")
    text = SHARE_BAR_BLOCK.sub("", text)
    text = _inline_text(text, root, root, 0)
    if "</head>" in text:
        text = text.replace("</head>", CAPTURE_CSS + "</head>", 1)
    else:
        text = CAPTURE_CSS + text
    return text


def build_payload(html_path: Path, quality: int = DEFAULT_QUALITY) -> dict:
    return {
        "html": build_render_html(html_path),
        "viewport": {"width": CAPTURE_WIDTH, "height": CAPTURE_HEIGHT},
        "gotoOptions": {"waitUntil": "networkidle0", "timeout": 30000},
        "screenshotOptions": {
            "type": "jpeg",
            "quality": quality,
            "clip": {
                "x": 0,
                "y": _CLIP_Y,
                "width": CAPTURE_WIDTH,
                "height": _CLIP_HEIGHT,
                "scale": _CLIP_SCALE,
            },
        },
    }


def render(html_path: Path, quality: int = DEFAULT_QUALITY, timeout: int = DEFAULT_TIMEOUT) -> bytes:
    """POST the payload to Browser Run and return the JPEG bytes."""
    load_forge_env()
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    if not token:
        raise OgRenderError(
            "CLOUDFLARE_API_TOKEN missing -- put it in ~/.config/silex/forge.env (chmod 600)"
        )
    if not account:
        raise OgRenderError(
            "CLOUDFLARE_ACCOUNT_ID missing -- forge-discover.sh prints it, then forge-doctor.sh"
        )

    body = json.dumps(build_payload(html_path, quality)).encode("utf-8")
    if len(body) > MAX_PAYLOAD_BYTES:
        raise OgRenderError(
            f"render payload {len(body) // (1024 * 1024)} MB exceeds the {MAX_PAYLOAD_BYTES // (1024 * 1024)} MB ceiling"
        )

    # cacheTTL=0: Quick Actions cache responses for 5s by default, which would
    # serve a stale card to the retry that follows a failed render.
    url = (
        "https://api.cloudflare.com/client/v4/accounts/"
        f"{account}/browser-rendering/screenshot?cacheTTL=0"
    )
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read()
    except urllib.error.HTTPError as exc:
        raise OgRenderError(f"browser run HTTP {exc.code}: {_api_error(exc.read())}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise OgRenderError(f"browser run unreachable: {exc}") from exc

    # A JSON body on a 200 means the API reported failure in-band.
    if payload[:3] != b"\xff\xd8\xff":
        raise OgRenderError(f"browser run returned no JPEG: {_api_error(payload)}")
    return payload


def _api_error(raw: bytes) -> str:
    try:
        doc = json.loads(raw.decode("utf-8", errors="replace"))
    except (ValueError, UnicodeDecodeError):
        return raw[:200].decode("utf-8", errors="replace").strip() or "empty response"
    errors = doc.get("errors") if isinstance(doc, dict) else None
    if isinstance(errors, list) and errors:
        return "; ".join(str(e.get("message", e)) for e in errors)
    return raw[:200].decode("utf-8", errors="replace").strip() or "unknown error"


def _cmd_digest(args: argparse.Namespace) -> int:
    print(canonical_digest(Path(args.html)))
    return 0


def _cmd_subresources(args: argparse.Namespace) -> int:
    for rel, path in collect_subresources(Path(args.html)):
        print(f"{rel}\t{path.stat().st_size}")
    return 0


def _cmd_payload(args: argparse.Namespace) -> int:
    body = json.dumps(build_payload(Path(args.html), args.quality))
    if args.out:
        Path(args.out).write_text(body, encoding="utf-8")
        print(len(body.encode("utf-8")))
    else:
        print(body)
    return 0


def _cmd_render(args: argparse.Namespace) -> int:
    jpeg = render(Path(args.html), args.quality, args.timeout)
    out = Path(args.out)
    tmp = out.with_name(f".{out.name}.tmp")
    tmp.write_bytes(jpeg)
    tmp.replace(out)
    print(len(jpeg))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="og_render.py",
        description="Canonical OG source digest and Browser Run render for one artifact.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_digest = sub.add_parser("digest", help="print the v2 canonical source digest")
    p_digest.add_argument("html")
    p_digest.set_defaults(func=_cmd_digest)

    p_subs = sub.add_parser("subresources", help="list the files the payload will carry")
    p_subs.add_argument("html")
    p_subs.set_defaults(func=_cmd_subresources)

    p_payload = sub.add_parser("payload", help="build the request body without sending it")
    p_payload.add_argument("html")
    p_payload.add_argument("--quality", type=int, default=DEFAULT_QUALITY)
    p_payload.add_argument("--out")
    p_payload.set_defaults(func=_cmd_payload)

    p_render = sub.add_parser("render", help="render the artifact into a JPEG")
    p_render.add_argument("html")
    p_render.add_argument("--out", required=True)
    p_render.add_argument("--quality", type=int, default=DEFAULT_QUALITY)
    p_render.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    p_render.set_defaults(func=_cmd_render)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except OgRenderError as exc:
        print(f"og-render: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
