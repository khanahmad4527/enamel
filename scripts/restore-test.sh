#!/usr/bin/env bash
# Prove the backup restores. Not that it exists — that it restores.
#
# A backup nobody has restored is a hypothesis, and the way it usually
# fails is not "the file was empty". It is subtler and worse: the rows
# come back and something else does not. A dump restored without its
# exclusion constraints gives you a database that cheerfully accepts a
# double-booked chair. One restored without `enamel_access_log_append_only`
# gives you an audit log anybody can rewrite. Both look perfect in a row
# count, and both are a system that has quietly stopped enforcing the
# things this project is about.
#
# So this restores into a scratch database beside the live one and asserts
# four kinds of thing:
#
#   1. The rows are there, in the same numbers as the source.
#   2. Named records came back intact, not just counted.
#   3. The constraints and triggers came back — all of them, by name.
#   4. They still *work*: it tries a double-booking and an audit rewrite
#      against the restored copy and requires both to be refused.
#
# The fourth is the one worth having. Three checks the presence of a
# trigger; four checks that restoring did not leave it disabled, which is
# a real pg_restore outcome and not a theoretical one.
#
# The scratch database is dropped on the way out, including on failure.
#
# Usage:
#   ./scripts/restore-test.sh                     # the newest backup
#   ./scripts/restore-test.sh backups/enamel-….dump.enc
set -euo pipefail
cd "$(dirname "$0")/.."

say()  { printf '\n\033[36m▸\033[0m \033[1m%s\033[0m\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

PASSED=0
FAILED=0
check() {
  if [ "$2" = "ok" ]; then
    printf '  \033[32mPASS\033[0m  %s\033[2m%s\033[0m\n' "$(printf '%-62s' "$1")" "${3:-}"
    PASSED=$((PASSED + 1))
  else
    printf '  \033[31mFAIL\033[0m  %s\033[2m%s\033[0m\n' "$(printf '%-62s' "$1")" "${3:-}"
    FAILED=$((FAILED + 1))
  fi
}

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
: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE in .env}"

USER="${DB_USER:-enamel}"
LIVE="${DB_DATABASE:-enamel}"
SCRATCH="${LIVE}_restore_check"

ARCHIVE="${1:-$(ls -t "${BACKUP_DIR:-backups}"/enamel-*.dump.enc 2>/dev/null | head -1 || true)}"
[ -n "${ARCHIVE}" ] || fail "no backup found — run ./scripts/backup.sh first"
[ -f "${ARCHIVE}" ] || fail "no such file: ${ARCHIVE}"

docker compose ps --status running --format '{{.Service}}' 2>/dev/null | grep -qx database \
  || fail "the database container is not running"

# `|| true` on both, and it is load-bearing.
#
# This script runs under `set -o pipefail`, so a psql that exits non-zero
# — which is what "relation does not exist" is — takes the whole pipeline
# down with it, and `set -e` then kills the script mid-loop. It did:
# pointed at a data-only dump with no tables in it, this exited **zero**,
# having printed two passes and nothing else. A test that reports success
# by dying quietly is worse than no test, and the failure it hid is
# exactly the one it exists to catch.
#
# A query that cannot run returns empty here, and every check below is
# written to fail on empty rather than to assume it.
psql_live()    { docker compose exec -T database psql -U "${USER}" -d "${LIVE}"    -tAc "$1" 2>/dev/null | tr -d '\r' || true; }
psql_scratch() { docker compose exec -T database psql -U "${USER}" -d "${SCRATCH}" -tAc "$1" 2>/dev/null | tr -d '\r' || true; }

