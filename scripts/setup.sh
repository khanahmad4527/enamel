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

# Secrets this repo generates rather than ships.
#
# `SECRET` above is only generated when .env is first created, which is
# fine for a value that has always existed. These are newer, so an .env
# written before they landed has neither the key nor a value — and an
# empty one is not a footgun that waits: compose refuses to start the
# patient site without a cookie-signing key, and the inbound webhook
# refuses every request without a secret to check against. Filling a blank
# is therefore part of setup, not part of creating .env.
ensure_secret() {
  local key="$1" note="$2" value
  if grep -qE "^${key}=.+" .env; then return 0; fi
  command -v openssl >/dev/null 2>&1 || {
    echo "  ! ${key} is empty and openssl is not on PATH — set it by hand in .env"
    return 0
  }
  value="$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-40)"
  if grep -qE "^${key}=" .env; then
    if sed --version >/dev/null 2>&1; then sed -i "s|^${key}=.*|${key}=${value}|" .env
    else sed -i '' "s|^${key}=.*|${key}=${value}|" .env; fi
  else
    printf '\n# %s\n%s=%s\n' "${note}" "${key}" "${value}" >> .env
  fi
  echo "  generated ${key}"
}

ensure_secret PORTAL_SESSION_SECRET "Signs the patient site's session cookie. Rotating it signs everybody out."
ensure_secret MESSAGING_INBOUND_SECRET "Checked on the provider webhook that receives patient replies."
ensure_secret BACKUP_PASSPHRASE "Encrypts ./scripts/backup.sh output. Lose it and the backups are noise."

set -a; . ./.env; set +a
PORT="${DIRECTUS_PORT:-9056}"

# Fail with a sentence rather than "pnpm: command not found" or a stack
# trace from a Node that predates the syntax this uses.
for tool in docker curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "  ✗ $tool is required and is not on PATH."; exit 1; }
done
command -v pnpm >/dev/null 2>&1 || {
  cat <<'NEED'
  ✗ pnpm is required and is not on PATH.
      npm install -g pnpm   — or see https://pnpm.io/installation
NEED
  exit 1
}
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR}" -lt 18 ]; then
  echo "  ✗ Node 18.17 or newer is required; this is $(node -v 2>/dev/null || echo 'not installed')."
  exit 1
fi

say "Installing the workspace"
# One install for every package. pnpm links @enamel/time into the three
# things that use it, which is the whole reason this is a workspace.
pnpm install --silent

say "Building shared packages and extensions"
# dist/ is gitignored, so a fresh clone has no compiled output at all: the
# patients form would show a missing field, the scheduling rules would not
# apply, and the day sheet would not appear in the module bar. The shared
# package goes first — the extensions import from its dist.
# Both shared packages, before the extensions that import them. The
# extension builder resolves a workspace package through its compiled
# `dist`, so an unbuilt one is silently treated as an external dependency
# and the extension loads with a missing import at runtime.
pnpm --filter @enamel/time build >/dev/null
pnpm --filter @enamel/extension-ui build >/dev/null
./scripts/build-extensions.sh >/dev/null

say "Starting Postgres, Redis, Mailpit, Directus and the core service"
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
pnpm --filter @enamel/bootstrap seed

# The seed generates the reminder sweep's token and writes it to .env,
# which the container read at startup — before it existed. Without this
# restart the reminder sweep runs with no credential and cannot mark an
# appointment reminded, which surfaces much later as every reminder
# retrying five times and then failing.
# .env was read at the top of this script, before the seed existed to
# write anything into it. The verify step below reads the sweep's
# token from the environment, so without this it checks a value that was
# empty when this shell started and reports three failures about a token
# that is sitting in the file a foot away.
set -a; . ./.env; set +a

say "Handing the reminder sweep its token"
docker compose up -d --force-recreate --no-deps core
for _ in $(seq 1 30); do
  curl -fsS --max-time 2 "http://localhost:${CORE_PORT:-8057}/health" >/dev/null 2>&1 && break
  sleep 2
done

# So the demo instance has an inbox. The sweeps run every fifteen minutes
# on their own; this is only to avoid handing somebody a Messages
# collection that is empty for the first quarter of an hour.
say "Sending the first round of patient messages"
for _ in 1 2 3 4 5 6; do
  QUEUED=$(curl -fsS -X POST -H "x-reminder-token: ${REMINDER_TOKEN}" \
    "http://localhost:${CORE_PORT:-8057}/api/messaging/sweep" 2>/dev/null \
    | sed -n 's/.*"total":\([0-9]*\).*/\1/p')
  [ "${QUEUED:-0}" = "0" ] && break
  echo "  queued ${QUEUED}"
  sleep 2
done

say "Waiting for the patient site on :${PUBLIC_PORT:-8058}"
# Built into its image, so it comes up on its own — but the checks below
# ask it questions, and "the patient site is unreachable" is a confusing
# way to be told that it is simply still starting.
for i in $(seq 1 45); do
  if curl -fsS --max-time 3 -o /dev/null "http://localhost:${PUBLIC_PORT:-8058}/" 2>/dev/null; then
    echo "  up after ~$((i * 2))s"; break
  fi
  [ "$i" = "45" ] && echo "  ! not answering — docker compose logs public"
  sleep 2
done

say "Verifying the access model"
pnpm --filter @enamel/bootstrap verify

cat <<EOF

  Enamel is up:  http://localhost:${PORT}
  Patient site:  http://localhost:${PUBLIC_PORT:-8058}
  Core service:  http://localhost:${CORE_PORT:-8057}/health
  Mail:          http://localhost:${MAILPIT_PORT:-8025}  (reminders land here)
  Admin:         ${ADMIN_EMAIL:-admin@enamel.dev}
  Demo staff:    desk@kadehuis.example.com / dentist@kadehuis.example.com
  Demo patient:  patient@kadehuis.example.com
                 password ${DEMO_PASSWORD:-EnamelDemo!2026}

  Sign in as the front desk and again as the dentist, open the same
  patient, and compare. That contrast is the point of this project.

  Then open Day sheet and drag an appointment onto one that is already
  there. The refusal comes from a Postgres exclusion constraint four
  hops away, and arrives as a sentence.

  Then sign in to the patient site and book the same slot you just
  took. Same constraint, same sentence, different building.

  When you have something worth keeping:

    pnpm backup        encrypted dump + the file library
    pnpm restore:test  proves it restores, into a scratch database

  The second one is the point. It asserts the rows, the constraints and
  the triggers all came back — and then tries a double-booking against
  the restored copy, because a trigger can restore and still be disabled.

EOF
