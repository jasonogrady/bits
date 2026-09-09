# guestbook 📝 — "get notified" signups, PIN-gated admin, notification fan-out

A drop-in for any Cloudflare Worker site: a signup form (first, last, email,
note/referral), a thanks page that returns to the landing page, and an
`/admin` dashboard behind a PIN with signup metrics, the full list newest
first, CSV export, Sheets export, and per-channel notification settings.
Every signup fans out to [town-crier 📯](../town-crier), ntfy, and email; SMS
is a settings-level stub until it's wired. Zero deps, one file + one schema.

```
 landing page ──▶ /signup ──▶ D1 (gb_signups) ──▶ notify ─┬─▶ town-crier 📯 → every device
        ▲             │                                   ├─▶ ntfy → iPhone
        └── /thanks ◀─┘                                   ├─▶ email (Resend)
                                                          └─▶ sms (stub)
 ADMIN button (cookie hint) ──▶ /admin (PIN) ──▶ tiles · table · CSV · Sheets · 🔔 settings · send test
```

| Piece | Path | What it does |
|---|---|---|
| Worker module | `worker.js` | routes, auth, fan-out, all pages inline |
| Schema | `schema.sql` | `gb_signups`, `gb_settings`, `gb_attempts` — idempotent |
| Smoke test | `scripts/test.sh` | signup → honeypot → PIN → api → csv → settings → test note |

## Wire it

```js
// src/worker.js
import { handleGuestbook } from "./guestbook/worker.js";
export default {
  async fetch(request, env, ctx) {
    return (await handleGuestbook(request, env, ctx)) || env.ASSETS.fetch(request);
  },
};
```

```jsonc
// wrangler.jsonc
"main": "src/worker.js",
"assets": { "directory": "./public", "binding": "ASSETS",
            "run_worker_first": ["/signup", "/thanks", "/login", "/admin", "/admin/*"] },
"d1_databases": [{ "binding": "DB", "database_name": "…", "database_id": "…" }]
```

```zsh
npx wrangler d1 create <name>                      # paste id into wrangler.jsonc
npx wrangler d1 execute <name> --remote --file schema.sql
npx wrangler secret put ADMIN_PIN                  # required
npx wrangler secret put CRIER_URL                  # https://ogrady.ai/api/crier/notify
npx wrangler secret put CRIER_TOKEN
npx wrangler secret put NTFY_TOPIC                 # + NTFY_AUTH for a paid/reserved topic
npx wrangler secret put RESEND_API_KEY             # + NOTIFY_FROM (verified sender), NOTIFY_TO
npx wrangler deploy
```

Landing page: link **Get notified** to `/signup`, and add an ADMIN link that
appears after PIN login (the login sets a non-HttpOnly `gb_admin=1` hint
cookie; real auth is the HttpOnly `gb_s` cookie):

```html
<a id="admin" href="/admin" hidden>ADMIN</a>
<script>if(/\bgb_admin=1\b/.test(document.cookie))document.getElementById("admin").hidden=false;</script>
```

## Routes

| Route | Auth | Does |
|---|---|---|
| `GET/POST /signup` | — | form; store (email unique, re-signup updates), notify, 303 → `/thanks` |
| `GET /thanks` | — | "we'll be in touch", meta-refresh back to `/` in 5 s |
| `GET /admin` | PIN cookie | dashboard; PIN page when signed out |
| `POST /admin/login` | — | 5 wrong PINs from one IP → 15 min lockout |
| `GET /admin/api` | admin | `{metrics, signups, settings, channels, export_key}` |
| `POST /admin/settings` | admin | `{notify_crier, notify_ntfy, notify_email, notify_sms, notify_to}` |
| `POST /admin/test` | admin | fire a test note; per-channel results returned and shown |
| `GET /admin/signups.csv` | admin **or** `?key=<export_key>` | CSV, newest first |
| `GET /login` | — | → `/admin` (until the site has its own login) |

**Export to Sheets** copies `=IMPORTDATA("https://host/admin/signups.csv?key=…")`
to the clipboard and opens `sheets.new`; paste into A1. The key is derived
from the PIN (read-only CSV, nothing else), so changing the PIN rotates it.
Sheets refreshes IMPORTDATA about hourly.

## Design notes

- **Statuses are recorded, never swallowed.** Every fan-out writes its
  per-channel results to `gb_settings.last_notify`; the dashboard shows them,
  and *Send test* exercises the real path. A channel is used only when it's
  both toggled on in settings and has its secrets.
- **Sessions are stateless.** The cookie is `sha256("gb:session:" + PIN)`;
  no session table, and changing the PIN logs every device out.
- **Spam:** honeypot field (`website`) + server-side validation. No Turnstile
  until it's needed.
- **Notify runs in `ctx.waitUntil`** — a 📯 outage never loses a signup.
