#!/bin/sh
set -eu

# Docker named volumes can retain root-owned files from a previous image. The
# only root work is making the explicit writable log directory usable; the HTTP
# application itself always runs as the unprivileged user.
LOG_DIRECTORY=/app/logs

mkdir -p "$LOG_DIRECTORY"
chown -R pokyh:pokyh "$LOG_DIRECTORY"

echo "[startup] Starting server as unprivileged user; database readiness is checked by the application."
exec su-exec pokyh node dist/index.js
