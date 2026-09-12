<div align="center">

# POKYH — Backend

**The API, realtime layer and admin panel behind POKYH — the school companion app for LBS Brixen.**

Node.js · Express 5 · TypeScript · Prisma · MySQL · Server-Sent Events · Web Push · self-hosted via Docker + Cloudflare Tunnel

</div>

---

## Table of contents

- [What this is](#what-this-is)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Database](#database)
- [Authentication & security](#authentication--security)
- [API overview](#api-overview)
- [Realtime (SSE)](#realtime-sse)
- [Background jobs](#background-jobs)
- [Admin panel](#admin-panel)
- [Deployment](#deployment)
- [Operations & maintenance](#operations--maintenance)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)

---

## What this is

POKYH adds a social/organisational layer on top of [WebUntis](https://www.untis.at/): shared class
reminders, personal to-dos, the cafeteria menu with ratings & comments, and push notifications.
This backend is the **single source of truth** for everything that is *not* WebUntis data.

Users never log in here with a password. They authenticate against WebUntis in the
**web frontend** or the **iOS app**, which then perform a trusted **server-to-server**
login here (guarded by a shared `SERVER_KEY`) to mint a POKYH session. Parents/guardians get a
hidden "parent" membership in their child's class.

It also serves a built-in **React admin panel** at `/admin/` and can expose itself to the
internet through an in-container **Cloudflare Tunnel** — no open ports required.

---

## Architecture

```
┌──────────────┐         ┌──────────────┐
│  Web (Next)  │         │  iOS (Swift) │
└──────┬───────┘         └──────┬───────┘
       │  X-API-Key + (X-Server-Key for login)
       │  Bearer <JWT> for user requests
       ▼                        ▼
┌─────────────────────────────────────────────┐
│                POKYH Backend                  │
│  Express 5  ·  JWT auth  ·  rate limiting     │
│  REST  +  SSE (realtime)  +  Web Push         │
│  /admin/  (React SPA, JWT-protected)          │
└───────────────┬───────────────────┬──────────┘
                │                   │
        ┌───────▼──────┐    ┌───────▼────────┐
        │  MySQL 8     │    │ Cloudflare      │
        │  (Prisma)    │    │ Tunnel (egress) │
        └──────────────┘    └─────────────────┘
```

- **Stateless HTTP** — horizontally scalable; JWTs carry identity, refresh tokens live in MySQL.
- **Non-blocking boot** — the HTTP server starts immediately; the database is created, migrated
  (`prisma db push`) and connected in the background with retry/backoff. A cold or missing DB
  never blocks startup.
- **Config-driven, zero hardcoded hosts** — CORS origins, the public hostname and every limit are
  derived from environment variables.

### Pokyh Learn extension

The additive `/learn` router serves the separate `learn.pokyh.com` product. It
does not change the existing Pokyh routes, data or built-in `/admin/` panel.
The Learn web app has its own management surface at `learn.pokyh.com/admin`,
backed by `/learn/admin/*` and the existing server-side Pokyh `Admin` record.

- Learn accepts only accounts whose login has been confirmed against WebUntis;
  a local Pokyh fallback account cannot open Learn data or receive a Learn grant.
- In production, the Learn WebUntis sign-in is fail-closed until the operator
  configures a non-secret authorisation reference and a versioned HTTPS privacy
  notice. The acknowledgement records transparency, not a legal basis; the
  controller/school must complete its own approval and privacy review before
  activation.
- Course content, access grants, team membership, quiz grading, review state,
  progress and imports are all MySQL-backed server decisions. A learner marks a
  real section complete; the server derives the enrollment percentage.
- Personal JSON export/import is scoped to the caller's own authored courses,
  vocabulary and review state. Imports create new private drafts and cannot
  carry roles, grants, teams, credentials or other people's content.
- An optional dictionary suggestion adapter is configured only with
  `LEARN_DICTIONARY_*`. It is called explicitly by an authorized editor and
  never becomes the quiz-answer authority.

---

## Tech stack

| Concern            | Choice                                                        |
| ------------------ | ------------------------------------------------------------- |
| Runtime            | Node.js 22 (Alpine in production)                             |
| Web framework      | Express 5                                                     |
| Language           | TypeScript (strict)                                           |
| ORM / DB           | Prisma 5 · MySQL 8                                            |
| Auth               | JWT access tokens + opaque, hashed refresh tokens (bcrypt admin password) |
| Realtime           | Server-Sent Events (`/sse/*`)                                 |
| Push               | Web Push (VAPID)                                              |
| Images             | `sharp` (dish images, subject icons)                          |
| Hardening          | `helmet`, `cors`, `express-rate-limit`                        |
| Logging            | `winston` + daily-rotate files                                |
| Ingress            | Cloudflare Tunnel (`cloudflared`, in-container)               |

---

## Quick start

### Prerequisites
- Node.js ≥ 22
- A MySQL 8 database (local or the bundled Docker service)

### Local development

```bash
# 1. Install dependencies
npm install

# 2. Create your environment file
cp .env.example .env
#    → fill in DATABASE_URL and generate the secrets (see Configuration)

# 3. Generate the Prisma client + apply the schema
npx prisma generate
npm run db:push

# 4. Run in watch mode
npm run dev
```

The API is now on `http://localhost:4000`, the admin panel on `http://localhost:4000/admin/`.
On first run, open `/admin/` to complete the setup wizard (admin account + optional tunnel).

### Run everything with Docker (recommended for parity with prod)

```bash
cp .env.example .env        # set MYSQL_ROOT_PASSWORD, secrets, etc.
docker compose up --build
```

This starts MySQL (with a healthcheck) and the app, which auto-creates and migrates the database.

---

## Configuration

All configuration is environment-driven. See **`.env.example`** for the complete, commented list.
Required values fail fast on boot if missing.

### Generate the secrets

```bash
# Each of these:
openssl rand -hex 32      # JWT_SECRET, REFRESH_TOKEN_SECRET, API_KEY, SERVER_KEY

# Web Push (VAPID) key pair:
npx web-push generate-vapid-keys
```

### The keys that matter most

| Variable                 | Purpose                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | MySQL connection string. If blank, it is built from the `DB_*` fields.                   |
| `JWT_SECRET`             | Signs access tokens.                                                                     |
| `REFRESH_TOKEN_SECRET`   | Secret for refresh-token handling.                                                       |
| `API_KEY`                | Public-ish key every client must send as `X-API-Key`. Must match the frontend/iOS key.  |
| `SERVER_KEY`             | **Secret.** Trusted server-to-server login key (`X-Server-Key`). Only the web/iOS servers hold it. |
| `CORS_ORIGIN`            | Comma-separated allowed origins (e.g. `https://pokyh.com,https://api.pokyh.com`).        |
| `LEARN_ALLOWED_ORIGINS`  | Exact browser-origin allow-list for the additive `/learn` router.                        |
| `LEARN_LEGAL_*`          | Production WebUntis activation gate: non-secret approval reference, HTTPS notice URL and notice version. |
| `LEARN_DICTIONARY_*`     | Optional, server-only vocabulary suggestion policy, HTTPS endpoint, pairs, timeout and bounded cache. |
| `LEARN_IMPORT_*`         | Maximum personal Learn courses, sections and vocabulary entries accepted in one import.  |
| `TRUST_PROXY`            | `loopback` behind the in-container tunnel — required so per-IP rate limits see the real client IP. |
| `TUNNEL_NAME` / `TUNNEL_HOSTNAME` | Cloudflare Tunnel identity & public hostname (auto-derives the parent domain for CORS). |
| `VAPID_*`                | Web Push key pair + contact e-mail.                                                      |

> **Trusted callers bypass the auth/refresh rate limiters.** A request carrying a valid
> `X-Server-Key` skips the per-IP brute-force limiter — because every user's login is proxied
> through one frontend-server IP, and a shared bucket would lock everyone out at scale.

---

## Database

Prisma is the single schema source (`prisma/schema.prisma`). Key models:

- **Identity** — `User`, `Admin`, `RefreshToken`, `ApiKey`
- **Classes** — `Class`, `ClassMember` (a `role` of `parent` marks a hidden member)
- **Content** — `Todo`, `Reminder`, `Comment`, `DishComment`
- **Cafeteria** — `Dish`, `DishImage`, `DishRating`
- **Subjects** — `KnownSubject`, `SubjectImage`
- **School-year archiving** — `SchoolYear`, `ArchivedUser`, `ArchivedClass`, `ArchivedTodo`, `ArchivedReminder`
- **Telemetry** — `RequestLog`, `FrontendActivityLog`

```bash
npm run db:push      # apply schema to the database (idempotent, additive)
npm run db:studio    # open Prisma Studio (visual DB browser)
npm run db:migrate   # create a dev migration
npm run db:reset     # ⚠ drop & recreate (destroys all data)
```

On boot the server runs a **non-destructive** `prisma db push` automatically (`DB_AUTO_PUSH=true`),
so additive schema changes are applied on every deploy.

---

## Authentication & security

**Two layers, clearly separated:**

1. **API key** — every non-admin route requires `X-API-Key: <API_KEY>`. Coarse gate that keeps
   anonymous traffic off the API.
2. **User session** — clients exchange a trusted WebUntis login (`POST /auth/login` with
   `X-Server-Key`) for a short-lived **JWT access token** + a long-lived, hashed **refresh token**.
   User requests then send `Authorization: Bearer <JWT>`.

**Hardening highlights**
- `helmet` security headers; strict, allow-list **CORS** (auto-includes the tunnel host and its parent domain).
- Tiered **rate limiting**: global, auth (strict, per-IP brute-force), refresh (generous — refresh
  is gated by an unguessable token), read, write, SSE and admin-login limiters. Trusted server-key
  callers bypass auth/refresh limits.
- Refresh tokens are stored **hashed (SHA-256)**; one active session per user.
- Admin password stored as a **bcrypt** hash; admin routes require a JWT + admin membership.
- `timingSafeEqual` for all key comparisons.

---

## API overview

> Base URL: your tunnel hostname (e.g. `https://api.pokyh.com`). All times are ISO-8601 UTC.

| Group              | Mount                                             | Notes                                  |
| ------------------ | ------------------------------------------------- | -------------------------------------- |
| Auth               | `/auth/login` · `/refresh` · `/logout` · `/me` · `/register` | Server-to-server + token lifecycle |
| Users              | `/users/:username`                                | Profile lookup                          |
| To-dos             | `/users/:username/todos`                          | Per-user, CRUD + SSE                    |
| Classes            | `/classes` · `/classes/mine` · `/classes/:id`     | Auto join/create by WebUntis class id   |
| Reminders          | `/classes/:classId/reminders`                     | Class-wide, CRUD + SSE                  |
| Reminder comments  | `/classes/:classId/reminders/:reminderId/comments`| Threaded comments + SSE                 |
| Dishes             | `/dishes`                                         | **Public** read-only menu               |
| Dish ratings       | `/dish-ratings` (`/:id`, `/batch`)                | Stars + SSE                             |
| Dish comments      | `/dish-comments/:dishId`                          | Comments + SSE                          |
| Subject images     | `/subject-images`                                 | Icon catalog (GET public, write = admin)|
| Push               | `/push`                                           | Web Push subscription registration      |
| Activity log       | `/activity-log`                                   | Frontend telemetry                      |
| Learn              | `/learn/*`                                        | Additive learning API; API key, then per-resource bearer authorization |
| Learn sign-in      | `/auth/learn-login`                               | API-key-gated WebUntis verification for the Learn BFF only; production legal gate must be ready before verification |
| Admin              | `/api/admin/*`                                    | JWT + admin only (no API key)           |
| Setup              | `/api/setup`                                      | First-run wizard                        |
| Health             | `/health`                                         | Liveness probe                          |
| Readiness          | `/readyz`                                         | DB-aware readiness probe for Compose/load balancers |

---

## Realtime (SSE)

Live updates are delivered via **Server-Sent Events** under `/sse/*` (to-dos, reminders,
reminder comments, dish ratings, dish comments). Because `EventSource` cannot set headers, SSE
endpoints accept the token and API key as query parameters and emit periodic heartbeats
(`SSE_HEARTBEAT_MS`). Clients reconnect automatically.

---

## Background jobs

Started once the DB is reachable (`src/index.ts` → `startBackgroundJobs`):

- **Session cleanup** — prunes expired/revoked refresh tokens.
- **Archiver** — moves to-dos/reminders overdue by `ARCHIVE_AFTER_HOURS` into an admin-viewable archive.
- **Push poller** — sends due reminder notifications (no-op without VAPID keys).
- **School-year rollover** — on the configured date (default **1 August**), snapshots all non-admin
  users, classes, to-dos and reminders into the `school_years` archive tables and clears the live
  tables so the new year starts fresh. Idempotent; configurable month/day.

---

## Admin panel

A React + Vite SPA is built into the image and served at **`/admin/`** (same-origin, JWT-protected).
It covers the existing Pokyh users, classes, sessions, dishes & images, comments, to-dos/reminders,
logs, the Cloudflare tunnel and school-year archives. Pokyh Learn administration is intentionally
separate at `learn.pokyh.com/admin` and uses `/learn/admin/*` rather than mixing Learn data into
this UI.

The legacy `/api/admin/import` cannot run while Learn records exist, preventing a legacy restore
from cascading into Learn data. Use the scoped Learn personal export/import routes for learner
portability, and plan a dedicated, reviewed platform backup/migration before treating either
surface as a full Learn backup.

```bash
npm run admin:dev      # run the admin panel in dev (Vite)
npm run admin:build    # build it into admin/dist (also done by the Docker build)
```

---

## Deployment

Production runs as a Docker image (multi-stage `Dockerfile`) that:

1. Builds the API (`tsc`) **and** the admin panel.
2. Installs `cloudflared` (arch auto-detected) and `openssl` (Prisma engine on Alpine).
3. On start (`entrypoint.sh`), launches the server, which **self-bootstraps the database** and,
   if configured, starts the Cloudflare Tunnel — so no inbound ports need to be opened.

```bash
docker compose up --build -d
```

On the bundled compose stack the app waits for the MySQL healthcheck, then the
container healthcheck calls `/readyz` (which verifies database reachability)
before it is considered ready. The existing `/health` remains a lightweight
liveness endpoint. The tunnel exposes the app publicly at `TUNNEL_HOSTNAME`.

---

## Operations & maintenance

Helper scripts (run inside the container or locally with a valid `.env`):

```bash
npm run make-admin <username>            # grant admin
npm run revoke-admin <username>          # revoke admin
npm run set-admin-password               # set/replace the admin password (bcrypt)
npm run create-user                      # create a local (non-WebUntis) user
npm run tunnel                           # run the Cloudflare tunnel manually
```

Logs are written to rotating files (winston) and stdout; the admin panel exposes a log viewer.

---

## Project layout

```
src/
├── index.ts            # app bootstrap, middleware, CORS, boot/retry, background jobs
├── config.ts           # all env parsing (fail-fast on required secrets)
├── db.ts               # Prisma client singleton
├── tunnel.ts           # Cloudflare Tunnel lifecycle
├── middleware/         # apiKey, auth (JWT), rateLimiter, requireAdmin, requestLogger
├── routes/             # auth, users, todos, classes, reminders(+comments),
│                       # dishes/ratings/comments, subjectImages, sse, admin, setup, push
├── services/           # webuntis, sse, archiver, schoolYearArchiver, pushPoller
└── utils/              # cache, errors, logger, uid, revokedTokens
prisma/schema.prisma    # database schema (source of truth)
admin/                  # React + Vite admin panel (built into admin/dist)
scripts/                # admin/user management CLIs
Dockerfile · docker-compose.yml · entrypoint.sh
```

---

## Troubleshooting

| Symptom                                   | Likely cause / fix                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Logins fail with **429** at scale         | `TRUST_PROXY` unset → all clients share one IP bucket. Set `TRUST_PROXY=loopback`. Server-to-server logins must send a valid `X-Server-Key` (those bypass the limiter). |
| Browser **CORS** error from the frontend  | Add the frontend origin to `CORS_ORIGIN` (the tunnel host & its parent domain are auto-added). |
| `/auth/me` returns **401** right after login | The frontend/iOS didn't receive a token — check the server-to-server login response and `X-Server-Key`/`X-API-Key`. |
| **422** on `/auth/login`                  | Body validation failed — `klasseId` may be `0` (no class); the schema accepts that, but check the logged Zod error. |
| Prisma **"property does not exist"**      | Run `npx prisma generate` after schema changes.                                    |
| DB unreachable on boot                    | Non-fatal — the server retries with backoff. Check `DATABASE_URL` and the MySQL healthcheck. |

---

<div align="center">

Part of the **POKYH** project · Frontend (Next.js) · iOS (SwiftUI) · Backend (this repo)

</div>
