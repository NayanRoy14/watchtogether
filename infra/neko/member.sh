#!/usr/bin/env bash
# Accounts for the shared browser, for testing it directly before the site is wired up.
#   ./member.sh add riya            → creates "riya" and prints a password
#   ./member.sh add nayan --admin   → an admin (can take control back, change settings)
#   ./member.sh rm riya
#   ./member.sh list
set -euo pipefail
. "$(dirname "$0")/lib.sh"

usage() { sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

case "${1:-}" in
  add)
    name=${2:-}; [ -n "$name" ] || usage
    [[ "$name" =~ ^[a-zA-Z0-9_-]{1,32}$ ]] || { echo "Use letters, digits, - and _ only." >&2; exit 1; }
    admin=false; [ "${3:-}" = "--admin" ] && admin=true
    password=$(openssl rand -hex 8)
    out=$(api POST /api/members "{
      \"username\": \"$name\", \"password\": \"$password\",
      \"profile\": {
        \"name\": \"$name\", \"is_admin\": $admin,
        \"can_login\": true, \"can_connect\": true, \"can_watch\": true, \"can_host\": true,
        \"can_share_media\": true, \"can_access_clipboard\": true,
        \"sends_inactive_cursor\": true, \"can_see_inactive_cursors\": true
      }}")
    status=${out##*$'\n'}
    if [ "$status" != 200 ]; then echo "Could not create \"$name\" (HTTP $status): ${out%$'\n'*}" >&2; exit 1; fi
    echo "Created $name"
    echo "  username: $name"
    echo "  password: $password"
    echo "  link:     https://$NEKO_DOMAIN/?usr=$name&pwd=$password"
    ;;
  rm)
    name=${2:-}; [ -n "$name" ] || usage
    out=$(api DELETE "/api/members/$name")
    status=${out##*$'\n'}
    if [ "$status" != 204 ] && [ "$status" != 200 ]; then echo "Could not remove \"$name\" (HTTP $status)." >&2; exit 1; fi
    echo "Removed $name"
    ;;
  list)
    out=$(api GET /api/members)
    echo "${out%$'\n'*}" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 || echo "(no members)"
    ;;
  *) usage ;;
esac
