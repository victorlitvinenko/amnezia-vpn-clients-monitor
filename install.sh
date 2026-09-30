#!/usr/bin/env bash

set -Eeuo pipefail

readonly REPOSITORY_ARCHIVE_URL="${REPOSITORY_ARCHIVE_URL:-https://github.com/victorlitvinenko/amnezia-vpn-clients-monitor/archive/refs/heads/main.tar.gz}"
readonly INSTALL_DIR="${INSTALL_DIR:-/opt/amnezia-vpn-clients-monitor}"

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

ask() {
  local prompt="$1"
  local default_value="$2"
  local answer=''

  if [[ -r /dev/tty ]]; then
    read -r -p "$prompt [$default_value]: " answer </dev/tty
  fi
  printf '%s' "${answer:-$default_value}"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "'$1' is required. Install it and run the script again."
}

install_docker() {
  if [[ ! -r /dev/tty ]]; then
    fail 'Docker is missing and no terminal is available to confirm its installation.'
  fi

  local answer=''
  read -r -p 'Docker is missing. Install Docker Engine using https://get.docker.com? [y/N]: ' answer </dev/tty
  [[ "$answer" =~ ^[Yy]$ ]] || fail 'Docker Engine is required to continue.'

  if [[ "$(id -u)" -eq 0 ]]; then
    curl -fsSL https://get.docker.com | sh
  else
    require_command sudo
    curl -fsSL https://get.docker.com | sudo sh
  fi
}

if [[ "$(uname -s)" != 'Linux' ]]; then
  fail 'This installer supports Linux only.'
fi

require_command curl
require_command tar

if ! command -v docker >/dev/null 2>&1; then
  install_docker
fi

if ! docker compose version >/dev/null 2>&1; then
  fail 'Docker Compose plugin is required. Install it and run the script again.'
fi

docker_command=(docker)
if ! docker info >/dev/null 2>&1; then
  require_command sudo
  docker_command=(sudo docker)
fi

container_name="$(ask 'AmneziaWG container name' "${AMNEZIA_CONTAINER:-amnezia-awg2}")"
host_port="$(ask 'Dashboard host port' "${HOST_PORT:-8080}")"

[[ "$container_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || fail 'Container name contains unsupported characters.'
[[ "$host_port" =~ ^[0-9]+$ ]] && ((host_port >= 1 && host_port <= 65535)) ||
  fail 'Host port must be between 1 and 65535.'

"${docker_command[@]}" container inspect "$container_name" >/dev/null 2>&1 ||
  fail "AmneziaWG container '$container_name' was not found. Start it first, then run this script again."

if [[ -e "$INSTALL_DIR" ]]; then
  fail "Installation directory '$INSTALL_DIR' already exists. Remove it manually or set INSTALL_DIR before running the script."
fi

temporary_directory="$(mktemp -d)"
curl -fsSL "$REPOSITORY_ARCHIVE_URL" -o "$temporary_directory/project.tar.gz"
tar -tzf "$temporary_directory/project.tar.gz" >/dev/null

if [[ "$(id -u)" -eq 0 ]]; then
  mkdir -p "$INSTALL_DIR"
  tar -xzf "$temporary_directory/project.tar.gz" --strip-components=1 -C "$INSTALL_DIR"
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
  sed -i "s|^HOST_PORT=.*|HOST_PORT=$host_port|; s|^AMNEZIA_CONTAINER=.*|AMNEZIA_CONTAINER=$container_name|" "$INSTALL_DIR/.env"
else
  require_command sudo
  sudo mkdir -p "$INSTALL_DIR"
  sudo tar -xzf "$temporary_directory/project.tar.gz" --strip-components=1 -C "$INSTALL_DIR"
  sudo cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  sudo chmod 600 "$INSTALL_DIR/.env"
  sudo sed -i "s|^HOST_PORT=.*|HOST_PORT=$host_port|; s|^AMNEZIA_CONTAINER=.*|AMNEZIA_CONTAINER=$container_name|" "$INSTALL_DIR/.env"
fi

cd "$INSTALL_DIR"
"${docker_command[@]}" compose up -d --build

for _ in {1..20}; do
  if curl --fail --silent "http://127.0.0.1:$host_port/api/health" >/dev/null; then
    printf '\nDashboard is running. Configure an HTTPS domain, then open it and create the administrator password.\n'
    exit 0
  fi
  sleep 2
done

fail "The dashboard did not become healthy. Run '${docker_command[*]} compose logs vpn-dashboard' in '$INSTALL_DIR'."
