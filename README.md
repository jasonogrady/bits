# bits

Small, dependency-free front-end modules I reuse across my sites. Each folder
is self-contained: copy it into your project (or vendor the one file you
need) — there's no build step, no package to install, no framework lock-in.

| Module | What it does |
|---|---|
| [`theme`](./theme) | Dark / light / **auto** theme controller — auto follows local sunrise and sunset, estimated from the browser timezone with no geolocation prompt. Vanilla drop-in, TypeScript core, and a React toggle. |
| [`version-tab`](./version-tab) | "What build am I looking at?" — a 🏷️ v8.0 chip showing the live version; click it for the release notes (every version, date, and notes). Parses plain `CHANGELOG.md` + `VERSION`; vanilla drop-in for static sites, Python module for server-fed apps. |
| [`showroom`](./showroom) | Demo-first front door for an app with private data — visitors get a 🎭 sample-data showroom with a welcome note; 📡 Live opens a sign-in dialog (SSO and/or a device key that allowlists the owner's personal devices). The app just renders whichever mode and calls `requireAuth()` on a 401. |
| [`bug-jar`](./bug-jar) | 🫙 One-tap in-app bug reports — testers tap a button, type a sentence, and the report (plus URL, app version, and recent console errors) drops into a shared Worker + D1 jar with a Buganizer-style triage dashboard, CSV reports, and optional town-crier 📯 fan-out. Drop-in client + deployable hub. |
| [`town-crier`](./town-crier) | 📯 Personal notification hub — anything that matters POSTs a note in, and it fans out to every device: ntfy → iPhone, Web Push → Mac PWA, native menu-bar app. Zero-dep Web Push crypto (VAPID + aes128gcm), every delivery status recorded. Cloudflare Pages functions + KV; the one bit that's a deployable service rather than a drop-in file. |
| [`x-ray`](./x-ray) | 🩻 A "show me the internals" toggle — one persisted button that flips an app between its clean face and its diagnostic one (provenance lines, trace panels, raw ids). Tri-state: until the visitor clicks, the effective state follows an app-set default ("on for the owner, off for visitors"); an explicit click sticks. Extracted from Manifest's 🐛 debug view. |
| [`lobby`](./lobby) | 🛎️ The front door before the showroom — a first-visit landing card centered over the app itself, blurred behind frosted glass: brand mark, tiny build line, short pitch, and three doors (see the demo · sign in · contact). Pairs with `showroom`; auto-dismisses forever once any door is used. |
| [`shop-bell`](./shop-bell) | 🔔 Visitor pulse with a bell on the door — first-party analytics that rings your phone when someone who matters walks in. Drop-in client (configurable browse + goal ⇒ qualified-lead funnel, scroll/dwell, owner opt-out) + Worker/D1 ledger with alert fan-out to a town-crier 📯 hub **and** ntfy direct. Named `pulse` on the wire because "analytics"/"track" get ad-blocked. |

## Conventions

Every module keeps to the same rules:

- **Zero dependencies.** If it needs a library, it doesn't belong here.
- **One folder, one README.** Usage, API, and the reasoning behind any
  non-obvious choices live next to the code.
- **Copy-paste is the distribution model.** Files are small enough to vendor
  and audit; pin by commit if you care about drift.
- **Vanilla first.** A plain-JS/DOM version is the source of truth; framework
  wrappers (React, etc.) sit alongside it.

MIT licensed — see [LICENSE](./LICENSE).
