#!/usr/bin/env bash

set -Eeuo pipefail

readonly INSTALL_DIR="${INSTALL_DIR:-/opt/amnezia-vpn-clients-monitor}"
readonly UPDATE_SERVICE='amnezia-vpn-monitor-update.service'
readonly UPDATE_TIMER='amnezia-vpn-monitor-update.timer'

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

[[ "$INSTALL_DIR" == /* && "$INSTALL_DIR" != '/' ]] ||
  fail 'INSTALL_DIR must be an absolute path other than /.'
[[ -d "$INSTALL_DIR" ]] || fail "Installation directory '$INSTALL_DIR' was not found."
[[ -f "$INSTALL_DIR/docker-compose.yml" ]] ||
  fail "Docker Compose configuration was not found in '$INSTALL_DIR'."

if [[ ! -r /dev/tty ]]; then
  fail 'No terminal is available to confirm uninstallation.'
fi

printf '%s\n' "This removes the dashboard container, its image, and all dashboard data in '$INSTALL_DIR'."
printf '%s\n' 'Docker, the Docker Compose plugin, and the AmneziaWG container will not be changed.'

answer=''
read -r -p 'Continue? [y/N]: ' answer </dev/tty
[[ "$answer" =~ ^[Yy]$ ]] || {
  printf '%s\n' 'Uninstallation cancelled.'
  exit 0
}

command -v docker >/dev/null 2>&1 || fail 'Docker is required to remove the dashboard resources.'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose plugin is required to remove the dashboard resources.'

docker_command=(docker)
if ! docker info >/dev/null 2>&1; then
  command -v sudo >/dev/null 2>&1 || fail 'sudo is required to access Docker.'
  docker_command=(sudo docker)
fi

cd "$INSTALL_DIR"
"${docker_command[@]}" compose down --volumes --rmi local --remove-orphans

if command -v systemctl >/dev/null 2>&1; then
  if [[ "$(id -u)" -eq 0 ]]; then
    systemctl disable --now "$UPDATE_TIMER" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$UPDATE_SERVICE" "/etc/systemd/system/$UPDATE_TIMER"
    systemctl daemon-reload >/dev/null 2>&1 || true
  else
    command -v sudo >/dev/null 2>&1 || fail 'sudo is required to remove the automatic update task.'
    sudo systemctl disable --now "$UPDATE_TIMER" >/dev/null 2>&1 || true
    sudo rm -f "/etc/systemd/system/$UPDATE_SERVICE" "/etc/systemd/system/$UPDATE_TIMER"
    sudo systemctl daemon-reload >/dev/null 2>&1 || true
  fi
fi

if [[ "$(id -u)" -eq 0 ]]; then
  rm -rf -- "$INSTALL_DIR"
else
  command -v sudo >/dev/null 2>&1 || fail "sudo is required to remove '$INSTALL_DIR'."
  sudo rm -rf -- "$INSTALL_DIR"
fi

printf '%s\n' 'Dashboard uninstalled.'
