# pokyh-backend

REST API + admin panel for the POKYH school app. **Express 5 · Prisma · MySQL 8 · JWT · SSE · React admin UI at `/admin/`.**

Powers the [Next.js web app](../pokyh-frontend) and the [iOS app](../POKYH_IOS): todos, class reminders, the Mensa (canteen) catalog with ratings & comments, and WebUntis-backed accounts.

---

## Stack

| | |
|---|---|
| Runtime | Node.js 22, Express 5, TypeScript |
| Database | MySQL 8 via Prisma ORM |
| Auth | JWT + refresh tokens + in-memory revocation |
| Real-time | Server-Sent Events (SSE) |
| Admin UI | React 19 + Vite + Tailwind (served from the same process at `/admin/`) |
| Deployment | Docker + docker-compose, optional Cloudflare Tunnel |

---

## Highlights

- 🔐 **Stateless, fully `.env`-driven config** — ports, rate limits, token lifetimes, body limits, job intervals, cache TTLs, DB connection: nothing is hardcoded.
- 🚀 **Resilient startup** — the HTTP server listens immediately; the database is created (if missing), migrated (`prisma db push`) and connected **in the background with retry/backoff**. A slow or not-yet-ready DB never blocks or crashes boot.
- 👪 **Parent accounts** — guardians get a POKYH account with their own todos and read-only access to the child's class **name** (auto-resolved from WebUntis). They have **no reminders** and never appear in the class member list.
- 🗄️ **Auto-archiving** — todos/reminders that have been expired for more than 24 h (configurable) are archived: kept on the server, hidden from users, **viewable by admins only**.
- 💾 **Full JSON export / import** — one-click complete database backup & restore from the admin panel (binary image blobs included, transactional restore).
- 🖼️ **Dish image uploads** — upload/crop images for Mensa dishes (stored as WebP, served with caching).
- ⚡ **Performance** — in-memory TTL cache for the public dish catalog, targeted DB indexes, configurable connection pool — built for ~1000 concurrent users.

---

## Local development

**Prerequisites:** Node 22+, a reachable MySQL 8.

```sh
cp .env.example .env          # fill in your values
npm install
cd admin && npm install && cd ..
npm run dev                   # hot-reload dev server
```

On first boot the server **creates the database and applies the schema automatically** (`DB_AUTO_PUSH=true`). No manual migration step is needed. Open the admin panel at **http://localhost:4000/admin/** — the first visit runs the setup wizard (admin password + optional tunnel).

