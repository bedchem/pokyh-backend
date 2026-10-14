#!/bin/sh
# Pokyh node installer.
#
# Served by a node of a Pokyh cluster at https://<its address>/setup — only
# while an administrator is adding a node — and started with the one-line
# command its admin panel shows (Cluster → "Server per Einzeiler hinzufügen"):
#
#   curl -fsSL https://<address>/setup -o pokyh.sh && echo '<sha256>  pokyh.sh' | sha256sum -c - && sh pokyh.sh '<key>'
#
# sha256sum accepts only this exact script, so nothing on the way (a CDN, a
# proxy) can hand you a different one.
#
# It turns a fresh Debian or Ubuntu server into a node of that cluster:
#   1. checks the system: OS, architecture, memory, disk, free ports, clock;
#   2. installs Docker Engine from Docker's own repository, with the
#      repository key's fingerprint pinned below;
#   3. runs the bootstrap (embedded below) in a throw-away Node.js container:
#      it fetches the cluster's shared configuration (sealed with a key only
#      the install key yields) and the inviting node's exact build
#      (hash-checked), and writes this node's configuration with secrets of
#      its own;
#   4. hardens the server: automatic security updates, a firewall that lets
#      in only SSH and the ports Pokyh needs (POKYH_HARDEN=0 skips this);
#   5. builds and starts the stack in /opt/pokyh: MySQL, Redis, the backend
#      (blue/green, for updates without downtime), the cluster channel's
#      forwarder, the updater, and — with a domain — Caddy (HTTPS, Let's
#      Encrypt); optionally Ollama;
#   6. waits until the node has paired with the cluster over the mutually
#      authenticated channel and received the cluster's data.
#
# Running it again with the same key resumes after a failure.

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
  if [ ! -d "$POKYH_HOME/state" ] && port_in_use "$CLUSTER_PORT"; then
    die "Port $CLUSTER_PORT is already in use on this server; Pokyh needs it for the cluster"
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
    -e POKYH_TLS_INTERNAL="${POKYH_TLS_INTERNAL:-}" -e POKYH_HOME_ON_HOST="$POKYH_HOME" \
    -v "$POKYH_HOME:/out" -v "$POKYH_HOME/state/bootstrap:/boot:ro" \
    "$NODE_IMAGE" node /boot/bootstrap.mjs \
    || die "The bootstrap stopped (see the message above). Fix the cause and run the same command again."
  DOMAIN=$(sed -n 's/^domain=//p' "$POKYH_HOME/state/summary")
  ADDRESS=$(sed -n 's/^address=//p' "$POKYH_HOME/state/summary")
  NODE_NAME=$(sed -n 's/^name=//p' "$POKYH_HOME/state/summary")
  PEER_NAME=$(sed -n 's/^peer=//p' "$POKYH_HOME/state/summary")
  WITH_AI=$(sed -n 's/^ai=//p' "$POKYH_HOME/state/summary")
}

# ─── 4. Hardening ──────────────────────────────────────────────────────────────

harden() {
  if [ "${POKYH_HARDEN:-1}" != 1 ]; then
    warn "Hardening skipped (POKYH_HARDEN=$POKYH_HARDEN)"
    return 0
  fi
  if [ ! -d /run/systemd/system ]; then
    warn "Hardening skipped: no systemd here (container or unusual system)"
    return 0
  fi
  step "Hardening this server"
  apt-get update -qq >/dev/null
  # Security updates install themselves, every day.
  apt_install unattended-upgrades
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
  info "Automatic security updates: on"
  # Firewall: SSH on the port(s) it really listens on — so nobody is locked
  # out — and the ports Pokyh needs; nothing else comes in.
  apt_install ufw
  ssh_ports=$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }' | sort -u | tr '\n' ' ')
  if [ -z "$ssh_ports" ] && command -v ss >/dev/null 2>&1; then
    ssh_ports=$(ss -Hltnp 2>/dev/null | awk '/"sshd"/ { n = split($4, part, ":"); print part[n] }' | sort -u | tr '\n' ' ')
  fi
  [ -n "$ssh_ports" ] || ssh_ports=22
  for port in $ssh_ports; do ufw allow "$port/tcp" comment 'SSH' >/dev/null; done
  ufw allow "$CLUSTER_PORT/tcp" comment 'Pokyh cluster' >/dev/null
  if [ -n "$DOMAIN" ]; then
    ufw allow 80/tcp comment 'Pokyh HTTPS' >/dev/null
    ufw allow 443/tcp comment 'Pokyh HTTPS' >/dev/null
    ufw allow 443/udp comment 'Pokyh HTTP/3' >/dev/null
  fi
  if ! ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw default deny incoming >/dev/null
    ufw default allow outgoing >/dev/null
    ufw --force enable >/dev/null
  fi
  info "Firewall: open only for SSH (port ${ssh_ports% }), $CLUSTER_PORT${DOMAIN:+, 80, 443}"
}

# ─── 5. Stack ──────────────────────────────────────────────────────────────────

