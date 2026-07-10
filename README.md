# bits

Small, dependency-free front-end modules I reuse across my sites. Each folder
is self-contained: copy it into your project (or vendor the one file you
need) — there's no build step, no package to install, no framework lock-in.

| Module | What it does |
|---|---|
| [`daylight-theme`](./daylight-theme) | Dark / light / **auto** theme controller — auto follows local sunrise and sunset, estimated from the browser timezone with no geolocation prompt. Vanilla drop-in, TypeScript core, and a React toggle. |

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
