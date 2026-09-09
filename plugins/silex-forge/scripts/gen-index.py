#!/usr/bin/env python3
"""gen-index.py — génère site/index.html (shell) + manifest.json (worker-only).

Landing façon roxabi-forge. DATA cards come from GET /api/catalogue
(anonymous = public only; Access JWT = all). manifest.json is blocked
from clients; the Function reads it via ASSETS.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_LIB = Path(__file__).resolve().parent / "lib"
if _LIB.is_dir() and str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))


def _resolve_paths() -> tuple[Path, Path, Path, Path, Path]:
    """repo ROOT, registry, site, index out, manifest — config-aware with defaults."""
    root = Path(__file__).resolve().parents[3]
    site_dir = "site"
    reg_dir = "registry"
    try:
        from load_config import load_config

        cfg = load_config()
        site_dir = str(cfg.get("site_dir") or site_dir)
        reg_dir = str(cfg.get("registry_dir") or reg_dir)
    except Exception:
        pass
    site = root / site_dir
    return root, root / reg_dir, site, site / "index.html", site / "manifest.json"


ROOT, REG, SITE, OUT, MANIFEST = _resolve_paths()

TYPE_LABEL = {
    "talk": "Talk",
    "deck": "Deck",
    "guide": "Guide",
    "diagram": "Diagramme",
    "gallery": "Galerie",
    "html": "HTML",
    "other": "Artefact",
}

# Color token keys used by CSS (match roxabi group-tag / card classes)
TYPE_COLOR = {
    "talk": "purple",
    "deck": "blue",
    "guide": "green",
    "diagram": "amber",
    "gallery": "cyan",
    "html": "orange",
    "other": "gold",
}


def load_items() -> list[dict]:
    items: list[dict] = []
    if not REG.is_dir():
        return items
    for p in sorted(REG.glob("*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"skip {p.name}: {e}", file=sys.stderr)
            continue
        if not data.get("slug") or not data.get("title"):
            print(f"skip {p.name}: slug/title required", file=sys.stderr)
            continue
        if data.get("list_on_index", True) is False:
            continue
        data.setdefault("type", "html")
        data.setdefault("description", "")
        data.setdefault("date", "")
        data["path"] = data.get("path") or f"/a/{data['slug']}/"
        # Snapshot only — never persist share keys in registry; live badge = GET /api/share
        data["shared"] = bool(data.get("shared"))
        # /p/ purged — only /a/ (Access) + /s/ (share key)
        items.append(data)
    items.sort(key=lambda x: x.get("date") or "", reverse=True)
    return items


def file_kb(item: dict) -> int:
    """Size of the main HTML for display (kb), 0 if missing."""
    rel = str(item["path"]).lstrip("/")
    candidates = [
        SITE / rel / "index.html",
        SITE / rel.rstrip("/") ,
    ]
    if rel.endswith(".html"):
        candidates.insert(0, SITE / rel)
    for c in candidates:
        if c.is_file():
            return max(1, c.stat().st_size // 1024)
    return 0


def preview_info(item: dict) -> tuple[bool, str]:
    """Return (has_preview, thumb_url) if an og/thumb image exists on disk."""
    slug = item["slug"]
    rel = str(item["path"]).lstrip("/").rstrip("/")
    # Prefer compressed JPEG from gen-og-images.sh; fall back to legacy PNG
    candidates = [
        (SITE / rel / "og.jpg", f"/{rel}/og.jpg"),
        (SITE / rel / "og.jpeg", f"/{rel}/og.jpeg"),
        (SITE / rel / "og.png", f"/{rel}/og.png"),
        (SITE / rel / "index.og.png", f"/{rel}/index.og.png"),
        (SITE / rel / f"{slug}.og.png", f"/{rel}/{slug}.og.png"),
        (SITE / "images" / f"{slug}.og.jpg", f"/images/{slug}.og.jpg"),
        (SITE / "images" / f"{slug}.og.png", f"/images/{slug}.og.png"),
        (SITE / "images" / f"{slug}.png", f"/images/{slug}.png"),
    ]
    for path, url in candidates:
        if path.is_file():
            return True, url
    return False, ""


def to_manifest(items: list[dict]) -> list[dict]:
    """Compact client payload (roxabi-shaped + Silex extras)."""
    out = []
    for it in items:
        t = it.get("type") or "html"
        has_p, thumb = preview_info(it)
        badges: list[str] = []
        is_shared = bool(it.get("shared"))
        if is_shared:
            badges.append("share")
        out.append(
            {
                "f": it["path"],
                "t": it["title"],
                "d": it.get("date") or "",
                "cat": t,
                "cl": TYPE_LABEL.get(t, t.title()),
                "c": TYPE_COLOR.get(t, "gold"),
                "b": badges,
                "kb": file_kb(it),
                "p": has_p,
                "thumb": thumb,
                "desc": it.get("description") or "",
                "slug": it["slug"],
                "shared": is_shared,
            }
        )
    return out


def render(manifest: list[dict]) -> str:
    _ = manifest  # written separately to manifest.json for the worker
    return f"""<!DOCTYPE html>
