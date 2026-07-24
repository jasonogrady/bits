# bug-jar 🫙 — one-tap in-app bug reports, one jar for every project

Testers tap **🫙 report a bug** inside your app, type a sentence, done. Every
report — from every project — drops into one shared jar: a Worker + D1 hub
with a triage dashboard (Buganizer-style priorities and statuses), CSV export
for reports, and optional [town-crier 📯](../town-crier) fan-out so new bugs
hit your phone the moment they're caught.

```
 caddy-shack ──┐  POST /api/bug   ┌──────────────┐  🫙 dashboard: filter, P0–P4,
 your-app ─────┼─▶ (your backend, │ bug-jar hub  │──▶ status lanes, notes, CSV
 any site ─────┘  adds identity + │ Worker + D1  │
                  JAR_TOKEN)      └──────┬───────┘
                                         └─▶ town-crier 📯 → phone / menu bar (optional)
```

| Piece | Path | What it does |
|---|---|---|
| Drop-in client | `jar.js` | 🫙 trigger + dialog; auto-captures URL, viewport, last 20 console errors; braille spinner |
| Hub | `hub/src/worker.js` | ingest + triage API + dashboard, zero deps |
| Schema | `hub/schema.sql` | one `bugs` table, idempotent |
| Smoke test | `hub/scripts/test-jar.sh` | health → ingest → triage → csv, end to end |

## Why the client talks to *your* backend, not the hub

The hub's ingest token must never ship to a browser. Each app exposes a tiny
authenticated endpoint (e.g. `POST /api/bug`) that:

1. checks the reporter is signed in (your existing session),
2. attaches identity (`reporter`), app `version`, and `ua` server-side,
3. forwards to the hub with `Authorization: Bearer JAR_TOKEN`.

That's ~30 lines in any backend, keeps the hub token secret, and means bug
reports are exactly as spam-proof as your app's login.

## Hub setup (once)

```zsh
cd hub
npx wrangler d1 create bug-jar            # paste database_id into wrangler.toml
npx wrangler d1 execute bug-jar --file schema.sql --remote
npx wrangler secret put JAR_TOKEN         # ingest (apps hold it server-side)
npx wrangler secret put JAR_ADMIN_TOKEN   # dashboard + triage
npx wrangler secret put CRIER_URL         # optional 📯
npx wrangler secret put CRIER_TOKEN       # optional 📯
npx wrangler deploy
```

Dashboard = the hub's root URL. Paste `JAR_ADMIN_TOKEN` once (localStorage).

Local dev: `cp .dev.vars.example .dev.vars`, `npx wrangler d1 execute bug-jar
--file schema.sql --local`, `npx wrangler dev` (port 8788), then
`JAR_TOKEN=devtoken JAR_ADMIN_TOKEN=admintoken scripts/test-jar.sh`.

## Wire an app

**Client** — vendor `jar.js` (copy-paste is the distribution model; it's
written without template literals so it can live inside a server-side string):

```html
<a href="#" id="bugjar-link">🫙 report a bug</a>
<script src="/jar.js"></script>
<script>BugJar.init({ mount: "#bugjar-link", endpoint: "/api/bug" });</script>
```

No `mount` → floating 🫙 button, bottom-right. `extra: {...}` merges app
context into the payload. Load `jar.js` early to catch more console errors.

**Backend** — forward with identity attached:

```js
// POST /api/bug (requires your app's session)
const payload = {
  project: "your-app",                       // ^[a-z0-9][a-z0-9._-]{0,39}$
  body: req.body.body,                       // required, ≤4000 chars
  severity: req.body.severity,               // minor | normal | major | blocker
  reporter: `${user.name} <${user.email}>`,
  url: req.body.url, viewport: req.body.viewport, console: req.body.console,
  ua: req.headers["user-agent"], version: APP_VERSION,
};
await fetch(new URL("/api/bugs", HUB_URL), {
  method: "POST",
  headers: { authorization: `Bearer ${JAR_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify(payload),
});
```

## Hub API

| Route | Auth | Does |
|---|---|---|
| `POST /api/bugs` | `JAR_TOKEN` | add a bug → `{id}`; `title` defaults to `body`'s first line |
| `GET /api/bugs` | admin | list (≤500) + per-project open counts; `?project=` `?status=open\|new\|…` `?q=` |
| `PATCH /api/bugs/:id` | admin | set `status`, `priority` (`P0`–`P4` or null), `notes` |
| `GET /api/bugs.csv` | admin | CSV export, same filters |
| `GET /` | — | dashboard (token gate) |

**Model** (borrowed from Buganizer): the reporter picks a *severity* guess
(`minor / normal / major / blocker`); the owner assigns *priority* (`P0`–`P4`)
and walks *status* through `new → assigned → fixed → verified` (or `wontfix` /
`dupe`). "Open" = `new` + `assigned`.

## Design notes

- **Two tokens, one direction each.** `JAR_TOKEN` can only add; `JAR_ADMIN_TOKEN`
  can only read/triage. Leaking an app's ingest token never exposes the jar.
- **Crier fan-out is fire-and-forget** (`ctx.waitUntil`) — a 📯 outage can't
  lose a report. Severity maps to notification priority
  (blocker→urgent, major→high, normal→default, minor→low); the note deep-links
  `#bug-<id>`, which the dashboard auto-expands.
- **No CORS on purpose.** Ingest is server-to-server; the dashboard is
  same-origin. Nothing browser-facing carries a hub token.
- **Screenshots are the one thing you give up** vs. paid widgets — can't do
  them zero-dep. The console ring buffer + URL + version cover most of it.
- Delivery failures are answered, not swallowed: the dialog shows the hub's
  actual error, and crier failures land in the Worker logs.