start_stack() {
  step "Building and starting Pokyh"
  if [ -n "$DOMAIN" ]; then
    for port in 80 443; do
      if port_in_use "$port" && ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^pokyh-caddy'; then
        die "Port $port is already in use on this server; with a domain Pokyh needs 80 and 443 for HTTPS"
      fi
    done
  fi
  rm -rf "$POKYH_HOME/app.new"
  mkdir -p "$POKYH_HOME/app.new"
  (umask 022 && tar -xzf "$POKYH_HOME/state/bundle.tgz" -C "$POKYH_HOME/app.new" --strip-components=1 --no-same-owner)
  rm -rf "$POKYH_HOME/app"
  mv "$POKYH_HOME/app.new" "$POKYH_HOME/app"
  install -m 0644 "$POKYH_HOME/app/deploy/node/compose.yml" "$POKYH_HOME/compose.yml"
  mkdir -p "$POKYH_HOME/runtime" "$POKYH_HOME/releases" "$POKYH_HOME/data/update"
  chmod 0755 "$POKYH_HOME/runtime"
  install -m 0644 "$POKYH_HOME/app/deploy/node/edge.mjs" "$POKYH_HOME/runtime/edge.mjs"
  install -m 0644 "$POKYH_HOME/app/deploy/node/updater.mjs" "$POKYH_HOME/runtime/updater.mjs"
  install -m 0644 "$POKYH_HOME/app/deploy/node/updater.Dockerfile" "$POKYH_HOME/runtime/updater.Dockerfile"
  # The app writes update requests here; the updater (root) reads them.
  chown "$APP_UID:$APP_UID" "$POKYH_HOME/data/update"
  chmod 0750 "$POKYH_HOME/data/update"
  [ -s "$POKYH_HOME/data/update/active" ] || printf 'blue\n' > "$POKYH_HOME/data/update/active"
  chmod 0644 "$POKYH_HOME/data/update/active"
  if [ -f "$POKYH_HOME/Caddyfile" ]; then chmod 0644 "$POKYH_HOME/Caddyfile"; fi
  commit=$(sed -n 's/.*"commit":"\([0-9a-f]\{12\}\).*/\1/p' "$POKYH_HOME/app/dist/build-info.json" 2>/dev/null)
  IMAGE_TAG=${commit:-initial-$(date +%s)}
  info "Building the image (this takes a few minutes)…"
  docker build -q -f "$POKYH_HOME/app/deploy/node/Dockerfile" -t "pokyh-node:$IMAGE_TAG" "$POKYH_HOME/app" >/dev/null \
    || die "Building the image failed. Run the same command again to retry."
  docker build -q -f "$POKYH_HOME/app/deploy/node/updater.Dockerfile" -t pokyh-updater:local "$POKYH_HOME/app/deploy/node" >/dev/null \
    || die "Building the updater failed. Run the same command again to retry."
  active=$(cat "$POKYH_HOME/data/update/active")
  tag_key=POKYH_IMAGE_BLUE
  if [ "$active" = green ]; then tag_key=POKYH_IMAGE_GREEN; fi
  awk -v key="$tag_key" 'index($0, key "=") != 1' "$POKYH_HOME/compose.env" > "$POKYH_HOME/compose.env.new"
  printf '%s=%s\n' "$tag_key" "$IMAGE_TAG" >> "$POKYH_HOME/compose.env.new"
  mv "$POKYH_HOME/compose.env.new" "$POKYH_HOME/compose.env"
  chmod 0600 "$POKYH_HOME/compose.env"
  cat > "$POKYH_HOME/pokyh" <<EOF
#!/bin/sh
# Docker Compose for this Pokyh node, e.g. "$POKYH_HOME/pokyh ps" or "$POKYH_HOME/pokyh logs -f app".
exec docker compose --project-directory "$POKYH_HOME" --env-file "$POKYH_HOME/compose.env" -f "$POKYH_HOME/compose.yml" "\$@"
EOF
  chmod 0755 "$POKYH_HOME/pokyh"
  compose up -d --remove-orphans || die "Starting the stack failed (see above). Run the same command again to retry."
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
  info "${BOLD}${NODE_NAME:-${DOMAIN:-$ADDRESS}}${RESET} is a node of the cluster${PEER_NAME:+ (joined through $PEER_NAME)}."
  if [ -n "$DOMAIN" ]; then
    info "Admin panel:   https://$DOMAIN/admin/"
    info "API:           https://$DOMAIN"
  else
    info "Web:           none of its own — clients reach the cluster through your other nodes or your proxy"
  fi
  info "Cluster:       ${DOMAIN:-${ADDRESS:-via relay}}:$CLUSTER_PORT (mutual TLS)${pin:+, certificate pin sha256//$pin}"
  info "AI runtime:    ${WITH_AI:-no}"
  info "Updates:       automatic, without downtime (admin panel → Cluster → Updates)"
  info "Manage:        $POKYH_HOME/pokyh ps | logs -f app-blue | logs -f updater"
  info "Configuration: $POKYH_HOME/.env (keep it private)"
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
  harden
  start_stack
  wait_for_cluster
  finish
}

main "$@"
