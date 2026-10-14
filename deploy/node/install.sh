#!/bin/sh
# Pokyh node installer.
#
# Served by a node of a Pokyh cluster at /cluster/v1/install.sh and started
# with the one-line command that node's admin panel shows (Cluster → "Server
# per Einzeiler hinzufügen"):
#
#   curl … --pinnedpubkey 'sha256//<node pin>' -o pokyh-install.sh https://<node>:4100/cluster/v1/install.sh \
#     && echo '<sha256>  pokyh-install.sh' | sha256sum -c - && sh pokyh-install.sh '<token>'
#
# curl accepts only the inviting node's certificate and sha256sum only this
# exact script, so neither DNS, a certificate authority nor anything on the
# way can hand you a different one.
#
# It turns a fresh Debian or Ubuntu server into a node of that cluster:
#   1. checks the system: OS, architecture, memory, disk, free ports, clock;
#   2. installs Docker Engine from Docker's own repository, with the
#      repository key's fingerprint pinned below;
#   3. runs the bootstrap (embedded below) in a throw-away Node.js container:
#      it fetches the cluster's shared configuration (sealed with a key only
#      the token yields) and the inviting node's exact build (hash-checked),
#      and writes this node's configuration with secrets of its own;
#   4. builds and starts the stack in /opt/pokyh: MySQL, Redis, the backend,
#      Caddy (HTTPS for this server's domain, Let's Encrypt), optionally Ollama;
#   5. waits until the node has paired with the cluster over the mutually
#      authenticated channel and received the cluster's data.
#
# Running it again with the same token resumes after a failure.

set -eu
umask 077

POKYH_HOME=${POKYH_HOME:-/opt/pokyh}
NODE_IMAGE=node:22-alpine
APP_UID=10001
CLUSTER_PORT=4100
DOCKER_KEY_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
MIN_MEMORY_KB=1900000
MIN_DISK_KB=10000000

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m'); RED=$(printf '\033[31m'); RESET=$(printf '\033[0m')
else
  BOLD=''; GREEN=''; YELLOW=''; RED=''; RESET=''
fi

step() { printf '\n%s==>%s %s%s%s\n' "$GREEN" "$RESET" "$BOLD" "$*" "$RESET"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    %s! %s%s\n' "$YELLOW" "$*" "$RESET" >&2; }
die() { printf '\n  %s✗ %s%s\n\n' "$RED" "$*" "$RESET" >&2; exit 1; }

compose() {
  docker compose --project-directory "$POKYH_HOME" --env-file "$POKYH_HOME/compose.env" -f "$POKYH_HOME/compose.yml" "$@"
}

apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@" >/dev/null
}

port_in_use() {
  command -v ss >/dev/null 2>&1 || return 1
  [ -n "$(ss -Hltn "( sport = :$1 )" 2>/dev/null)" ] || [ -n "$(ss -Hlun "( sport = :$1 )" 2>/dev/null)" ]
}

# ─── 1. System ─────────────────────────────────────────────────────────────────

preflight() {
  step "Checking this server"
  [ -r /etc/os-release ] || die "Unsupported system: /etc/os-release is missing (Debian 12+ or Ubuntu 22.04+ required)"
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID=${ID:-}
  case "$OS_ID" in
    debian) OS_CODENAME=${VERSION_CODENAME:-} ;;
    ubuntu) OS_CODENAME=${UBUNTU_CODENAME:-${VERSION_CODENAME:-}} ;;
    *) die "Unsupported system: ${PRETTY_NAME:-$OS_ID} (Debian 12+ or Ubuntu 22.04+ required)" ;;
  esac
  [ -n "$OS_CODENAME" ] || die "Could not determine the release name of ${PRETTY_NAME:-this system}"
  ARCH=$(dpkg --print-architecture 2>/dev/null || echo unknown)
  case "$ARCH" in
    amd64|arm64) ;;
    *) die "Unsupported architecture: $ARCH (amd64 or arm64 required)" ;;
  esac
  info "System: ${PRETTY_NAME:-$OS_ID} ($ARCH)"

  MEM_KB=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)
  CPUS=$(nproc 2>/dev/null || echo 1)
  [ "$MEM_KB" -ge "$MIN_MEMORY_KB" ] || die "At least 2 GB of memory are required (this server has $((MEM_KB / 1024)) MB)"
  info "Memory: $((MEM_KB / 1024)) MB, CPUs: $CPUS"

  mkdir -p "$(dirname "$POKYH_HOME")"
  DISK_KB=$(df -Pk "$(dirname "$POKYH_HOME")" | awk 'NR == 2 { print $4 }')
  [ "$DISK_KB" -ge "$MIN_DISK_KB" ] || die "At least 10 GB of free disk space are required in $(dirname "$POKYH_HOME") (free: $((DISK_KB / 1024 / 1024)) GB)"
  info "Free disk: $((DISK_KB / 1024 / 1024)) GB"

  [ ! -e "$POKYH_HOME/.installed" ] || die "Pokyh is already installed in $POKYH_HOME. To start over, remove it first (see $POKYH_HOME/pokyh)."
  if [ ! -d "$POKYH_HOME/state" ]; then
    for port in 80 443 "$CLUSTER_PORT"; do
      if port_in_use "$port"; then die "Port $port is already in use on this server; Pokyh needs 80 and 443 (HTTPS) and $CLUSTER_PORT (cluster)"; fi
    done
  fi
}

