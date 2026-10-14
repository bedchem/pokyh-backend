#!/bin/sh
# Pokyh relay installer.
#
# Served by a node of a Pokyh cluster (admin panel → Cluster → "Relay auf VPS
# einrichten") and started with the command shown there, which checks this
# script by SHA-256 before running it:
#
#   curl … -o pokyh-relay.sh https://<node>/cluster-relay/v1/install.sh \
#     && echo '<sha256>  pokyh-relay.sh' | sha256sum -c - && sh pokyh-relay.sh --host vps.example.org …
#
# It installs Docker if needed and runs the relay (embedded below) as a
# container that restarts by itself. At the end it prints the relay key:
# paste it into the admin panel (Cluster → "Relay hinzufügen") once — every
# node of the cluster then registers itself — or into CLUSTER_RELAY_KEYS.
#
# The relay never sees what the nodes exchange: it reads only the server name
# of each incoming TLS connection and passes the encrypted bytes on to the
# node registered under that name.
#
# Options:
#   --host NAME      this server's public name or IP, as nodes reach it   (required with --public)
#   --port N         port to listen on                                      (4100)
#   --public         accept connections on that port from anywhere          (default)
#   --proxy-only     listen on 127.0.0.1 only: your proxy forwards to it
#   --domain NAME    names <node>.NAME arrive on 443 through your proxy (SNI); optional
#   --name NAME      shown in the admin panel                               (relay)
#
# Running it again keeps the relay's identity and key.

set -eu
umask 077

RELAY_HOME=${RELAY_HOME:-/opt/pokyh-relay}
NODE_IMAGE=node:22-alpine
RELAY_UID=10002
DOCKER_KEY_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m'); RED=$(printf '\033[31m'); RESET=$(printf '\033[0m')
else
  BOLD=''; GREEN=''; YELLOW=''; RED=''; RESET=''
fi

step() { printf '\n%s==>%s %s%s%s\n' "$GREEN" "$RESET" "$BOLD" "$*" "$RESET"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    %s! %s%s\n' "$YELLOW" "$*" "$RESET" >&2; }
die() { printf '\n  %s✗ %s%s\n\n' "$RED" "$*" "$RESET" >&2; exit 1; }

is_name() {
  printf '%s' "$1" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
}

is_ipv4() {
  printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'
}

parse_args() {
  HOST=''; PORT=4100; PUBLIC=1; DOMAIN=''; NAME=relay
  while [ $# -gt 0 ]; do
    case "$1" in
      --host|--port|--domain|--name) [ $# -ge 2 ] || die "$1 needs a value" ;;
    esac
    case "$1" in
      --host) HOST=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]'); shift 2 ;;
      --port) PORT=$2; shift 2 ;;
      --public) PUBLIC=1; shift ;;
      --proxy-only) PUBLIC=0; shift ;;
      --domain) DOMAIN=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]'); shift 2 ;;
      --name) NAME=$2; shift 2 ;;
      *) die "Unknown option: $1" ;;
    esac
  done
  case "$PORT" in ''|*[!0-9]*) die "--port must be a number" ;; esac
  [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "--port must be between 1 and 65535"
  if [ "$PUBLIC" = 1 ]; then
    [ -n "$HOST" ] || die "--host is required with --public (the name or IP nodes reach this server at)"
    is_name "$HOST" || is_ipv4 "$HOST" || die "--host is not a valid name or IPv4 address"
  fi
  if [ -n "$DOMAIN" ]; then is_name "$DOMAIN" || die "--domain is not a valid domain name"; fi
  [ "$PUBLIC" = 1 ] || [ -n "$DOMAIN" ] || die "With --proxy-only, --domain is required (the names your proxy forwards on 443)"
  NAME=$(printf '%s' "$NAME" | tr -cd 'A-Za-z0-9 ._-' | cut -c1-60)
  [ -n "$NAME" ] || NAME=relay
}

