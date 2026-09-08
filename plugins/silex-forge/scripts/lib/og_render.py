#!/usr/bin/env python3
"""Canonical OG source digest + Cloudflare Browser Run render for one artifact.

Single resolution point for BOTH halves, on purpose:

  * gen-og-images.sh records "<source_digest> <image_digest>" in og.src and
    decides staleness from that pair.
  * publish.sh recomputes the source digest from the hub copy inside
    persist_og_to_hub and refuses to persist when the two disagree.

Two implementations of either half would flip the identity of every thumbnail
in the catalogue at once -- the same failure mode the single
share_bar_script() resolution point exists to prevent. Callers on the digest
or payload path MUST shell out to this module and MUST NOT re-derive either.
For the same reason those callers must resolve THIS FILE from the engine
clone, never from the installed plugin: a clone/installed skew during a
rollout makes the two copies disagree about the canonical bytes.

probe() is the one deliberate exception, and only because it touches neither
half: load_config.browser_run_probe imports it in-process from the installed
plugin to answer "may this token render at all". It computes no digest and
builds no artifact payload, so a skew there cannot move canonical bytes.

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

Two known limits of the payload form, both from the same root: the page is
rendered from an inline HTML string, so it has an opaque origin and no base
URL.

  * A third-party embed that needs a real origin degrades -- measured on
    lgu-recap, whose remote tella.tv player is replaced by its own client-side
    error box.
  * A path built at runtime cannot be rewritten. Inlining covers src=, href=
    and url(), which is all a parser can see; a fetch() or XHR argument is
    computed while the page runs. Measured on infographie-repos-showcase,
    whose inlined script fetches tabs/<id>.html and reports "Failed to parse
    URL". No inlining strategy can close this -- the path does not exist until
    execution. It is the only artifact of the 33 that does this, and its card
    is already broken the same way on main.

Rendering either faithfully would require navigating the real URL, which is
behind the visibility ACL.
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

# Browser Run reachability probe (forge-doctor.sh --online). The Browser Run
# Write permission cannot be read back from the token verify endpoint, so the
# only honest check is a real render.
# Constant on purpose. Quick Actions caches a response ~5 s keyed on the
# request body, so a second probe inside that window is replayed for free
# (measured: identical bytes and an identical X-Browser-Ms-Used at 0.15 s
# wall, against 3.8 s for the render) -- which is what /forge-setup wants,
# since it runs --online twice. It cannot fake a green either: the same
# cached body with a revoked token answers HTTP 401, so authentication is
# enforced ahead of the cache.
PROBE_HTML = '<!doctype html><meta charset="utf-8"><title>forge probe</title>'
# A blank 64x64 page measured 0.13-2.5 s of browser time (cold instance vs
# warm) and 3.8 s wall, so 15 s is generous. urlopen's timeout is per socket
# operation, not a wall clock, so this bounds a stalled connection loosely --
# keep it well under the 90 s a real render is allowed.
PROBE_TIMEOUT = 15

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


def _config_account_id() -> str:
    """forge.config.json's cloudflare_account_id, or "" when unreadable.

    Lazy import: load_config imports this module lazily too (browser_run_probe),
    so a module-level import would close the cycle.
    """
    try:
        from load_config import resolved_account_id  # noqa: PLC0415

        return str(resolved_account_id() or "").strip()
    except (Exception, SystemExit):
        # SystemExit, not just Exception: load_config._read_json raises
        # SystemExit("config unreadable") on malformed JSON, which is the
        # likeliest way this call fails. A bare "except Exception" would let
        # it escape and kill the render batch this fallback exists to serve.
        return ""


def _credentials(token: str = "", account: str = "") -> tuple[str, str]:
    """What the caller already resolved, else the environment, or a refusal.

    The account id falls back to load_config's resolution, which also reads
    forge.config.json's cloudflare_account_id. Resolving it more narrowly here
    would refuse a value the rest of the forge accepts: publish.sh exports the
    resolved id, but a standalone gen-og-images.sh run only eval's export_env
    into shell variables, and forge-doctor.sh's probe runs in-process. A caller
    that resolved the pair itself passes it in, so doctor can never blame a
    value it just resolved.
    """
    # .strip() like every other resolver here (resolved_account_id,
    # resolve_api_token, token_present): an id pasted from the dashboard with
    # a trailing space would otherwise build ".../accounts/<id> /..." and
    # raise InvalidURL, whose message embeds the whole id in a per-slug
    # warning -- against the acct[:8] redaction the rest of the forge uses.
    token = (token or os.environ.get("CLOUDFLARE_API_TOKEN", "")).strip()
    account = (account or os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")).strip() or _config_account_id()
    if not token:
        raise OgRenderError(
            "CLOUDFLARE_API_TOKEN missing -- put it in ~/.config/silex/forge.env (chmod 600)"
        )
    if not account:
        raise OgRenderError(
            "CLOUDFLARE_ACCOUNT_ID missing -- forge-discover.sh prints it, then forge-doctor.sh"
        )
    return token, account


def _screenshot(body: bytes, timeout: int, token: str = "", account: str = "") -> bytes:
    """POST one screenshot request body and return the JPEG bytes.

    The single request path, shared by render() and probe(): a probe that
    reached another endpoint, or resolved the credential differently, would
    prove nothing about the render it stands in for. It takes the already
    encoded body so render() weighs the exact bytes it sends against
    MAX_PAYLOAD_BYTES without serialising a multi-megabyte payload twice, and
    the resolved credential so one call resolves it once.
    """
    token, account = _credentials(token, account)

    # No cacheTTL. Measured 2026-09-08: the endpoint rejects it in the body
    # ("HTTP 400 Unrecognized key: cacheTTL"), accepts it in the query string,
    # and documents it in neither the screenshot endpoint page, the Quick
    # Actions index, nor llms.txt. Nothing here needs it. The ~5 s response
    # cache is keyed on the request body, so an identical body deserves an
    # identical card, a failed render caches nothing, and a cache hit is
    # still authenticated (same body + revoked token = HTTP 401).
    url = (
        "https://api.cloudflare.com/client/v4/accounts/"
        f"{account}/browser-rendering/screenshot"
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


def render(html_path: Path, quality: int = DEFAULT_QUALITY, timeout: int = DEFAULT_TIMEOUT) -> bytes:
    """POST the payload to Browser Run and return the JPEG bytes."""
    load_forge_env()
    # Refuse a missing credential before inlining a multi-megabyte payload.
    token, account = _credentials()

    body = json.dumps(build_payload(html_path, quality)).encode("utf-8")
    if len(body) > MAX_PAYLOAD_BYTES:
        raise OgRenderError(
            f"render payload {len(body) // (1024 * 1024)} MB exceeds the "
            f"{MAX_PAYLOAD_BYTES // (1024 * 1024)} MB ceiling"
        )
    return _screenshot(body, timeout, token, account)


def probe_payload() -> dict:
    """The smallest render Browser Run will accept: a 64x64 blank page."""
    return {
        "html": PROBE_HTML,
        "viewport": {"width": 64, "height": 64},
        "gotoOptions": {"waitUntil": "load", "timeout": 10000},
        "screenshotOptions": {"type": "jpeg", "quality": 1},
    }


def probe(timeout: int = PROBE_TIMEOUT, token: str = "", account: str = "") -> None:
    """Raise OgRenderError when this token cannot render on Browser Run.

    Deliberately minimal: the cheapest possible real proof that the credential
    is accepted by the endpoint the renderer uses. No file is written and there
    is no waitForTimeout -- SETTLE_MS buys nothing on a blank page, it would
    only bill 2.5 s of browser time per doctor run.

    A caller that already resolved the pair (forge-doctor.sh's advisory) passes
    it in: forge.env is then neither read nor mode-gated here, so the probe
    reports on Browser Run and nothing else -- doctor owns the env-permission
    verdict and must not report it twice under another name.
    """
    if not (token and account):
        load_forge_env()
    _screenshot(json.dumps(probe_payload()).encode("utf-8"), timeout, token, account)


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


def _cmd_probe(args: argparse.Namespace) -> int:
    probe(args.timeout)
    print("browser run: ok")
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

    p_probe = sub.add_parser(
        "probe", help="prove this token can render on Browser Run (no file written)"
    )
    p_probe.add_argument("--timeout", type=int, default=PROBE_TIMEOUT)
    p_probe.set_defaults(func=_cmd_probe)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except OgRenderError as exc:
        print(f"og-render: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