ensure_clock() {
  step "Checking the clock"
  if [ ! -d /run/systemd/system ] || ! command -v timedatectl >/dev/null 2>&1; then
    warn "Time synchronisation cannot be checked here (no systemd); make sure the clock is synchronised"
    return 0
  fi
  if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ]; then
    info "Clock is synchronised (NTP)"
    return 0
  fi
  if ! timedatectl set-ntp true >/dev/null 2>&1; then
    apt-get update -qq >/dev/null
    apt_install systemd-timesyncd || true
    timedatectl set-ntp true >/dev/null 2>&1 || true
  fi
  waited=0
  while [ "$waited" -lt 60 ]; do
    if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ]; then
      info "Clock is synchronised (NTP)"
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  warn "The clock is not reported as synchronised yet; the bootstrap compares it with the cluster's"
}

# ─── 2. Docker ─────────────────────────────────────────────────────────────────

install_docker() {
  step "Docker"
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    info "$(docker --version)"
    return 0
  fi
  info "Installing Docker Engine from download.docker.com"
  apt-get update -qq >/dev/null
  apt_install ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  key_file=$(mktemp)
  curl -fsSL --proto '=https' "https://download.docker.com/linux/$OS_ID/gpg" -o "$key_file"
  fingerprint=$(gpg --batch --with-colons --show-keys "$key_file" 2>/dev/null | awk -F: '/^fpr:/ { print $10; exit }')
  if [ "$fingerprint" != "$DOCKER_KEY_FINGERPRINT" ]; then
    rm -f "$key_file"
    die "Docker's repository key has an unexpected fingerprint ($fingerprint) — refusing to install"
  fi
  install -m 0644 "$key_file" /etc/apt/keyrings/docker.asc
  rm -f "$key_file"
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$ARCH" "$OS_ID" "$OS_CODENAME" \
    > /etc/apt/sources.list.d/docker.list
  chmod 0644 /etc/apt/sources.list.d/docker.list
  apt-get update -qq >/dev/null
  apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  if [ -d /run/systemd/system ]; then systemctl enable --now docker >/dev/null 2>&1; fi
  docker compose version >/dev/null 2>&1 || die "Docker was installed but does not run"
  info "$(docker --version)"
}

# ─── 3. Bootstrap ──────────────────────────────────────────────────────────────

run_bootstrap() {
  step "Fetching the cluster's configuration"
  mkdir -p "$POKYH_HOME/state/bootstrap"
  chmod 0700 "$POKYH_HOME" "$POKYH_HOME/state"
  cat > "$POKYH_HOME/state/bootstrap/bootstrap.mjs" <<'POKYH_BOOTSTRAP_END'
__POKYH_BOOTSTRAP__
POKYH_BOOTSTRAP_END
  chmod 0644 "$POKYH_HOME/state/bootstrap/bootstrap.mjs"
  chmod 0755 "$POKYH_HOME/state/bootstrap"
  docker pull -q "$NODE_IMAGE" >/dev/null || die "Could not download the $NODE_IMAGE image"
  # The token goes in on stdin, so it never appears in a process list or in
  # `docker inspect`.
  printf '%s' "$TOKEN" | docker run --rm -i \
    --network bridge \
    --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
    --security-opt no-new-privileges \
    -e POKYH_MEM_KB="$MEM_KB" -e POKYH_CPUS="$CPUS" -e POKYH_APP_UID="$APP_UID" \
    -e POKYH_TLS_INTERNAL="${POKYH_TLS_INTERNAL:-}" \
    -v "$POKYH_HOME:/out" -v "$POKYH_HOME/state/bootstrap:/boot:ro" \
    "$NODE_IMAGE" node /boot/bootstrap.mjs \
    || die "The bootstrap stopped (see the message above). Fix the cause and run the same command again."
  DOMAIN=$(sed -n 's/^domain=//p' "$POKYH_HOME/state/summary")
  NODE_NAME=$(sed -n 's/^name=//p' "$POKYH_HOME/state/summary")
  PEER_NAME=$(sed -n 's/^peer=//p' "$POKYH_HOME/state/summary")
  WITH_AI=$(sed -n 's/^ai=//p' "$POKYH_HOME/state/summary")
}

# ─── 4. Stack ──────────────────────────────────────────────────────────────────

