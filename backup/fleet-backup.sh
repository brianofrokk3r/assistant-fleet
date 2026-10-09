#!/bin/sh
set -eu

staging=/staging/current
paused_file=/tmp/fleet-backup-paused
status_dir=/backup-root/.assistant-fleet-status

read_status_value() {
  file=$1
  fallback=$2
  if [ -s "$status_dir/$file" ]; then cat "$status_dir/$file"; else printf '%s' "$fallback"; fi
}

write_status() {
  state=$1
  operation=$2
  message=$3
  mkdir -p "$status_dir"
  printf '%s' "$state" > "$status_dir/state"
  printf '%s' "$operation" > "$status_dir/operation"
  printf '%s' "$message" > "$status_dir/message"
  date -Iseconds > "$status_dir/updated-at"
}

json_escape() {
  sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n'
}

show_status() {
  state=$(read_status_value state idle)
  operation=$(read_status_value operation none)
  message=$(read_status_value message 'No backup has completed yet.')
  updated_at=$(read_status_value updated-at '')
  last_attempt=$(read_status_value last-attempt '')
  last_success=$(read_status_value last-success '')
  last_restore=$(read_status_value last-restore '')
  restore_target=$(read_status_value restore-target '')
  duration=$(read_status_value duration-seconds '')
  printf '{"state":"%s","operation":"%s","message":"%s","updatedAt":"%s","lastAttempt":"%s","lastSuccess":"%s","lastRestore":"%s","restoreTarget":"%s","durationSeconds":%s}\n' \
    "$(printf '%s' "$state" | json_escape)" \
    "$(printf '%s' "$operation" | json_escape)" \
    "$(printf '%s' "$message" | json_escape)" \
    "$(printf '%s' "$updated_at" | json_escape)" \
    "$(printf '%s' "$last_attempt" | json_escape)" \
    "$(printf '%s' "$last_success" | json_escape)" \
    "$(printf '%s' "$last_restore" | json_escape)" \
    "$(printf '%s' "$restore_target" | json_escape)" \
    "${duration:-null}"
}

resume_tenants() {
  if [ -f "$paused_file" ]; then
    while IFS= read -r container; do
      [ -n "$container" ] || continue
      docker unpause "$container" >/dev/null 2>&1 || true
    done < "$paused_file"
    rm -f "$paused_file"
  fi
}

