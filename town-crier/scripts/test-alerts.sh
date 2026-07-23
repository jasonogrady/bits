#!/usr/bin/env bash
# ============================================================
# End-to-end test of the tracking + Town Crier notification stack.
#
# Usage:
#   CRIER_TOKEN=xxxx scripts/test-alerts.sh            # against production
#   CRIER_TOKEN=xxxx scripts/test-alerts.sh http://localhost:8788   # wrangler pages dev
#
# What it does:
#   1. GET  /api/pulse           — health: bindings, subs, recent deliveries
#   2. GET  /api/pulse?selftest  — fires a REAL notification through every
#                                  channel and prints per-channel status
#   3. POST /api/pulse           — synthetic visitor session_start
#   4. POST /api/pulse           — synthetic qualified_lead
#   5. POST /api/crier/notify    — external-app note (like chip-recruiter would)
#
# Expect: ntfy status 200 on each fire + pushes on your phone/Mac.
# Any {"error": ...} or non-200 ntfy status in the output is the bug.
# ============================================================
set -euo pipefail

BASE="${1:-https://ogrady.ai}"
: "${CRIER_TOKEN:?Set CRIER_TOKEN (the Pages secret) in the environment}"
AUTH="Authorization: Bearer ${CRIER_TOKEN}"
JQ=$(command -v jq || echo cat)

step() { printf '\n\033[1;33m── %s\033[0m\n' "$*"; }

step "1/5 Health check — ${BASE}/api/pulse"
curl -sf "${BASE}/api/pulse" -H "$AUTH" | $JQ

step "2/5 Self-test — full pipeline fan-out (expect a push!)"
curl -sf "${BASE}/api/pulse?selftest=1" -H "$AUTH" | $JQ

step "3/5 Synthetic visitor (session_start → 👀 Visit alert)"
curl -sf -X POST "${BASE}/api/pulse" -H 'Content-Type: application/json' -d '{
  "event": "session_start",
  "session": { "id": "test-'"$(date +%s)"'", "referrer": "test-alerts.sh",
               "ua": "test-alerts.sh synthetic visitor" },
  "funnel": { "landed": true }
}' | $JQ

step "4/5 Synthetic qualified lead (🚨 alert, high priority)"
curl -sf -X POST "${BASE}/api/pulse" -H 'Content-Type: application/json' -d '{
  "event": "qualified_lead",
  "props": { "trigger": "linkedin_click", "href": "https://linkedin.com/in/test" },
  "session": { "id": "test-'"$(date +%s)"'", "referrer": "test-alerts.sh",
               "ua": "test-alerts.sh synthetic lead" },
  "funnel": { "landed": true, "contact": true, "li": true, "qualified": true }
}' | $JQ

step "5/5 External app note via /api/crier/notify (how chip-recruiter etc. post)"
curl -sf -X POST "${BASE}/api/crier/notify" -H "$AUTH" -H 'Content-Type: application/json' -d '{
  "source": "test-alerts.sh",
  "title": "Hub ingest works",
  "body": "This is what a note from chip-recruiter / manifest / crispy-digitals looks like.",
  "priority": "default",
  "tags": "white_check_mark"
}' | $JQ

printf '\n\033[1;32mDone. Check your phone (ntfy) and Mac (Crier PWA) — you should have 4 notifications.\033[0m\n'
printf 'Delivery statuses are also recorded: %s/api/pulse (Health tab in the PWA).\n' "$BASE"
