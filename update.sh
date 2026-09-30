#!/usr/bin/env bash

set -Eeuo pipefail

readonly REPOSITORY_ARCHIVE_URL="${REPOSITORY_ARCHIVE_URL:-https://github.com/victorlitvinenko/amnezia-vpn-clients-monitor/archive/refs/heads/main.tar.gz}"
readonly INSTALL_DIR="${INSTALL_DIR:-/opt/amnezia-vpn-clients-monitor}"
readonly UPDATE_SERVICE='amnezia-vpn-monitor-update.service'
readonly UPDATE_TIMER='amnezia-vpn-monitor-update.timer'
readonly VERSION_FILE="$INSTALL_DIR/.amnezia-vpn-monitor-update.sha256"

temporary_directory=''

cleanup() {
  if [[ -n "$temporary_directory" && -d "$temporary_directory" ]]; then
    rm -rf "$temporary_directory"
  fi
}

trap cleanup EXIT

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "'$1' is required."
}

run_privileged() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    require_command sudo
    sudo "$@"
  fi
}

validate_installation() {
  [[ "$INSTALL_DIR" == /* && "$INSTALL_DIR" != '/' ]] ||
    fail 'INSTALL_DIR must be an absolute path other than /.'
  [[ -d "$INSTALL_DIR" ]] || fail "Installation directory '$INSTALL_DIR' was not found."
  [[ -f "$INSTALL_DIR/docker-compose.yml" ]] ||
    fail "Docker Compose configuration was not found in '$INSTALL_DIR'."
}

configure_docker_command() {
  require_command docker
  docker compose version >/dev/null 2>&1 || fail 'Docker Compose plugin is required.'

  docker_command=(docker)
  if ! docker info >/dev/null 2>&1; then
    require_command sudo
    docker_command=(sudo docker)
  fi
}

update_dashboard() {
  require_command curl
  require_command sha256sum
  require_command tar
  validate_installation
  configure_docker_command

  temporary_directory="$(mktemp -d)"
  curl -fsSL "$REPOSITORY_ARCHIVE_URL" -o "$temporary_directory/project.tar.gz"
  tar -tzf "$temporary_directory/project.tar.gz" >/dev/null
  local archive_checksum
  archive_checksum="$(sha256sum "$temporary_directory/project.tar.gz" | cut -d ' ' -f 1)"

  if [[ -r "$VERSION_FILE" ]]; then
    local installed_checksum=''
    read -r installed_checksum <"$VERSION_FILE" || true
    if [[ "$archive_checksum" == "$installed_checksum" ]]; then
      printf '%s\n' 'Dashboard is already up to date.'
      return
    fi
  fi

  run_privileged tar -xzf "$temporary_directory/project.tar.gz" \
    --exclude='.env' \
    --strip-components=1 \
    -C "$INSTALL_DIR"

  cd "$INSTALL_DIR"
  "${docker_command[@]}" compose up -d --build --remove-orphans
  printf '%s\n' "$archive_checksum" | run_privileged tee "$VERSION_FILE" >/dev/null
  printf '%s\n' 'Dashboard updated.'
}

enable_auto_update() {
  require_command systemctl
  validate_installation

  temporary_directory="${temporary_directory:-$(mktemp -d)}"
  local service_file="$temporary_directory/$UPDATE_SERVICE"
  local timer_file="$temporary_directory/$UPDATE_TIMER"

  printf '%s\n' \
    '[Unit]' \
    'Description=Update AmneziaVPN Clients Monitor' \
    'Wants=network-online.target' \
    'After=network-online.target docker.service' \
    '' \
    '[Service]' \
    'Type=oneshot' \
    "ExecStart=$INSTALL_DIR/update.sh" >"$service_file"

  printf '%s\n' \
    '[Unit]' \
    'Description=Daily update for AmneziaVPN Clients Monitor' \
    '' \
    '[Timer]' \
    'OnCalendar=*-*-* 00:00:00' \
    'RandomizedDelaySec=3h' \
    'Persistent=true' \
    '' \
    '[Install]' \
    'WantedBy=timers.target' >"$timer_file"

  run_privileged install -m 644 "$service_file" "/etc/systemd/system/$UPDATE_SERVICE"
  run_privileged install -m 644 "$timer_file" "/etc/systemd/system/$UPDATE_TIMER"
  run_privileged systemctl daemon-reload
  run_privileged systemctl enable --now "$UPDATE_TIMER"
  printf '%s\n' 'Daily automatic updates are enabled.'
}

disable_auto_update() {
  require_command systemctl
  run_privileged systemctl disable --now "$UPDATE_TIMER" >/dev/null 2>&1 || true
  run_privileged rm -f "/etc/systemd/system/$UPDATE_SERVICE" "/etc/systemd/system/$UPDATE_TIMER"
  run_privileged systemctl daemon-reload
  printf '%s\n' 'Daily automatic updates are disabled.'
}

case "${1:-update}" in
  update) update_dashboard ;;
  --enable-auto-update) enable_auto_update ;;
  --setup-auto-update)
    update_dashboard
    enable_auto_update
    ;;
  --disable-auto-update) disable_auto_update ;;
  *) fail 'Usage: update.sh [update|--enable-auto-update|--setup-auto-update|--disable-auto-update]' ;;
esac
