# guestbook 📝 — "get notified" signups, admin dashboard, notification fan-out

A drop-in for any Cloudflare Worker site: a signup form (first, last, email,
note/referral), a thanks page that returns to the landing page, and an
`/admin` dashboard with signup metrics, the full list newest first, CSV
export, Open in Sheets, and per-channel notification settings. The dashboard
sits behind a PIN, or behind the site's own login when it has one
([host mode](#host-mode--sites-with-their-own-login-and-layout)).
Every signup fans out to [town-crier 📯](../town-crier), ntfy, email, and SMS
(Twilio). Zero deps, one file + one schema.

```
 landing page ──▶ /signup ──▶ D1 (gb_signups) ──▶ notify ─┬─▶ town-crier 📯 → every device
        ▲             │                                   ├─▶ ntfy → iPhone
        └── /thanks ◀─┘                                   ├─▶ email (Resend)
                                                          └─▶ sms (Twilio)
 ADMIN button (cookie hint) ──▶ /admin (PIN) ──▶ tiles · table · CSV · Sheets · 🔔 settings · send test
```

| Piece | Path | What it does |
|---|---|---|
| Worker module | `worker.js` | routes, auth, fan-out, all pages inline |
| Schema | `schema.sql` | `gb_signups`, `gb_settings`, `gb_attempts` — idempotent |
| Types | `worker.d.ts` | vendor next to `worker.js` in a TypeScript project |
| Tests | `test.js` | `node test.js` — PIN mode, host mode, and Twilio, offline (D1 shimmed with `node:sqlite`) |
| Smoke test | `scripts/test.sh` | the same PIN-mode flow against a running Worker |

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
npx wrangler secret put TWILIO_ACCOUNT_SID         # + TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SID (or TWILIO_FROM), NOTIFY_SMS_TO
npx wrangler deploy
```

Landing page: link **Get notified** to `/signup`, and add an ADMIN link that
appears after PIN login (the login sets a non-HttpOnly `gb_admin=1` hint
cookie; real auth is the HttpOnly `gb_s` cookie):

```html
<a id="admin" href="/admin" hidden>ADMIN</a>
<script>if(/\bgb_admin=1\b/.test(document.cookie))document.getElementById("admin").hidden=false;</script>
```

**Own form?** Skip `/signup` and call `recordSignup(request, env, ctx, { email })` from your
handler (first/last/note/phone optional); the dashboard hides columns nobody filled.
Vars: `ADMIN_SESSION_DAYS` (PIN login lifetime, default 30) and `GB_MINIMAL=1`
(store email + time only, no referrer/geo/UA; notifications carry the running count, never the person).

## Host mode — sites with their own login and layout

`handleGuestbook` takes a fourth argument. Every key is optional; pass none
and you get the PIN-gated standalone pages above.

```js
const res = await handleGuestbook(request, env, ctx, {
  isAdmin:   (request, env) => user?.email === env.OWNER_EMAIL,  // your auth replaces the PIN
  loginUrl:  "/auth/login?next=%2Fadmin",   // signed-out /admin goes here
  logoutUrl: "/auth/logout",                // dashboard "Log out" (omit = no button)
  secret:    env.SESSION_SECRET,            // derives the Sheets export key (no PIN to derive it from)
  site:      "Caddy Shack",                 // name in notifications + dashboard title
  copy:      { heading: "Sign up for next season", lede: "…", noteLabel: "…", button: "Count me in",
               thanksHeading: "You're on the list.", thanksBody: "…" },
  prefill:   { first, last, email },        // signed-in visitor: fill the form for them
  sms:       { sender: "example.com", frequency: "about 2 to 4 per week", termsUrl: "/sms-terms", privacyUrl: "/privacy" },
  shell:     ({ kind, title, body }) => myLayout(title, body),   // /signup + /thanks inside your layout
  css:       ":root{--accent:#2ea043}",     // restyle the standalone pages (dashboard, PIN page)
  notifyTo:  env.OWNER_EMAIL,               // default email recipient
  sendEmail: async (env, note, to) => ({ status: 200 }),         // your mailer instead of Resend
});
return res || next();
```

- **`isAdmin`** turns off `/login`, `/admin/login`, and `/admin/logout`; the
  bit only answers `/admin` and its own `/admin/*` routes and returns `null`
  for the rest, so the host can keep other `/admin/…` routes of its own.
  Show the ADMIN link from your own session instead of the `gb_admin` cookie.
- **`shell`** gets the form or thanks markup scoped under `.gb`, with styles
  that inherit the host's colors and fonts (light and dark both work). Buttons
  carry `btn primary` / `btn ghost` for the host's CSS to pick up.
- **`sms`** adds the phone field and the consent text. Without it there is no
  phone field at all, and a posted `sms_optin` is ignored.

## Routes

| Route | Auth | Does |
|---|---|---|
| `GET/POST /signup` | — | form; store (email unique, re-signup updates), notify, 303 → `/thanks` |
| `GET /thanks` | — | "we'll be in touch", back to `/` in 5 s |
| `GET /admin` | PIN cookie or `opts.isAdmin` | dashboard; PIN page (or `loginUrl`) when signed out |
| `POST /admin/login` | — | 5 wrong PINs from one IP → 15 min lockout |
| `GET /admin/api` | admin | `{metrics, signups, settings, channels, export_key}` |
| `GET /admin/count` | admin | `{total}` for an **Admin (42)** button on the landing page |
| `POST /admin/settings` | admin | `{notify_crier, notify_ntfy, notify_email, notify_sms, notify_to, notify_sms_to}` |
| `POST /admin/test` | admin | fire a test note; per-channel results returned and shown |
| `GET /admin/signups.csv` | admin **or** `?key=<export_key>` | CSV, newest first |
| `GET /login` | — | → `/admin` (until the site has its own login) |

**Open in Sheets** copies `=IMPORTDATA("https://host/admin/signups.csv?key=…")`
to the clipboard and opens `sheets.new`; paste into A1. The key is derived
from the PIN, or from `opts.secret` in host mode (read-only CSV, nothing
else), so changing the PIN or the secret rotates it.
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
