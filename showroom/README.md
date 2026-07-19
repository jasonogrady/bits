# showroom

Demo-first front door for a personal app with private data. Visitors land in a
**🎭 Demo** showroom — sample data, no auth, plus a welcome note — and the
**📡 Live** mode is the owner's: flipping to it opens a sign-in dialog offering
whatever the server says is available — an SSO redirect (Google, etc.), a
**device key** that allowlists a personal device with a normal session, or
both. Closing the dialog without signing in drops gently back to Demo.

Born in [Traccoon](https://tracking.usechip.ai), a package-tracking dashboard
whose public URL shows a full showroom (every carrier, every status) while the
owner's real packages sit behind the gate.

## Division of labor

The bit owns the *mode* and the *gate*; your app owns the *data*.

- **Bit**: persists the demo/live choice (demo is the first-visit default),
  renders the 🎭/📡 pill and the welcome note, opens/closes the sign-in
  dialog, performs the device-key POST.
- **App**: renders sample data in demo mode, fetches real data in live mode,
  and calls `showroom.requireAuth()` whenever a live fetch returns **401**.
  The app never decides *whether* auth is needed — the server's 401 does.

## Usage

```html
<script src="showroom/vanilla.js"
        data-key="myapp:mode"
        data-welcome="Sample data — flip to 📡 Live for the real thing."></script>

<!-- anywhere in your chrome: -->
<span data-showroom-toggle></span>
<p data-showroom-note></p>
```

```js
document.addEventListener("showroom:mode", (e) => {
  if (e.detail.mode === "live") loadRealData(); // on 401 → showroom.requireAuth()
  else renderSampleData();
});
document.addEventListener("showroom:authed", () => loadRealData());
```

Mounts are re-rendered automatically if your framework remounts them, so the
pill can live inside a React/Vue component.

## Server contract

Two small endpoints, both reachable logged-out:

```
GET  /api/auth/options   → { "sso": { "label": "Sign in with Google",
                                      "url": "/api/auth/google" } | null,
                             "device": true }
POST /api/auth/device    ← { "key": "<entered key>" }
                         → 2xx + session cookie, or 401
```

Omit what you don't support: `"sso": null` hides the SSO button, `"device":
false` hides the key form. The device key is a single high-entropy secret
(e.g. `openssl rand -hex 16`) compared timing-safe server-side; entering it
once per personal device mints that device an ordinary session — an allowlist
without an identity provider.

## Config

All `data-*` attributes on the script tag, all optional: `data-key`,
`data-default` (`demo`|`live`), `data-demo-label`/`-icon`,
`data-live-label`/`-icon`, `data-welcome`, `data-gate-title`, `data-gate-text`,
`data-device-placeholder`, `data-device-button`, `data-device-error`,
`data-options-url`, `data-device-url`.

## Events + API

- `showroom:mode` on `document`, `detail.mode` = `"demo"` | `"live"` — every
  switch, including the dialog's fall-back-to-demo.
- `showroom:authed` — device-key sign-in succeeded (SSO comes back via its own
  redirect, so there's no event for it).
- `window.showroom` = `{ mode(), set(mode), requireAuth() }`.

## Skinning

Custom properties, all optional — pill: `--sr-bg`, `--sr-border`,
`--sr-color`, `--sr-active-bg`, `--sr-active-color`; dialog:
`--sr-dialog-bg`, `--sr-dialog-color`, `--sr-dialog-border`, `--sr-accent`,
`--sr-error`. The dialog follows `prefers-color-scheme` out of the box.
