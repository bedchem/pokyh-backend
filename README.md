<div align="center">

# POKYH — Backend

**The API, realtime layer and admin panel behind POKYH — the school companion app for LBS Brixen.**

Node.js · Express 5 · TypeScript · Prisma · MySQL · Server-Sent Events · Web Push · self-hosted via Docker

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

It also serves a built-in **React admin panel** at `/admin/`. Public DNS, TLS
termination and ingress are operated outside the application container.

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
        │  MySQL 8     │
        │  (Prisma)    │
        └──────────────┘
```

- **Stateless HTTP** — horizontally scalable; JWTs carry identity, refresh tokens live in MySQL.
- **Non-blocking boot** — the HTTP server starts immediately; the database is created, migrated
  (`prisma db push`) and connected in the background with retry/backoff. A cold or missing DB
  never blocks startup.
- **Config-driven, zero hardcoded hosts** — CORS origins, the public hostname and every limit are
  derived from environment variables.

### Pokyh Learn extension

The additive `/learn` router serves the separate `learn.pokyh.com` product. It
does not change existing Pokyh routes or data. The built-in backend
administration at `api.pokyh.com/admin/` contains a separately scoped **Learn**
area for safe Learn configuration and group management; it uses the existing
administrator session but does not blend Learn records into unrelated school
screens. The Learn web app may offer its own Learn-only `/admin` client
surface, but the backend remains the authority for every configuration,
membership, and access decision.

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
- Quiz attempts also create a private per-user/per-course/day count aggregate
  in the same MySQL transaction. The optional Compose Redis service can cache
  only an already-authorized course-specific analytics response; it stores no
  answer text, answer keys, credentials, permissions, or durable learning
  state and falls back to MySQL if unavailable.
- Group creation, membership changes, and linking a course to a group are
  canonical Pokyh administrator operations. Membership labels grant only the
  team-course access confirmed by the backend; they do not delegate group
  administration to a learner.
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
| Ingress            | External reverse proxy or infrastructure load balancer         |

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
On first run, open `/admin/` to create the administrator account.

### Run everything with Docker (recommended for parity with prod)

```bash
# Development example only: replace placeholders; never commit the resulting file.
cp .env.example .env
./scripts/compose-stack.sh up --build -d
```

`scripts/compose-stack.sh` selects one operator-owned environment file for the
app and the MySQL initialisation config, while disabling Compose's automatic
project-`.env` parsing. The service-level `env_file` uses Compose's `raw`
format, so values such as bcrypt hashes are passed literally rather than being
interpolated by Compose. MySQL receives only its root password and database
name; the full backend environment is never injected into the MySQL process.

For a separately managed private file, select it once:

```bash
BACKEND_ENV_FILE=/secure/path/backend.env \
  ./scripts/compose-stack.sh up --build -d
```

This starts MySQL and an internal, non-persistent Redis service behind
healthchecks, then starts the app. Redis is not published to the host network
and is only the optional private Learn analytics cache; MySQL remains the
durable source of truth.

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
| `LEARN_REVIEW_*` / `LEARN_ANALYTICS_RETENTION_DAYS` | Bounded adaptive-review policy and retention for private daily activity aggregates. |
| `LEARN_REDIS_URL` / `LEARN_REDIS_KEY_PREFIX` / `LEARN_ANALYTICS_CACHE_TTL_SECONDS` | Optional internal course-specific analytics cache. Do not expose Redis publicly or use it for tokens, answers, permissions, or durable state. |
| `REQUEST_LOG_RETENTION_DAYS` / `LOG_FILE_RETENTION_DAYS` | Finite retention for database/file request logs containing technical security data. |
| `TRUST_PROXY`            | `false` for direct exposure; set the exact trusted proxy topology only when an operator puts one in front of the API. |
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
- `helmet` security headers; strict, allow-list **CORS** configured entirely through `CORS_ORIGIN` and `LEARN_ALLOWED_ORIGINS`.
- Tiered **rate limiting**: global, auth (strict, per-IP brute-force), refresh (generous — refresh
  is gated by an unguessable token), read, write, SSE and admin-login limiters. Trusted server-key
  callers bypass auth/refresh limits.
- Refresh tokens are stored **hashed (SHA-256)**; one active session per user.
- Admin password stored as a **bcrypt** hash; admin routes require a JWT + admin membership.
- `timingSafeEqual` for all key comparisons.

---

## API overview

> Base URL: the HTTPS API origin operated by your infrastructure (for example `https://api.pokyh.com`). All times are ISO-8601 UTC.

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

A React + Vite SPA is built into the image and served at **`/admin/`**
(same-origin, JWT-protected). It covers the existing Pokyh users, classes,
sessions, dishes & images, comments, to-dos/reminders, logs, and school-year
archives. Its dedicated **Learn** area is visibly
separate from those records and manages safe Learn policy through
`/api/admin/learn-config` plus group administration through
`/api/admin/learn/teams`. It never returns secrets, raw quiz answers, or
unrelated school data as part of a Learn view.

`learn.pokyh.com/admin` is a separate frontend product surface and may consume
the scoped `/learn/admin/*` routes. It does not replace the backend admin
boundary or confer administrator status; every server route repeats the
canonical Pokyh administrator check.

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
2. Installs `openssl` (Prisma engine on Alpine) and drops runtime privileges to the application user.
3. On start (`entrypoint.sh`), launches the server, which **self-bootstraps the database**.

```bash
./scripts/compose-stack.sh up --build -d
```

On the bundled compose stack the app waits for both MySQL and internal Redis
healthchecks, then the container healthcheck calls `/readyz` (which verifies
database reachability) before it is considered ready. Redis availability is not
the durable readiness authority: its failure must degrade private analytics to
MySQL rather than lose learning data. The existing `/health` remains a
lightweight liveness endpoint. Publish the container deliberately through an
externally operated TLS reverse proxy or load balancer.

### Production boundaries

This Compose file is a single-host deployment topology, not an off-host backup,
restore, disaster-recovery, or migration-management system. Its named MySQL
volume is durable only as far as the Docker host and its storage remain intact.
No encrypted off-host backup target, restore runbook, scheduled backup job, or
reviewed production migration workflow is configured by this repository.

`DB_AUTO_PUSH=true` can apply Prisma schema changes at startup; that is a
deployment convenience, not evidence that a production migration has been
reviewed, backed up, or rehearsed. Before a production schema change, use a
reviewed migration plan, take and test an operator-managed backup/restore, and
verify the target database separately. Do not treat personal Learn JSON export
or the admin UI as a platform backup.

### Logs

The `app` service emits structured JSON events to stdout/stderr, so inspect a
running deployment with `docker compose logs -f app`. Docker's local log driver
keeps this container stream bounded to five 10 MiB files. The existing local
daily files under `./logs/` remain available outside Docker and are bounded by
`LOG_FILE_RETENTION_DAYS`. A defense-in-depth redaction formatter masks common
credential fields and connection-string credentials, but request bodies and
secrets must still never be passed to logger calls.

---

## Operations & maintenance

Helper scripts (run inside the container or locally with a valid `.env`):

```bash
npm run make-admin <username>            # grant admin
npm run revoke-admin <username>          # revoke admin
npm run set-admin-password               # set/replace the admin password (bcrypt)
npm run create-user                      # create a local (non-WebUntis) user
```

Logs are written to rotating files (winston) and stdout; the admin panel exposes a log viewer.

---

## Project layout

```
src/
├── index.ts            # app bootstrap, middleware, CORS, boot/retry, background jobs
├── config.ts           # all env parsing (fail-fast on required secrets)
├── db.ts               # Prisma client singleton
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
