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
to this module and MUST NOT re-derive a digest or a payload. For the same
reason every caller must resolve THIS FILE from the engine clone, never from
the installed plugin: a clone/installed skew during a rollout makes the two
copies disagree about the canonical bytes.

The digest and the payload are built from ONE canonical text, produced by the
scripts that injected the overlays in the first place (inject-share-bar.py
--strip, then inject-og.py --strip). An earlier revision stripped the share bar
by regex for the payload and by script for the digest; the two disagreed on
legacy artifacts that carry the bar without its marker comment, which is
exactly the duplication the paragraph above forbids.

Digest contract (v2)::

    sha256(
        b"forge-og-v2\\n"
        + sha256(canonical html bytes)
        + for each resolvable subresource, sorted by relative path:
              relpath.encode() + b"\\x00" + sha256(file bytes)
    )

The capture stylesheet is deliberately NOT part of the digest: it is
engine-owned, so bumping it must not invalidate all 31 thumbnails in one
publish.

Subresources ARE part of it. The pre-v2 pipeline hashed index.html alone, so
editing assets/hero.png never re-rendered the card. Those files now travel
inside the render payload, so keying the digest on less than what is actually
rendered would be incoherent.

The "v2" prefix forces exactly one re-render per artifact at cutover: v1
digests recorded by the Chrome pipeline can never collide with these. Until an
artifact is re-rendered its previously published card keeps shipping --
build-site-from-hub.py copies the hub JPEG unconditionally, and it must stay
that way: a full-snapshot deploy plus a single-slug re-render means any
per-slug gate there deletes the live thumbnails of every other artifact.

Known limit of the payload form: the page is rendered from an inline HTML
string, so it has an opaque origin. A third-party embed that needs a real one
degrades -- measured on lgu-recap, whose remote tella.tv player is replaced by
its own client-side error box. Rendering that slug faithfully would require
navigating the real URL, which is behind the visibility ACL.
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

# Settle budget before the capture. Every subresource is inlined as a data:
# URI, so the page makes almost no network requests and gotoOptions'
# networkidle0 ("no connection for 500 ms") is satisfied about half a second
# after navigation, where the Chrome pipeline this replaces ran
# --virtual-time-budget=10000 --run-all-compositor-stages-before-draw.
#
# Honest scope: this changed no measured output on the slugs tested -- their
# captures were already deterministic. It is kept as insurance against
# capturing a CSS entrance animation or a webfont swap mid-flight, which fails
# silently because the screenshot still succeeds.
SETTLE_MS = 2500

# Cover-crop, computed once so it always matches the old ffmpeg filter
# (scale=increase then crop): keep the full width, crop the height to the OG
# aspect ratio, centre it, then scale to 1200x630 in the same request.
_CLIP_SCALE = OG_WIDTH / CAPTURE_WIDTH
_CLIP_HEIGHT = round(OG_HEIGHT / _CLIP_SCALE)
_CLIP_Y = (CAPTURE_HEIGHT - _CLIP_HEIGHT) // 2

# 50 MB is the documented cap on the sibling /pdf endpoint; stay clear of it.
# The largest real artifact payload measured 6.5 MiB, so this only ever fires
# on a pathological artifact -- and a named refusal beats an opaque HTTP 413.
# Enforced DURING inlining, not only on the finished body, so a runaway
# artifact cannot exhaust memory before the check.
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

# Relative subresource references: src=/href= attributes and CSS url().
# Absolute, protocol-relative, data:, fragment and scripted values are excluded
# here, so the digest and the inliner can never disagree about what counts as a
# subresource: both walk this same iterator over the same canonical text.
_REF = re.compile(
    r"""(?:(?:src|href)\s*=\s*(?P<q>["'])(?P<attr>[^"']+)(?P=q))"""
    r"""|(?:url\(\s*(?P<cq>["']?)(?P<css>[^"')]+)(?P=cq)\s*\))""",
    re.IGNORECASE,
)

_SKIP_PREFIXES = (
    "http://",
    "https://",
    "//",
    "#",
    "data:",
    "mailto:",
    "tel:",
    "javascript:",
    "file:",
    "blob:",
    "ftp:",
    "ws:",
    "wss:",
)

# Text formats whose own relative refs must be rewritten before they are
# inlined: a data: URI has an opaque origin, so a stylesheet that still carried
# a relative ref would resolve it against the data: URL.
_TEXT_INLINE_EXTS = {".css"}

# Refs that must be left exactly as they are. _TEXT_INLINE_EXTS only decides
# whether a carried file's OWN refs get rewritten first; this set decides
# whether the file is carried at all.
#
# Nested documents are not carried. Inlining one was added speculatively: the
# only artifact that references one (lgu-recap -> deck.html) has no relative
# refs of its own, so embedding it as a 3 MB data: iframe bought nothing. It is
# NOT the cause of that slug's degraded card -- measured after this change, the
# remote tella.tv player still renders its own client-side error box, because
# the payload page has an opaque origin either way (see the module docstring).
# An un-inlined relative iframe simply fails to load, exactly as it already
# does for an anonymous visitor. They stay out of the digest too, since the
# payload never carries them.
_NEVER_INLINE_EXTS = {".html", ".htm"}
_MAX_REF_DEPTH = 3

mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/avif", ".avif")
mimetypes.add_type("font/woff2", ".woff2")


class OgRenderError(RuntimeError):
    """Any failure that must abort this artifact without killing the batch."""


def _scripts_dir() -> Path:
    return Path(__file__).resolve().parent.parent


def _forge_env_path() -> Path:
    """The credentials path the caller designated, then the shared resolution.

    FORGE_ENV_FILE comes FIRST: publish.sh exports it (and load_config's
    export_env emits it), so it names the file this run must read. Deferring to
    load_config.forge_env_path() first would ignore it -- load_config reads
    FORGE_ENV -- and this module would read a different token file than the
    publish that invoked it. FORGE_ENV is honoured next because
    forge-discover.sh and forge-provision.sh set that name instead.
    """
    for var in ("FORGE_ENV_FILE", "FORGE_ENV"):
        override = os.environ.get(var, "").strip()
        if override:
            return Path(override).expanduser()
    try:
        from load_config import forge_env_path  # noqa: PLC0415

        return Path(forge_env_path())
    except Exception:
        return Path.home() / ".config/silex/forge.env"


def load_forge_env() -> None:
    """Fill CLOUDFLARE_* from forge.env when the caller did not export them.

    publish.sh already sources forge.env and exports both keys, so this only
    matters for a standalone gen-og-images.sh run. Only the two keys this
    module needs are read; nothing is printed.

    The 600/400 mode gate mirrors publish.sh's require_forge_env_secure: a
    reader that silently accepts a world-readable credentials file is a hole in
    a control every other consumer enforces.
    """
    if os.environ.get("CLOUDFLARE_API_TOKEN") and os.environ.get("CLOUDFLARE_ACCOUNT_ID"):
        return
    path = _forge_env_path()
    try:
        mode = path.stat().st_mode & 0o777
    except OSError:
        return
    if mode not in (0o600, 0o400):
        raise OgRenderError(
            f"{path} permissions {mode:o} -- chmod 600 required before it is read"
        )
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
    except (OSError, ValueError):
        # ValueError: an embedded NUL byte. Returning None keeps a crafted ref
        # a skipped subresource instead of an exception escaping into a caller
        # that only absorbs OgRenderError.
        return None
    # Never follow a ref out of the artifact: og.src is per-slug, and a payload
    # is not a licence to read the rest of the hub. Both sides are resolved, so
    # a symlink cannot widen the root nor smuggle a target out of it.
    if root_resolved != target and root_resolved not in target.parents:
        return None
    try:
        return target if target.is_file() else None
    except OSError:
        return None


def _iter_refs(text: str):
    for m in _REF.finditer(text):
        value = m.group("attr") if m.group("attr") is not None else m.group("css")
        if value is None or not _is_relative_ref(value):
            continue
        start, end = m.span("attr") if m.group("attr") is not None else m.span("css")
        yield start, end, value


def canonical_html_bytes(html_path: Path) -> bytes:
    """The artifact with both engine-owned overlays stripped by their inverses.

    Both the digest and the render payload derive from this, so there is
    exactly one notion of "the craft" and one stripper.
    """
    scripts = _scripts_dir()
    share_inj = scripts / "inject-share-bar.py"
    og_inj = scripts / "inject-og.py"
    if not share_inj.is_file() or not og_inj.is_file():
        raise OgRenderError("inject-share-bar.py / inject-og.py missing from scripts/")
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / "canonical.html"
        try:
            shutil.copyfile(html_path, tmp)
        except OSError as exc:
            raise OgRenderError(f"cannot read {html_path}: {exc}") from exc
        for script in (share_inj, og_inj):
            proc = subprocess.run(
                [sys.executable, str(script), str(tmp), "--strip"],
                capture_output=True,
                text=True,
            )
            if proc.returncode != 0:
                raise OgRenderError(f"{script.name} --strip failed: {proc.stderr.strip()}")
        try:
            return tmp.read_bytes()
        except OSError as exc:
            raise OgRenderError(f"cannot read the canonical copy: {exc}") from exc


def collect_subresources(
    html_path: Path, canonical: str | None = None
) -> list[tuple[str, Path]]:
    """Every file the render payload will carry, transitively through CSS.

    Walks the CANONICAL text, not the raw file: a ref inside an engine-owned
    overlay must not enter the digest, since the payload never carries it.

    Returned paths are relative to the artifact directory so the digest is
    identical on every machine regardless of where the hub is mounted.
    """
    root = html_path.parent
    root_resolved = root.resolve()
    if canonical is None:
        canonical = canonical_html_bytes(html_path).decode("utf-8", errors="replace")

    found: dict[str, Path] = {}
    queue: list[tuple[Path, int]] = []

    for _, _, value in _iter_refs(canonical):
        target = _resolve_ref(root, root, value)
        if target is None or target.suffix.lower() in _NEVER_INLINE_EXTS:
            continue
        rel = target.relative_to(root_resolved).as_posix()
        if rel not in found:
            found[rel] = target
            queue.append((target, 1))

    while queue:
        path, depth = queue.pop()
        if depth >= _MAX_REF_DEPTH or path.suffix.lower() not in _TEXT_INLINE_EXTS:
            continue
        try:
            nested = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for _, _, value in _iter_refs(nested):
            target = _resolve_ref(path.parent, root, value)
            if target is None or target.suffix.lower() in _NEVER_INLINE_EXTS:
                continue
            nrel = target.relative_to(root_resolved).as_posix()
            if nrel not in found:
                found[nrel] = target
                queue.append((target, depth + 1))

    return sorted(found.items())


