import { useEffect, useState } from "react";
import type { DaylightTheme, ThemePref } from "./daylightTheme";

const OPTIONS: Array<{ pref: ThemePref; glyph: string; label: string }> = [
  { pref: "light", glyph: "☀", label: "Light theme" },
  { pref: "auto", glyph: "◐", label: "Auto theme — follows local daylight" },
  { pref: "dark", glyph: "☾", label: "Dark theme" },
];

export function ThemeToggle({ theme }: { theme: DaylightTheme }) {
  const [pref, setPref] = useState<ThemePref>(theme.getPref());
  useEffect(() => theme.subscribe((p) => setPref(p)), [theme]);

  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      {OPTIONS.map((o) => (
        <button
          key={o.pref}
          type="button"
          aria-pressed={pref === o.pref}
          aria-label={o.label}
          title={o.label}
          onClick={() => theme.setPref(o.pref)}
        >
          {o.glyph}
        </button>
      ))}
    </div>
  );
}
