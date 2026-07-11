# daylight-theme

Dark / light / **auto** theme controller. Auto means *light between local
sunrise and sunset, dark otherwise* — the sun position is computed from a
location estimated off the browser timezone (longitude from the UTC offset,
latitude from the region), so there's **no geolocation prompt** and no network
call. First seen on [ogrady.ai](https://ogrady.ai).

Three flavors, same behavior:

| File | Use when |
|---|---|
| `vanilla.js` | Plain HTML site. Inline or load it in `<head>` — it applies the theme synchronously (no flash of the wrong theme) and renders + styles the ☀ ◐ ☾ pill itself. |
| `daylightTheme.ts` | Any bundled app. Framework-agnostic core, typed, configurable. |
| `ThemeToggle.tsx` + `theme-toggle.css` | React. Renders the pill, driven by the core; the CSS file is the same skin `vanilla.js` injects. |

## How it works

- The chosen preference (`"auto" | "light" | "dark"`) persists in
  `localStorage`; the *effective* theme lands on
  `<html data-theme="light|dark">` — style against that attribute.
- Auto re-evaluates every 5 minutes and on tab focus, so an open page flips
  at sunrise/sunset.
- Sunrise/sunset use the standard solar-declination formula with the sun
  centre at −0.833° (accounts for refraction); polar day and night are
  handled.
- Optionally keeps `<meta name="theme-color">` in sync for mobile chrome.

## Vanilla usage

One script tag, one empty div. Configuration rides on `data-*` attributes of
the script tag (works inlined too); all are optional.

```html
<head>
  <!-- synchronous, before first paint -->
  <script src="vanilla.js"
          data-key="myapp-theme"
          data-default="auto"
          data-light-color="#f6f8fa"
          data-dark-color="#0d1117"></script>
</head>
<body>
  <div data-theme-toggle></div> <!-- becomes the ☀ ◐ ☾ pill -->
</body>
```

```css
:root { --bg: #fff; --text: #111; }
:root[data-theme="dark"] { --bg: #0a0a0c; --text: #eee; }
```

The pill ships with neutral defaults (translucent grays, inherits the
surrounding text color) so it looks right on any background. To skin it, set
custom properties on `.theme-toggle` — no pill CSS of your own to write:

```css
.theme-toggle {
  --tt-bg: #21262d;          /* pill background */
  --tt-border: #30363d;      /* pill border */
  --tt-color: inherit;       /* idle icon color */
  --tt-active-bg: #161b22;   /* selected button background */
  --tt-active-color: gold;   /* selected icon color */
  --tt-size: 26px;           /* button diameter */
  --tt-icon-size: 13px;
}
```

Hand-written markup still works (and wins over auto-render) — any button with
`data-theme-opt="light|auto|dark"` is wired up and gets `aria-pressed` state.

## TypeScript / React usage

```ts
// theme.ts — create once, import first so it runs before first paint
import { createDaylightTheme } from "./daylightTheme";

export const theme = createDaylightTheme({
  storageKey: "myapp-theme",     // default "daylight-theme"
  defaultPref: "auto",           // default "auto"
  themeColors: { light: "#f7f5f0", dark: "#0f172a" }, // optional
});
```

```tsx
import { theme } from "./theme";
import { ThemeToggle } from "./ThemeToggle";
import "./theme-toggle.css";     // same skin vanilla.js injects

<ThemeToggle theme={theme} />
```

The core's API: `getPref()`, `setPref(pref)`, `effective()`, `apply()`,
`isDaytime()`, and `subscribe(fn)` (returns an unsubscribe function).
`vanilla.js` exposes the same surface on `window.__theme`.

## Caveats

- The location estimate is deliberately coarse (~hundreds of km). That's fine
  for a sunrise boundary; don't reuse it for anything that needs a real
  position.
- Both flavors default first-time visitors to **auto**; override with
  `data-default` / `defaultPref`.