start_stack() {
  step "Building and starting Pokyh"
  rm -rf "$POKYH_HOME/app.new"
  mkdir -p "$POKYH_HOME/app.new"
  (umask 022 && tar -xzf "$POKYH_HOME/state/bundle.tgz" -C "$POKYH_HOME/app.new" --strip-components=1 --no-same-owner)
  rm -rf "$POKYH_HOME/app"
  mv "$POKYH_HOME/app.new" "$POKYH_HOME/app"
  install -m 0644 "$POKYH_HOME/app/deploy/node/compose.yml" "$POKYH_HOME/compose.yml"
  chmod 0644 "$POKYH_HOME/Caddyfile"
  cat > "$POKYH_HOME/pokyh" <<EOF
#!/bin/sh
# Docker Compose for this Pokyh node, e.g. "$POKYH_HOME/pokyh ps" or "$POKYH_HOME/pokyh logs -f app".
exec docker compose --project-directory "$POKYH_HOME" --env-file "$POKYH_HOME/compose.env" -f "$POKYH_HOME/compose.yml" "\$@"
EOF
  chmod 0755 "$POKYH_HOME/pokyh"
  info "Building the image (this takes a few minutes)…"
  compose build --quiet app || die "Building the image failed (see above). Run the same command again to retry."
  compose up -d --remove-orphans || die "Starting the stack failed (see above). Run the same command again to retry."
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw allow 443/udp >/dev/null && ufw allow "$CLUSTER_PORT/tcp" >/dev/null
    info "Firewall (ufw): opened 80, 443 and $CLUSTER_PORT"
  fi
}

# ─── 5. Joining ────────────────────────────────────────────────────────────────

status_field() {
  sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" "$POKYH_HOME/data/bootstrap/status.json" 2>/dev/null | head -n 1
}

status_number() {
  sed -n "s/.*\"$1\":\\([0-9]*\\).*/\\1/p" "$POKYH_HOME/data/bootstrap/status.json" 2>/dev/null | head -n 1
}

wait_for_cluster() {
  step "Joining the cluster"
  info "Waiting for the backend to start…"
  waited=0
  last=''
  while :; do
    if [ -f "$POKYH_HOME/data/bootstrap/status.json" ]; then
      state=$(status_field state)
      message=$(status_field message)
      rows=$(status_number rowsReceived)
      line="$message"
      if [ "$state" = paired ] && [ -n "$rows" ] && [ "$rows" != 0 ]; then line="$message ($rows rows so far)"; fi
      if [ "$line" != "$last" ]; then info "$line"; last=$line; fi
      case "$state" in
        synced) return 0 ;;
        failed) die "$message" ;;
      esac
    fi
    if [ "$waited" -ge 3600 ]; then
      warn "Still busy after an hour; the node keeps going on its own. Follow it with: $POKYH_HOME/pokyh logs -f app"
      return 0
    fi
    if [ "$waited" -ge 900 ] && [ ! -f "$POKYH_HOME/data/bootstrap/status.json" ]; then
      die "The backend did not start within 15 minutes. Look at: $POKYH_HOME/pokyh logs app"
    fi
    sleep 5
    waited=$((waited + 5))
  done
}

finish() {
  touch "$POKYH_HOME/.installed"
  # Everything secret now lives in .env alone.
  rm -f "$POKYH_HOME/state/provision.json" "$POKYH_HOME/state/node-secrets.json" "$POKYH_HOME/state/bundle.tgz"
  pin=$(status_field ownPin)
  step "Done"
  info "${BOLD}${NODE_NAME:-$DOMAIN}${RESET} is a node of the cluster${PEER_NAME:+ (joined through $PEER_NAME)}."
  info "Admin panel:   https://$DOMAIN/admin/"
  info "API:           https://$DOMAIN"
  info "Cluster:       https://$DOMAIN:$CLUSTER_PORT (mutual TLS)${pin:+, certificate pin sha256//$pin}"
  info "AI runtime:    ${WITH_AI:-no}"
  info "Manage:        $POKYH_HOME/pokyh ps | logs -f app | restart app"
  info "Configuration: $POKYH_HOME/.env (keep it private)"
  printf '\n'
  info "Point clients at this node (DNS, load balancer) whenever you are ready —"
  info "it accepts reads and writes like every other node."
  printf '\n'
}

main() {
  TOKEN=${1:-}
  [ -n "$TOKEN" ] || die "Usage: sh pokyh-install.sh '<install token>' — copy the complete command from the admin panel"
  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 || die "Run this as root"
    exec sudo -- sh "$0" "$@"
  fi
  printf '%sPokyh node installer%s\n' "$BOLD" "$RESET"
  preflight
  ensure_clock
  install_docker
  run_bootstrap
  start_stack
  wait_for_cluster
  finish
}

main "$@"
