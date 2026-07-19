/* ============================================================
   showroom — demo-first front door with a gated Live mode
   Visitors land in a Demo showroom (sample data, no auth) with a
   welcome note; flipping to Live is for the site's owner and asks
   for sign-in — an SSO redirect (Google etc.), a device key that
   allowlists a personal device, or both, discovered at runtime
   from a small options endpoint.

   The bit owns the mode (persisted), the Demo/Live pill, the
   welcome note, and the sign-in dialog. The app owns the data:
   render sample data in demo, fetch real data in live, and call
   showroom.requireAuth() when a fetch comes back 401.

   Server contract (both endpoints on your API):
     GET  options-url → { "sso": { "label": "Sign in with Google",
                                   "url": "/api/auth/google" } | null,
                          "device": true|false }
     POST device-url  ← { "key": "<entered key>" }
                      → 2xx with a session cookie set, else 401.

   Configure via data-* attributes on the <script> tag, all optional:
     data-key          localStorage key       (default "showroom-mode")
     data-default      first-visit mode       (default "demo")
     data-demo-label   pill label             (default "Demo")
     data-demo-icon    pill icon              (default "🎭")
     data-live-label   pill label             (default "Live")
     data-live-icon    pill icon              (default "📡")
     data-welcome      demo-mode welcome note (default below)
     data-gate-title   sign-in dialog heading (default "Live is private")
     data-gate-text    sign-in dialog copy    (default below)
     data-device-placeholder  key input placeholder (default "Device key")
     data-device-button       key submit label (default "Authorize this device")
     data-device-error        bad-key message  (default "That key didn’t match.")
     data-options-url  auth methods endpoint  (default "/api/auth/options")
     data-device-url   device login endpoint  (default "/api/auth/device")

   Mount points (auto-rendered, re-rendered if your framework
   remounts them):
     <span data-showroom-toggle></span>   the 🎭/📡 pill
     <p data-showroom-note></p>           welcome note (demo mode only)

   Events on document:
     "showroom:mode"    detail {mode: "demo"|"live"} — every switch
     "showroom:authed"  device-key sign-in succeeded (SSO returns via
                        its own redirect, so no event for it)

   API: window.showroom = { mode(), set(mode), requireAuth() }
   Closing the dialog without signing in drops back to demo.

   Skin with custom properties (all optional):
     pill:   --sr-bg --sr-border --sr-color --sr-active-bg --sr-active-color
     dialog: --sr-dialog-bg --sr-dialog-color --sr-dialog-border
             --sr-accent (buttons)  --sr-error (bad-key message)
   ============================================================ */
