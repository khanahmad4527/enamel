#!/usr/bin/env bash
# One command from a clean checkout to a running, branded, seeded practice.
#
# Every step is idempotent, so re-running is the normal way to pick up a
# change rather than something to avoid.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[36m▸\033[0m \033[1m%s\033[0m\n' "$1"; }

if [ ! -f .env ]; then
  say "Creating .env from .env.example"
  cp .env.example .env
  # A default SECRET is a footgun in a repo people clone; generate one.
  if command -v openssl >/dev/null 2>&1; then
    SECRET_VALUE="$(openssl rand -hex 32)"
    if sed --version >/dev/null 2>&1; then
      sed -i "s|^SECRET=.*|SECRET=${SECRET_VALUE}|" .env
    else
      sed -i '' "s|^SECRET=.*|SECRET=${SECRET_VALUE}|" .env
    fi
    echo "  generated a fresh SECRET"
  fi
  echo "  review .env before using this anywhere but locally"
fi

set -a; . ./.env; set +a
PORT="${DIRECTUS_PORT:-8056}"

say "Building the tooth-chart extension"
# dist/ is gitignored, so a fresh clone has no compiled interface and the
# patients form would show a missing field.
pnpm --dir extensions/directus-extension-tooth-chart install --silent
pnpm --dir extensions/directus-extension-tooth-chart build

say "Starting Postgres, Redis, Mailpit and Directus"
# Docker creates a missing bind-mount source as root, and the Directus
# image does not run as root — so an absent ./uploads means every branding
# upload fails with a permission error on Linux.
mkdir -p uploads data
docker compose up -d

say "Waiting for Directus on :${PORT}"
for i in $(seq 1 60); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://localhost:${PORT}/server/ping" 2>/dev/null)" = "200" ]; then
    echo "  up after ~$((i * 2))s"; break
  fi
  if [ "$i" = "60" ]; then
    echo "  Directus did not come up."
    # It is almost always in the last FATAL, and almost never worth
    # reading 400 lines of PM2 restart noise to find it.
    # `|| true`: grep -m exits early, docker compose logs takes SIGPIPE,
    # and pipefail would otherwise abort here — swallowing the very
    # message this block exists to print.
    FATAL="$(docker compose logs directus 2>&1 | grep -m 2 'FATAL' | sed 's/^[^|]*| *//' || true)"
    [ -n "$FATAL" ] && printf '\n%s\n' "$FATAL"
    case "$FATAL" in
      *"Activation limit"*)
        cat <<'ACT'

    A licence key allows a limited number of activations, and every fresh
    database claims one. `docker compose down -v` throws that activation
    away without telling the licence server, so it is gone for good.

    Use ./scripts/teardown.sh instead of down -v — it hands the
    activation back first. To ask for more, or to have spent ones
    released: https://directus.com/docs/licensing/open-innovation-grant

ACT
        ;;
      *LICENSE*|*license*)
        echo
        echo "    Check DIRECTUS_LICENSE_KEY in .env, or run DIRECTUS_IMAGE=directus/directus:11."
        echo
        ;;
    esac
    echo "  Full log: docker compose logs directus"
    exit 1
  fi
  sleep 2
done

# On 12.x an unlicensed instance refuses every custom permission rule, so
# provisioning would emit ~90 opaque failures. Say so up front instead.
if [[ "${DIRECTUS_IMAGE:-}" != *":11"* ]]; then
  say "Checking licence entitlements"
  TOKEN=$(curl -s -X POST "http://localhost:${PORT}/auth/login" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" \
    | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
  RULES=$(curl -s -H "authorization: Bearer ${TOKEN}" "http://localhost:${PORT}/license" \
    | grep -o '"custom_permission_rules_enabled":{"default":[a-z]*' | grep -o '[a-z]*$' || true)
  if [ "${RULES}" = "true" ]; then
    echo "  custom permission rules: enabled"
  else
    cat <<'WARN'

  ✗ This Directus is unlicensed, and its tier refuses custom rules on
    access policies. Those rules are the entire subject of this project,
    so provisioning would fail ~90 times over.

    Either set DIRECTUS_LICENSE_KEY in .env — an Open Innovation Grant key
    is free under $5M revenue and 50 employees:
      https://directus.com/docs/licensing/open-innovation-grant

    Or run the last unrestricted version:
      DIRECTUS_IMAGE=directus/directus:11

    While you are in .env, set PROJECT_OWNER_EMAIL too. Directus 12 asks
    for one the first time you sign in, and filling it here answers that
    dialog instead of meeting it later.

    Then run this script again — it picks up both.

WARN
    exit 1
  fi
fi

say "Provisioning and seeding"
pnpm --dir bootstrap install --silent
pnpm --dir bootstrap seed

say "Verifying the access model"
pnpm --dir bootstrap verify

cat <<EOF

  Enamel is up:  http://localhost:${PORT}
  Mail:          http://localhost:${MAILPIT_PORT:-8025}  (reminders land here)
  Admin:         ${ADMIN_EMAIL:-admin@enamel.dev}
  Demo staff:    desk@riverside.example.com / dentist@riverside.example.com
                 password ${DEMO_PASSWORD:-EnamelDemo!2026}

  Sign in as the front desk and again as the dentist, open the same
  patient, and compare. That contrast is the point of this project.

EOF
