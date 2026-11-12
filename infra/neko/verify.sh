#!/usr/bin/env bash
# Checks the shared-browser server end to end and prints PASS / FAIL per item.
#   ./verify.sh
#   INSECURE=1 ./verify.sh    accept a self-signed certificate (local trials only)
set -uo pipefail
. "$(dirname "$0")/lib.sh"

fails=0
pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n        %s\n' "$1" "$2"; fails=$((fails + 1)); }
check() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3" "${4:-expected $2, got $1}"; fi; }
status_of() { echo "${1##*$'\n'}"; }
body_of() { echo "${1%$'\n'*}"; }

K=(); [ "${INSECURE:-}" = 1 ] && K=(-k)
SITE="https://$NEKO_DOMAIN"

echo "Containers"
running=$(compose ps --status running --format '{{.Service}}' 2>/dev/null | sort | tr '\n' ' ')
check "$running" "caddy neko " "neko and caddy are running" "running: ${running:-none}. Try: docker compose up -d && docker compose logs"

echo "neko API"
check "$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$API/health")" 200 "health endpoint answers"
check "$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$API/api/members")" 401 "API refuses requests without the token"
check "$(status_of "$(api GET /api/members)")" 200 "API accepts the admin token"

echo "Accounts created on the fly (what the room server will do)"
user="verify-$RANDOM"; pw=$(openssl rand -hex 8)
login() { curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$API/api/login" -H 'Content-Type: application/json' -d "{\"username\":\"$user\",\"password\":\"$pw\"}"; }
out=$(api POST /api/members "{\"username\":\"$user\",\"password\":\"$pw\",\"profile\":{\"name\":\"$user\",\"is_admin\":false,\"can_login\":true,\"can_connect\":true,\"can_watch\":true,\"can_host\":true,\"can_share_media\":true,\"can_access_clipboard\":true,\"sends_inactive_cursor\":true,\"can_see_inactive_cursors\":true}}")
check "$(status_of "$out")" 200 "create a member"
check "$(login)" 200 "that member can log in"
check "$(status_of "$(api DELETE "/api/members/$user")")" 204 "delete the member"
check "$(login)" 401 "a deleted member can no longer log in"

echo "Control mode and screen"
before=$(body_of "$(api GET /api/room/settings)")
api POST /api/room/settings '{"implicit_hosting":false}' >/dev/null
case "$(body_of "$(api GET /api/room/settings)")" in
  *'"implicit_hosting":false'*) pass "control mode can be switched at runtime" ;;
  *) fail "control mode can be switched at runtime" "implicit_hosting did not change" ;;
esac
case "$before" in *'"implicit_hosting":true'*) api POST /api/room/settings '{"implicit_hosting":true}' >/dev/null ;; esac
check "$(body_of "$(api GET /api/room/screen)")" '{"width":1280,"height":720,"rate":30}' "screen is 1280x720 at 30 fps"

echo "Saved logins"
if [ -d data/profile/Default ]; then pass "browser profile is being written to data/profile"
else fail "browser profile is being written to data/profile" "data/profile/Default is missing. Run: sudo chown -R 1000:1000 data && docker compose restart neko"; fi

echo "Public address"
actual=$(curl -4 -s -m 10 https://checkip.amazonaws.com | tr -d '[:space:]')
check "${actual:-unknown}" "$PUBLIC_IP" "PUBLIC_IP in .env matches this server" "this server's address is ${actual:-unknown} but .env says $PUBLIC_IP; video would not connect"
code=$(curl -s -m 15 "${K[@]}" -o /dev/null -w '%{http_code}' "$SITE/health")
check "$code" 200 "https://$NEKO_DOMAIN answers with a valid certificate" \
  "got ${code/000/no answer}. Check DNS points here, and ports 80 + 443 are open in the Oracle security list"
csp=$(curl -s -m 15 "${K[@]}" -D - -o /dev/null "$SITE/" | tr -d '\r' | awk -F': ' 'tolower($1) == "content-security-policy" { print $2 }')
check "$csp" "frame-ancestors $SITE_ORIGIN" "only $SITE_ORIGIN may embed the browser"

echo
if [ "$fails" = 0 ]; then
  echo "All checks passed."
  echo "Not checked from here: UDP/TCP 52000 from the internet. If the page loads but the"
  echo "screen stays black, add those two rules to the Oracle security list (README, step 3)."
else
  echo "$fails check(s) failed."
  exit 1
fi
