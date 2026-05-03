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
#   Step 2: Connect Cloudflare Tunnel (makes the API live at your domain)
#   Step 3: Done — everything is running
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

## Cloudflare Tunnel (api.pokyh.com)

```bash
# First-time setup (opens browser for Cloudflare login, one time only)
bash scripts/setup-tunnel.sh

# Start tunnel (makes localhost:4000 available as api.pokyh.com)
npm run tunnel

# Run tunnel as a system service (auto-start on boot)
sudo cloudflared service install
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
