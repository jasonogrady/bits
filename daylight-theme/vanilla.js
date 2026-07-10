/* ============================================================
   theme.js — dark / light / auto theme controller
   Auto = light between local sunrise and sunset, dark otherwise.
   Location is estimated from the browser timezone (longitude from
   UTC offset, latitude from region) — no geolocation prompt.
   Runs synchronously in <head> to avoid a flash of the wrong theme.
   ============================================================ */
(function () {
  var KEY = "ogrady-theme"; // "auto" | "light" | "dark"
  var root = document.documentElement;

  function getPref() {
    // Default to light for first-time visitors; auto + dark remain selectable.
    try { return localStorage.getItem(KEY) || "light"; } catch (e) { return "light"; }
  }
  function setPref(v) {
    try { localStorage.setItem(KEY, v); } catch (e) {}
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
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "light" ? "#f6f4ef" : "#0a0a0c");
    var btns = document.querySelectorAll("[data-theme-opt]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute("aria-pressed", String(btns[i].getAttribute("data-theme-opt") === pref));
    }
  }

  // Apply immediately (before first paint) to avoid a flash.
  apply(getPref());

  // Re-evaluate Auto periodically so it flips at sunrise/sunset while open.
  setInterval(function () { if (getPref() === "auto") apply("auto"); }, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && getPref() === "auto") apply("auto");
  });

  // Wire the masthead toggle once the DOM is ready.
  function wire() {
    var btns = document.querySelectorAll("[data-theme-opt]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function () {
        var pref = this.getAttribute("data-theme-opt");
        setPref(pref);
        apply(pref);
      });
    }
    apply(getPref());
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }

  // Expose for debugging / Tweaks integration if ever needed.
  window.__theme = { apply: apply, getPref: getPref, isDaytime: isDaytime, estimateLatLng: estimateLatLng };
})();
