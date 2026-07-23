/* ============================================================
   version-tab — "what build am I looking at?" version chip + release notes
   Renders a compact tab/chip showing the live version (🏷️ v8.0);
   clicking it opens the release notes — every version with its date
   and notes, newest first. Useful on auto-deployed pages: the served
   version bumps on the next fetch, so you can see what's live (and
   what changed) without shelling in.

   Static mode (default): fetches CHANGELOG.md (+ VERSION) as plain
   static files and parses them client-side. Configure via data-*
   attributes on the <script> tag (external or inline), all optional:
     data-changelog    CHANGELOG.md URL     (default "CHANGELOG.md")
     data-version      VERSION-file URL, or a literal version — values
                       starting with a digit (optionally "v") are
                       literals ("8.0", "v8.0"); anything else is
                       fetched (default "VERSION"). If the fetch
                       fails, falls back to the newest changelog
                       entry's version.
     data-icon         chip icon            (default "🏷️"; "" for none)
     data-loaded-text  badge caption        (default "loaded on this server")
     data-auto         "off" disables the auto-fetch (server-fed mode)

   Mount points (any number of each):
     <div data-version-tab></div>       becomes the 🏷️ v8.0 chip; click
                                        opens the release notes
     <div data-version-panel></div>     optional: render the notes here
                                        (chip toggles it) instead of the
                                        auto-created modal overlay
     <span data-version-label></span>   textContent becomes "v8.0" (for
                                        wiring into your own tab system)

   Server-fed mode: your app ships {version, changelog} in its own
   payload (see versiontab.py) and calls
     window.__versionTab.render(version, entries)
   where entries = [{version, date, html}].

   Skin with custom properties on .vt-tab / .version-tab / .vt-dialog
   (all optional) — the injected CSS is the same skin as version-tab.css:
     --vt-tab-bg  --vt-tab-border  --vt-tab-color  --vt-tab-hover-bg
     --vt-accent  --vt-accent-contrast  --vt-heading  --vt-dim
     --vt-border  --vt-border-subtle  --vt-max-width
     --vt-panel-bg  --vt-panel-color
   ============================================================ */
