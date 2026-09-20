#!/bin/sh
set -eu

# Container environment variables are not Worker bindings.
#
# workerd only sees what its config declares, so the values compose passes
# in have to be written where wrangler looks for them: `.dev.vars`, beside
# the built worker. Written at start-up from the environment, so nothing
# secret is baked into the image or committed to the repository —
# `.dockerignore` keeps the developer's own copy out of the build context
# for the same reason, because the build would otherwise emit it here and
# it would win over whatever the container was actually given.
umask 077
cd dist/server
{
  printf 'DIRECTUS_URL=%s\n' "${DIRECTUS_URL:-http://directus:8055}"
  printf 'CORE_URL=%s\n' "${CORE_URL:-http://core:8057}"
  printf 'PORTAL_SESSION_SECRET=%s\n' "${PORTAL_SESSION_SECRET:?set PORTAL_SESSION_SECRET}"
  printf 'PORTAL_SECURE=%s\n' "${PORTAL_SECURE:-0}"
  # The read-only content credential. Required rather than defaulted: a
  # site that starts without it renders every public page as a 503, which
  # is a confusing way to learn that the seed has not run.
  printf 'WEBSITE_TOKEN=%s\n' "${WEBSITE_TOKEN:?set WEBSITE_TOKEN — run the seed}"
  printf 'WEBSITE_CACHE_SECONDS=%s\n' "${WEBSITE_CACHE_SECONDS:-60}"
} > .dev.vars

# `wrangler dev` on the already-built worker, not `vite preview`.
#
# Both run the same runtime. This one needs nothing but the build output —
# no Vite, no plugin chain, no `app/` source in the runtime image — which
# is why the container ships the artefact and not the project.
exec npx wrangler dev \
  --config wrangler.json \
  --ip 0.0.0.0 \
  --port "${PUBLIC_PORT:-8058}"
