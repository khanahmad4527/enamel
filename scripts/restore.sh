#!/usr/bin/env bash
# Put a backup back.
#
# The dangerous script in the pair, so it is the careful one: it checks the
# HMAC before decrypting anything, refuses to write over a database that
# already has patients in it unless told twice, and restores the files
# beside the rows because one without the other is not a restore.
#
# Usage:
#   ./scripts/restore.sh backups/enamel-20260913-120000.dump.enc
#   ./scripts/restore.sh <file> --force        # over a populated database
#   ./scripts/restore.sh <file> --into scratch # into another database
set -euo pipefail
cd "$(dirname "$0")/.."

say()  { printf '\n\033[36m▸\033[0m \033[1m%s\033[0m\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

[ -f .env ] || fail "no .env here"
# An exported BACKUP_PASSPHRASE wins over the one in .env.
#
# Sourcing .env clobbers whatever is already in the environment, which is
# right for every other value here and wrong for this one. The moment you
# need to override it is the moment you are restoring an archive written
# before the passphrase was rotated — and discovering then that the script
# ignores what you passed is the worst possible time to find out.
#
#   BACKUP_PASSPHRASE='the old one' ./scripts/restore.sh backups/….dump.enc
PASSED_IN="${BACKUP_PASSPHRASE:-}"
set -a; . ./.env; set +a
[ -n "${PASSED_IN}" ] && BACKUP_PASSPHRASE="${PASSED_IN}"

ARCHIVE="${1:-}"
[ -n "${ARCHIVE}" ] || fail "which backup? ./scripts/restore.sh backups/enamel-….dump.enc"
[ -f "${ARCHIVE}" ] || fail "no such file: ${ARCHIVE}"
shift

FORCE=0
TARGET="${DB_DATABASE:-enamel}"
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --into)  shift; TARGET="${1:?--into needs a database name}" ;;
    *) fail "unknown option: $1" ;;
  esac
  shift
done

: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE in .env — it is the only way to read this archive}"
USER="${DB_USER:-enamel}"

docker compose ps --status running --format '{{.Service}}' 2>/dev/null | grep -qx database \
  || fail "the database container is not running"

# --- integrity, before anything is decrypted ---------------------------
say "Checking the archive"
[ -f "${ARCHIVE}.hmac" ] || fail "no ${ARCHIVE}.hmac beside it — refusing to restore an unverifiable archive"
EXPECTED="$(cat "${ARCHIVE}.hmac")"
ACTUAL="$(openssl dgst -sha256 -hmac "${BACKUP_PASSPHRASE}" -r "${ARCHIVE}" | cut -d' ' -f1)"
if [ "${EXPECTED}" != "${ACTUAL}" ]; then
  # Could be either, and saying which would be guessing. Both mean the
  # same thing operationally: do not restore this.
  fail "the archive does not match its HMAC — it is damaged, or the passphrase is wrong"
fi
echo "  intact, and the passphrase is right"

# --- is there something here already? ----------------------------------
EXISTING="$(docker compose exec -T database psql -U "${USER}" -d "${TARGET}" -tAc \
  "SELECT count(*) FROM patients" 2>/dev/null | tr -d '\r ' || echo "")"
if [ -n "${EXISTING}" ] && [ "${EXISTING}" != "0" ] && [ "${FORCE}" = "0" ]; then
  cat <<WARN

  ✗ ${TARGET} already holds ${EXISTING} patients.

    Restoring would drop and recreate every object in it. If that is what
    you want, say so:

      ./scripts/restore.sh ${ARCHIVE} --force

    If it is not, restore somewhere else and compare first:

      ./scripts/restore-test.sh ${ARCHIVE}

WARN
  exit 1
fi

# --- the restore -------------------------------------------------------
say "Restoring into ${TARGET}"
docker compose exec -T database psql -U "${USER}" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '${TARGET}'" | grep -q 1 \
  || docker compose exec -T database createdb -U "${USER}" "${TARGET}"

# --clean --if-exists drops each object before recreating it, so this is
# idempotent rather than a pile of "already exists" errors.
#
# The exit code is deliberately not fatal. pg_restore reports a non-zero
# status for warnings that do not matter here — dropping objects that were
# never there, and the comment on the postgis extension, which is owned by
# the superuser and cannot be set by the application role. The check below
# is what decides whether it worked, because "did pg_restore exit 0" and
# "is the practice's data back" are different questions.
set +e
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_PASSPHRASE < "${ARCHIVE}" \
  | docker compose exec -T database pg_restore -U "${USER}" -d "${TARGET}" \
      --clean --if-exists --no-owner --no-privileges 2>/tmp/enamel-restore.$$
RC=$?
set -e
WARNINGS=$(grep -c 'error' /tmp/enamel-restore.$$ 2>/dev/null || true)
if [ "${WARNINGS:-0}" -gt 0 ]; then
  echo "  pg_restore reported ${WARNINGS} non-fatal message(s):"
  grep 'error' /tmp/enamel-restore.$$ | sed 's/^/      /' | head -5
fi
rm -f /tmp/enamel-restore.$$

COUNT="$(docker compose exec -T database psql -U "${USER}" -d "${TARGET}" -tAc \
  "SELECT count(*) FROM patients" 2>/dev/null | tr -d '\r ' || echo 0)"
[ "${COUNT}" -gt 0 ] || fail "the restore finished with no patients in ${TARGET} (pg_restore exit ${RC})"
echo "  ${COUNT} patients"

# --- the files -------------------------------------------------------
UPLOADS="${ARCHIVE%.dump.enc}.uploads.tar.gz.enc"
if [ -f "${UPLOADS}" ]; then
  if [ -f "${UPLOADS}.hmac" ]; then
    U_EXPECTED="$(cat "${UPLOADS}.hmac")"
    U_ACTUAL="$(openssl dgst -sha256 -hmac "${BACKUP_PASSPHRASE}" -r "${UPLOADS}" | cut -d' ' -f1)"
    [ "${U_EXPECTED}" = "${U_ACTUAL}" ] || fail "the uploads archive does not match its HMAC"
  fi
  say "Restoring the file library"
  mkdir -p uploads
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_PASSPHRASE < "${UPLOADS}" \
    | gzip -dc | tar -xf - -C uploads
  echo "  $(find uploads -type f | wc -l | tr -d ' ') files"
else
  echo
  echo "  ! No uploads archive beside this dump. Every document row will"
  echo "    point at a file that is not there."
fi

cat <<EOF

  ${TARGET} is restored.

  Directus caches aggressively, so it will keep serving what it had until
  it is restarted:

    docker compose restart directus core

EOF
