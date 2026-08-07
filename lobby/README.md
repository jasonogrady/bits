# lobby 🛎️ — the front door before the showroom

A first-visit landing card centered over the app itself: the real UI stays
partially visible behind a frosted-glass blur, like a lit shop seen from the
street. The card carries the brand mark, a tiny build line, a short pitch,
and three doors — **see the demo**, **sign in**, or **contact**.

Pairs naturally with the [showroom](../showroom) bit: the app maps
`lobby:demo` → showroom demo mode and `lobby:login` → showroom live (which
opens showroom's sign-in gate on the resulting 401). No hard dependency —
any app can listen for the two events.

## Drop-in

```html
<script src="/assets/lobby.js"
        data-key="myapp:lobby"
        data-image="/mascot-full.jpg"
        data-image-alt="MyApp"
        data-build="v3.1.0 · 2026-08-07"
        data-blurb="One sentence on what it does.

A second paragraph on how, if you must."
        data-demo-label="See the demo"
        data-login-label="Sign in"
        data-contact-url="https://example.com/contact"></script>
<script>
  document.addEventListener("lobby:demo", () => showroom.set("demo"));
  document.addEventListener("lobby:login", () => showroom.set("live"));
</script>
```

Auto-opens on load when the dismissal key is absent (`data-auto="false"` to
open only via `window.lobby.open()`). Any exit — demo button, backdrop click,
Escape, either door — marks it seen; it won't auto-open again on that device.
`open()` still works after dismissal, so wire it to an "About" menu item.

`data-title` adds a heading under the image — omit it when the image already
carries the wordmark. `data-blurb` splits paragraphs on blank lines.

## Events & API

- `lobby:demo` — demo button, backdrop click, or Escape
- `lobby:login` — sign-in button
- `window.lobby = { open(), close(), seen() }`

## Skin

Custom properties, set on `:root` or any ancestor: `--lb-backdrop` (dim
color), `--lb-blur` (default 7px), `--lb-bg` / `--lb-color` / `--lb-border`
(card), `--lb-accent` / `--lb-accent-contrast` (primary button), `--lb-muted`
(build line + contact link).