> Tip: configure the database either as a single `DATABASE_URL` **or** as discrete fields (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`). When `DATABASE_URL` is blank it is built from the discrete fields (credentials URL-encoded automatically).

---

## Docker (production)

```sh
cp .env.example .env          # fill in secrets
docker compose up -d --build
```

MySQL starts first; the app starts immediately and bootstraps the schema itself once the DB is reachable. The published port follows `PORT` from `.env`.

---

## Environment variables

Everything is configurable from `.env`. Required secrets first; everything else has a sensible default and is listed in [`.env.example`](.env.example).

### Required

| Variable | Description |
|---|---|
| `JWT_SECRET` | ≥32-byte hex — `openssl rand -hex 32` |
| `REFRESH_TOKEN_SECRET` | same format |
| `API_KEY` | sent by clients in `X-API-Key` |
| `SERVER_KEY` | server-to-server key (WebUntis login proxy → backend) |
| `DATABASE_URL` **or** `DB_HOST`+`DB_NAME`(+`DB_USER`/`DB_PASSWORD`/`DB_PORT`) | database connection |

### Common optional (defaults shown)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | HTTP port (host + container in Docker) |
| `CORS_ORIGIN` | `http://localhost:3000` | comma-separated allowed origins |
| `ADMIN_USERNAMES` | — | comma-separated admin usernames |
| `ADMIN_PASSWORD_HASH` | — | bcrypt hash (set via setup wizard) |
| `BCRYPT_ROUNDS` | `12` | password hashing cost |
| `JWT_EXPIRES_IN` / `ADMIN_JWT_EXPIRES_IN` | `1h` / `7d` | token lifetimes |
| `REFRESH_TOKEN_EXPIRES_HOURS` | `1` | refresh token lifetime |
| `DB_CONNECTION_LIMIT` | `20` | Prisma pool size (when URL is built from `DB_*`) |
| `DB_AUTO_PUSH` | `true` | create DB + apply schema on startup |
| `ARCHIVE_AFTER_HOURS` | `24` | archive items expired longer than this |
| `ARCHIVE_CHECK_INTERVAL_MS` | `3600000` | archiver run interval |
| `CACHE_TTL_MS` | `300000` | in-memory cache TTL (dish catalog) |
| `RATE_LIMIT_*` | see example | per-limiter request caps + windows |
| `BODY_LIMIT` / `BODY_LIMIT_UPLOAD` / `BODY_LIMIT_IMPORT` | `10kb` / `4mb` / `100mb` | request body size limits |
| `PUSH_POLL_INTERVAL_MS` / `PUSH_DUE_CHECK_INTERVAL_MS` | `300000` / `60000` | push poller intervals |
| `WEBUNTIS_BASE` / `WEBUNTIS_SCHOOL` | — | WebUntis instance |
| `PUBLIC_BASE_URL` | — | absolute base for uploaded asset URLs (e.g. dish images) |
| `MENSA_IMPORT_URL` | mensa.json URL | default source for the dish import |
| `TUNNEL_NAME` / `TUNNEL_HOSTNAME` | — | Cloudflare Tunnel (set via admin wizard) |
| `DEBUG` | `false` | verbose request logging |

---

## Scripts

```sh
npm run dev          # dev server with hot-reload
npm run build        # prisma generate + compile TS
npm start            # start compiled server (dist/)
npm run db:push      # sync schema to DB manually
npm run db:studio    # Prisma Studio GUI
npm run admin:build  # build the admin panel only
```

---

## API overview

All non-admin/non-public routes require `X-API-Key`; authenticated routes require `Authorization: Bearer <jwt>`.

| Route prefix | Auth | Purpose |
|---|---|---|
| `/auth/*` | API key | login (password / WebUntis server-to-server), register, refresh, logout, `/me` |
| `/users/:username/todos/*` | JWT | personal todo CRUD (students **and** parents) |
| `/classes/*` | JWT | class get/join/leave (parents see name only, hidden from members) |
| `/classes/:id/reminders/*` | JWT | class reminders (**blocked for parents**) |
| `/classes/:id/reminders/:rid/comments/*` | JWT | reminder comments (blocked for parents) |
| `/dishes` · `/dishes/:id/image` | public | Mensa catalog (cached) + dish images |
| `/dish-ratings/*` · `/dish-comments/*` | JWT | ratings (1–5★) and comments |
| `/sse/*` | JWT | real-time streams (todos, reminders, ratings, comments) |
| `/api/admin/*` | Admin JWT | admin panel endpoints (see below) |
| `/api/setup/*` | — | first-time setup wizard |
| `/health` | — | liveness probe (always responds, even before DB is up) |

### Notable admin endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/admin/export` | full database dump as one JSON (complete backup) |
| `POST /api/admin/import` | restore a dump (transactional, all-or-nothing) |
| `GET /api/admin/archive/todos` · `…/reminders` | view archived (expired) items |
| `PUT /api/admin/dishes/:id/image` | upload/crop a dish image (→ WebP) |

---

## Roles & visibility

| | Todos | Reminders | Class | Listed as member |
|---|---|---|---|---|
| **Student** | ✅ own | ✅ class | ✅ full | ✅ |
| **Parent / guardian** | ✅ own | ❌ | name only | ❌ (hidden) |
| **Admin** | ✅ + all (incl. archived) | ✅ + all | ✅ all | — |

Parent accounts are created automatically at WebUntis login: the login proxy resolves the **child's** class id and sends `role: "parent"`, and the backend joins the parent to that class as a hidden member.

---

## Security

- **Helmet** + strict CORS allowlist.
- **Rate limiting** — every limiter (global / auth / read / write / SSE / admin-login) is `.env`-configurable.
- **JWT revocation** — in-memory map invalidates access tokens instantly on session revoke or user delete.
- **Refresh tokens** — hashed at rest, individually revocable, auto-cleaned.
- **Input validation** — Zod on request bodies.
- **Timing-safe** server-key comparison via `crypto.timingSafeEqual`.
- **Parent isolation** — reminders surface fully blocked server-side for `role=parent`, not just hidden in the UI.
- **Safe auto-migration** — startup `prisma db push` runs without `--accept-data-loss`, so only additive schema changes are applied automatically.

---

## Performance (built for ~1000 users)

- Non-blocking startup + background DB connect with backoff.
- In-memory TTL cache for the public dish catalog (invalidated on every dish write).
- Targeted indexes: `class_members(stable_uid)`, `todos(stable_uid, archived_at)`, `reminders(class_id, archived_at)`, plus due-scan indexes on `todos(notified_at, due_at)` and `reminders(notified_at, remind_at)`.
- Configurable Prisma connection pool (`DB_CONNECTION_LIMIT`).
- Archiving runs as a batched background job and broadcasts updated lists over SSE.