<html lang="fr" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Silex Forge</title>
<meta name="description" content="Catalogue d’artefacts HTML Silex. Pages publiques ici ; le reste derrière Cloudflare Access.">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="theme-color" content="#031635">
<link rel="icon" type="image/png" href="/images/favicon.png">
<meta property="og:type" content="website">
<meta property="og:url" content="https://forge.gosilex.com/">
<meta property="og:title" content="Silex Forge">
<meta property="og:description" content="Artefacts HTML d'équipe — decks, talks, guides.">
<meta property="og:site_name" content="Silex">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Manrope:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root {{
  --bg:#f7f9fc; --surface:#eef2f7; --surface2:#e2e9f1; --card:#ffffff;
  --border:rgba(3,22,53,0.08); --border2:rgba(3,22,53,0.15);
  --text:#031635; --text-dim:#1a2b4b; --text-xdim:#6b7a90;
  --accent:#eb7457; --accent-dim:rgba(235,116,87,0.12);
  --green:#0d7a5f;  --green-dim:rgba(13,122,95,0.10);
  --blue:#2e5f9d;   --blue-dim:rgba(46,95,157,0.12);
  --purple:#6b5b95; --purple-dim:rgba(107,91,149,0.12);
  --orange:#c46a2a; --orange-dim:rgba(196,106,42,0.12);
  --cyan:#0e7a8c;   --cyan-dim:rgba(14,122,140,0.12);
  --red:#c43c3c;    --red-dim:rgba(196,60,60,0.10);
  --gold:#b8860b;   --gold-dim:rgba(184,134,11,0.12);
  --font:'Manrope',system-ui,sans-serif;
  --display:'Instrument Serif',Georgia,serif;
  --mono:'JetBrains Mono',ui-monospace,monospace;
  --glow-a:rgba(107,159,212,.32); --glow-b:rgba(235,116,87,.14);
}}
[data-theme="dark"] {{
  --bg:#0a1220; --surface:#111b2c; --surface2:#1a2740; --card:#152033;
  --border:rgba(255,255,255,0.07); --border2:rgba(255,255,255,0.13);
  --text:#e8eef7; --text-dim:#9aabbf; --text-xdim:#5a6b82;
  --accent:#f08a70; --accent-dim:rgba(240,138,112,0.14);
  --green:#34d399;  --green-dim:rgba(52,211,153,0.12);
  --blue:#6b9fd4;   --blue-dim:rgba(107,159,212,0.14);
  --purple:#a78bfa; --purple-dim:rgba(167,139,250,0.12);
  --orange:#fb923c; --orange-dim:rgba(251,146,60,0.12);
  --cyan:#22d3ee;   --cyan-dim:rgba(34,211,238,0.12);
  --red:#f87171;    --red-dim:rgba(248,113,113,0.12);
  --gold:#fbbf24;   --gold-dim:rgba(251,191,36,0.12);
  --glow-a:rgba(107,159,212,.14); --glow-b:rgba(235,116,87,.08);
}}

*,*::before,*::after{{box-sizing:border-box;margin:0;padding:0}}
html{{font-size:15px;-webkit-font-smoothing:antialiased}}
body{{
  font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh;
  transition:background .2s,color .2s;position:relative;
}}
body::before{{
  content:"";position:fixed;inset:0;pointer-events:none;z-index:0;
  background:
    radial-gradient(56% 52% at 78% 18%, var(--glow-a) 0%, transparent 72%),
    radial-gradient(48% 46% at 12% 88%, var(--glow-b) 0%, transparent 76%);
}}
.layout{{position:relative;z-index:1;max-width:1200px;margin:0 auto;padding:28px 24px 64px}}

/* ── Header ── */
.header{{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:24px 0 20px;border-bottom:1px solid var(--border);margin-bottom:14px}}
.header-brand{{display:flex;flex-direction:column;gap:6px}}
.header-kicker{{
  display:inline-flex;align-items:center;gap:8px;align-self:flex-start;
  font-size:.62rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;
  color:var(--blue);background:var(--blue-dim);border:1px solid color-mix(in srgb,var(--blue) 35%,transparent);
  border-radius:999px;padding:4px 10px;
}}
.header-kicker-dot{{width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px var(--accent-dim)}}
.header-title{{font-family:var(--display);font-size:clamp(1.7rem,3.5vw,2.2rem);font-weight:400;letter-spacing:-0.02em;line-height:1.1}}
.header-title em{{font-style:italic;color:var(--blue)}}
.header-sub{{font-size:.8rem;color:var(--text-dim);margin-top:4px;max-width:36rem;line-height:1.45}}
.header-actions{{display:flex;align-items:center;gap:8px;flex-shrink:0}}
.theme-btn{{background:var(--surface);border:1px solid var(--border2);border-radius:6px;color:var(--text-dim);cursor:pointer;font-size:.85rem;padding:5px 10px;transition:border-color .15s,color .15s;line-height:1}}
.theme-btn:hover{{border-color:var(--accent);color:var(--accent)}}
.ghost-btn{{
  background:transparent;border:1px solid color-mix(in srgb,var(--text) 16%,transparent);
  color:var(--text-xdim);cursor:pointer;font-size:.68rem;font-weight:500;letter-spacing:.06em;
  padding:4px 9px;border-radius:6px;text-decoration:none;opacity:.65;
  transition:opacity .15s,border-color .15s,color .15s;line-height:1.2;
}}
.ghost-btn:hover{{opacity:1;color:var(--text-dim);border-color:color-mix(in srgb,var(--text) 32%,transparent)}}