(function () {
  var cfg = (document.currentScript && document.currentScript.dataset) || {};
  var ICON = "icon" in cfg ? cfg.icon : "🏷️";

  // ── CHANGELOG.md parser — mirrors versiontab.py ─────────────────────────────
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Inline markdown → HTML on an escaped string: **bold**, `code`.
  function inline(s) {
    s = esc(s);
    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/`(.+?)`/g, "<code>$1</code>");
    return s;
  }

  // One entry's body — `### ` subheads, `- ` bullets (with wrapped
  // continuation lines), and plain paragraphs — into an HTML fragment.
  function bodyHtml(lines) {
    var out = [], para = [], li = [], items = [];
    function flushPara() {
      if (para.length) { out.push('<p class="vt-p">' + inline(para.join(" ")) + "</p>"); para = []; }
    }
    function flushItem() {
      if (li.length) { items.push("<li>" + inline(li.join(" ")) + "</li>"); li = []; }
    }
    function flushList() {
      flushItem();
      if (items.length) { out.push('<ul class="vt-list">' + items.join("") + "</ul>"); items = []; }
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\s+$/, "");
      if (!line.trim()) { flushPara(); flushList(); continue; }
      if (line.indexOf("### ") === 0) {
        flushPara(); flushList();
        out.push('<h4 class="vt-sub">' + inline(line.slice(4).trim()) + "</h4>");
      } else if (line.indexOf("- ") === 0) {
        flushPara(); flushItem();
        li.push(line.slice(2).trim());
      } else if ((line[0] === " " || line[0] === "\t") && (li.length || items.length)) {
        li.push(line.trim());                          // wrapped bullet continuation
      } else {
        if (li.length || items.length) flushList();
        para.push(line.trim());
      }
    }
    flushPara(); flushList();
    return out.join("");
  }

  // Full CHANGELOG.md text → [{version, date, html}], file order (newest first).
  function parse(text) {
    var entries = [], cur = null, body = [];
    var lines = String(text).split(/\r?\n/);
    function close() {
      if (cur) { cur.html = bodyHtml(body); entries.push(cur); }
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf("## ") === 0) {
        close();
        var head = line.slice(3).trim();               // e.g. "v8.0 — 2026-07-10"
        var m = head.match(/^(.*?)\s+[—–-]\s+(.*)$/);
        cur = m ? { version: m[1].trim(), date: m[2].trim() }
                : { version: head, date: "" };
        body = [];
      } else if (line.indexOf("# ") === 0) {
        continue;                                      // the "# Changelog" title
      } else if (cur !== null) {
        body.push(line);
      }
    }
    close();
    return entries;
  }

  // ── The skin — same rules as version-tab.css ────────────────────────────────
  var CSS =
    ".vt-tab{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:999px;" +
      "background:var(--vt-tab-bg,rgba(127,127,127,.15));border:1px solid var(--vt-tab-border,rgba(127,127,127,.3));" +
      "color:var(--vt-tab-color,inherit);font:inherit;font-size:13px;font-weight:600;line-height:1.4;" +
      "cursor:pointer;transition:background .15s}" +
    ".vt-tab:hover{background:var(--vt-tab-hover-bg,rgba(127,127,127,.25))}" +
    ".vt-tab-ico{font-size:14px;line-height:1}" +
    ".version-tab{max-width:var(--vt-max-width,760px)}" +
    ".vt-head{display:flex;align-items:baseline;gap:10px;margin:2px 0 18px;padding-bottom:14px;" +
      "border-bottom:1px solid var(--vt-border,rgba(127,127,127,.35))}" +
    ".vt-badge{background:var(--vt-accent,rgba(127,127,127,.22));color:var(--vt-accent-contrast,inherit);" +
      "font-weight:800;font-size:15px;padding:4px 12px;border-radius:6px;letter-spacing:.5px}" +
    ".vt-loaded{color:var(--vt-dim,rgba(127,127,127,.95));font-size:12px}" +
    ".vt-entry{padding:16px 0;border-top:1px solid var(--vt-border-subtle,rgba(127,127,127,.2))}" +
    ".vt-entry:first-of-type{border-top:none;padding-top:2px}" +
    ".vt-ver{font-size:16px;font-weight:800;margin-bottom:2px}" +
    ".vt-date{font-weight:500;font-size:12.5px;color:var(--vt-dim,rgba(127,127,127,.95))}" +
    ".vt-sub{font-size:11px;font-weight:700;color:var(--vt-heading,inherit);letter-spacing:.6px;" +
      "text-transform:uppercase;margin:14px 0 6px}" +
    ".vt-p{font-size:12.5px;line-height:1.65;margin:6px 0}" +
    ".vt-p.dim{color:var(--vt-dim,rgba(127,127,127,.95))}" +
    ".vt-list{margin:6px 0 10px;padding-left:18px}" +
    ".vt-list li{font-size:12.5px;line-height:1.6;margin-bottom:6px}" +
    ".version-tab code{background:rgba(127,127,127,.18);padding:1px 5px;border-radius:4px;" +
      "font-size:11.5px;color:var(--vt-heading,inherit)}" +
    ".vt-spin{display:inline-block;width:1em;text-align:center}" +
    ".vt-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-start;" +
      "justify-content:center;padding:6vh 16px 16px}" +
    ".vt-overlay[hidden]{display:none}" +
    ".vt-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.55)}" +
    ".vt-dialog{position:relative;background:var(--vt-panel-bg,Canvas);color:var(--vt-panel-color,CanvasText);" +
      "border:1px solid var(--vt-border,rgba(127,127,127,.35));border-radius:12px;" +
      "width:min(760px,100%);max-height:85vh;overflow:auto;padding:20px 24px;" +
      "box-shadow:0 12px 40px rgba(0,0,0,.35)}" +
    ".vt-close{float:right;position:sticky;top:0;background:none;border:0;margin:-6px -10px 0 12px;" +
      "padding:2px 8px;font:inherit;font-size:20px;line-height:1;cursor:pointer;color:inherit;opacity:.6}" +
    ".vt-close:hover{opacity:1}";

  function injectCSS() {
    if (document.getElementById("version-tab-css")) return;
    var style = document.createElement("style");
    style.id = "version-tab-css";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ── Braille spinner (loading state) ─────────────────────────────────────────
  var SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  var spinTimer = null;
  function startSpin() {
    if (spinTimer) return;
    var f = 0;
    spinTimer = setInterval(function () {
      f = (f + 1) % SPIN.length;
      var els = document.querySelectorAll(".vt-spin");
      for (var i = 0; i < els.length; i++) els[i].textContent = SPIN[f];
    }, 120);
  }
  function stopSpin() {
    if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
  }

  // ── State + render ──────────────────────────────────────────────────────────
  var state = { version: "", entries: null };   // entries null = not loaded yet

  function badge(v) {
    v = String(v == null ? "" : v).trim();
    if (!v) return "v?";
    return /^v/i.test(v) ? v : "v" + v;
  }

  function notesHtml() {
    var html =
      '<div class="vt-head">' +
        '<span class="vt-badge">' + esc(badge(state.version)) + "</span>" +
        '<span class="vt-loaded">' + esc(cfg.loadedText || "loaded on this server") + "</span>" +
      "</div>";
    if (!state.entries) {
      return html + '<p class="vt-p dim"><span class="vt-spin">⠋</span> Loading release notes…</p>';
    }
    if (!state.entries.length) {
      return html + '<p class="vt-p dim">No release notes available.</p>';
    }
    for (var i = 0; i < state.entries.length; i++) {
      var e = state.entries[i];
      html +=
        '<div class="vt-entry' + (i === 0 ? " latest" : "") + '">' +
          '<div class="vt-ver">' + esc(e.version || "") +
            (e.date ? '<span class="vt-date"> · ' + esc(e.date) + "</span>" : "") +
          "</div>" + (e.html || "") +
        "</div>";
    }
    return html;
  }

  // ── The chip — icon + live version, click opens the notes ──────────────────
  var CHIP_BODY =
    (ICON ? '<span class="vt-tab-ico">' + esc(ICON) + "</span>" : "") +
    '<span class="vt-tab-ver"><span class="vt-spin">⠋</span></span>';

  function chips() { return document.querySelectorAll("[data-version-tab]"); }
  function panels() { return document.querySelectorAll("[data-version-panel]"); }

  function renderChips() {
    var els = chips();
    for (var i = 0; i < els.length; i++) {
      var el = els[i], btn;
      if (el.tagName === "BUTTON") {
        btn = el;
      } else {
        btn = el.querySelector("button.vt-tab");
        if (!btn) {
          btn = document.createElement("button");
          btn.type = "button";
          el.appendChild(btn);
        }
      }
      if (!btn.__vtWired) {
        btn.__vtWired = true;
        btn.classList.add("vt-tab");
        btn.setAttribute("aria-haspopup", "dialog");
        btn.setAttribute("aria-expanded", "false");
        btn.title = "Release notes";
        btn.innerHTML = CHIP_BODY;
        btn.addEventListener("click", toggleNotes);
      }
      var ver = btn.querySelector(".vt-tab-ver");
      if (state.version && ver) ver.textContent = badge(state.version);
    }
  }

  function renderPanels() {
    var els = panels();
    for (var i = 0; i < els.length; i++) {
      els[i].classList.add("version-tab");
      els[i].innerHTML = notesHtml();
    }
  }

  // Feed the data in (called by static mode, or by your app in server-fed
  // mode). Updates chips, panels, [data-version-label]s, and an open overlay.
  function render(version, entries) {
    entries = entries || [];
    if (!version && entries.length) version = entries[0].version;
    state.version = version || "";
    state.entries = entries;
    stopSpin();
    renderChips();
    renderPanels();
    if (overlay && !overlay.hidden) {
      overlay.querySelector(".vt-notes").innerHTML = notesHtml();
    }
    if (state.version) {
      var labels = document.querySelectorAll("[data-version-label]");
      for (var i = 0; i < labels.length; i++) labels[i].textContent = badge(state.version);
    }
  }

  // ── The overlay (used when no [data-version-panel] is on the page) ─────────
  var overlay = null, lastTrigger = null;

  function buildOverlay() {
    overlay = document.createElement("div");
    overlay.className = "vt-overlay";
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="vt-backdrop"></div>' +
      '<div class="vt-dialog" role="dialog" aria-modal="true" aria-label="Release notes">' +
        '<button type="button" class="vt-close" aria-label="Close">×</button>' +
        '<div class="version-tab vt-notes"></div>' +
      "</div>";
    overlay.querySelector(".vt-backdrop").addEventListener("click", closeNotes);
    overlay.querySelector(".vt-close").addEventListener("click", closeNotes);
    document.body.appendChild(overlay);
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && overlay && !overlay.hidden) closeNotes();
    });
  }

  function setExpanded(v) {
    var els = chips();
    for (var i = 0; i < els.length; i++) {
      var btn = els[i].tagName === "BUTTON" ? els[i] : els[i].querySelector("button.vt-tab");
      if (btn) btn.setAttribute("aria-expanded", String(v));
    }
  }

  function openNotes(ev) {
    lastTrigger = ev && ev.currentTarget;
    var inline = panels();
    if (inline.length) {                               // inline panel(s) win over the modal
      for (var i = 0; i < inline.length; i++) inline[i].hidden = false;
      setExpanded(true);
      return;
    }
    if (!overlay) buildOverlay();
    overlay.querySelector(".vt-notes").innerHTML = notesHtml();
    overlay.hidden = false;
    if (!state.entries) startSpin();                   // still fetching
    setExpanded(true);
    overlay.querySelector(".vt-close").focus();
  }

  function closeNotes() {
    var inline = panels();
    for (var i = 0; i < inline.length; i++) inline[i].hidden = true;
    if (overlay) overlay.hidden = true;
    setExpanded(false);
    if (lastTrigger && lastTrigger.focus) lastTrigger.focus();
  }

  function isOpen() {
    if (overlay && !overlay.hidden) return true;
    var inline = panels();
    return inline.length > 0 && !inline[0].hidden;
  }

  function toggleNotes(ev) {
    if (isOpen()) closeNotes(); else openNotes(ev);
  }

  // ── Static mode — fetch + parse + render ────────────────────────────────────
  function autoload() {
    injectCSS();
    renderChips();
    // A panel next to a chip starts closed; a bare panel renders in place.
    var inline = panels();
    if (chips().length) {
      for (var i = 0; i < inline.length; i++) inline[i].hidden = true;
    }
    if (chips().length || inline.length) startSpin();  // animate ⠋ until data lands
    if (cfg.auto === "off") return;
    if (!chips().length && !inline.length &&
        !document.querySelectorAll("[data-version-label]").length) return;
    renderPanels();

    var clUrl = "changelog" in cfg ? cfg.changelog : "CHANGELOG.md";
    var vSpec = "version" in cfg ? cfg.version : "VERSION";
    var vLiteral = /^v?\d/.test(vSpec) ? vSpec : null;

    var clP = clUrl
      ? fetch(clUrl, { cache: "no-cache" })
          .then(function (r) { return r.ok ? r.text() : ""; })
          .catch(function () { return ""; })
      : Promise.resolve("");
    var vP = vLiteral
      ? Promise.resolve(vLiteral)
      : fetch(vSpec, { cache: "no-cache" })
          .then(function (r) { return r.ok ? r.text() : ""; })
          .catch(function () { return ""; });

    Promise.all([clP, vP]).then(function (res) {
      var entries = res[0] ? parse(res[0]) : [];
      render((res[1] || "").trim(), entries);
    });
  }

  injectCSS();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoload);
  } else {
    autoload();
  }

  // Expose for server-fed mode / debugging / integration.
  window.__versionTab = {
    parse: parse, render: render, refresh: autoload,
    open: openNotes, close: closeNotes, toggle: toggleNotes
  };
})();
