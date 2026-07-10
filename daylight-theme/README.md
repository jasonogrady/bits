# daylight-theme

Dark / light / **auto** theme controller. Auto means *light between local
sunrise and sunset, dark otherwise* — the sun position is computed from a
location estimated off the browser timezone (longitude from the UTC offset,
latitude from the region), so there's **no geolocation prompt** and no network
call. First seen on [ogrady.ai](https://ogrady.ai).

Three flavors, same behavior:

| File | Use when |
|---|---|
| `vanilla.js` | Plain HTML site. Inline or load it in `<head>` — it applies the theme synchronously, so no flash of the wrong theme. |
| `daylightTheme.ts` | Any bundled app. Framework-agnostic core, typed, configurable. |
| `ThemeToggle.tsx` | React. Renders the ☀ ◐ ☾ pill, driven by the core. |

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

```html
<head>
  <script src="vanilla.js"></script> <!-- synchronous, before first paint -->
</head>
<body>
  <div class="theme-toggle" role="group" aria-label="Theme">
    <button type="button" data-theme-opt="light" aria-label="Light theme">☀</button>
    <button type="button" data-theme-opt="auto" aria-label="Auto theme — follows local daylight">◐</button>
    <button type="button" data-theme-opt="dark" aria-label="Dark theme">☾</button>
  </div>
</body>
```

```css
:root { --bg: #fff; --text: #111; }
:root[data-theme="dark"] { --bg: #0a0a0c; --text: #eee; }
```

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

<ThemeToggle theme={theme} />
```

The core's API: `getPref()`, `setPref(pref)`, `effective()`, `apply()`,
`isDaytime()`, and `subscribe(fn)` (returns an unsubscribe function).

## Caveats

- The location estimate is deliberately coarse (~hundreds of km). That's fine
  for a sunrise boundary; don't reuse it for anything that needs a real
  position.
- `vanilla.js` defaults first-time visitors to **light**; the TS core
  defaults to **auto**. Both are one-line changes.