install_docker() {
  step "Docker"
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    info "$(docker --version)"
    return 0
  fi
  [ -r /etc/os-release ] || die "Docker is not installed and this system is not Debian/Ubuntu — install Docker first, then run this again"
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    debian) CODENAME=${VERSION_CODENAME:-} ;;
    ubuntu) CODENAME=${UBUNTU_CODENAME:-${VERSION_CODENAME:-}} ;;
    *) die "Docker is not installed and ${PRETTY_NAME:-this system} is not Debian/Ubuntu — install Docker first, then run this again" ;;
  esac
  ARCH=$(dpkg --print-architecture)
  info "Installing Docker Engine from download.docker.com"
  apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  key_file=$(mktemp)
  curl -fsSL --proto '=https' "https://download.docker.com/linux/$ID/gpg" -o "$key_file"
  fingerprint=$(gpg --batch --with-colons --show-keys "$key_file" 2>/dev/null | awk -F: '/^fpr:/ { print $10; exit }')
  if [ "$fingerprint" != "$DOCKER_KEY_FINGERPRINT" ]; then
    rm -f "$key_file"
    die "Docker's repository key has an unexpected fingerprint ($fingerprint) — refusing to install"
  fi
  install -m 0644 "$key_file" /etc/apt/keyrings/docker.asc
  rm -f "$key_file"
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$ARCH" "$ID" "$CODENAME" \
    > /etc/apt/sources.list.d/docker.list
  chmod 0644 /etc/apt/sources.list.d/docker.list
  apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends docker-ce docker-ce-cli containerd.io >/dev/null
  if [ -d /run/systemd/system ]; then systemctl enable --now docker >/dev/null 2>&1; fi
  docker info >/dev/null 2>&1 || die "Docker was installed but does not run"
  info "$(docker --version)"
}

write_relay() {
  step "Setting up the relay in $RELAY_HOME"
  mkdir -p "$RELAY_HOME/data"
  chmod 0755 "$RELAY_HOME"
  cat > "$RELAY_HOME/relay.mjs" <<'POKYH_RELAY_END'
__POKYH_RELAY__
POKYH_RELAY_END
  chmod 0644 "$RELAY_HOME/relay.mjs"
  chown "$RELAY_UID:$RELAY_UID" "$RELAY_HOME/data"
  chmod 0700 "$RELAY_HOME/data"
}

start_relay() {
  step "Starting the relay"
  if [ "$PUBLIC" = 1 ]; then BIND=0.0.0.0; PUBLIC_URL="https://$HOST:$PORT"; else BIND=127.0.0.1; PUBLIC_URL=''; fi
  docker pull -q "$NODE_IMAGE" >/dev/null || die "Could not download the $NODE_IMAGE image"
  docker rm -f pokyh-relay >/dev/null 2>&1 || true
  rm -f "$RELAY_HOME/data/relay-key.txt"
  docker run -d --name pokyh-relay --restart unless-stopped \
    --user "$RELAY_UID:$RELAY_UID" --read-only --cap-drop ALL --security-opt no-new-privileges \
    --memory 256m --pids-limit 256 \
    --log-driver local --log-opt max-size=10m --log-opt max-file=3 \
    -p "$BIND:$PORT:4100" \
    -e RELAY_DATA=/data -e RELAY_PORT=4100 -e RELAY_BIND=0.0.0.0 \
    -e RELAY_PUBLIC="$PUBLIC_URL" -e RELAY_DOMAIN="$DOMAIN" -e RELAY_NAME="$NAME" \
    -v "$RELAY_HOME/data:/data" -v "$RELAY_HOME/relay.mjs:/app/relay.mjs:ro" \
    "$NODE_IMAGE" node /app/relay.mjs >/dev/null || die "The relay container could not be started"
  waited=0
  while [ ! -s "$RELAY_HOME/data/relay-key.txt" ]; do
    [ "$waited" -lt 30 ] || die "The relay did not start. Look at: docker logs pokyh-relay"
    sleep 1
    waited=$((waited + 1))
  done
  if [ "$PUBLIC" = 1 ] && command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw allow "$PORT/tcp" >/dev/null && info "Firewall (ufw): opened $PORT"
  fi
}

finish() {
  step "Done"
  if [ "$PUBLIC" = 1 ]; then info "Nodes reach the relay at https://$HOST:$PORT"; fi
  if [ -n "$DOMAIN" ]; then
    info "Your proxy must pass TLS connections for *.$DOMAIN on port 443 through unchanged"
    info "(no TLS termination) to 127.0.0.1:$PORT — DNS: *.$DOMAIN → this server."
  fi
  printf '\n    %sRelay key%s — paste it in the admin panel (Cluster → "Relay hinzufügen") or into CLUSTER_RELAY_KEYS:\n\n' "$BOLD" "$RESET"
  printf '%s\n\n' "$(cat "$RELAY_HOME/data/relay-key.txt")"
  info "Keep the key private: it lets a server register at this relay."
  info "Logs: docker logs -f pokyh-relay"
  printf '\n'
}

main() {
  parse_args "$@"
  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 || die "Run this as root"
    exec sudo -- sh "$0" "$@"
  fi
  printf '%sPokyh relay installer%s\n' "$BOLD" "$RESET"
  install_docker
  write_relay
  start_relay
  finish
}

main "$@"
