# x-ray 🩻 — a "show me the internals" toggle

One small persisted switch that flips an app between its clean face and its
diagnostic one — provenance lines, freshness stamps, raw ids, trace panels,
whatever the app decides "debug" means. Extracted from
[Manifest](https://getmanife.st)'s 🐛 debug view.

The bit owns the button, the persisted choice, and the change event; **the app
owns what actually gets revealed** — subscribe to `xray:change` (or call
`window.xray.on()`) and render accordingly.

The choice is deliberately **tri-state**: until the visitor clicks, the
effective state follows a default the app can move at runtime — the pattern
that motivated this bit is *"internals on for the signed-in owner, off for
first-time visitors"* (`xray.setDefault(isOwner)`). An explicit click sticks
in localStorage and wins from then on.

## Drop-in

```html
<span data-xray-toggle></span>
<script src="/assets/x-ray.js"
        data-key="myapp:debug"
        data-icon="🐛"
        data-title-on="Hide debug info"
        data-title-off="Show debug info"></script>
<script>
  document.addEventListener("xray:change", (e) => {
    document.body.classList.toggle("debug", e.detail.on);
  });
</script>
```

All `data-*` attributes are optional: `data-key` (localStorage key, default
`xray`), `data-icon` (default 🩻), `data-default` (`on`|`off`, default `off`),
`data-title-on` / `data-title-off` (button tooltips).

## API

```js
window.xray.on()          // → bool, the effective state
window.xray.pref()        // → "on" | "off" | null (no explicit choice yet)
window.xray.set("on")     // explicit; null clears back to the default
window.xray.toggle()
window.xray.setDefault(b) // move the no-choice default (e.g. on sign-in)
```

`xray:change` fires on `document` with `detail: { on, explicit }` — `explicit`
is false when the state moved because `setDefault()` changed it for a visitor
who hasn't clicked yet.

## Skin

Custom properties on the mount (or an ancestor): `--xr-bg`, `--xr-border`,
`--xr-color`, `--xr-active-bg`, `--xr-active-color`.