def canonical_digest(html_path: Path) -> str:
    """The v2 source digest: canonical HTML plus every payload subresource."""
    raw = canonical_html_bytes(html_path)
    outer = hashlib.sha256()
    outer.update(DIGEST_VERSION)
    outer.update(hashlib.sha256(raw).digest())
    canonical = raw.decode("utf-8", errors="replace")
    for rel, path in collect_subresources(html_path, canonical):
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


def _inline_text(
    text: str,
    origin_dir: Path,
    root: Path,
    depth: int,
    cache: dict[Path, str],
    spent: list[int],
) -> str:
    """Rewrite every resolvable relative ref in `text` into a data: URI.

    `cache` memoises by resolved path, so an artifact referencing the same
    asset twenty times encodes it once. `spent` carries the running payload
    size, checked here rather than only on the finished body: a pathological
    artifact must be refused before it is materialised, not after.
    """
    if depth >= _MAX_REF_DEPTH:
        return text
    out: list[str] = []
    cursor = 0
    for start, end, value in _iter_refs(text):
        target = _resolve_ref(origin_dir, root, value)
        if target is None or target.suffix.lower() in _NEVER_INLINE_EXTS:
            continue
        uri = cache.get(target)
        if uri is None:
            try:
                raw = target.read_bytes()
            except OSError:
                continue
            if target.suffix.lower() in _TEXT_INLINE_EXTS:
                nested = _inline_text(
                    raw.decode("utf-8", errors="replace"),
                    target.parent,
                    root,
                    depth + 1,
                    cache,
                    spent,
                )
                raw = nested.encode("utf-8")
            uri = _data_uri(target, raw)
            cache[target] = uri
            spent[0] += len(uri)
            if spent[0] > MAX_PAYLOAD_BYTES:
                raise OgRenderError(
                    f"render payload exceeds the "
                    f"{MAX_PAYLOAD_BYTES // (1024 * 1024)} MB ceiling while inlining "
                    f"{target.name}"
                )
        out.append(text[cursor:start])
        out.append(uri)
        cursor = end
    out.append(text[cursor:])
    return "".join(out)


def build_render_html(html_path: Path) -> str:
    """Payload HTML: canonical craft, subresources inlined, capture CSS in.

    The overlays are removed by canonical_html_bytes -- the same stripper the
    digest uses -- so the bytes that are rendered and the bytes that are hashed
    describe the same artifact.
    """
    root = html_path.parent
    text = canonical_html_bytes(html_path).decode("utf-8", errors="replace")
    text = _inline_text(text, root, root, 0, {}, [len(text)])
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
        # networkidle0 fires ~500 ms in on an all-inline payload; see SETTLE_MS.
        "waitForTimeout": SETTLE_MS,
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
            f"render payload {len(body) // (1024 * 1024)} MB exceeds the "
            f"{MAX_PAYLOAD_BYTES // (1024 * 1024)} MB ceiling"
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
    """Summarise an API response body. Never sees the request or its headers."""
    try:
        doc = json.loads(raw.decode("utf-8", errors="replace"))
    except (ValueError, UnicodeDecodeError):
        return raw[:200].decode("utf-8", errors="replace").strip() or "empty response"
    errors = doc.get("errors") if isinstance(doc, dict) else None
    if isinstance(errors, list) and errors:
        return "; ".join(str(e.get("message", e)) for e in errors)
    return raw[:200].decode("utf-8", errors="replace").strip() or "unknown error"


def _write_private(path: Path, data: bytes) -> None:
    """Atomic write, owner-only. Artifact content is private client material."""
    tmp = path.with_name(f".{path.name}.tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    tmp.replace(path)


def _cmd_digest(args: argparse.Namespace) -> int:
    print(canonical_digest(Path(args.html)))
    return 0


def _cmd_subresources(args: argparse.Namespace) -> int:
    for rel, path in collect_subresources(Path(args.html)):
        print(f"{rel}\t{path.stat().st_size}")
    return 0


def _cmd_payload(args: argparse.Namespace) -> int:
    body = json.dumps(build_payload(Path(args.html), args.quality)).encode("utf-8")
    if args.out:
        _write_private(Path(args.out), body)
        print(len(body))
    else:
        sys.stdout.write(body.decode("utf-8"))
        sys.stdout.write("\n")
    return 0


def _cmd_render(args: argparse.Namespace) -> int:
    jpeg = render(Path(args.html), args.quality, args.timeout)
    _write_private(Path(args.out), jpeg)
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
