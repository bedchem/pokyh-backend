#!/bin/sh
set -e

echo "[startup] DATABASE_URL host: $(echo "$DATABASE_URL" | sed 's|.*@||;s|/.*||')"
echo "[startup] Waiting for MySQL to be ready..."

RETRIES=0
until npx prisma db push --skip-generate > /tmp/prisma-out 2>&1; do
  RETRIES=$((RETRIES+1))
  if [ $RETRIES -ge 40 ]; then
    echo "[startup] ERROR: Could not connect to database after 40 attempts. Last error:"
    cat /tmp/prisma-out
    exit 1
  fi
  # Print the actual error so logs are useful
  LAST_ERR=$(grep -i "error\|P1\|ECONNREFUSED\|Access denied\|authentication" /tmp/prisma-out | tail -3)
  echo "[startup] Not ready (attempt $RETRIES/40): ${LAST_ERR:-$(tail -1 /tmp/prisma-out)}"
  echo "[startup] Retrying in 3s..."
  sleep 3
done

echo "[startup] Database schema is up to date."
exec node dist/index.js
