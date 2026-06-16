#!/bin/sh
set -e

# The Node app now bootstraps the database itself: on startup it creates the DB
# if missing, applies the schema (prisma db push) and connects — all with
# retry/backoff, in the background, so the HTTP server starts immediately and
# never gets stuck waiting on a slow or not-yet-ready database.
echo "[startup] DATABASE_URL host: $(echo "$DATABASE_URL" | sed 's|.*@||;s|/.*||')"
echo "[startup] Starting server (DB is created + migrated automatically)…"
exec node dist/index.js
