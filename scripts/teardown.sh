#!/usr/bin/env bash
# Hand the licence activation back, then destroy the stack.
#
# `docker compose down -v` alone looks harmless and is not. A licence key
# allows a limited number of activations; a fresh database claims a new
# one on boot, and wiping the volume strands the old one — the licence
# server is never told, and you do not get it back. Rebuild an instance a
# few times and the key stops working, with a FATAL at boot rather than
# anything resembling an explanation.
#
# So: deactivate first, wipe second. `DELETE /license` is the same call
# the admin's License screen makes.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[36m▸\033[0m \033[1m%s\033[0m\n' "$1"; }

[ -f .env ] || { echo "no .env here; nothing to tear down"; exit 1; }
set -a; . ./.env; set +a
PORT="${DIRECTUS_PORT:-8056}"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

if [ -n "${DIRECTUS_LICENSE_KEY:-}" ] &&
   [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://localhost:${PORT}/server/ping" 2>/dev/null)" = "200" ]; then
  say "Releasing the licence activation"
  TOKEN=$(curl -s -X POST "http://localhost:${PORT}/auth/login" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" \
    | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
  CODE=$(curl -s -o /tmp/enamel-deactivate.$$ -w '%{http_code}' \
    -X DELETE -H "authorization: Bearer ${TOKEN}" "http://localhost:${PORT}/license")
  BODY=$(cat /tmp/enamel-deactivate.$$ 2>/dev/null || true); rm -f /tmp/enamel-deactivate.$$
  if [ "${CODE}" = "200" ] || [ "${CODE}" = "204" ]; then
    echo "  released — this activation is available again"
  else
    echo "  ✗ deactivation returned HTTP ${CODE}: ${BODY}"
    if [ "${FORCE}" = "0" ]; then
      cat <<'WARN'

  Stopping here. Wiping now would strand this activation for good.
  Fix the deactivation, or re-run with --force if you accept losing it.

WARN
      exit 1
    fi
    echo "  --force given; continuing anyway"
  fi
else
  say "No running licensed instance to release"
fi

say "Removing containers and volumes"
docker compose down -v

cat <<EOF

  Gone. ./scripts/setup.sh rebuilds it from nothing.

EOF
