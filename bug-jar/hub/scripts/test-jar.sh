#!/usr/bin/env bash
# bug-jar 🫙 end-to-end smoke test: health → ingest → list → triage → csv.
#
#   JAR_TOKEN=… JAR_ADMIN_TOKEN=… scripts/test-jar.sh                    # against prod
#   JAR_TOKEN=devtoken JAR_ADMIN_TOKEN=admintoken scripts/test-jar.sh http://localhost:8788
set -euo pipefail

BASE="${1:-http://localhost:8788}"
: "${JAR_TOKEN:?set JAR_TOKEN}" "${JAR_ADMIN_TOKEN:?set JAR_ADMIN_TOKEN}"

say() { printf '\n— %s\n' "$1"; }

say "health"
curl -fsS "$BASE/healthz"

say "ingest (should 201 and return an id)"
ID=$(curl -fsS -X POST "$BASE/api/bugs" \
  -H "Authorization: Bearer $JAR_TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "project": "jar-selftest",
    "body": "Synthetic bug from test-jar.sh\nSecond line of detail.",
    "severity": "minor",
    "reporter": "Test Harness <test@invalid>",
    "url": "https://example.com/page",
    "viewport": "1280x800",
    "version": "v0.0",
    "console": ["12:00:00 [console.error] synthetic error"]
  }' | sed -E 's/.*"id":([0-9]+).*/\1/')
echo "id=$ID"

say "ingest with bad token (should 401)"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/bugs" \
  -H 'Authorization: Bearer wrong' -H 'Content-Type: application/json' -d '{}'

say "list (admin)"
curl -fsS "$BASE/api/bugs?project=jar-selftest" -H "Authorization: Bearer $JAR_ADMIN_TOKEN" | head -c 400; echo

say "triage: P4 + wontfix"
curl -fsS -X PATCH "$BASE/api/bugs/$ID" \
  -H "Authorization: Bearer $JAR_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"priority": "P4", "status": "wontfix", "notes": "self-test bug — ignore"}'
echo

say "csv"
curl -fsS "$BASE/api/bugs.csv?project=jar-selftest" -H "Authorization: Bearer $JAR_ADMIN_TOKEN" | head -3

say "done — check the dashboard at $BASE (and your 📯 if CRIER_URL is set)"