/* ── Stats strip ── */
.stats{{display:flex;flex-wrap:wrap;gap:10px 18px;margin-bottom:8px;font-family:var(--mono);font-size:.72rem;color:var(--text-xdim)}}
.stats b{{color:var(--text);font-weight:500}}
.share-sync{{font-size:.62rem;opacity:.75}}
.share-sync.ok{{color:var(--green)}}
.share-sync.err{{color:var(--orange)}}
.share-sync.loading{{color:var(--text-xdim)}}

/* ── Toolbar ── */
.toolbar{{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:12px 0 16px;border-bottom:1px solid var(--border);margin-bottom:24px}}
.toolbar-left{{display:flex;align-items:center;gap:8px;flex:1;min-width:180px}}
.toolbar-right{{display:flex;flex-wrap:wrap;align-items:center;gap:8px}}
.ctrl-group{{display:flex;align-items:center;gap:5px}}
.ctrl-label{{font-size:.62rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--text-xdim);font-family:var(--mono);white-space:nowrap}}
.segs{{display:flex;background:var(--surface);border:1px solid var(--border);border-radius:6px;overflow:hidden}}
.seg{{background:none;border:none;border-right:1px solid var(--border);color:var(--text-dim);cursor:pointer;font-family:var(--font);font-size:.72rem;font-weight:500;padding:5px 11px;transition:background .12s,color .12s;white-space:nowrap}}
.seg:last-child{{border-right:none}}
.seg:hover{{background:var(--surface2);color:var(--text)}}
.seg.on{{background:var(--accent-dim);color:var(--accent);font-weight:600}}

/* ── Search ── */
.search-wrap{{position:relative;flex:1;max-width:280px}}
.search-wrap::before{{content:'⌕';position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--text-xdim);font-size:.9rem;pointer-events:none}}
.search-wrap input{{background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:var(--mono);font-size:.75rem;padding:6px 10px 6px 28px;width:100%;outline:none;transition:border-color .15s}}
.search-wrap input:focus{{border-color:var(--accent)}}
.search-wrap input::placeholder{{color:var(--text-xdim)}}
.count{{font-family:var(--mono);font-size:.65rem;color:var(--text-xdim);white-space:nowrap}}

/* ── Group section ── */
.group-sec{{margin-bottom:32px}}
.group-hdr{{display:flex;align-items:center;gap:10px;margin-bottom:14px}}
.group-tag{{font-size:.61rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;padding:2px 8px;border-radius:4px;font-family:var(--mono)}}
.group-tag.amber{{background:var(--accent-dim);color:var(--accent);border:1px solid var(--accent)}}
.group-tag.blue{{background:var(--blue-dim);color:var(--blue);border:1px solid var(--blue)}}
.group-tag.green{{background:var(--green-dim);color:var(--green);border:1px solid var(--green)}}
.group-tag.purple{{background:var(--purple-dim);color:var(--purple);border:1px solid var(--purple)}}
.group-tag.orange{{background:var(--orange-dim);color:var(--orange);border:1px solid var(--orange)}}
.group-tag.cyan{{background:var(--cyan-dim);color:var(--cyan);border:1px solid var(--cyan)}}
.group-tag.red{{background:var(--red-dim);color:var(--red);border:1px solid var(--red)}}
.group-tag.gold{{background:var(--gold-dim);color:var(--gold);border:1px solid var(--gold)}}
.group-tag.neutral{{background:var(--surface2);color:var(--text-dim);border:1px solid var(--border2)}}
.group-cnt{{font-family:var(--mono);font-size:.64rem;color:var(--text-xdim)}}

