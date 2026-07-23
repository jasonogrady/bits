# Town Crier 📯 — personal notification hub

One notifier, just for Jason. A layer **above** the noise of email/text/social:
anything that matters gets posted to the hub and fans out to every device.

**This directory is the canonical home for Town Crier development.** It was
consolidated here from the `ogradyai-website` repo (2026-07-23). Production
still deploys through the `ogradyai-website` Pages project at ogrady.ai —
develop here, then sync the changed files into that repo to ship (or cut Town
Crier over to its own Pages project using the `wrangler.toml` in this folder).

```
 ogrady.ai visits/leads ─┐
 chip-recruiter ─────────┤   POST /api/crier/notify        ┌─▶ ntfy.sh  → iPhone
 manifest ───────────────┼─▶ (Bearer CRIER_TOKEN)  ──▶ KV ─┼─▶ Web Push → Mac (Crier PWA)
 crispy-digitals ────────┤        feed + fan-out           └─▶ TownCrier.app (menu bar, polls)
 anything with curl ─────┘
```

| Piece | Path | What it does |
|---|---|---|
| Hub ingest + feed | `functions/api/crier/notify.js` | POST a note in, GET the feed out |
| Push registry | `functions/api/crier/subscribe.js` | stores Web Push subscriptions; serves VAPID public key |
| Fan-out core | `functions/lib/crier.js` | KV store + ntfy + Web Push, delivery statuses recorded |
| Web Push crypto | `functions/lib/webpush.js` | VAPID (RFC 8292) + aes128gcm (RFC 8291), zero deps |
| Site beacon | `deploy/pulse.js` → `functions/api/pulse.js` | visit/lead tracking (renamed from analytics.js/track — ad-blocker lists) |
| Mac PWA | `deploy/crier/` | https://ogrady.ai/crier/ — feed, traffic, health, push registration |
| Version chip | `deploy/crier/version-tab.js` + `CHANGELOG.md` + `VERSION` | 🏷️ chip in the PWA header — the [`version-tab`](../version-tab) bit; release notes open on click |
| Native menu bar app | `macos/` | v2 scaffold — polls the hub, native macOS notifications |
| Test harness | `scripts/test-alerts.sh` | fires every path end to end |

Secrets on the Pages project: `CRIER_TOKEN` (hub auth), `VAPID_PRIVATE_JWK`
(Web Push signing), `NTFY_TOPIC` (phone), `NTFY_AUTH` (paid ntfy token — bound
2026-07; fixes shared-egress-IP 429s), optional `IPINFO_TOKEN` (company
enrichment). `VAPID_PUBLIC_KEY` is a plain var in `wrangler.toml`. KV namespace
`CRIER` is bound in `wrangler.toml`.

## Post a notification from any app

```bash
curl -X POST https://ogrady.ai/api/crier/notify \
  -H "Authorization: Bearer $CRIER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "source":   "chip-recruiter",
    "title":    "New qualified applicant",
    "body":     "Jane Doe · staff eng · via referral",
    "url":      "https://chip.example/applicants/42",
    "priority": "high",
    "tags":     "golf"
  }'
```

`source` + `title` required. `priority`: `min|low|default|high|urgent`.
Response includes per-channel delivery results — if `ntfy` isn't `status: 200`,
that's your bug, in the response, not swallowed.

## Testing (the answer to "am I getting alerts?")

```bash
CRIER_TOKEN=… scripts/test-alerts.sh                     # production
CRIER_TOKEN=testtoken123 scripts/test-alerts.sh http://localhost:8788   # local
```

Local = `npx wrangler pages dev deploy` from **this directory** with a
`.dev.vars` (gitignored) holding `NTFY_TOPIC` / `CRIER_TOKEN` / VAPID pair.
Fires: health check, full-pipeline self-test, synthetic visit, synthetic
qualified lead, and an external-app note. Expect 4 pushes and `"status": 200`
on every ntfy result.

In the PWA: **Ring the bell** = the same self-test; the **Health** tab shows the
last 10 delivery attempts with real statuses; **Traffic** shows raw events (90d
retention in KV) including `you` / `bot` flags.

## Mac setup (PWA, v1)

1. Open https://ogrady.ai/crier/ → paste `CRIER_TOKEN`
   (`npx wrangler pages secret put CRIER_TOKEN` set it; value in your notes).
2. Install as an app: Safari **File → Add to Dock**, or Chrome's install icon.
3. **Open the installed app** (push permission is per-install) → **Enable push**
   → allow notifications.
4. **Ring the bell** → you should get a macOS notification + phone push.

## Menu bar app (native, v2 scaffold)

`macos/` — Swift/AppKit `NSStatusItem` (📯) + `UNUserNotificationCenter`,
polls the hub feed every 30 s, notes menu with click-through, no Dock icon.

```bash
cd macos
./make-app.sh install         # builds, ad-hoc signs, installs, launches
mkdir -p ~/.config/crier && echo YOUR_CRIER_TOKEN > ~/.config/crier/token
```

Roadmap for the native app: replace polling with an SSE/WebSocket subscribe
(ntfy's WS endpoint works today: `wss://ntfy.sh/$TOPIC/ws`), Login Item
auto-start, per-source mute rules, notification history window, proper icon.

## Design notes

- **Nothing is silently swallowed.** Every delivery attempt (ntfy status, Web
  Push status per device) is recorded to KV (`sys:push:*`, 7d) and surfaced in
  `/api/pulse` health + the PWA. The old track.js swallowed ntfy errors — that's
  why "no alerts" was undiagnosable.
- **Ad blockers:** `analytics.js` and `/api/track` match EasyPrivacy patterns
  (why many real visitors never beaconed). Now `pulse.js` + `/api/pulse`;
  `/api/track` remains as an alias for cached pages.
- **Bots** are stored (flagged) but never alert. Owner (`?me=1`) likewise.
- Dead Web Push subscriptions (404/410 from the push service) auto-prune.
- KV keys use inverted timestamps so `list()` returns newest-first without pagination tricks.
