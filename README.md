# pokyh-backend

REST API + admin panel for the pokyh school app. Express 5 · Prisma · MySQL 8 · JWT · SSE · React admin UI at `/admin/`.

---

## Stack

| | |
|---|---|
| Runtime | Node.js 22, Express 5, TypeScript |
| Database | MySQL 8 via Prisma ORM |
| Auth | JWT (8 h) + Refresh Tokens (30 d) + in-memory revocation |
| Real-time | Server-Sent Events |
| Admin UI | React 19 + Vite + Tailwind CSS (served from same process) |
| Deployment | Docker + docker-compose, optional Cloudflare Tunnel |

---

## Local development

**Prerequisites:** Node 22+, MySQL 8 on port 3306

```sh
cp .env.example .env          # fill in your values
npm install
cd admin && npm install && cd ..
npm run db:push               # sync schema to DB
npm run dev                   # hot-reload dev server
```

Admin panel → [http://localhost:4000/admin/](http://localhost:4000/admin/)  
First boot triggers the setup wizard (password + optional tunnel).

---

## Docker (production / Dokploy)

```sh
cp .env.example .env.production   # fill in secrets
docker compose --env-file .env.production up -d --build
```

MySQL starts first; the app waits until healthy, then runs `prisma db push` and starts the server. No manual migration step needed.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `MYSQL_ROOT_PASSWORD` | Docker | MySQL root password used by docker-compose |
| `DATABASE_URL` | yes | Set automatically in Docker; set manually for local |
| `JWT_SECRET` | yes | 32-byte hex — `openssl rand -hex 32` |
| `REFRESH_TOKEN_SECRET` | yes | Same format |
| `API_KEY` | yes | Sent by the mobile app in `X-API-Key` |
| `SERVER_KEY` | yes | Next.js → backend server-to-server key |
| `CORS_ORIGIN` | yes | Comma-separated allowed origins |
| `ADMIN_USERNAMES` | yes | Comma-separated admin usernames, e.g. `nexor,plat-feli` |
| `ADMIN_PASSWORD_HASH` | yes | bcrypt hash — set via setup wizard on first boot |
| `WEBUNTIS_BASE` | no | WebUntis API base URL |
| `WEBUNTIS_SCHOOL` | no | WebUntis school slug |
| `TUNNEL_NAME` / `TUNNEL_HOSTNAME` | no | Cloudflare Tunnel — set via admin wizard |
| `DEBUG` | no | `true` for verbose request logging |

See [`.env.example`](.env.example) for the full template.

---

## Scripts

```sh
npm run dev          # dev server with hot-reload
npm run build        # compile TS + generate Prisma client
npm start            # start compiled server
npm run db:push      # sync schema (no migration history)
npm run db:studio    # Prisma Studio GUI
npm run admin:build  # build admin panel only
```

---

## API overview

Base path: `/api/` · All requests require `X-API-Key` · Authenticated routes require `Authorization: Bearer <jwt>`

| Route prefix | Auth | Purpose |
|---|---|---|
| `/api/auth/*` | — | Login, refresh, logout, /me |
| `/api/todos/*` | JWT | User todo CRUD |
| `/api/classes/*` | JWT | Class management + join/leave |
| `/api/reminders/*` | JWT | Class reminders |
| `/api/dish-ratings/*` | JWT | Mensa dish ratings (1–5 ★) |
| `/api/sse/*` | JWT | Real-time SSE streams (todos, reminders, ratings) |
| `/api/users/*` | Server key | Internal user lookup |
| `/api/admin/*` | Admin JWT | Admin panel endpoints |
| `/api/setup/*` | — | First-time setup wizard (SSE) |

---

## Admin panel

`/admin/` — full management UI:

- **Dashboard** — user / class / todo stats + charts
- **Users** — detail drawer: view todos & classes, edit/delete entries, revoke sessions (force-logout in real time)
- **Classes & Reminders** — full CRUD
- **Sessions** — live session list, revoke with animated fade-out
- **Tunnel** — step-by-step Cloudflare Tunnel wizard, auto-downloads `cloudflared` if missing
- Multi-admin login via `ADMIN_USERNAMES` (shared password hash)

---

## Security

- **Helmet** + strict CORS allowlist
- **Rate limiting** — global 500 req/min, auth 10 req/15 min, writes 60 req/min, SSE 10 conn/IP
- **JWT revocation** — in-memory map invalidates tokens instantly on session revoke or user delete
- **Refresh tokens** — hashed in DB, individually revocable
- **Input validation** — Zod on all request bodies
- **Timing-safe** API key comparison via `crypto.timingSafeEqual`