/* ── Card grid ── */
.card-grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}}
.card{{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:0;overflow:hidden;text-decoration:none;display:flex;flex-direction:column;transition:border-color .15s,transform .12s,box-shadow .15s;color:inherit;position:relative}}
.card:hover{{transform:translateY(-2px)}}
/* Full-bleed thumb: edge-to-edge card width, OG aspect ratio (1200×630) */
.card-thumb{{width:100%;aspect-ratio:1200/630;overflow:hidden;background:var(--surface2);border-bottom:1px solid var(--border);position:relative;flex-shrink:0;margin:0;padding:0;line-height:0}}
.card-thumb img{{width:100%;height:100%;object-fit:cover;object-position:top center;display:block;transition:transform .25s ease}}
.card:hover .card-thumb img{{transform:scale(1.025)}}
.card-thumb.no-preview{{display:flex;align-items:center;justify-content:center;line-height:normal;min-height:120px;aspect-ratio:1200/630}}
.card-thumb.no-preview::before{{content:'⊞';font-size:1.75rem;color:var(--text-xdim);opacity:.32;line-height:1}}
.card.amber .card-thumb.no-preview{{background:var(--accent-dim)}}
.card.blue .card-thumb.no-preview{{background:var(--blue-dim)}}
.card.green .card-thumb.no-preview{{background:var(--green-dim)}}
.card.purple .card-thumb.no-preview{{background:var(--purple-dim)}}
.card.orange .card-thumb.no-preview{{background:var(--orange-dim)}}
.card.cyan .card-thumb.no-preview{{background:var(--cyan-dim)}}
.card.red .card-thumb.no-preview{{background:var(--red-dim)}}
.card.gold .card-thumb.no-preview{{background:var(--gold-dim)}}
.card-body{{padding:12px 14px 14px;display:flex;flex-direction:column;gap:6px;flex:1}}
.card.amber:hover{{border-color:var(--accent);box-shadow:0 5px 18px rgba(235,116,87,.14)}}
.card.blue:hover{{border-color:var(--blue);box-shadow:0 5px 18px rgba(46,95,157,.14)}}
.card.green:hover{{border-color:var(--green);box-shadow:0 5px 18px rgba(13,122,95,.12)}}
.card.purple:hover{{border-color:var(--purple);box-shadow:0 5px 18px rgba(107,91,149,.14)}}
.card.orange:hover{{border-color:var(--orange);box-shadow:0 5px 18px rgba(196,106,42,.12)}}
.card.cyan:hover{{border-color:var(--cyan);box-shadow:0 5px 18px rgba(14,122,140,.12)}}
.card.red:hover{{border-color:var(--red);box-shadow:0 5px 18px rgba(196,60,60,.12)}}
.card.gold:hover{{border-color:var(--gold);box-shadow:0 5px 18px rgba(184,134,11,.12)}}
.card-title{{font-family:var(--display);font-size:1.05rem;font-weight:400;color:var(--text);line-height:1.3}}
.card-desc{{font-size:.78rem;line-height:1.45;color:var(--text-dim);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}}
.card-meta{{display:flex;align-items:center;gap:4px;flex-wrap:wrap}}
.card-meta span{{font-family:var(--mono);font-size:.62rem;color:var(--text-xdim)}}
.card-file{{font-family:var(--mono);font-size:.62rem;color:var(--text-xdim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}

/* ── List view ── */
.list-view{{display:flex;flex-direction:column;gap:1px}}
.list-item{{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:7px;text-decoration:none;color:inherit;transition:background .12s}}
.list-item:hover{{background:var(--surface)}}
.li-dot{{width:7px;height:7px;border-radius:50%;flex-shrink:0}}
.li-dot.amber{{background:var(--accent)}}
.li-dot.blue{{background:var(--blue)}}
.li-dot.green{{background:var(--green)}}
.li-dot.purple{{background:var(--purple)}}
.li-dot.orange{{background:var(--orange)}}
.li-dot.cyan{{background:var(--cyan)}}
.li-dot.red{{background:var(--red)}}
.li-dot.gold{{background:var(--gold)}}
.li-title{{font-size:.82rem;font-weight:500;color:var(--text);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
.li-cat{{font-family:var(--mono);font-size:.62rem;color:var(--text-xdim);flex-shrink:0;min-width:80px}}
.li-file{{font-family:var(--mono);font-size:.62rem;color:var(--text-xdim);flex-shrink:0}}
.li-date{{font-family:var(--mono);font-size:.62rem;color:var(--text-xdim);flex-shrink:0}}
.li-size{{font-family:var(--mono);font-size:.62rem;color:var(--text-xdim);flex-shrink:0;min-width:44px;text-align:right}}
@media(max-width:860px){{.li-file{{display:none}}}}
@media(max-width:700px){{.li-cat{{display:none}}}}

/* ── Badges ── */
.badges{{display:flex;gap:3px;flex-shrink:0;flex-wrap:wrap}}
.badge{{font-family:var(--mono);font-size:.56rem;font-weight:600;padding:1px 5px;border-radius:3px;text-transform:uppercase;letter-spacing:.05em}}
.badge.share{{background:var(--accent-dim);color:var(--accent);border:1px solid var(--accent)}}
.badge.internal{{background:var(--blue-dim);color:var(--blue);border:1px solid var(--blue)}}
.badge.latest{{background:var(--green-dim);color:var(--green);border:1px solid var(--green)}}
.badge.draft{{background:var(--orange-dim);color:var(--orange);border:1px solid var(--orange)}}

/* ── Star ── */
.star-btn{{background:none;border:none;cursor:pointer;font-size:.92rem;line-height:1;padding:2px;color:var(--text-xdim);transition:color .12s,transform .12s;flex-shrink:0}}
.star-btn:hover{{color:var(--gold);transform:scale(1.2)}}
.star-btn.on{{color:var(--gold)}}
.card .star-btn{{position:absolute;top:8px;right:8px;z-index:2;background:rgba(10,18,32,.55);border-radius:5px;backdrop-filter:blur(4px);color:#dde4f0}}
[data-theme="light"] .card .star-btn{{background:rgba(255,255,255,.82);color:var(--text-xdim)}}
[data-theme="light"] .card .star-btn.on{{color:var(--gold)}}

.empty{{padding:48px 0;text-align:center;font-size:.84rem;color:var(--text-xdim)}}
.empty code{{font-family:var(--mono);font-size:.78rem;background:var(--surface);padding:1px 6px;border-radius:3px}}
.note{{margin-top:28px;font-size:.78rem;line-height:1.55;color:var(--text-xdim);max-width:40rem}}
.note code{{font-family:var(--mono);font-size:.72rem;background:var(--surface);padding:1px 5px;border-radius:3px}}
.note a{{color:var(--blue);text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--blue) 35%,transparent)}}
footer{{margin-top:40px;padding-top:16px;border-top:1px solid var(--border);display:flex;flex-wrap:wrap;gap:10px 18px;justify-content:space-between;font-size:.75rem;color:var(--text-xdim)}}
footer a{{color:var(--text-xdim);text-decoration:none}}
footer a:hover{{color:var(--blue)}}
::-webkit-scrollbar{{width:5px;height:5px}}
::-webkit-scrollbar-track{{background:transparent}}
::-webkit-scrollbar-thumb{{background:var(--border2);border-radius:3px}}
@media(max-width:580px){{.ctrl-label{{display:none}}.seg{{padding:5px 8px;font-size:.7rem}}}}
</style>
</head>
<body>
<div class="layout">

<header class="header">
  <div class="header-brand">
    <span class="header-kicker" id="headerKicker"><span class="header-kicker-dot" aria-hidden="true"></span>Catalogue public</span>
    <div class="header-title">Forge <em>Silex</em></div>
    <div class="header-sub" id="headerSub">Pages publiques. Connexion équipe pour le reste.</div>
  </div>
  <div class="header-actions">
    <a class="ghost-btn" id="loginLink" href="/login" title="Connexion équipe">Équipe</a>
    <button class="theme-btn" id="themeBtn" title="Basculer le thème" aria-label="Basculer le thème">☀️</button>
  </div>
</header>

<div class="stats">
  <span><b id="statTotal">0</b> au catalogue</span>
  <span><b id="statPublic">0</b> publiques</span>
  <span><b id="statShared">0</b> partagées</span>
  <span id="shareSync" class="share-sync" title="État share synchronisé depuis KV (live)"></span>
</div>

<div class="toolbar">
  <div class="toolbar-left">
    <div class="search-wrap">
      <input type="search" id="search" placeholder="Filtrer…" autocomplete="off" aria-label="Filtrer le catalogue">
    </div>
    <span class="count" id="count"></span>
  </div>
  <div class="toolbar-right">
    <div class="ctrl-group">
      <span class="ctrl-label">Accès</span>
      <div class="segs">
        <button type="button" class="seg" data-k="access" data-v="all">Tous</button>
        <button type="button" class="seg" data-k="access" data-v="public">Publiques</button>
        <button type="button" class="seg" data-k="access" data-v="shared">Partagées</button>
        <button type="button" class="seg" data-k="access" data-v="private">Privées</button>
      </div>
    </div>
    <div class="ctrl-group">
      <span class="ctrl-label">Grouper</span>
      <div class="segs">
        <button type="button" class="seg" data-k="group" data-v="starred">★ Favoris</button>
        <button type="button" class="seg" data-k="group" data-v="cat">Type</button>
        <button type="button" class="seg" data-k="group" data-v="date">Date</button>
        <button type="button" class="seg" data-k="group" data-v="none">Aucun</button>
      </div>
    </div>
    <div class="ctrl-group">
      <span class="ctrl-label">Trier</span>
      <div class="segs">
        <button type="button" class="seg" data-k="sort" data-v="date-desc">Récent</button>
        <button type="button" class="seg" data-k="sort" data-v="date-asc">Ancien</button>
        <button type="button" class="seg" data-k="sort" data-v="title">A → Z</button>
      </div>
    </div>
    <div class="ctrl-group">
      <span class="ctrl-label">Vue</span>
      <div class="segs">
        <button type="button" class="seg" data-k="view" data-v="card">⊞ Cartes</button>
        <button type="button" class="seg" data-k="view" data-v="list">≡ Liste</button>
      </div>
    </div>
  </div>
</div>

<div id="content"></div>

<p class="note">
  Publier : skill <code>forge-publish</code> ou <code>plugins/silex-forge/scripts/publish.sh</code>.
  Doc Access : <code>docs/cloudflare-access.md</code>.
  Cible long terme : <a href="https://share.gosilex.com">share.gosilex.com</a> (silex-share).
  ≠ démos client (<a href="https://demo.gosilex.com">demo.gosilex.com</a>).
</p>

<footer>
  <span>© Silex · forge.gosilex.com</span>
  <a href="https://gosilex.com">gosilex.com</a>
</footer>
</div>

<script>
// ── Data from GET /api/catalogue (never embed private titles) ────
let DATA = [];
let TEAM = false;

// ── State ─────────────────────────────────────────────────────────
const LS = {{
  theme:  'silex-forge-theme',
  group:  'silex-forge-group',
  sort:   'silex-forge-sort',
  view:   'silex-forge-view',
  access: 'silex-forge-access',
  stars:  'silex-forge-stars',
}};
const S = {{
  theme:  localStorage.getItem(LS.theme)  || 'light',
  group:  localStorage.getItem(LS.group)  || 'cat',
  sort:   localStorage.getItem(LS.sort)   || 'date-desc',
  view:   localStorage.getItem(LS.view)   || 'card',
  access: localStorage.getItem(LS.access) || 'all',
  q: '',
}};
const stars = new Set(JSON.parse(localStorage.getItem(LS.stars) || '[]'));
function saveStar() {{ localStorage.setItem(LS.stars, JSON.stringify([...stars])); }}
function toggleStar(file, e) {{
  e.preventDefault(); e.stopPropagation();
  stars.has(file) ? stars.delete(file) : stars.add(file);
  saveStar(); render();
}}

const html_el    = document.documentElement;
const contentEl  = document.getElementById('content');
const countEl    = document.getElementById('count');

function escHtml(s) {{
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}}

function fmtDate(iso) {{
  if (!iso) return '—';
  const parts = iso.split('-');
  if (parts.length < 3) return iso;
  const [y,m,day] = parts;
  const months = 'janv. févr. mars avr. mai juin juil. août sept. oct. nov. déc.'.split(' ');
  return `${{months[+m-1]}} ${{+day}}, ${{y}}`;
}}

function badges(list) {{
  return (list || []).map(b => `<span class="badge ${{escHtml(b)}}">${{escHtml(b)}}</span>`).join('');
}}

function setShared(d, active) {{
  d.shared = !!active;
  const rest = (d.b || []).filter(x => x !== 'share');
  if (d.shared) rest.push('share');
  d.b = rest;
}}

function accessBadges(d) {{
  const vis = d.visibility || (d.shared ? 'shared' : 'private');
  if (vis === 'public') return badges(['public']);
  if (vis === 'shared') return badges(['share']);
  return badges(['private']);
}}

function thumbSrc(d) {{
  if (d.thumb) return d.thumb;
  const f = d.f || '';
  if (f.endsWith('.html')) return f.slice(0, -5) + '.og.jpg';
  return f.replace(/\\/?$/, '/') + 'og.jpg';
}}

function groupByKey(items, fn) {{
  const grouped = new Map();
  items.forEach(d => {{
    const k = fn(d);
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(d);
  }});
  return grouped;
}}

function mkCard(d, showCat) {{
  const a = document.createElement('a');
  a.className = `card ${{d.c}}`;
  a.href = d.f;
  const starred = stars.has(d.f);
  const catSpan = showCat
    ? `<span style="color:var(--${{d.c==='amber'?'accent':d.c}})">${{escHtml(d.cl)}}</span><span>·</span>`
    : '';
  const thumbBlock = d.p
    ? `<div class="card-thumb"><img src="${{escHtml(thumbSrc(d))}}" alt="${{escHtml(d.t)}} aperçu" loading="lazy" decoding="async"></div>`
    : `<div class="card-thumb no-preview" aria-hidden="true"></div>`;
  const desc = d.desc ? `<div class="card-desc">${{escHtml(d.desc)}}</div>` : '';
  const size = d.kb ? `<span>·</span><span>${{d.kb}} kb</span>` : '';
  a.innerHTML = `
    <button type="button" class="star-btn${{starred?' on':''}}" title="${{starred?'Retirer des favoris':'Ajouter aux favoris'}}" aria-label="${{starred?'Retirer des favoris':'Ajouter aux favoris'}}">${{starred?'★':'☆'}}</button>
    ${{thumbBlock}}
    <div class="card-body">
      <div class="badges">${{accessBadges(d)}}</div>
      <div class="card-title">${{escHtml(d.t)}}</div>
      ${{desc}}
      <div class="card-meta">${{catSpan}}<span>${{fmtDate(d.d)}}</span>${{size}}</div>
      <div class="card-file">${{escHtml(d.f)}}</div>
    </div>`;
  a.querySelector('.star-btn').addEventListener('click', e => toggleStar(d.f, e));
  if (d.p) {{
    const img = a.querySelector('.card-thumb img');
    if (img) img.addEventListener('error', () => {{
      const wrap = img.closest('.card-thumb');
      wrap.classList.add('no-preview');
      img.remove();
    }});
  }}
  return a;
}}

function mkRow(d, showCat) {{
  const a = document.createElement('a');
  a.className = 'list-item';
  a.href = d.f;
  const starred = stars.has(d.f);
  a.innerHTML = `
    <button type="button" class="star-btn${{starred?' on':''}}" title="${{starred?'Retirer des favoris':'Ajouter aux favoris'}}" aria-label="${{starred?'Retirer des favoris':'Ajouter aux favoris'}}">${{starred?'★':'☆'}}</button>
    <span class="li-dot ${{escHtml(d.c)}}"></span>
    <span class="li-title">${{escHtml(d.t)}}</span>
    <span class="badges">${{accessBadges(d)}}</span>
    ${{showCat ? `<span class="li-cat">${{escHtml(d.cl)}}</span>` : ''}}
    <span class="li-file">${{escHtml(d.f)}}</span>
    <span class="li-date">${{fmtDate(d.d)}}</span>
    <span class="li-size">${{d.kb ? d.kb + ' kb' : '—'}}</span>`;
  a.querySelector('.star-btn').addEventListener('click', e => toggleStar(d.f, e));
  return a;
}}

function mkSection(label, color, items, showCat) {{
  const sec = document.createElement('div');
  sec.className = 'group-sec';
  if (label) {{
    sec.innerHTML = `
      <div class="group-hdr">
        <span class="group-tag ${{color}}">${{escHtml(label)}}</span>
        <span class="group-cnt">${{items.length}} artefact${{items.length!==1?'s':''}}</span>
      </div>`;
  }}
  if (S.view === 'card') {{
    const g = document.createElement('div'); g.className = 'card-grid';
    items.forEach(d => g.appendChild(mkCard(d, showCat)));
    sec.appendChild(g);
  }} else {{
    const l = document.createElement('div'); l.className = 'list-view';
    items.forEach(d => l.appendChild(mkRow(d, showCat)));
    sec.appendChild(l);
  }}
  return sec;
}}

function visOf(d) {{
  return d.visibility || (d.shared ? 'shared' : 'private');
}}

function matchesAccess(d) {{
  if (S.access === 'all') return true;
  return visOf(d) === S.access;
}}

function updateShareStats() {{
  const tot = document.getElementById('statTotal');
  const pub = document.getElementById('statPublic');
  const sh = document.getElementById('statShared');
  if (tot) tot.textContent = String(DATA.length);
  if (pub) pub.textContent = String(DATA.filter(d => visOf(d) === 'public').length);
  if (sh) sh.textContent = String(DATA.filter(d => visOf(d) === 'shared').length);
}}

function setShareSync(msg, cls) {{
  const el = document.getElementById('shareSync');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'share-sync' + (cls ? ' ' + cls : '');
}}

async function loadCatalogue() {{
  setShareSync('catalogue…', 'loading');
  try {{
    const r = await fetch('/api/catalogue', {{
      credentials: 'same-origin',
      headers: {{ accept: 'application/json' }},
      cache: 'no-store',
    }});
    if (!r.ok) throw new Error('http_' + r.status);
    const data = await r.json();
    DATA = Array.isArray(data.items) ? data.items : [];
    TEAM = !!data.team;
    const login = document.getElementById('loginLink');
    const kicker = document.getElementById('headerKicker');
    const sub = document.getElementById('headerSub');
    if (TEAM) {{
      if (login) login.style.display = 'none';
      if (kicker) kicker.innerHTML = '<span class="header-kicker-dot" aria-hidden="true"></span>Équipe · Cloudflare Access';
      if (sub) sub.textContent = 'Toutes les pages. Publique = catalogue anonyme ; partagée = lien /s/… ; privée = Access.';
    }} else {{
      document.querySelectorAll('[data-k="access"][data-v="shared"],[data-k="access"][data-v="private"]').forEach(el => {{
        el.style.display = 'none';
      }});
    }}
    updateShareStats();
    render();
    setShareSync(TEAM ? 'équipe' : 'public', 'ok');
  }} catch (e) {{
    DATA = [];
    render();
    setShareSync('catalogue offline', 'err');
  }}
}}

function render() {{
  const q = S.q.toLowerCase().trim();
  let items = DATA.filter(matchesAccess);
  if (q) {{
    items = items.filter(d =>
        (d.t || '').toLowerCase().includes(q) ||
        (d.f || '').toLowerCase().includes(q) ||
        (d.cl || '').toLowerCase().includes(q) ||
        (d.desc || '').toLowerCase().includes(q) ||
        (d.slug || '').toLowerCase().includes(q));
  }}

  items.sort((a, b) => {{
    if (S.sort === 'date-desc') return (b.d||'').localeCompare(a.d||'') || (a.t||'').localeCompare(b.t||'');
    if (S.sort === 'date-asc')  return (a.d||'').localeCompare(b.d||'') || (a.t||'').localeCompare(b.t||'');
    return (a.t||'').localeCompare(b.t||'');
  }});

  contentEl.innerHTML = '';

  if (!items.length) {{
    if (!DATA.length) {{
      contentEl.innerHTML = `<div class="empty">
        <p>Aucun artefact publié pour l’instant.</p>
        <p style="margin-top:8px">Utilise <code>forge-publish</code> pour pousser un HTML sur <code>/a/&lt;slug&gt;/</code>.</p>
      </div>`;
    }} else {{
      contentEl.innerHTML = `<div class="empty">Aucun artefact ne correspond à « ${{escHtml(S.q)}} »</div>`;
    }}
    countEl.textContent = '0 résultat';
    return;
  }}

  if (S.group === 'starred') {{
    const starred = items.filter(d => stars.has(d.f));
    const rest    = items.filter(d => !stars.has(d.f));
    if (starred.length) contentEl.appendChild(mkSection('★ Favoris', 'gold', starred, true));
    if (rest.length)    contentEl.appendChild(mkSection('Autres', 'neutral', rest, true));
  }} else if (S.group === 'none') {{
    contentEl.appendChild(mkSection(null, null, items, true));
  }} else if (S.group === 'cat') {{
    const bycat = groupByKey(items, d => d.cat);
    const cats = [...bycat.keys()].sort((a, b) => {{
      const maxDate = arr => arr.reduce((m, d) => (d.d || '') > m ? d.d : m, '');
      return maxDate(bycat.get(b)).localeCompare(maxDate(bycat.get(a)));
    }});
    cats.forEach(cat => {{
      const g = bycat.get(cat);
      contentEl.appendChild(mkSection(g[0].cl, g[0].c, g, false));
    }});
  }} else {{
    const bydate = groupByKey(items, d => d.d || 'sans-date');
    // preserve sort order of dates
    const dates = [...bydate.keys()];
    if (S.sort === 'date-asc') dates.sort((a,b) => a.localeCompare(b));
    else dates.sort((a,b) => b.localeCompare(a));
    dates.forEach(date => {{
      contentEl.appendChild(mkSection(fmtDate(date === 'sans-date' ? '' : date), 'neutral', bydate.get(date), true));
    }});
  }}

  countEl.textContent = items.length < DATA.length
    ? `${{items.length}} / ${{DATA.length}}`
    : `${{DATA.length}} artefact${{DATA.length!==1?'s':''}}`;
}}

function applyTheme(t) {{
  html_el.setAttribute('data-theme', t);
  document.getElementById('themeBtn').textContent = t === 'dark' ? '🌙' : '☀️';
  localStorage.setItem(LS.theme, t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#0a1220' : '#031635');
}}
document.getElementById('themeBtn').addEventListener('click', () => {{
  S.theme = S.theme === 'dark' ? 'light' : 'dark';
  applyTheme(S.theme);
}});

document.querySelectorAll('.seg').forEach(btn => {{
  btn.addEventListener('click', () => {{
    const k = btn.dataset.k, v = btn.dataset.v;
    S[k] = v;
    localStorage.setItem(LS[k], v);
    document.querySelectorAll(`[data-k="${{k}}"]`).forEach(b => b.classList.toggle('on', b === btn));
    render();
  }});
}});

document.getElementById('search').addEventListener('input', e => {{ S.q = e.target.value; render(); }});

applyTheme(S.theme);
['group','sort','view','access'].forEach(k => {{
  document.querySelectorAll(`[data-k="${{k}}"]`).forEach(b => b.classList.toggle('on', b.dataset.v === S[k]));
}});
loadCatalogue();
document.addEventListener('visibilitychange', () => {{
  if (document.visibilityState === 'visible') loadCatalogue();
}});
window.addEventListener('focus', () => {{ loadCatalogue(); }});
</script>
</body>
</html>
"""


def main() -> int:
    items = load_items()
    manifest = to_manifest(items)
    SITE.mkdir(parents=True, exist_ok=True)
    OUT.write_text(render(manifest), encoding="utf-8")
    MANIFEST.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"✓ wrote {OUT.relative_to(ROOT)} ({len(manifest)} items)")
    print(f"✓ wrote {MANIFEST.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
