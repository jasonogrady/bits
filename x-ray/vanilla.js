/* ============================================================
   x-ray 🩻 — a "show me the internals" toggle
   One small persisted switch that flips an app between its clean
   face and its diagnostic one (provenance lines, freshness stamps,
   raw ids, trace panels — whatever the app decides "debug" means).

   Extracted from Manifest's 🐛 debug view. The bit owns the
   button, the persisted choice, and the change event; the app owns
   what actually gets revealed.

   The choice is tri-state: until the visitor clicks, the effective
   state follows a default the APP can set at runtime (e.g. "on for
   the owner, off for visitors"); an explicit click sticks and wins
   from then on.

   Configure via data-* attributes on the <script> tag, all optional:
     data-key        localStorage key   (default "xray")
     data-icon       button icon        (default "🩻")
     data-default    starting default   ("on"|"off", default "off");
                     apps can move it later with xray.setDefault()
     data-title-on   button title while on  (default "Hide internals")
     data-title-off  button title while off (default "Show internals")

   Mount point (auto-rendered, re-rendered on framework remounts):
     <span data-xray-toggle></span>

   Event on document:
     "xray:change"  detail {on: bool, explicit: bool} — every change,
                    including setDefault() moves while no explicit
                    choice is stored.

   API: window.xray = {
     on()            → bool   effective state
     pref()          → "on" | "off" | null (no explicit choice yet)
     set(v)          "on" | "off" | null (null clears back to default)
     toggle()
     setDefault(b)   move the no-choice default (bool)
   }

   Skin with custom properties (all optional):
     --xr-bg --xr-border --xr-color --xr-active-bg --xr-active-color
   ============================================================ */
(function () {
  var cfg = (document.currentScript && document.currentScript.dataset) || {};
  var KEY = cfg.key || "xray";
  var ICON = cfg.icon || "🩻";
  var TITLE_ON = cfg.titleOn || "Hide internals";
  var TITLE_OFF = cfg.titleOff || "Show internals";
  var defaultOn = cfg.default === "on";

  function pref() {
    try {
      var v = localStorage.getItem(KEY);
      return v === "on" || v === "off" ? v : null;
    } catch (e) { return null; }
  }
  function isOn() {
    var p = pref();
    return p != null ? p === "on" : defaultOn;
  }
  function emit(explicit) {
    document.dispatchEvent(new CustomEvent("xray:change", {
      detail: { on: isOn(), explicit: explicit },
    }));
  }
  function set(v) {
    try {
      if (v === "on" || v === "off") localStorage.setItem(KEY, v);
      else localStorage.removeItem(KEY);
    } catch (e) {}
    sync();
    emit(true);
  }
  function toggle() { set(isOn() ? "off" : "on"); }
  function setDefault(b) {
    b = !!b;
    if (b === defaultOn) return;
    defaultOn = b;
    sync();
    if (pref() == null) emit(false);
  }

  var CSS =
    ".xray-toggle{display:inline-flex}" +
    ".xray-toggle button{background:var(--xr-bg,transparent);margin:0;cursor:pointer;font:inherit;" +
      "line-height:1;padding:3px 10px;border-radius:999px;" +
      "border:1px solid var(--xr-border,rgba(127,127,127,.3));" +
      "color:var(--xr-color,inherit);transition:background .15s,color .15s,border-color .15s}" +
    ".xray-toggle button[aria-pressed=\"true\"]{" +
      "background:var(--xr-active-bg,rgba(127,127,127,.25));color:var(--xr-active-color,inherit)}";

  function injectCSS() {
    if (document.getElementById("xray-css")) return;
    var style = document.createElement("style");
    style.id = "xray-css";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function render() {
    var mounts = document.querySelectorAll("[data-xray-toggle]");
    for (var i = 0; i < mounts.length; i++) {
      var m = mounts[i];
      if (m.querySelector("[data-xray-btn]")) continue;
      m.classList.add("xray-toggle");
      m.textContent = "";
      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("data-xray-btn", "");
      var icon = document.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = ICON;
      b.appendChild(icon);
      b.addEventListener("click", toggle);
      m.appendChild(b);
    }
    sync();
  }

  function sync() {
    var on = isOn();
    var btns = document.querySelectorAll("[data-xray-btn]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute("aria-pressed", String(on));
      btns[i].title = on ? TITLE_ON : TITLE_OFF;
    }
  }

  injectCSS();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
  new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      if (muts[i].addedNodes.length) { render(); return; }
    }
  }).observe(document.body || document.documentElement, { childList: true, subtree: true });

  window.xray = { on: isOn, pref: pref, set: set, toggle: toggle, setDefault: setDefault };
})();
