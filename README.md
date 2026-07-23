# bits

Small, dependency-free front-end modules I reuse across my sites. Each folder
is self-contained: copy it into your project (or vendor the one file you
need) — there's no build step, no package to install, no framework lock-in.

| Module | What it does |
|---|---|
| [`theme`](./theme) | Dark / light / **auto** theme controller — auto follows local sunrise and sunset, estimated from the browser timezone with no geolocation prompt. Vanilla drop-in, TypeScript core, and a React toggle. |
| [`version-tab`](./version-tab) | "What build am I looking at?" — a 🏷️ v8.0 chip showing the live version; click it for the release notes (every version, date, and notes). Parses plain `CHANGELOG.md` + `VERSION`; vanilla drop-in for static sites, Python module for server-fed apps. |
| [`showroom`](./showroom) | Demo-first front door for an app with private data — visitors get a 🎭 sample-data showroom with a welcome note; 📡 Live opens a sign-in dialog (SSO and/or a device key that allowlists the owner's personal devices). The app just renders whichever mode and calls `requireAuth()` on a 401. |
| [`town-crier`](./town-crier) | 📯 Personal notification hub — anything that matters POSTs a note in, and it fans out to every device: ntfy → iPhone, Web Push → Mac PWA, native menu-bar app. Zero-dep Web Push crypto (VAPID + aes128gcm), every delivery status recorded. Cloudflare Pages functions + KV; the one bit that's a deployable service rather than a drop-in file. |

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
