// daylight-theme — dark / light / auto theme controller.
// Auto = light between local sunrise and sunset, dark otherwise. Location is
// estimated from the browser timezone (longitude from UTC offset, latitude
// from region) — no geolocation prompt. Framework-agnostic core.


export type ThemePref = "auto" | "light" | "dark";
export type Theme = "light" | "dark";

export interface DaylightThemeOptions {
  /** localStorage key (default "daylight-theme") */
  storageKey?: string;
  /** first-visit preference (default "auto") */
  defaultPref?: ThemePref;
  /** values for <meta name="theme-color">, applied per effective theme */
  themeColors?: { light: string; dark: string };
}

export interface DaylightTheme {
  getPref(): ThemePref;
  setPref(pref: ThemePref): void;
  effective(pref?: ThemePref): Theme;
  apply(): void;
  isDaytime(): boolean;
  subscribe(fn: (pref: ThemePref, theme: Theme) => void): () => void;
}

// Rough location from timezone — good enough for a sunrise/sunset boundary.
function estimateLatLng(): { lat: number; lng: number } {
  // Longitude east ≈ -offsetMinutes / 4 (15° per hour, /4 per minute)
  const lng = -new Date().getTimezoneOffset() / 4;
  let lat = 40; // sensible northern mid-latitude default
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    const region = tz.split("/")[0];
    const byRegion: Record<string, number> = {
      America: 39, Europe: 50, Asia: 30, Africa: 5,
      Australia: -30, Pacific: -15, Antarctica: -70,
      Atlantic: 38, Indian: -20, Arctic: 78,
    };
    if (region in byRegion) lat = byRegion[region];
    // Pull obvious southern-hemisphere cities below the equator
    if (/Sao_Paulo|Argentina|Buenos_Aires|Santiago|Montevideo|Asuncion|La_Paz|Lima|Bogota|Guayaquil|Recife|Cordoba|Fortaleza|Bahia/.test(tz)) lat = -23;
    if (/Johannesburg|Windhoek|Maputo|Harare|Gaborone/.test(tz)) lat = -26;
  } catch {
    /* keep defaults */
  }
  return { lat, lng };
}

// Is it currently daytime at the estimated location?
function isDaytime(): boolean {
  const loc = estimateLatLng();
  const now = new Date();
  const dayOfYear = Math.floor(
    (Date.now() - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86400000,
  );
  const decl =
    ((-23.45 * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10))) * Math.PI) / 180;
  const latR = (loc.lat * Math.PI) / 180;
  // hour angle at sunrise/sunset (sun centre at -0.833° incl. refraction)
  const cosH =
    (Math.sin((-0.833 * Math.PI) / 180) - Math.sin(latR) * Math.sin(decl)) /
    (Math.cos(latR) * Math.cos(decl));
  if (cosH > 1) return false; // polar night — sun never rises
  if (cosH < -1) return true; // polar day — sun never sets
  const H = (Math.acos(cosH) * 180) / Math.PI; // degrees
  const solarNoonUTC = 12 - loc.lng / 15; // hours, UTC
  const sunriseUTC = solarNoonUTC - H / 15;
  const sunsetUTC = solarNoonUTC + H / 15;
  const nowUTCh =
    now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  return nowUTCh >= sunriseUTC && nowUTCh < sunsetUTC;
}

export function createDaylightTheme(opts: DaylightThemeOptions = {}): DaylightTheme {
  const KEY = opts.storageKey ?? "daylight-theme";
  const DEFAULT = opts.defaultPref ?? "auto";
  const root = document.documentElement;
  const listeners = new Set<(pref: ThemePref, theme: Theme) => void>();

  function getPref(): ThemePref {
    try {
      return (localStorage.getItem(KEY) as ThemePref) || DEFAULT;
    } catch {
      return DEFAULT;
    }
  }

  function effective(pref: ThemePref = getPref()): Theme {
    if (pref === "light" || pref === "dark") return pref;
    return isDaytime() ? "light" : "dark";
  }

  function apply(): void {
    const pref = getPref();
    const theme = effective(pref);
    root.setAttribute("data-theme", theme);
    root.setAttribute("data-theme-pref", pref);
    if (opts.themeColors) {
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", opts.themeColors[theme]);
    }
    listeners.forEach((l) => l(pref, theme));
  }

  function setPref(pref: ThemePref): void {
    try {
      localStorage.setItem(KEY, pref);
    } catch {
      /* private mode — session-only */
    }
    apply();
  }

  // Apply immediately (call createDaylightTheme before first paint to avoid
  // a flash), then re-evaluate Auto so it flips at sunrise/sunset while open.
  apply();
  setInterval(() => {
    if (getPref() === "auto") apply();
  }, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && getPref() === "auto") apply();
  });

  return {
    getPref,
    setPref,
    effective,
    apply,
    isDaytime,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
