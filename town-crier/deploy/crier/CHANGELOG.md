# Changelog

## v1.1 — 2026-07-23

- Development consolidated into `bits/town-crier` — the canonical home; ogrady.ai deploys downstream
- 🏷️ version-tab chip in the PWA header (this panel)
- `NTFY_AUTH` bound: paid ntfy token fixes shared-egress-IP 429s on phone pushes

## v1.0 — 2026-07-23

- Town Crier hub live (shipped as ogradyai-website v4.2.0)
- `POST /api/crier/notify` ingest + feed, Bearer `CRIER_TOKEN` auth
- Fan-out to ntfy (iPhone) and Web Push (Mac), every delivery status recorded — nothing silently swallowed
- Web Push registry + zero-dep VAPID/aes128gcm crypto
- PWA at `/crier/` — Alerts, Traffic, and Health tabs, push registration, ring-the-bell self-test
- Site beacon renamed `analytics.js`/`track` → `pulse` (dodges EasyPrivacy ad-blocker lists)
- Native macOS menu-bar app scaffold (`macos/`), polls the feed every 30 s

## v0.1 — 2026-07-02

- First wire-up: visit + qualified-lead tracking via `/api/track` → ntfy push
