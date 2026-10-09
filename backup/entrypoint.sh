#!/bin/sh
set -eu

password_file=${RESTIC_PASSWORD_FILE:-/backup-root/.assistant-fleet-restic-password}
repository=${RESTIC_REPOSITORY:-/backup-root/restic}

mkdir -p "$(dirname "$password_file")" "$repository" /restore

if [ ! -s "$password_file" ]; then
  umask 077
  head -c 32 /dev/urandom | base64 > "$password_file"
  echo "Created the Restic password file at $password_file. Keep a separate secure copy."
fi

if [ ! -f "$repository/config" ]; then
  restic init
  echo "Initialized the Restic repository at $repository."
fi

if [ "${1:-schedule}" = "schedule" ]; then
  last_success=/backup-root/.assistant-fleet-status/last-success
  today=$(date +%F)
  hour=$(date +%H)
  last_success_day=$(sed -n '1s/T.*//p' "$last_success" 2>/dev/null || true)
  if [ "$last_success_day" != "$today" ] && [ "$hour" -ge 10 ]; then
    echo "Today's 10:00 backup was missed; running it now."
    if ! /usr/local/bin/fleet-backup run; then
      echo "Catch-up backup failed; keeping the scheduler available for retry." >&2
    fi
  fi
  echo "Fleet backups are scheduled daily at 10:00 America/New_York."
  exec crond -f -l 2
fi

exec /usr/local/bin/fleet-backup "$@"
