// theme — dark / light / auto theme controller.
// Auto = light between local sunrise and sunset, dark otherwise. Location is
// estimated from the browser timezone (longitude from UTC offset, latitude
// from region) — no geolocation prompt. Framework-agnostic core.


export type ThemePref = "auto" | "light" | "dark";
export type Theme = "light" | "dark";

export interface ThemeOptions {
  /** localStorage key (default "theme") */
  storageKey?: string;
  /** first-visit preference (default "auto") */
  defaultPref?: ThemePref;
  /** values for <meta name="theme-color">, applied per effective theme (the tag is created if missing) */
  themeColors?: { light: string; dark: string };
}

export interface ThemeController {
  getPref(): ThemePref;
  setPref(pref: ThemePref): void;
  effective(pref?: ThemePref): Theme;
  apply(): void;
  isDaytime(): boolean;
  subscribe(fn: (pref: ThemePref, theme: Theme) => void): () => void;
  /** Stop the flip timer and remove listeners — for SPA/HMR teardown. */
  destroy(): void;
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

type SunTimes =
  | { polar: "day" | "night" }
  | { polar?: undefined; sunrise: number; sunset: number };

const dayOfYear = (now: Date): number =>
  Math.floor((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86400000);

const utcHours = (now: Date): number =>
  now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;

// Sunrise/sunset for a UTC day at the estimated location, in UTC hours.
function sunTimesUTC(day: number): SunTimes {
  const loc = estimateLatLng();
  const decl =
    ((-23.45 * Math.cos((2 * Math.PI / 365) * (day + 10))) * Math.PI) / 180;
  const latR = (loc.lat * Math.PI) / 180;
  // hour angle at sunrise/sunset (sun centre at -0.833° incl. refraction)
  const cosH =
    (Math.sin((-0.833 * Math.PI) / 180) - Math.sin(latR) * Math.sin(decl)) /
    (Math.cos(latR) * Math.cos(decl));
  if (cosH > 1) return { polar: "night" }; // sun never rises
  if (cosH < -1) return { polar: "day" }; // sun never sets
  const H = (Math.acos(cosH) * 180) / Math.PI; // degrees
  const solarNoonUTC = 12 - loc.lng / 15; // hours, UTC
  return { sunrise: solarNoonUTC - H / 15, sunset: solarNoonUTC + H / 15 };
}

// Is it currently daytime at the estimated location?
function isDaytime(): boolean {
  const now = new Date();
  const sun = sunTimesUTC(dayOfYear(now));
  if (sun.polar) return sun.polar === "day";
  const h = utcHours(now);
  return h >= sun.sunrise && h < sun.sunset;
}

// Milliseconds until the next sunrise/sunset boundary — when Auto next flips.
function msUntilNextFlip(): number {
  const now = new Date();
  const day = dayOfYear(now);
  const h = utcHours(now);
  const today = sunTimesUTC(day);
  let next: number | null = null;
  if (!today.polar) {
    if (h < today.sunrise) next = today.sunrise - h;
    else if (h < today.sunset) next = today.sunset - h;
  }
  if (next === null) {
    const tomorrow = sunTimesUTC(day + 1);
    if (!tomorrow.polar) next = 24 - h + tomorrow.sunrise;
  }
  if (next === null) return 6 * 3600_000; // polar day/night — recheck later
  // Land just past the boundary; the location estimate is coarse anyway.
  return Math.max(60_000, Math.min(24 * 3600_000, next * 3600_000 + 1000));
}

export function createTheme(opts: ThemeOptions = {}): ThemeController {
  const KEY = opts.storageKey ?? "theme";
  const DEFAULT = opts.defaultPref ?? "auto";
  const root = document.documentElement;
  const listeners = new Set<(pref: ThemePref, theme: Theme) => void>();
  let flipTimer: ReturnType<typeof setTimeout> | undefined;

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
    root.style.colorScheme = theme; // native controls & scrollbars follow
    if (opts.themeColors) {
      let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
      if (!meta) {
        meta = document.createElement("meta");
        meta.name = "theme-color";
        document.head.appendChild(meta);
      }
      meta.setAttribute("content", opts.themeColors[theme]);
    }
    // Auto flips exactly at the next sunrise/sunset while the page is open.
    clearTimeout(flipTimer);
    if (pref === "auto") flipTimer = setTimeout(apply, msUntilNextFlip());
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

  // Re-check on tab focus (a slept device may have missed the flip timer)…
  const onVisibility = () => {
    if (!document.hidden && getPref() === "auto") apply();
  };
  // …and follow preference changes made in other tabs.
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) apply();
  };

  // Apply immediately (call createTheme before first paint to avoid a flash).
  apply();
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("storage", onStorage);

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
    destroy() {
      clearTimeout(flipTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("storage", onStorage);
      listeners.clear();
    },
  };
}
