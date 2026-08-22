/* forge share-bar — interne (Access) / externe (/s/ + shlink) + toast + revoke
 * window.__FORGE_SHARE__ = { slug?, shareUrl?, shortUrl? }
 * slug déduit du path /a/<slug>/ si absent.
 */
(function () {
  if (window.__FORGE_SHARE_BAR__) return;
  window.__FORGE_SHARE_BAR__ = true;

  var cfg = window.__FORGE_SHARE__ || {};
  var slug = cfg.slug || "";
  if (!slug) {
    var m = location.pathname.match(/^\/a\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?/);
    if (m) slug = m[1];
  }
  if (!slug || location.pathname.indexOf("/a/") !== 0) return;

  var state = {
    visibility: "private",
    shareUrl: "",
    shortUrl: "",
  };

  /* ── styles ───────────────────────────────────────────── */
  var css = document.createElement("style");
  css.textContent =
    "[data-forge-share-bar]{position:fixed;top:12px;right:12px;z-index:2147483646;" +
    "display:flex;gap:6px;align-items:center;" +
    "font-family:system-ui,-apple-system,sans-serif;" +
    "background:rgba(254,254,254,.92);backdrop-filter:blur(10px);" +
    "border:1px solid rgba(3,22,53,.12);padding:4px;box-shadow:0 8px 28px rgba(3,22,53,.12)}" +
    "[data-forge-share-bar] .fsb-switch{display:flex;border:1px solid rgba(3,22,53,.14);overflow:hidden;border-radius:6px}" +
    "[data-forge-share-bar] .fsb-switch button{cursor:pointer;border:none;border-right:1px solid rgba(3,22,53,.12);" +
    "background:transparent;color:#6b7a90;padding:6px 10px;font-weight:600;font-size:11.5px;" +
    "font-family:inherit;line-height:1.2;letter-spacing:.02em;transition:background .12s,color .12s}" +
    "[data-forge-share-bar] .fsb-switch button:last-child{border-right:none}" +
    "[data-forge-share-bar] .fsb-switch button:hover:not(:disabled):not(.on){background:#eef2f7;color:#031635}" +
    "[data-forge-share-bar] .fsb-switch button.on{background:#031635;color:#FEFEFE}" +
    "[data-forge-share-bar] .fsb-switch button:disabled{opacity:.55;cursor:wait}" +
    "[data-forge-share-bar] .fsb-copy{cursor:pointer;border:none;background:transparent;color:#6b7a90;" +
    "width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;padding:0;border-radius:6px}" +
    "[data-forge-share-bar] .fsb-copy:hover:not(:disabled){background:#eef2f7;color:#031635}" +
    "[data-forge-share-bar] .fsb-copy:disabled{opacity:.55;cursor:wait}" +
    "[data-forge-share-bar] .fsb-copy svg{display:block}" +
    "[data-forge-toast]{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(12px);" +
    "z-index:2147483647;background:#031635;color:#FEFEFE;padding:12px 18px;font:600 13px system-ui,sans-serif;" +
    "box-shadow:0 10px 32px rgba(3,22,53,.28);opacity:0;pointer-events:none;" +
    "transition:opacity .18s ease,transform .18s ease;max-width:min(92vw,360px);text-align:center}" +
    "[data-forge-toast].on{opacity:1;transform:translateX(-50%) translateY(0)}" +
    "[data-forge-toast].err{background:#c43c3c}";
  document.documentElement.appendChild(css);

  /* ── toast ────────────────────────────────────────────── */
  var toastEl = document.createElement("div");
  toastEl.setAttribute("data-forge-toast", "1");
  toastEl.setAttribute("role", "status");
  toastEl.setAttribute("aria-live", "polite");
  document.documentElement.appendChild(toastEl);
  var toastTimer = null;

  function toast(msg, isErr) {
    toastEl.textContent = msg;
    toastEl.classList.toggle("err", !!isErr);
    toastEl.classList.add("on");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove("on");
    }, 2400);
  }

  /* ── bar (équipe only — hidden until GET /api/visibility 200) ── */
  var bar = document.createElement("div");
  bar.setAttribute("data-forge-share-bar", "1");
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Visibilité forge");
  bar.style.display = "none";

  function mkSeg(label, vis, title) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.dataset.vis = vis;
    b.title = title;
    return b;
  }

  var sw = document.createElement("div");
  sw.className = "fsb-switch";
  sw.setAttribute("role", "radiogroup");
  sw.setAttribute("aria-label", "Visibilité");

  var privateBtn = mkSeg("Privé", "private", "Équipe seulement");
  var sharedBtn = mkSeg("Partagé", "shared", "Lien secret — pas au catalogue public");
  var publicBtn = mkSeg("Public", "public", "Listée au catalogue public");
  sw.appendChild(privateBtn);
  sw.appendChild(sharedBtn);
  sw.appendChild(publicBtn);

  var copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "fsb-copy";
  copyBtn.title = "Copier le lien";
  copyBtn.setAttribute("aria-label", "Copier le lien");
  copyBtn.innerHTML =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

  bar.appendChild(sw);
  bar.appendChild(copyBtn);
  document.documentElement.appendChild(bar);

  function setBusy(on) {
    privateBtn.disabled = on;
    sharedBtn.disabled = on;
    publicBtn.disabled = on;
    copyBtn.disabled = on;
  }

  function renderState() {
    [privateBtn, sharedBtn, publicBtn].forEach(function (b) {
      var on = b.dataset.vis === state.visibility;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
      b.setAttribute("role", "radio");
    });
  }

  function copyText(url) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(url);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement("textarea");
        ta.value = url;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;left:-9999px;top:0";
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (ok) resolve();
        else reject(new Error("copy_failed"));
      } catch (e) {
        reject(e);
      }
    });
  }

  function pageUrl() {
    return location.origin + "/a/" + slug + "/";
  }

  function currentCopyUrl() {
    if (state.visibility === "shared") return state.shortUrl || state.shareUrl || pageUrl();
    return pageUrl();
  }

  function apiVis(method, body) {
    var q = method === "GET" ? "?slug=" + encodeURIComponent(slug) : "";
    var opts = {
      method: method,
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
    };
    if (body) opts.body = JSON.stringify(body);
    return fetch("/api/visibility" + q, opts).then(function (r) {
      return r.json().then(function (data) {
        if (r.status === 401) throw new Error("unauthorized");
        if (!r.ok) throw new Error(data.error || "error_" + r.status);
        return data;
      });
    });
  }

  function applyVis(data) {
    state.visibility = data.visibility || "private";
    state.shareUrl = data.shareUrl || "";
    state.shortUrl = data.shortUrl || "";
    renderState();
  }

  function setVis(vis, copyAfter) {
    setBusy(true);
    return apiVis("POST", { slug: slug, visibility: vis })
      .then(function (data) {
        applyVis(data);
        var msg =
          vis === "public"
            ? "Page publique — listée au catalogue"
            : vis === "shared"
              ? "Lien partagé (pas au catalogue public)"
              : "Page privée — équipe seulement";
        if (copyAfter) {
          var url = currentCopyUrl();
          return copyText(url).then(function () {
            toast(
              msg +
                (vis === "shared" && !state.shortUrl
                  ? " · lien direct copié (raccourci indisponible)"
                  : " · lien copié"),
            );
          });
        }
        toast(msg);
      })
      .catch(function (err) {
        console.error("[forge vis]", err);
        toast("Échec — connecte-toi (Access)", true);
      })
      .finally(function () {
        setBusy(false);
      });
  }

  function onSeg(vis, copyAfter) {
    if (state.visibility === vis) {
      if (vis === "shared" && copyAfter) setVis(vis, true);
      return;
    }
    setVis(vis, copyAfter);
  }
  privateBtn.addEventListener("click", function () {
    onSeg("private", false);
  });
  sharedBtn.addEventListener("click", function () {
    onSeg("shared", true);
  });
  publicBtn.addEventListener("click", function () {
    onSeg("public", true);
  });
  copyBtn.addEventListener("click", function () {
    if (state.visibility === "shared") {
      setVis("shared", true);
      return;
    }
    var url = currentCopyUrl();
    setBusy(true);
    copyText(url)
      .then(function () {
        toast("Lien copié");
      })
      .catch(function () {
        toast("Impossible de copier — " + url, true);
      })
      .finally(function () {
        setBusy(false);
      });
  });

  apiVis("GET")
    .then(function (data) {
      bar.style.display = "";
      applyVis(data);
    })
    .catch(function () {
      /* anonymous on a public page — no toolbar */
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    });
})();
