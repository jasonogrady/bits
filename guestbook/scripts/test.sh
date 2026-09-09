#!/bin/zsh
# Smoke test: signup → PIN login → api → csv → sheets key. Usage: PIN=12345678 scripts/test.sh http://localhost:8787
set -e; B=${1:-http://localhost:8787}; J=$(mktemp); trap 'rm -f $J' EXIT
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
[ "$(code $B/signup)" = 200 ] || { echo "FAIL signup page"; exit 1; }
[ "$(code -X POST $B/signup -d 'first=Test&last=User&email=test%40example.com&note=via+smoke')" = 303 ] || { echo "FAIL signup post"; exit 1; }
[ "$(code -X POST $B/signup -d 'first=&last=&email=nope')" = 303 ] || { echo "FAIL validation"; exit 1; }
[ "$(code -X POST $B/signup -d 'first=Bot&last=Bot&email=bot%40x.com&website=spam')" = 303 ] || { echo "FAIL honeypot"; exit 1; }
[ "$(code -X POST $B/signup -d 'first=Sms&last=User&email=sms%40example.com&phone=%28555%29+555-1234&sms_optin=yes')" = 303 ] || { echo "FAIL sms optin"; exit 1; }
curl -s -o /dev/null -w '%{redirect_url}\n' -X POST $B/signup -d 'first=Bad&last=Phone&email=bad%40example.com&phone=12&sms_optin=yes' | grep -q 'err=phone' || { echo "FAIL phone validation"; exit 1; }
[ "$(code $B/admin/api)" = 401 ] || { echo "FAIL admin unauth"; exit 1; }
[ "$(code -c $J -X POST $B/admin/login -d 'pin=wrong')" = 303 ] || { echo "FAIL wrong pin"; exit 1; }
[ "$(code -c $J -X POST $B/admin/login -d "pin=${PIN:-12345678}")" = 303 ] || { echo "FAIL login"; exit 1; }
grep -q gb_s $J || { echo "FAIL session cookie"; exit 1; }
API=$(curl -s -b $J $B/admin/api)
echo "$API" | grep -q '"email":"test@example.com"' || { echo "FAIL api rows: $API"; exit 1; }
echo "$API" | grep -q 'bot@x.com' && { echo "FAIL honeypot stored"; exit 1; }
echo "$API" | grep -q '"phone":"+15555551234","sms_optin":1' || { echo "FAIL sms stored: $API"; exit 1; }
KEY=$(echo "$API" | sed -n 's/.*"export_key":"\([a-f0-9]*\)".*/\1/p')
curl -s -b $J $B/admin/signups.csv | grep -q '^when,first' || { echo "FAIL csv"; exit 1; }
curl -s "$B/admin/signups.csv?key=$KEY" | grep -q 'test@example.com' || { echo "FAIL csv export key"; exit 1; }
[ "$(code "$B/admin/signups.csv?key=bad")" = 401 ] || { echo "FAIL csv bad key"; exit 1; }
curl -s -b $J -X POST $B/admin/settings -H 'content-type: application/json' -d '{"notify_crier":false,"notify_to":"me@x.com"}' | grep -q ok || { echo "FAIL settings"; exit 1; }
curl -s -b $J $B/admin/api | grep -q '"notify_crier":"0"' || { echo "FAIL settings persisted"; exit 1; }
curl -s -b $J -X POST $B/admin/test | grep -q '"channel":"crier","skipped":"off"' || { echo "FAIL test notify"; exit 1; }
echo "PASS"
