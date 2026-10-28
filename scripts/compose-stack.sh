#!/bin/sh
set -eu

# Docker Compose otherwise parses a project-local `.env` before it sees the
# service-level raw env_file declaration. That can interpolate `$` from bcrypt
# hashes or other secrets. Select the operator-owned backend env file strictly
# as a file path and disable that automatic project-env parse.
backend_env_file=${BACKEND_ENV_FILE:-.env}

if [ ! -f "$backend_env_file" ]; then
  echo "Backend env file not found: $backend_env_file" >&2
  exit 1
fi

export BACKEND_ENV_FILE="$backend_env_file"
export COMPOSE_DISABLE_ENV_FILE=1

# COMPOSE_DISABLE_ENV_FILE above stops Compose from auto-loading the project
# .env for ${VAR} substitution — the whole reason this script exists (a `$`
# in a bcrypt hash or other secret would otherwise be shell-interpolated).
# That also means an operator's ${VAR:-default} override in the backend env
# file (e.g. CLUSTER_MTLS_PUBLISH) is silently ignored unless it is also a
# real process environment variable. So extract just this small, non-secret
# set of keys the same safe, single-key way the mysql service extracts its two
# values below, and export them as real shell variables — never the whole file.
read_env_value() {
  awk -v key="$1" 'index($0, key "=") == 1 { sub(/^[^=]*=/, ""); print; exit }' "$backend_env_file"
}
for key in CLUSTER_MTLS_PUBLISH; do
  value=$(read_env_value "$key")
  if [ -n "$value" ]; then
    export "$key=$value"
  fi
done

exec docker compose "$@"
