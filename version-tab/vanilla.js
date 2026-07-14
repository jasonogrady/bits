/* ============================================================
   version-tab — "what build am I looking at?" changelog panel
   Renders a loaded-version badge + the project changelog (newest
   first) into a mount div, and stamps the live version number onto
   any label element (e.g. the tab button itself: "Version" → "v8.0").
   Useful on auto-deployed pages: the served version bumps on the
   next fetch, so you can see what's live without shelling in.

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
     data-loaded-text  badge caption        (default "loaded on this server")
     data-auto         "off" disables the auto-fetch (server-fed mode)

   Mount points (any number of each):
     <div data-version-tab></div>       becomes the changelog panel
     <span data-version-label></span>   textContent becomes "v8.0"

   Server-fed mode: your app ships {version, changelog} in its own
   payload (see versiontab.py) and calls
     window.__versionTab.render(version, entries)
   where entries = [{version, date, html}].

   Skin with custom properties on .version-tab (all optional) — the
   injected CSS is the same skin as version-tab.css:
     --vt-accent  --vt-accent-contrast  --vt-heading  --vt-dim
     --vt-border  --vt-border-subtle  --vt-max-width
   ============================================================ */
(function () {
  var cfg = (document.currentScript && document.currentScript.dataset) || {};

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
    ".vt-spin{display:inline-block;width:1em;text-align:center;margin-right:6px}";

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

  // ── Render ──────────────────────────────────────────────────────────────────
  function badge(v) {
    v = String(v == null ? "" : v).trim();
    if (!v) return "v?";
    return /^v/i.test(v) ? v : "v" + v;
  }

  function renderInto(el, version, entries) {
    var html =
      '<div class="vt-head">' +
        '<span class="vt-badge">' + esc(badge(version)) + "</span>" +
        '<span class="vt-loaded">' + esc(cfg.loadedText || "loaded on this server") + "</span>" +
      "</div>";
    if (!entries.length) {
      el.innerHTML = html + '<p class="vt-p dim">No changelog available.</p>';
      return;
    }
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      html +=
        '<div class="vt-entry' + (i === 0 ? " latest" : "") + '">' +
          '<div class="vt-ver">' + esc(e.version || "") +
            (e.date ? '<span class="vt-date"> · ' + esc(e.date) + "</span>" : "") +
          "</div>" + (e.html || "") +
        "</div>";
    }
    el.innerHTML = html;
  }

  // Draw into every [data-version-tab] mount and stamp every
  // [data-version-label]. Call directly in server-fed mode.
  function render(version, entries) {
    stopSpin();
    entries = entries || [];
    if (!version && entries.length) version = entries[0].version;
    var mounts = document.querySelectorAll("[data-version-tab]");
    for (var i = 0; i < mounts.length; i++) {
      mounts[i].classList.add("version-tab");
      renderInto(mounts[i], version, entries);
    }
    if (version) {
      var labels = document.querySelectorAll("[data-version-label]");
      for (var j = 0; j < labels.length; j++) labels[j].textContent = badge(version);
    }
  }

  // ── Static mode — fetch + parse + render ────────────────────────────────────
  function autoload() {
    injectCSS();
    if (cfg.auto === "off") return;
    var mounts = document.querySelectorAll("[data-version-tab]");
    if (!mounts.length) return;
    for (var i = 0; i < mounts.length; i++) {
      mounts[i].classList.add("version-tab");
      if (!mounts[i].innerHTML.trim()) {
        mounts[i].innerHTML = '<p class="vt-p dim"><span class="vt-spin">⠋</span>Loading changelog…</p>';
      }
    }
    startSpin();

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
  window.__versionTab = { parse: parse, render: render, refresh: autoload };
})();
