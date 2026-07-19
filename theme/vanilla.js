/* ============================================================
   theme — dark / light / auto theme controller
   Auto = light between local sunrise and sunset, dark otherwise.
   Location is estimated from the browser timezone (longitude from
   UTC offset, latitude from region) — no geolocation prompt.
   Runs synchronously in <head> to avoid a flash of the wrong theme.

   Configure via data-* attributes on the <script> tag (external or
   inline), all optional:
     data-key          localStorage key            (default "theme")
     data-default      first-visit pref            (default "auto")
     data-light-color  <meta theme-color> in light (tag created if missing)
     data-dark-color   <meta theme-color> in dark  (tag created if missing)

   Drop <div data-theme-toggle></div> anywhere to get the ☀ ◐ ☾ pill —
   markup and CSS are injected by this file. Skin it with custom
   properties on .theme-toggle (all optional):
     --tt-bg  --tt-border  --tt-color  --tt-active-bg  --tt-active-color
     --tt-size (button diameter)  --tt-icon-size

   Every theme change dispatches a "themechange" CustomEvent on
   window with detail { pref, theme }. Full surface on window.__theme.
   ============================================================ */
(() => {
  const cfg = (document.currentScript && document.currentScript.dataset) || {};
  const KEY = cfg.key || "theme"; // "auto" | "light" | "dark"
  const DEFAULT = cfg.default || "auto";
  const root = document.documentElement;

  function getPref() {
    try { return localStorage.getItem(KEY) || DEFAULT; } catch { return DEFAULT; }
  }
  function setPref(v) {
    try { localStorage.setItem(KEY, v); } catch { /* private mode — session-only */ }
    apply(v);
  }

  // Rough location from timezone — good enough for a sunrise/sunset boundary.
  function estimateLatLng() {
    // Longitude east ≈ -offsetMinutes / 4  (15° per hour, /4 per minute)
    const lng = -new Date().getTimezoneOffset() / 4;
    let lat = 40; // sensible northern mid-latitude default
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      const region = tz.split("/")[0];
      const byRegion = {
        America: 39, Europe: 50, Asia: 30, Africa: 5,
        Australia: -30, Pacific: -15, Antarctica: -70,
        Atlantic: 38, Indian: -20, Arctic: 78
      };
      if (region in byRegion) lat = byRegion[region];
      // Pull obvious southern-hemisphere cities below the equator
      if (/Sao_Paulo|Argentina|Buenos_Aires|Santiago|Montevideo|Asuncion|La_Paz|Lima|Bogota|Guayaquil|Recife|Cordoba|Fortaleza|Bahia/.test(tz)) lat = -23;
      if (/Johannesburg|Windhoek|Maputo|Harare|Gaborone/.test(tz)) lat = -26;
    } catch { /* keep defaults */ }
    return { lat, lng };
  }

  const dayOfYear = (now) =>
    Math.floor((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86400000);
  const utcHours = (now) =>
    now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;

  // Sunrise/sunset for a UTC day at the estimated location, in UTC hours.
  function sunTimesUTC(day) {
    const loc = estimateLatLng();
    const decl = -23.45 * Math.cos((2 * Math.PI / 365) * (day + 10)) * Math.PI / 180;
    const latR = loc.lat * Math.PI / 180;
    // hour angle at sunrise/sunset (sun centre at -0.833° incl. refraction)
    const cosH = (Math.sin(-0.833 * Math.PI / 180) - Math.sin(latR) * Math.sin(decl)) /
                 (Math.cos(latR) * Math.cos(decl));
    if (cosH > 1) return { polar: "night" }; // sun never rises
    if (cosH < -1) return { polar: "day" };  // sun never sets
    const H = Math.acos(cosH) * 180 / Math.PI; // degrees
    const solarNoonUTC = 12 - loc.lng / 15;    // hours, UTC
    return { sunrise: solarNoonUTC - H / 15, sunset: solarNoonUTC + H / 15 };
  }

  // Is it currently daytime at the estimated location?
  function isDaytime() {
    const now = new Date();
    const sun = sunTimesUTC(dayOfYear(now));
    if (sun.polar) return sun.polar === "day";
    const h = utcHours(now);
    return h >= sun.sunrise && h < sun.sunset;
  }

  // Milliseconds until the next sunrise/sunset boundary — when Auto next flips.
  function msUntilNextFlip() {
    const now = new Date();
    const day = dayOfYear(now);
    const h = utcHours(now);
    const today = sunTimesUTC(day);
    let next = null;
    if (!today.polar) {
      if (h < today.sunrise) next = today.sunrise - h;
      else if (h < today.sunset) next = today.sunset - h;
    }
    if (next === null) {
      const tomorrow = sunTimesUTC(day + 1);
      if (!tomorrow.polar) next = 24 - h + tomorrow.sunrise;
    }
    if (next === null) return 6 * 3600000; // polar day/night — recheck later
    // Land just past the boundary; the location estimate is coarse anyway.
    return Math.max(60000, Math.min(24 * 3600000, next * 3600000 + 1000));
  }

  function effective(pref) {
    if (pref === "light" || pref === "dark") return pref;
    return isDaytime() ? "light" : "dark";
  }

  let flipTimer = 0;

  function apply(pref) {
    const theme = effective(pref);
    root.setAttribute("data-theme", theme);
    root.setAttribute("data-theme-pref", pref);
    root.style.colorScheme = theme; // native controls & scrollbars follow
    if (cfg.lightColor && cfg.darkColor) {
      let meta = document.querySelector('meta[name="theme-color"]');
      if (!meta) {
        meta = document.createElement("meta");
        meta.name = "theme-color";
        document.head.appendChild(meta);
      }
      meta.setAttribute("content", theme === "light" ? cfg.lightColor : cfg.darkColor);
    }
    for (const btn of document.querySelectorAll("[data-theme-opt]")) {
      btn.setAttribute("aria-pressed", String(btn.getAttribute("data-theme-opt") === pref));
    }
    // Auto flips exactly at the next sunrise/sunset while the page is open.
    clearTimeout(flipTimer);
    if (pref === "auto") flipTimer = setTimeout(() => apply("auto"), msUntilNextFlip());
    window.dispatchEvent(new CustomEvent("themechange", { detail: { pref, theme } }));
  }

  // ── The pill — same markup/CSS contract as ThemeToggle.tsx + theme-toggle.css ──
  const PILL_HTML =
    '<button type="button" data-theme-opt="light" aria-label="Light theme" title="Light">☀</button>' +
    '<button type="button" data-theme-opt="auto" aria-label="Auto theme — follows local daylight" title="Auto — follows local daylight">◐</button>' +
    '<button type="button" data-theme-opt="dark" aria-label="Dark theme" title="Dark">☾</button>';

  const PILL_CSS = `
    .theme-toggle{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:999px;
      background:var(--tt-bg,rgba(127,127,127,.15));border:1px solid var(--tt-border,rgba(127,127,127,.3))}
    .theme-toggle button{background:none;border:0;margin:0;padding:0;
      width:var(--tt-size,26px);height:var(--tt-size,26px);border-radius:50%;
      display:flex;align-items:center;justify-content:center;cursor:pointer;
      font:inherit;font-size:var(--tt-icon-size,13px);line-height:1;
      color:var(--tt-color,inherit);opacity:.55;transition:background .15s,color .15s,opacity .15s}
    .theme-toggle button:hover{opacity:1}
    .theme-toggle button[aria-pressed="true"]{opacity:1;
      background:var(--tt-active-bg,rgba(127,127,127,.25));color:var(--tt-active-color,inherit)}`;

  function injectCSS() {
    if (document.getElementById("theme-toggle-css")) return;
    const style = document.createElement("style");
    style.id = "theme-toggle-css";
    style.textContent = PILL_CSS;
    document.head.appendChild(style);
  }

  function renderPills() {
    for (const m of document.querySelectorAll("[data-theme-toggle]")) {
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

  // Re-check on tab focus (a slept device may have missed the flip timer)…
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && getPref() === "auto") apply("auto");
  });
  // …and follow preference changes made in other tabs.
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) apply(getPref());
  });

  // Render pills and wire every [data-theme-opt] button once the DOM is ready.
  function wire() {
    renderPills();
    for (const btn of document.querySelectorAll("[data-theme-opt]")) {
      btn.addEventListener("click", () => setPref(btn.getAttribute("data-theme-opt")));
    }
    apply(getPref());
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }

  // Expose for debugging / integration.
  window.__theme = { apply, getPref, setPref, isDaytime, estimateLatLng };
})();
