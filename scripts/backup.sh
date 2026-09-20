#!/usr/bin/env bash
# An encrypted backup of the database and the files it refers to.
#
# Two things are backed up because restoring one without the other gives
# you a working system full of broken images: the database holds a row
# saying "this patient's panoramic is file 8f3a…", and the bytes of 8f3a
# live in ./uploads. A dump alone restores to a practice whose radiographs
# have all disappeared.
#
# Encrypt-then-MAC, in that order. `openssl enc` gives confidentiality and
# no integrity at all: flip a byte in the ciphertext and it decrypts to
# garbage, or to something pg_restore half-accepts. The detached HMAC is
# checked *before* anything is decrypted, so a corrupted or tampered
# archive is refused rather than restored.
#
# Usage:
#   ./scripts/backup.sh            # database + uploads, encrypted
#   ./scripts/backup.sh --db-only  # skip the file library
set -euo pipefail
cd "$(dirname "$0")/.."

say()  { printf '\n\033[36m▸\033[0m \033[1m%s\033[0m\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

[ -f .env ] || fail "no .env here — run ./scripts/setup.sh first"
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

DB_ONLY=0
[ "${1:-}" = "--db-only" ] && DB_ONLY=1

command -v openssl >/dev/null 2>&1 || fail "openssl is required and is not on PATH"
command -v docker  >/dev/null 2>&1 || fail "docker is required and is not on PATH"

: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE in .env (./scripts/setup.sh generates one)}"
if [ "${#BACKUP_PASSPHRASE}" -lt 16 ]; then
  fail "BACKUP_PASSPHRASE is ${#BACKUP_PASSPHRASE} characters — use at least 16"
fi

DB="${DB_DATABASE:-enamel}"
USER="${DB_USER:-enamel}"
DIR="${BACKUP_DIR:-backups}"
KEEP="${BACKUP_KEEP:-7}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BASE="${DIR}/enamel-${STAMP}"

docker compose ps --status running --format '{{.Service}}' 2>/dev/null | grep -qx database \
  || fail "the database container is not running — docker compose up -d database"

mkdir -p "${DIR}"

# 600 on the directory as well as the files. A backup of a clinical
# database is the single most concentrated copy of it that exists.
chmod 700 "${DIR}"

# Encrypt on the way past, never to a plaintext file on disk.
#
# `-iter 600000` rather than openssl's default of 10000: this is a
# passphrase, and the only thing standing between a stolen archive and
# every patient in it is how long each guess costs an attacker. 600k is
# OWASP's current floor for PBKDF2-HMAC-SHA256.
encrypt() {
  openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass env:BACKUP_PASSPHRASE
}

# Keyed with the passphrase, computed over the ciphertext. Anybody who can
# read the archive cannot forge this without the key, and the check runs
# before a single byte reaches pg_restore.
sign() {
  openssl dgst -sha256 -hmac "${BACKUP_PASSPHRASE}" -r "$1" | cut -d' ' -f1 > "$1.hmac"
}

say "Dumping ${DB}"
# -Fc, the custom format: compressed, restorable selectively, and the only
# format pg_restore can parallelise. Plain SQL would also work and would
# be twice the size and single-threaded to restore, which matters on the
# day you are actually using this.
#
# --no-owner and --no-privileges: the role names on the machine you
# restore onto are not the role names on the machine you dumped from, and
# a restore that fails halfway through on a missing role is a restore that
# did not happen.
if ! docker compose exec -T database \
      pg_dump -U "${USER}" -d "${DB}" -Fc --no-owner --no-privileges \
      2>"${BASE}.dump.err" | encrypt > "${BASE}.dump.enc"; then
  cat "${BASE}.dump.err" >&2
  rm -f "${BASE}.dump.enc" "${BASE}.dump.err"
  fail "pg_dump failed"
fi
rm -f "${BASE}.dump.err"
sign "${BASE}.dump.enc"
DB_BYTES=$(wc -c < "${BASE}.dump.enc" | tr -d ' ')
echo "  $(printf '%s' "$((DB_BYTES / 1024))") KB encrypted"

UPLOAD_BYTES=0
if [ "${DB_ONLY}" = "0" ] && [ -d uploads ]; then
  say "Archiving the file library"
  # Relative paths inside the tar, so restoring into a different checkout
  # does not write to an absolute path from this machine.
  tar -cf - -C uploads . | gzip -9 | encrypt > "${BASE}.uploads.tar.gz.enc"
  sign "${BASE}.uploads.tar.gz.enc"
  UPLOAD_BYTES=$(wc -c < "${BASE}.uploads.tar.gz.enc" | tr -d ' ')
  echo "  $((UPLOAD_BYTES / 1024)) KB encrypted"
fi

# What this is a backup *of*. A restore six months from now is done by
# somebody who does not remember which version wrote it, and "which
# Directus made this dump" is the first question they will have.
cat > "${BASE}.manifest.json" <<JSON
{
  "taken_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "database": "${DB}",
  "postgres": "$(docker compose exec -T database psql -U "${USER}" -d "${DB}" -tAc 'SHOW server_version' 2>/dev/null | tr -d '\r')",
  "directus_image": "${DIRECTUS_IMAGE:-directus/directus:11}",
  "includes_uploads": $([ "${UPLOAD_BYTES}" -gt 0 ] && echo true || echo false),
  "cipher": "aes-256-cbc, pbkdf2-hmac-sha256, 600000 iterations",
  "integrity": "hmac-sha256 over the ciphertext, in the .hmac beside each file"
}
JSON

say "Pruning to the last ${KEEP}"
# Newest first, skip the ones being kept, delete the rest and everything
# named after them. `ls -t` rather than sorting the timestamp out of the
# name: the file's own mtime is the thing that cannot disagree with itself.
PRUNED=0
for old in $(ls -t "${DIR}"/enamel-*.dump.enc 2>/dev/null | tail -n +"$((KEEP + 1))"); do
  rm -f "${old%.dump.enc}".*
  PRUNED=$((PRUNED + 1))
done
echo "  ${PRUNED} older backup(s) removed, $(ls -1 "${DIR}"/enamel-*.dump.enc 2>/dev/null | wc -l | tr -d ' ') kept"

chmod 600 "${BASE}".* 2>/dev/null || true

cat <<EOF

  Written to ${BASE}.*

  Restore it:        ./scripts/restore.sh ${BASE}.dump.enc
  Prove it restores: ./scripts/restore-test.sh ${BASE}.dump.enc

  A backup nobody has restored is a hypothesis. The second command is the
  one that turns it into a fact — it restores into a scratch database and
  asserts the rows, the constraints and the triggers all came back.

EOF
