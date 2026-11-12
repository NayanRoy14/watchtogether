# Shared by the helper scripts. Source it; do not run it.
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

if [ ! -f .env ]; then
  echo "No .env here yet. Run ./setup.sh first." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
. ./.env
set +a

API="http://127.0.0.1:8080"

# api METHOD PATH [JSON]  → prints the body, then the HTTP status on its own last line
api() {
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -sS -m 15 -X "$method" "$API$path" -w '\n%{http_code}' \
      -H "Authorization: Bearer $NEKO_API_TOKEN" -H 'Content-Type: application/json' -d "$body"
  else
    curl -sS -m 15 -X "$method" "$API$path" -w '\n%{http_code}' \
      -H "Authorization: Bearer $NEKO_API_TOKEN"
  fi
}

compose() {
  if docker info >/dev/null 2>&1; then docker compose "$@"; else sudo docker compose "$@"; fi
}
