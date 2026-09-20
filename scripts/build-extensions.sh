#!/usr/bin/env bash
# Build every extension, and refuse a build that would break at runtime.
#
# The Directus extension builder treats an unresolvable import as an
# external dependency, prints a *warning*, and exits 0. The extension then
# loads in the browser with a bare `import "@enamel/extension-ui"` that
# nothing can resolve, and the module renders as a blank panel — with a
# green tick in the build log behind it.
#
# That is not hypothetical: it happened the first time the shared package
# was wired in, because its `main` pointed at TypeScript source. The build
# said Done. The fix is to make the warning fatal, because for a workspace
# package it always means the same thing.
set -euo pipefail
cd "$(dirname "$0")/.."

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

pnpm --filter './apps/directus/extensions/*' build 2>&1 | tee "$LOG"

if grep -q "could not be resolved" "$LOG"; then
  echo
  echo "  ✗ An extension imported something the builder could not resolve."
  echo
  grep "could not be resolved" "$LOG" | sed 's/^/      /'
  cat <<'WHY'

    Treated as an external dependency, which means the built extension
    carries a bare import nothing can satisfy at runtime. It will load
    as a blank panel.

    For a workspace package this is almost always one of two things:
      - it has not been built yet    → pnpm build:packages
      - `main` points at TypeScript  → it has to point at compiled dist

WHY
  exit 1
fi
