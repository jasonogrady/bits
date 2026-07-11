/* ============================================================
   daylight-theme — dark / light / auto theme controller
   Auto = light between local sunrise and sunset, dark otherwise.
   Location is estimated from the browser timezone (longitude from
   UTC offset, latitude from region) — no geolocation prompt.
   Runs synchronously in <head> to avoid a flash of the wrong theme.

   Configure via data-* attributes on the <script> tag (external or
   inline), all optional:
     data-key          localStorage key            (default "daylight-theme")
     data-default      first-visit pref            (default "auto")
     data-light-color  <meta theme-color> in light (meta untouched if unset)
     data-dark-color   <meta theme-color> in dark  (meta untouched if unset)

   Drop <div data-theme-toggle></div> anywhere to get the ☀ ◐ ☾ pill —
   markup and CSS are injected by this file. Skin it with custom
   properties on .theme-toggle (all optional):
     --tt-bg  --tt-border  --tt-color  --tt-active-bg  --tt-active-color
     --tt-size (button diameter)  --tt-icon-size
   ============================================================ */
(function () {
  var cfg = (document.currentScript && document.currentScript.dataset) || {};
  var KEY = cfg.key || "daylight-theme"; // "auto" | "light" | "dark"
  var DEFAULT = cfg.default || "auto";
  var root = document.documentElement;

  function getPref() {
    try { return localStorage.getItem(KEY) || DEFAULT; } catch (e) { return DEFAULT; }
  }
  function setPref(v) {
    try { localStorage.setItem(KEY, v); } catch (e) {}
    apply(v);
  }

  // Rough location from timezone — good enough for a sunrise/sunset boundary.
  function estimateLatLng() {
    // Longitude east ≈ -offsetMinutes / 4  (15° per hour, /4 per minute)
    var lng = -new Date().getTimezoneOffset() / 4;
    var lat = 40; // sensible northern mid-latitude default
    try {
      var tz = (Intl.DateTimeFormat().resolvedOptions().timeZone || "");
      var region = tz.split("/")[0];
      var byRegion = {
        America: 39, Europe: 50, Asia: 30, Africa: 5,
        Australia: -30, Pacific: -15, Antarctica: -70,
        Atlantic: 38, Indian: -20, Arctic: 78
      };
      if (byRegion.hasOwnProperty(region)) lat = byRegion[region];
      // Pull obvious southern-hemisphere cities below the equator
      if (/Sao_Paulo|Argentina|Buenos_Aires|Santiago|Montevideo|Asuncion|La_Paz|Lima|Bogota|Guayaquil|Recife|Cordoba|Fortaleza|Bahia/.test(tz)) lat = -23;
      if (/Johannesburg|Windhoek|Maputo|Harare|Gaborone/.test(tz)) lat = -26;
    } catch (e) {}
    return { lat: lat, lng: lng };
  }

  // Is it currently daytime at the estimated location?
  function isDaytime() {
    var loc = estimateLatLng();
    var now = new Date();
    var dayOfYear = Math.floor((Date.now() - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86400000);
    var decl = -23.45 * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10)) * Math.PI / 180;
    var latR = loc.lat * Math.PI / 180;
    // hour angle at sunrise/sunset (sun centre at -0.833° incl. refraction)
    var cosH = (Math.sin(-0.833 * Math.PI / 180) - Math.sin(latR) * Math.sin(decl)) /
               (Math.cos(latR) * Math.cos(decl));
    if (cosH > 1) return false;  // polar night — sun never rises
    if (cosH < -1) return true;  // polar day — sun never sets
    var H = Math.acos(cosH) * 180 / Math.PI;           // degrees
    var solarNoonUTC = 12 - loc.lng / 15;              // hours, UTC
    var sunriseUTC = solarNoonUTC - H / 15;
    var sunsetUTC = solarNoonUTC + H / 15;
    var nowUTCh = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
    return nowUTCh >= sunriseUTC && nowUTCh < sunsetUTC;
  }

  function effective(pref) {
    if (pref === "light" || pref === "dark") return pref;
    return isDaytime() ? "light" : "dark";
  }

  function apply(pref) {
    var theme = effective(pref);
    root.setAttribute("data-theme", theme);
    root.setAttribute("data-theme-pref", pref);
    if (cfg.lightColor && cfg.darkColor) {
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", theme === "light" ? cfg.lightColor : cfg.darkColor);
    }
    var btns = document.querySelectorAll("[data-theme-opt]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute("aria-pressed", String(btns[i].getAttribute("data-theme-opt") === pref));
    }
  }

  // ── The pill — same markup/CSS contract as ThemeToggle.tsx + theme-toggle.css ──
  var PILL_HTML =
    '<button type="button" data-theme-opt="light" aria-label="Light theme" title="Light">☀</button>' +
    '<button type="button" data-theme-opt="auto" aria-label="Auto theme — follows local daylight" title="Auto — follows local daylight">◐</button>' +
    '<button type="button" data-theme-opt="dark" aria-label="Dark theme" title="Dark">☾</button>';

  var PILL_CSS =
    '.theme-toggle{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:999px;' +
      'background:var(--tt-bg,rgba(127,127,127,.15));border:1px solid var(--tt-border,rgba(127,127,127,.3))}' +
    '.theme-toggle button{background:none;border:0;margin:0;padding:0;' +
      'width:var(--tt-size,26px);height:var(--tt-size,26px);border-radius:50%;' +
      'display:flex;align-items:center;justify-content:center;cursor:pointer;' +
      'font:inherit;font-size:var(--tt-icon-size,13px);line-height:1;' +
      'color:var(--tt-color,inherit);opacity:.55;transition:background .15s,color .15s,opacity .15s}' +
    '.theme-toggle button:hover{opacity:1}' +
    '.theme-toggle button[aria-pressed="true"]{opacity:1;' +
      'background:var(--tt-active-bg,rgba(127,127,127,.25));color:var(--tt-active-color,inherit)}';

  function injectCSS() {
    if (document.getElementById("daylight-theme-css")) return;
    var style = document.createElement("style");
    style.id = "daylight-theme-css";
    style.textContent = PILL_CSS;
    document.head.appendChild(style);
  }

  function renderPills() {
    var mounts = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < mounts.length; i++) {
      var m = mounts[i];
      if (m.querySelector("[data-theme-opt]")) continue; // hand-written markup wins
      m.classList.add("theme-toggle");
      if (!m.getAttribute("role")) m.setAttribute("role", "group");
      if (!m.getAttribute("aria-label")) m.setAttribute("aria-label", "Theme");
      m.innerHTML = PILL_HTML;
    }
  }

  // Apply immediately (before first paint) to avoid a flash.
  injectCSS();
  apply(getPref());

  // Re-evaluate Auto periodically so it flips at sunrise/sunset while open.
  setInterval(function () { if (getPref() === "auto") apply("auto"); }, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && getPref() === "auto") apply("auto");
  });

  // Render pills and wire every [data-theme-opt] button once the DOM is ready.
  function wire() {
    renderPills();
    var btns = document.querySelectorAll("[data-theme-opt]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function () {
        setPref(this.getAttribute("data-theme-opt"));
      });
    }
    apply(getPref());
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }

  // Expose for debugging / integration.
  window.__theme = { apply: apply, getPref: getPref, setPref: setPref, isDaytime: isDaytime, estimateLatLng: estimateLatLng };
})();