cleanup() {
  docker compose exec -T database dropdb -U "${USER}" --if-exists "${SCRATCH}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo
echo "  Restoring $(basename "${ARCHIVE}") into ${SCRATCH}"

# --- integrity ---------------------------------------------------------
if [ -f "${ARCHIVE}.hmac" ]; then
  EXPECTED="$(cat "${ARCHIVE}.hmac")"
  ACTUAL="$(openssl dgst -sha256 -hmac "${BACKUP_PASSPHRASE}" -r "${ARCHIVE}" | cut -d' ' -f1)"
  [ "${EXPECTED}" = "${ACTUAL}" ] && check "the archive matches its HMAC" ok \
    || { check "the archive matches its HMAC" no "damaged, or the wrong passphrase"; exit 1; }
else
  check "the archive matches its HMAC" no "no .hmac beside it"
fi

# A wrong passphrase has to fail loudly rather than produce plausible
# rubbish, which is what encrypt-without-MAC does.
if openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass pass:definitely-not-the-passphrase \
     < "${ARCHIVE}" 2>/dev/null | head -c 16 | grep -q 'PGDMP'; then
  check "the archive is actually encrypted" no "it decrypted with the wrong passphrase"
else
  check "the archive is actually encrypted" ok
fi

# --- restore -----------------------------------------------------------
cleanup
docker compose exec -T database createdb -U "${USER}" "${SCRATCH}" >/dev/null

set +e
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_PASSPHRASE < "${ARCHIVE}" \
  | docker compose exec -T database pg_restore -U "${USER}" -d "${SCRATCH}" \
      --no-owner --no-privileges >/tmp/enamel-rt.$$ 2>&1
set -e
ERRORS=$(grep -ci 'error' /tmp/enamel-rt.$$ 2>/dev/null || true)

# --- 1. the rows, table by table --------------------------------------
say "The rows came back"
DRIFT=""
for table in clinics patients appointments treatments treatment_records tooth_conditions \
             invoices invoice_lines documents messages access_log clinic_hours \
             practitioner_hours absences room_closures recalls treatment_plans; do
  L="$(psql_live "SELECT count(*) FROM ${table}")"
  S="$(psql_scratch "SELECT count(*) FROM ${table}")"
  if [ "${L:-x}" = "${S:-y}" ] && [ -n "${L}" ]; then
    :
  else
    DRIFT="${DRIFT} ${table}(${L:-?}≠${S:-?})"
  fi
done
if [ -z "${DRIFT}" ]; then
  check "every table holds the same number of rows as the source" ok \
    "$(psql_scratch "SELECT count(*) FROM patients") patients, $(psql_scratch "SELECT count(*) FROM appointments") appointments"
else
  check "every table holds the same number of rows as the source" no "${DRIFT}"
fi

# --- 2. a named record, not just a count ------------------------------
LIVE_NAME="$(psql_live "SELECT first_name || ' ' || last_name FROM patients ORDER BY id LIMIT 1")"
SCRATCH_NAME="$(psql_scratch "SELECT first_name || ' ' || last_name FROM patients ORDER BY id LIMIT 1")"
[ -n "${LIVE_NAME}" ] && [ "${LIVE_NAME}" = "${SCRATCH_NAME}" ] \
  && check "a named patient came back intact" ok "${SCRATCH_NAME}" \
  || check "a named patient came back intact" no "${LIVE_NAME:-?} vs ${SCRATCH_NAME:-?}"

# Clinical free text is the content most likely to be mangled by an
# encoding mistake somewhere in the pipe, and the least likely to be
# noticed if it is.
LIVE_SUM="$(psql_live    "SELECT md5(string_agg(id::text || coalesce(body,''), '' ORDER BY id)) FROM clinical_notes")"
SCRATCH_SUM="$(psql_scratch "SELECT md5(string_agg(id::text || coalesce(body,''), '' ORDER BY id)) FROM clinical_notes")"
[ -n "${LIVE_SUM}" ] && [ "${LIVE_SUM}" = "${SCRATCH_SUM}" ] \
  && check "every clinical note is byte-for-byte the same" ok "md5 ${SCRATCH_SUM:0:12}…" \
  || check "every clinical note is byte-for-byte the same" no "${LIVE_SUM:0:12} vs ${SCRATCH_SUM:0:12}"

# --- 3. the rules came back, by name ----------------------------------
say "The rules came back"
for con in appointments_no_practitioner_overlap appointments_no_room_overlap \
           appointments_end_after_start practitioner_hours_no_overlap; do
  FOUND="$(psql_scratch "SELECT count(*) FROM pg_constraint WHERE conname = '${con}'")"
  [ "${FOUND}" = "1" ] && check "constraint ${con}" ok || check "constraint ${con}" no "missing"
done
for trg in enamel_appointment_availability enamel_access_log_guard enamel_invoice_totals_sync \
           enamel_document_versions; do
  FOUND="$(psql_scratch "SELECT count(*) FROM pg_trigger WHERE tgname = '${trg}' AND NOT tgisinternal")"
  [ "${FOUND:-0}" -ge 1 ] && check "trigger ${trg}" ok || check "trigger ${trg}" no "missing"
done

# --- 4. and they still work -------------------------------------------
# The check worth having. A trigger can restore as a row in pg_trigger and
# still be disabled — `ALTER TABLE … DISABLE TRIGGER` is a real state a
# restore can land in, and pg_restore uses it internally while loading
# data. Presence is necessary and not sufficient.
say "And they still refuse what they should"

DOUBLE="$(docker compose exec -T database psql -U "${USER}" -d "${SCRATCH}" -tAc "
  DO \$\$
  DECLARE a appointments;
  BEGIN
    SELECT * INTO a FROM appointments
      WHERE practitioner IS NOT NULL AND status IN ('scheduled','confirmed') LIMIT 1;
    IF a.id IS NULL THEN RAISE EXCEPTION 'NO_SAMPLE'; END IF;
    INSERT INTO appointments (id, clinic, patient, practitioner, room, starts_at, ends_at, status)
      VALUES (gen_random_uuid(), a.clinic, a.patient, a.practitioner, a.room,
              a.starts_at, a.ends_at, 'scheduled');
    RAISE EXCEPTION 'ACCEPTED_A_DOUBLE_BOOKING';
  END \$\$;" 2>&1 | tr -d '\r' || true)"
case "${DOUBLE}" in
  *ACCEPTED_A_DOUBLE_BOOKING*)
    check "a restored database still refuses a double-booking" no "it accepted one" ;;
  *NO_SAMPLE*)
    check "a restored database still refuses a double-booking" no "no booked appointment to clash with" ;;
  *conflicting*|*exclusion*|*overlap*|*ENAMEL_*)
    check "a restored database still refuses a double-booking" ok "the constraint fired" ;;
  *)
    check "a restored database still refuses a double-booking" no "${DOUBLE:0:60}" ;;