(function () {
  var cfg = (document.currentScript && document.currentScript.dataset) || {};
  var KEY = cfg.key || "showroom-mode";
  var DEFAULT = cfg.default === "live" ? "live" : "demo";
  var DEMO_ICON = cfg.demoIcon || "🎭";
  var LIVE_ICON = cfg.liveIcon || "📡";
  var DEMO_LABEL = cfg.demoLabel || "Demo";
  var LIVE_LABEL = cfg.liveLabel || "Live";
  var WELCOME = cfg.welcome ||
    "Welcome — you’re in the showroom. Everything here is sample data; flip to " +
    LIVE_ICON + " " + LIVE_LABEL + " for the real thing.";
  var GATE_TITLE = cfg.gateTitle || "Live is private";
  var GATE_TEXT = cfg.gateText ||
    "This is the owner’s real data. Sign in — or keep exploring the demo.";
  var DEVICE_PLACEHOLDER = cfg.devicePlaceholder || "Device key";
  var DEVICE_BUTTON = cfg.deviceButton || "Authorize this device";
  var DEVICE_ERROR = cfg.deviceError || "That key didn’t match.";
  var OPTIONS_URL = cfg.optionsUrl || "/api/auth/options";
  var DEVICE_URL = cfg.deviceUrl || "/api/auth/device";

  function getMode() {
    try {
      var v = localStorage.getItem(KEY);
      return v === "live" || v === "demo" ? v : DEFAULT;
    } catch (e) { return DEFAULT; }
  }
  function setMode(m) {
    m = m === "live" ? "live" : "demo";
    if (m === getMode()) return;
    try { localStorage.setItem(KEY, m); } catch (e) {}
    sync();
    document.dispatchEvent(new CustomEvent("showroom:mode", { detail: { mode: m } }));
  }

  var CSS =
    ".showroom-toggle{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:999px;" +
      "background:var(--sr-bg,rgba(127,127,127,.15));border:1px solid var(--sr-border,rgba(127,127,127,.3))}" +
    ".showroom-toggle button{background:none;border:0;margin:0;padding:3px 10px;border-radius:999px;" +
      "display:inline-flex;align-items:center;gap:5px;cursor:pointer;font:inherit;line-height:1;" +
      "color:var(--sr-color,inherit);opacity:.55;transition:background .15s,color .15s,opacity .15s}" +
    ".showroom-toggle button:hover{opacity:1}" +
    ".showroom-toggle button[aria-pressed=\"true\"]{opacity:1;" +
      "background:var(--sr-active-bg,rgba(127,127,127,.25));color:var(--sr-active-color,inherit)}" +
    ".showroom-gate{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(0,0,0,.45)}" +
    ".showroom-dialog{max-width:340px;width:calc(100% - 48px);padding:24px;border-radius:12px;" +
      "background:var(--sr-dialog-bg,#fff);color:var(--sr-dialog-color,#111);" +
      "border:1px solid var(--sr-dialog-border,rgba(127,127,127,.3));text-align:center;font:inherit}" +
    "@media (prefers-color-scheme:dark){.showroom-dialog{background:var(--sr-dialog-bg,#1c1c1e);" +
      "color:var(--sr-dialog-color,#eee)}}" +
    ".showroom-dialog h2{margin:0 0 8px;font-size:1.1em}" +
    ".showroom-dialog p{margin:0 0 16px;opacity:.75;font-size:.92em}" +
    ".showroom-dialog form{display:flex;flex-direction:column;gap:8px;margin-top:12px}" +
    ".showroom-dialog input{padding:8px 10px;border-radius:8px;font:inherit;" +
      "border:1px solid var(--sr-dialog-border,rgba(127,127,127,.4));background:transparent;color:inherit}" +
    ".showroom-dialog .showroom-btn{padding:8px 12px;border-radius:8px;border:0;cursor:pointer;font:inherit;" +
      "background:var(--sr-accent,#3b82f6);color:#fff}" +
    ".showroom-dialog .showroom-btn:disabled{opacity:.5;cursor:default}" +
    ".showroom-dialog .showroom-demo-link{margin-top:14px;background:none;border:0;cursor:pointer;" +
      "font:inherit;font-size:.88em;text-decoration:underline;color:inherit;opacity:.6}" +
    ".showroom-dialog .showroom-demo-link:hover{opacity:1}" +
    ".showroom-error{color:var(--sr-error,#dc2626);font-size:.88em;margin-top:8px}";

  function injectCSS() {
    if (document.getElementById("showroom-css")) return;
    var style = document.createElement("style");
    style.id = "showroom-css";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ── Pill + welcome note ────────────────────────────────────────────────
  function pillButton(mode, icon, label, title) {
    var b = document.createElement("button");
    b.type = "button";
    b.title = title;
    b.setAttribute("data-showroom-mode", mode);
    var i = document.createElement("span");
    i.setAttribute("aria-hidden", "true");
    i.textContent = icon;
    b.appendChild(i);
    b.appendChild(document.createTextNode(label));
    b.addEventListener("click", function () { setMode(mode); });
    return b;
  }

  function render() {
    var mounts = document.querySelectorAll("[data-showroom-toggle]");
    for (var i = 0; i < mounts.length; i++) {
      var m = mounts[i];
      if (m.querySelector("[data-showroom-mode]")) continue;
      m.classList.add("showroom-toggle");
      if (!m.getAttribute("role")) m.setAttribute("role", "group");
      if (!m.getAttribute("aria-label")) m.setAttribute("aria-label", "Data mode");
      m.textContent = "";
      m.appendChild(pillButton("demo", DEMO_ICON, DEMO_LABEL, "Sample data"));
      m.appendChild(pillButton("live", LIVE_ICON, LIVE_LABEL, "Real data — sign-in required"));
    }
    var notes = document.querySelectorAll("[data-showroom-note]");
    for (var k = 0; k < notes.length; k++) {
      if (!notes[k].textContent) notes[k].textContent = WELCOME;
    }
    sync();
  }

  function sync() {
    var mode = getMode();
    var btns = document.querySelectorAll("[data-showroom-mode]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute("aria-pressed", String(btns[i].getAttribute("data-showroom-mode") === mode));
    }
    var notes = document.querySelectorAll("[data-showroom-note]");
    for (var k = 0; k < notes.length; k++) notes[k].hidden = mode !== "demo";
  }

  // ── Sign-in dialog ─────────────────────────────────────────────────────
  var gateEl = null;

  function closeGate(backToDemo) {
    if (gateEl) { gateEl.remove(); gateEl = null; }
    document.removeEventListener("keydown", onEsc);
    if (backToDemo && getMode() === "live") setMode("demo");
  }
  function onEsc(e) { if (e.key === "Escape") closeGate(true); }

  function requireAuth() {
    if (gateEl) return;
    gateEl = document.createElement("div");
    gateEl.className = "showroom-gate";
    var dialog = document.createElement("div");
    dialog.className = "showroom-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", GATE_TITLE);
    dialog.innerHTML = "<h2></h2><p></p>";
    dialog.querySelector("h2").textContent = GATE_TITLE;
    dialog.querySelector("p").textContent = GATE_TEXT;
    gateEl.appendChild(dialog);
    gateEl.addEventListener("click", function (e) {
      if (e.target === gateEl) closeGate(true);
    });
    document.addEventListener("keydown", onEsc);
    document.body.appendChild(gateEl);

    var gate = gateEl;
    fetch(OPTIONS_URL, { credentials: "include" })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; })
      .then(function (opts) {
        if (gateEl !== gate) return; // closed (or reopened) while loading
        if (opts.sso && opts.sso.url) {
          var sso = document.createElement("button");
          sso.type = "button";
          sso.className = "showroom-btn";
          sso.textContent = opts.sso.label || "Sign in";
          sso.addEventListener("click", function () { location.href = opts.sso.url; });
          dialog.appendChild(sso);
        }
        if (opts.device) {
          var form = document.createElement("form");
          var input = document.createElement("input");
          input.type = "password";
          input.placeholder = DEVICE_PLACEHOLDER;
          input.autocomplete = "current-password";
          var submit = document.createElement("button");
          submit.type = "submit";
          submit.className = "showroom-btn";
          submit.textContent = DEVICE_BUTTON;
          var err = document.createElement("div");
          err.className = "showroom-error";
          err.hidden = true;
          form.appendChild(input);
          form.appendChild(submit);
          form.appendChild(err);
          form.addEventListener("submit", function (e) {
            e.preventDefault();
            var key = input.value.trim();
            if (!key) return;
            submit.disabled = true;
            err.hidden = true;
            fetch(DEVICE_URL, {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ key: key }),
            })
              .then(function (r) {
                if (!r.ok) throw new Error(String(r.status));
                closeGate(false);
                document.dispatchEvent(new CustomEvent("showroom:authed"));
              })
              .catch(function () {
                err.textContent = DEVICE_ERROR;
                err.hidden = false;
              })
              .then(function () { submit.disabled = false; });
          });
          dialog.appendChild(form);
          input.focus();
        }
        if (!(opts.sso && opts.sso.url) && !opts.device) {
          var none = document.createElement("p");
          none.textContent = "No sign-in method is configured on this deployment.";
          dialog.appendChild(none);
        }
        var back = document.createElement("button");
        back.type = "button";
        back.className = "showroom-demo-link";
        back.textContent = "Stay in " + DEMO_ICON + " " + DEMO_LABEL;
        back.addEventListener("click", function () { closeGate(true); });
        dialog.appendChild(back);
      });
  }

  injectCSS();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
  // Frameworks (React et al.) may remount the toggle/note elements on
  // re-render — re-render bit markup whenever new mounts appear.
  new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      if (muts[i].addedNodes.length) { render(); return; }
    }
  }).observe(document.body || document.documentElement, { childList: true, subtree: true });

  // Expose for the app: read mode, set it, and open the sign-in dialog
  // (call requireAuth() when a live-data fetch returns 401).
  window.showroom = { mode: getMode, set: setMode, requireAuth: requireAuth };
})();
