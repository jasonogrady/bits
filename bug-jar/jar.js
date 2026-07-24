/* bug-jar 🫙 — one-tap in-app bug reports.
 *
 * Drop-in, zero-dep. Load it, then either wire an existing link:
 *
 *   BugJar.init({ mount: "#bugjar-link" });
 *
 * ...or call BugJar.init({}) with no mount to get a floating 🫙 button.
 *
 * Options:
 *   endpoint  POST target (default "/api/bug"). Point it at YOUR backend,
 *             which attaches the signed-in user and forwards to the hub with
 *             its server-side token — the hub token never ships to browsers.
 *   mount     selector or element to turn into the trigger (optional)
 *   label     floating-button title text (default "report a bug")
 *   extra     object merged into the payload (optional app context)
 *
 * Auto-captured with every report: page URL, viewport, and a ring buffer of
 * the last 20 console errors/warnings + uncaught errors. Load this file as
 * early as you can — errors thrown before it loads aren't seen.
 *
 * Deliberately written without template literals so apps can vendor it as a
 * plain string inside their own source (see bits README: copy-paste is the
 * distribution model).
 */
(function () {
  "use strict";

  /* ---- console ring buffer: starts recording the moment the file loads ---- */
  var MAX_ERRORS = 20;
  var errors = [];
  function join(args) {
    return Array.prototype.map
      .call(args, function (a) {
        if (typeof a === "string") return a;
        try { return JSON.stringify(a); } catch (_) { return String(a); }
      })
      .join(" ");
  }
  function remember(kind, msg) {
    errors.push(new Date().toISOString().slice(11, 19) + " [" + kind + "] " + String(msg).slice(0, 300));
    if (errors.length > MAX_ERRORS) errors.shift();
  }
  var origError = console.error;
  console.error = function () { remember("console.error", join(arguments)); origError.apply(console, arguments); };
  var origWarn = console.warn;
  console.warn = function () { remember("console.warn", join(arguments)); origWarn.apply(console, arguments); };
  window.addEventListener("error", function (e) {
    remember("uncaught", (e.message || "error") + " @ " + (e.filename || "?") + ":" + (e.lineno || 0));
  });
  window.addEventListener("unhandledrejection", function (e) {
    remember("unhandledrejection", e.reason);
  });

  var FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  var CSS = [
    ".bugjar-dialog { background: var(--bugjar-bg, #0d1117); color: var(--bugjar-fg, #e6edf3);",
    "  border: 1px solid var(--bugjar-border, #30363d); border-radius: 10px; padding: 1.1rem 1.2rem;",
    "  width: min(26rem, calc(100vw - 2rem)); font: inherit; }",
    ".bugjar-dialog::backdrop { background: rgba(0,0,0,.55); }",
    ".bugjar-dialog h2 { margin: 0 0 .6rem; font-size: 1.05rem; }",
    ".bugjar-dialog textarea { width: 100%; min-height: 6.5rem; box-sizing: border-box;",
    "  background: var(--bugjar-input-bg, #010409); color: inherit; border: 1px solid var(--bugjar-border, #30363d);",
    "  border-radius: 6px; padding: .5rem .6rem; font: inherit; font-size: .9rem; }",
    ".bugjar-dialog select { background: var(--bugjar-input-bg, #010409); color: inherit;",
    "  border: 1px solid var(--bugjar-border, #30363d); border-radius: 6px; padding: .35rem .5rem; font: inherit; font-size: .85rem; }",
    ".bugjar-row { display: flex; align-items: center; gap: .6rem; margin-top: .7rem; }",
    ".bugjar-row .bugjar-spacer { flex: 1; }",
    ".bugjar-dialog button { background: var(--bugjar-btn, #238636); color: #fff; border: 1px solid var(--bugjar-btn-border, #2ea043);",
    "  border-radius: 6px; padding: .4rem .9rem; font: inherit; font-size: .9rem; cursor: pointer; }",
    ".bugjar-dialog button.bugjar-cancel { background: transparent; color: var(--bugjar-muted, #8b949e); border-color: var(--bugjar-border, #30363d); }",
    ".bugjar-dialog .bugjar-note { color: var(--bugjar-muted, #8b949e); font-size: .78rem; margin: .5rem 0 0; }",
    ".bugjar-dialog .bugjar-status { font-size: .85rem; margin: .5rem 0 0; min-height: 1.2em; }",
    ".bugjar-dialog .bugjar-status.bad { color: #f85149; }",
    ".bugjar-dialog .bugjar-status.ok { color: #3fb950; }",
    ".bugjar-fab { position: fixed; right: 1rem; bottom: 1rem; z-index: 2147483000; font-size: 1.3rem;",
    "  background: var(--bugjar-bg, #0d1117); border: 1px solid var(--bugjar-border, #30363d); border-radius: 999px;",
    "  width: 2.6rem; height: 2.6rem; cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.4); }",
  ].join("\n");

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (text) n.textContent = text;
    return n;
  }

  function init(opts) {
    opts = opts || {};
    var endpoint = opts.endpoint || "/api/bug";

    if (!document.getElementById("bugjar-css")) {
      var style = el("style", { id: "bugjar-css" });
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    var dialog = el("dialog", { class: "bugjar-dialog" });
    dialog.innerHTML =
      '<h2>🫙 Report a bug</h2>' +
      '<form method="dialog">' +
      '<textarea name="body" placeholder="What happened? What did you expect?" maxlength="4000" required></textarea>' +
      '<div class="bugjar-row">' +
      '<select name="severity">' +
      '<option value="minor">minor — cosmetic</option>' +
      '<option value="normal" selected>normal — something is off</option>' +
      '<option value="major">major — feature broken</option>' +
      '<option value="blocker">blocker — cannot continue</option>' +
      "</select>" +
      '<span class="bugjar-spacer"></span>' +
      '<button type="button" class="bugjar-cancel">cancel</button>' +
      '<button type="submit" class="bugjar-submit">drop it in the jar</button>' +
      "</div>" +
      '<p class="bugjar-status"></p>' +
      '<p class="bugjar-note">The page URL, app version, and recent console errors ride along automatically.</p>' +
      "</form>";
    document.body.appendChild(dialog);

    var form = dialog.querySelector("form");
    var textarea = dialog.querySelector("textarea");
    var statusEl = dialog.querySelector(".bugjar-status");
    var submitBtn = dialog.querySelector(".bugjar-submit");
    dialog.querySelector(".bugjar-cancel").addEventListener("click", function () { dialog.close(); });

    var spinTimer = null;
    function spin(on) {
      if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
      if (on) {
        var i = 0;
        submitBtn.disabled = true;
        spinTimer = setInterval(function () {
          submitBtn.textContent = FRAMES[i++ % FRAMES.length] + " dropping…";
        }, 80);
      } else {
        submitBtn.disabled = false;
        submitBtn.textContent = "drop it in the jar";
      }
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var payload = {
        body: textarea.value.trim(),
        severity: form.severity.value,
        url: location.href,
        viewport: window.innerWidth + "x" + window.innerHeight,
        console: errors.slice(),
      };
      if (opts.extra) { for (var k in opts.extra) payload[k] = opts.extra[k]; }
      if (!payload.body) return;
      spin(true);
      statusEl.className = "bugjar-status";
      statusEl.textContent = "";
      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            spin(false);
            if (res.ok) {
              statusEl.className = "bugjar-status ok";
              statusEl.textContent = "🫙 caught — thanks!";
              setTimeout(function () {
                dialog.close();
                textarea.value = "";
                statusEl.textContent = "";
              }, 1400);
            } else {
              statusEl.className = "bugjar-status bad";
              statusEl.textContent = data.error || "Could not reach the jar (" + res.status + ").";
            }
          });
        })
        .catch(function () {
          spin(false);
          statusEl.className = "bugjar-status bad";
          statusEl.textContent = "Network error — the jar is out of reach.";
        });
    });

    function open() {
      dialog.showModal();
      textarea.focus();
    }

    var mount = opts.mount;
    if (mount) {
      var trigger = typeof mount === "string" ? document.querySelector(mount) : mount;
      if (trigger) trigger.addEventListener("click", function (e) { e.preventDefault(); open(); });
    } else {
      var fab = el("button", { class: "bugjar-fab", title: opts.label || "report a bug", "aria-label": opts.label || "report a bug" }, "🫙");
      fab.addEventListener("click", open);
      document.body.appendChild(fab);
    }

    return { open: open, close: function () { dialog.close(); } };
  }

  window.BugJar = { init: init };
})();