prepare_staging() {
  case "$staging" in
    /staging/*) ;;
    *) echo "Refusing unsafe staging path: $staging" >&2; exit 1 ;;
  esac
  rm -rf "$staging"
  mkdir -p "$staging/volumes"
  : > "$paused_file"
}

stage_fleet_files() {
  mkdir -p "$staging/fleet"
  set --
  for path in \
    data \
    tenants \
    rendered-skillsets \
    repository-snapshots \
    secrets \
    .env.console \
    compose.yaml
  do
    [ -e "/fleet/$path" ] && set -- "$@" "$path"
  done
  [ "$#" -gt 0 ] || return 0

  # Restic can receive EIO from Docker Desktop's VirtioFS bind while reading
  # many files concurrently. Copy the small Fleet control files into the
  # Docker-native staging volume first. Tenant workspaces are already captured
  # consistently from their /data volumes below.
  tar -C /fleet \
    --exclude='tenants/*/workspace' \
    --exclude='tenants/*/workspace/*' \
    -cf - "$@" |
    tar -C "$staging/fleet" -xf -
}

copy_tenant_volumes() {
  docker ps -a \
    --filter label=com.docker.compose.service=assistant \
    --format '{{.ID}} {{.Label "com.docker.compose.project"}}' |
  while read -r container project; do
    case "$project" in
      assistant-*) ;;
      *) continue ;;
    esac

    tenant=${project#assistant-}
    volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}{{end}}' "$container")
    [ -n "$volume" ] || continue

    running=$(docker inspect --format '{{.State.Running}}' "$container")
    if [ "$running" = "true" ]; then
      echo "Pausing $tenant while its data volume is copied."
      docker pause "$container" >/dev/null
      echo "$container" >> "$paused_file"
    fi

    mkdir -p "$staging/volumes/$tenant"
    if ! docker cp "$container:/data/." "$staging/volumes/$tenant/"; then
      echo "Failed to copy the /data volume for $tenant." >&2
      return 1
    fi

    if [ "$running" = "true" ]; then
      docker unpause "$container" >/dev/null
      sed -i "\|^$container\$|d" "$paused_file"
    fi
  done
}

run_backup() {
  started=$(date +%s)
  mkdir -p "$status_dir"
  date -Iseconds > "$status_dir/last-attempt"
  write_status running backup 'Backing up Fleet data and tenant volumes.'
  completed=false
  backup_cleanup() {
    code=$?
    resume_tenants
    rm -rf "$staging"
    if [ "$completed" != "true" ]; then
      write_status failed backup 'Backup failed. Check the fleet-backup logs for details.'
    fi
    return "$code"
  }
  trap backup_cleanup EXIT INT TERM
  prepare_staging
  stage_fleet_files
  copy_tenant_volumes
  resume_tenants

  set --
  for path in \
    "$staging/fleet/data" \
    "$staging/fleet/tenants" \
    "$staging/fleet/rendered-skillsets" \
    "$staging/fleet/repository-snapshots" \
    "$staging/fleet/secrets" \
    "$staging/fleet/.env.console" \
    "$staging/fleet/compose.yaml"
  do
    [ -e "$path" ] && set -- "$@" "$path"
  done
  set -- "$@" "$staging/volumes"

  echo "Starting Fleet backup at $(date -Iseconds)."
  restic backup --tag assistant-fleet --exclude '**/*.sock' "$@"
  restic forget --tag assistant-fleet --keep-daily 7 --keep-weekly 5 --keep-monthly 6 --prune
  restic check
  finished=$(date +%s)
  date -Iseconds > "$status_dir/last-success"
  printf '%s' "$((finished - started))" > "$status_dir/duration-seconds"
  write_status success backup 'Backup completed successfully.'
  completed=true
  rm -rf "$staging"
  echo "Fleet backup completed at $(date -Iseconds)."
}

run_check() {
  write_status verifying verify 'Checking backup repository integrity.'
  if restic check --read-data-subset=10%; then
    write_status success verify 'Backup verification passed.'
  else
    write_status failed verify 'Backup verification failed. Check the fleet-backup logs.'
    return 1
  fi
}

run_restore() {
  snapshot=$1
  short=$(printf '%.8s' "$snapshot")
  target="/restore/$(date +%Y%m%d-%H%M%S)-$short"
  mkdir -p "$target"
  chown "${RESTORE_UID:-1000}:${RESTORE_GID:-1000}" "$target"
  printf '%s' "$target" > "$status_dir/restore-target"
  write_status restoring restore "Restoring snapshot $short into a safe staging folder."
  if restic restore "$snapshot" --target "$target"; then
    date -Iseconds > "$status_dir/last-restore"
    write_status success restore "Snapshot $short restored successfully to $target."
  else
    write_status failed restore "Snapshot $short could not be restored. Check the fleet-backup logs."
    return 1
  fi
}

command=${1:-run}
case "$command" in
  run)
    if ! flock -n /backup-root/.assistant-fleet-operation.lock "$0" _run; then
      echo "Another backup operation is already running." >&2
      exit 75
    fi
    ;;
  _run)
    run_backup
    ;;
  snapshots)
    exec restic snapshots --tag assistant-fleet
    ;;
  snapshots-json)
    exec restic snapshots --tag assistant-fleet --json
    ;;
  check)
    if ! flock -n /backup-root/.assistant-fleet-operation.lock "$0" _check; then
      echo "Another backup operation is already running." >&2
      exit 75
    fi
    ;;
  _check)
    run_check
    ;;
  status)
    show_status
    ;;
  restore)
    snapshot=${2:-}
    case "$snapshot" in
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
      *) echo "A hexadecimal snapshot ID is required." >&2; exit 2 ;;
    esac
    if ! flock -n /backup-root/.assistant-fleet-operation.lock "$0" _restore "$snapshot"; then
      echo "Another backup operation is already running." >&2
      exit 75
    fi
    ;;
  _restore)
    run_restore "$2"
    ;;
  *)
    echo "Usage: fleet-backup {run|snapshots|snapshots-json|check|status|restore SNAPSHOT}" >&2
    exit 2
    ;;
esac
