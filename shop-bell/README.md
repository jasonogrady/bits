# shop-bell 🔔 — visitor pulse with a bell on the door

The bell over the shop door: it **rings when someone walks in** (push alert on
your phone and desktop) and **the ledger remembers every visit** (every event
stored, queryable, with geo/org enrichment for free). First-party, zero
dependencies, and deliberately boring on the wire — the files and endpoints
are named `pulse`, because `analytics.js` and `/api/track` sit on ad-blocker
filter lists and silently vanish for a chunk of your visitors.

Extracted from a production deployment (a photography-business site whose
sibling ran the same stack for recruiter-funnel alerts). Client and endpoint
shapes are field-tested; the funnel is configurable.

```
 pulse.js (every page) ──▶ POST /api/pulse ──▶ D1 ledger (pulse_events)
                                  │
                 session_start / qualified_lead
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
          town-crier 📯 hub               ntfy.sh direct
       (CRIER_URL + CRIER_TOKEN)     (NTFY_TOPIC [+ NTFY_AUTH])
```

| File | What it is |
|---|---|
| `pulse.js` | Drop-in client — session, configurable funnel, scroll depth, dwell time, click classification, owner opt-out |
| `worker.js` | `/api/pulse` handler for a Cloudflare Worker with D1 — storage, alert fan-out, health + selftest endpoint, traffic page, daily digest |
| `schema.sql` | The `pulse_events` ledger table |

## The funnel

Three flags, one conclusion: **`browse` + `goal` ⇒ `qualified_lead`**. A
visitor who looked at what you offer *and* reached your goal page (contact,
signup, pricing) is worth a ring; either alone is just traffic.

- `goal` — they hit a goal path (`data-goal-paths`, default `/contact`) or
  clicked a link to one.
- `browse` — they hit a browse path (`data-browse-paths`, e.g. `/services`)
  or clicked a browse link (`data-browse-links`, e.g. your portfolio,
  Instagram, GitHub — wherever "evaluating you" happens).

Funnel state persists in `localStorage`, so browse-today-contact-tomorrow
still qualifies. `qualified_lead` fires once per visitor.

## Client

```html
<script defer src="/assets/pulse.js"
        data-endpoint="/api/pulse"
        data-prefix="sb"
        data-goal-paths="/contact"
        data-browse-paths="/services,/work"
        data-browse-links="instagram.com,github.com"></script>
```

Events emitted: `page_view` (`{new: true}` on the first view of a session), `session_start`, `goal_view`, `goal_click`,
`browse_click`, `outbound_click`, `qualified_lead`, `scroll` (25/50/75/90),
`dwell` (15s/30s/60s/120s buckets, only while the tab is visible).
Manual events: `window.pulse('demo_started', { plan: 'pro' })`.

Beacons use `navigator.sendBeacon` (survives page unload) with
`fetch keepalive` fallback. Nothing here identifies a person — no cookies,
no fingerprinting; the session id is a random UUID that dies with the tab
session.

**Owner opt-out** — visit `/?me=1` once per device and your own visits are
flagged (stored, never alerted). `/?me=0` undoes it.

## Server

```js
import { handlePulse } from "./worker.js";
// in your Worker's fetch():
if (url.pathname === "/api/pulse") return handlePulse(request, env, ctx);
```

Apply `schema.sql` to your D1 database, then bind secrets
(`npx wrangler secret put …`):

| Secret / var | Role |
|---|---|
| `CRIER_TOKEN` | Auths the health endpoint **and** the town-crier hub POST |
| `CRIER_URL` | Your [town-crier](../town-crier) hub's `/api/crier/notify` (optional) |
| `NTFY_TOPIC` | Direct ntfy.sh channel (optional) |
| `NTFY_AUTH` | ntfy access token — paid account, reserved topic (optional) |
| `PULSE_NOTIFY` | Events that ring, comma-separated. Default `session_start,qualified_lead`. `page_view,qualified_lead` rings on **every page**: the first view of a session is a 👀 Visit (default priority), later views are 📄 (low priority, hub only). Don't list both `page_view` and `session_start` — a new visitor would ring twice. Unknown events get a generic ⚡ note, so `window.pulse('demo_started')` can ring too. |
| `PULSE_TZ` | IANA zone for the traffic page and digest (default `UTC`) |

Alert channels are independent: configure one, both, or neither (ledger
still fills). Every delivery status is reported, never swallowed. Quiet notes
(priority `low`/`min`) go to the hub only — the direct ntfy path is reserved
for things that should actually make the phone buzz.

Two channels on purpose: the hub gives you the feed, Web Push, and one
place every app posts to; direct ntfy is the redundant path that still
rings the phone when the hub is down, being redeployed, or is the thing
you're debugging.

**Form submits** (contact, signup, order) should ring from the form handler,
not the beacon — server-side survives JS-off and never double-fires:

```js
import { notify } from "./worker.js";
ctx.waitUntil(notify(env, {
  source: "yoursite.com",
  title: `✉️ Contact form — ${name}`,
  body: message.slice(0, 300),
  priority: "high",
  tags: "envelope_with_arrow",
}));
```

## Watching the traffic

```
GET /api/pulse?view=1&key=<CRIER_TOKEN>
```

A server-rendered page, no client JS: **on the site now** (sessions active in
the last 5 minutes), today / 7-day / 30-day visitors with views and leads, a
by-day table, top pages, referrers (by host) and countries for the week, and
the last 50 sessions (last seen, dwell, pages visited, city/org, referrer,
browser). Bots and your own visits are excluded from the counts; your own
sessions show greyed, leads highlighted. To put it behind your own admin
login instead of the token, route to `trafficPage(env, { host })`.

**Daily digest** — add a cron trigger and a `scheduled()` handler:

```jsonc
// wrangler.jsonc
"triggers": { "crons": ["0 15 * * *"] }   // 8am Pacific
```

```js
import { pulseDigest } from "./worker.js";
export default {
  async fetch(request, env, ctx) { /* … */ },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(pulseDigest(env, { host: "yoursite.com", url: "https://yoursite.com/admin/traffic" }));
  },
};
```

One note a day — visitors, views, leads, top pages, referrers and countries
for the last 24 hours. A digest that says `0 visitors` is the signal that the
beacon or the site is broken, so it always sends.

## Health & testing

```bash
# What's wired, 7-day event counts, recent ledger rows:
curl https://yoursite.com/api/pulse -H "Authorization: Bearer $CRIER_TOKEN"

# Fire a real alert through every channel, get per-channel status:
curl "https://yoursite.com/api/pulse?selftest=1" -H "Authorization: Bearer $CRIER_TOKEN"
```

## Notes

- Geo/org enrichment is Cloudflare's own `request.cf` (city, region,
  country, ASN organization) — free, no third-party lookup, accurate enough
  to tell "Comcast in Portland" from "a corporate network".
- Bots (UA regex) and owner visits are stored flagged, never alerted.
- KV instead of D1: swap the `INSERT` for a `put` with an
  inverted-timestamp key — see town-crier's `evt:` keys for the pattern.