esac

REWRITE="$(docker compose exec -T database psql -U "${USER}" -d "${SCRATCH}" -tAc \
  "UPDATE access_log SET item_count = 999 WHERE id = (SELECT id FROM access_log LIMIT 1)" 2>&1 | tr -d '\r' || true)"
case "${REWRITE}" in
  *ENAMEL_LOG_IMMUTABLE*) check "a restored audit log still cannot be rewritten" ok "the trigger fired" ;;
  UPDATE\ 0)              check "a restored audit log still cannot be rewritten" no "there was nothing in the log to try" ;;
  *)                      check "a restored audit log still cannot be rewritten" no "${REWRITE:0:60}" ;;
esac

# --- the file library --------------------------------------------------
UPLOADS="${ARCHIVE%.dump.enc}.uploads.tar.gz.enc"
say "The files behind the rows"
if [ -f "${UPLOADS}" ]; then
  FILES_IN_TAR="$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_PASSPHRASE < "${UPLOADS}" \
    | gzip -dc | tar -tf - 2>/dev/null | grep -c -v '/$' || true)"
  # Every file Directus knows about has to be in the archive, or the
  # restore produces documents pointing at nothing.
  KNOWN="$(psql_scratch "SELECT count(*) FROM directus_files")"
  [ "${FILES_IN_TAR:-0}" -ge "${KNOWN:-1}" ] \
    && check "the uploads archive holds every file the database refers to" ok "${FILES_IN_TAR} files, ${KNOWN} rows" \
    || check "the uploads archive holds every file the database refers to" no "${FILES_IN_TAR} files, ${KNOWN} rows"
else
  check "the uploads archive holds every file the database refers to" no "no uploads archive beside this dump"
fi

if [ "${ERRORS:-0}" -gt 0 ]; then
  echo
  echo "  pg_restore also reported ${ERRORS} message(s) containing 'error':"
  grep -i 'error' /tmp/enamel-rt.$$ | sed 's/^/      /' | head -4
fi
rm -f /tmp/enamel-rt.$$

echo
if [ "${FAILED}" = "0" ]; then
  printf '  \033[32m%s/%s checks passed — this backup restores\033[0m\n\n' "${PASSED}" "$((PASSED + FAILED))"
else
  printf '  \033[31m%s of %s checks FAILED — do not rely on this backup\033[0m\n\n' "${FAILED}" "$((PASSED + FAILED))"
  exit 1
fi
