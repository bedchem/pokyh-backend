#!/bin/sh
set -eu

# Docker named volumes can retain root-owned files from a previous image. The
# only root work is making the two explicit writable runtime directories usable;
# the HTTP application and cloudflared child then run as the unprivileged user.
RUNTIME_HOME=/var/lib/pokyh
CLOUDFLARED_HOME="$RUNTIME_HOME/.cloudflared"
LOG_DIRECTORY=/app/logs

mkdir -p "$CLOUDFLARED_HOME" "$LOG_DIRECTORY"
chown -R pokyh:pokyh "$RUNTIME_HOME" "$LOG_DIRECTORY"

echo "[startup] Starting server as unprivileged user; database readiness is checked by the application."
exec su-exec pokyh node dist/index.js
