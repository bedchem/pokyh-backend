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

exec docker compose "$@"
