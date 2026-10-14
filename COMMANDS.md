# Pokyh Backend — Commands Reference

## First-Time Setup

```bash
# 1. Build everything
npm run build && npm run admin:build

# 2. Start the server
npm start

# 3. Open the admin panel in your browser
open http://localhost:4000/admin/
# → A setup wizard appears automatically if no password is configured.
#   Step 1: Create admin username + password
#   Step 2: Done — configure HTTPS/DNS ingress in your infrastructure
```

## Development

```bash
# Start dev server (auto-syncs DB schema + hot-reload)
npm run dev

# Start production server (auto-syncs DB schema)
npm start

# Build TypeScript to dist/
npm run build
```

## Admin Panel

```bash
# Rebuild admin panel (React SPA → admin/dist/)
npm run admin:build

# Run admin dev server on :5173 (proxies /api → localhost:4000)
npm run admin:dev

# Access admin panel (production)
open http://localhost:4000/admin/
```

## Admin Account Management

```bash
# Set or change the admin panel password
node scripts/set-admin-password.js

# Grant a user admin privileges (by username)
npm run make-admin <username>
# Example: npm run make-admin felix

# Revoke admin privileges from a user
npm run revoke-admin <username>
```

## MySQL Database

```bash
# Start MySQL server
brew services start mysql

# Stop MySQL server
brew services stop mysql

# Connect to MySQL
mysql -u root pokyh

# Sync Prisma schema to DB (runs automatically on npm run dev / npm start)
npx prisma db push

# Open Prisma Studio (visual DB browser)
npx prisma studio
```

## Tests

```bash
# Unit tests
npm test

# Multi-node cluster test: starts a throw-away MySQL container and three
# backend processes (needs Docker; does not use your .env or database)
npm run test:cluster

# The updater's blue/green switch against real Docker (stand-in images; needs
# node:22-alpine, mysql:8.0.40 and redis:7.4.1-alpine locally)
npm run test:updater
```

## Cluster

Nodes are linked in the admin panel under **Cluster**:

- **Server per Einzeiler hinzufügen** — a fresh Debian/Ubuntu server becomes a
  complete node with one command (root or sudo). Needs `CLUSTER_MTLS_PORT` on the
  inviting node; open the panel under its public https address. `/setup` is
  reachable only while a command is open. Several servers can be added at once.
- **Updates** — repository, branch, automatic or by hand, only with passed checks;
  nodes update one after the other without downtime (no leader).
- **Node einladen** / **Beitreten** — link a node you set up yourself with an
  invite code.
- **Erreichbarkeit dieser Node** — the ways the others reach this node (direct,
  proxy by port, proxy on 443 by name), with proxy configuration to copy.
- **Relays** — "Relay auf VPS einrichten" prints a command for a VPS; paste the
  relay key it prints under "Relay hinzufügen" and every node registers there.

```bash
# On the VPS running a relay
docker logs -f pokyh-relay
cat /opt/pokyh-relay/data/relay-key.txt
```

See README.md → "Cluster".

```bash
# One-line install command through the API (shown once; admin token required)
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Homelab","address":"","origin":"https://api.example.org"}' http://localhost:4000/api/admin/cluster/node-installs

# On a node set up by the installer
/opt/pokyh/pokyh ps
/opt/pokyh/pokyh logs -f app-blue      # or app-green — whichever is active
/opt/pokyh/pokyh logs -f updater
cat /opt/pokyh/data/update/active      # the active colour
cat /opt/pokyh/data/update/status.json # the last update
```

```bash
# Updates (admin token required): state, check now, roll back this node
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:4000/api/admin/cluster/updates
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:4000/api/admin/cluster/updates/check
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:4000/api/admin/cluster/updates/rollback
```

```bash
# Status of this node and its peers (admin token required)
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:4000/api/admin/cluster
```

## Useful Checks

```bash
# Check if the server is running
curl http://localhost:4000/health

# Check if admin panel loads
curl -o /dev/null -sw "%{http_code}\n" http://localhost:4000/admin/

# Kill anything using port 4000
lsof -ti:4000 | xargs kill -9

# Kill dev server processes
pkill -f "ts-node-dev"
pkill -f "node dist/index"
```

## Environment (.env)

Key variables:
- `PORT` — server port (default: 4000)
- `DATABASE_URL` — MySQL connection string
- `JWT_SECRET` — secret for user JWTs
- `REFRESH_TOKEN_SECRET` — secret for refresh tokens
- `API_KEY` — required header `X-API-Key` for all non-admin API routes
- `SERVER_KEY` — `X-Server-Key` header required by `/auth/login` (used by Next.js backend)
- `CORS_ORIGIN` — comma-separated allowed CORS origins
- `ADMIN_USERNAME` — admin panel login username
- `ADMIN_PASSWORD_HASH` — bcrypt hash of admin password (set with `npm run set-admin-password`)
- `DEBUG` — set to `true` for verbose logging
