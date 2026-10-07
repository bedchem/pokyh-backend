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
- [Cluster (multi-node replication)](#cluster-multi-node-replication)
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
login here (guarded by a shared `SERVER_KEY`) to mint a POKYH session. Parents/guardians receive
no POKYH class identity or membership; child data needed by WebUntis stays outside that assignment.

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
| `CORS_ORIGIN`            | Comma-separated allowed browser origins (e.g. `https://pokyh.com`). The matching `www`/apex host is accepted too; list other subdomains explicitly. |
| `LEARN_ALLOWED_ORIGINS`  | Exact browser-origin allow-list for the additive `/learn` router.                        |
| `LEARN_LEGAL_*`          | Production WebUntis activation gate: non-secret approval reference, HTTPS notice URL and notice version. |
| `LEARN_DICTIONARY_*`     | Optional, server-only vocabulary suggestion policy, HTTPS endpoint, pairs, timeout and bounded cache. |
| `LEARN_AI_*`             | Self-hosted, CPU-only vocabulary-sentence trainer: disabled by default; even when enabled, access still requires a `LearnAiAccessGrant` for the person (`npm run grant-ai-access`) or a `LearnAiTeamAccessGrant` for their whole team (`npm run grant-ai-access-team`). It only receives a server-authorized vocabulary entry and returns a structured sentence/translation; the model has thinking disabled and cannot browse or receive user prompts/files. |
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
- **Classes** — `Class`, `ClassMember` (student memberships only; parents are always unassigned)
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
- Force-revoked sessions (admin revoke, password reset, account deletion) are persisted in
  `token_revocations`, so a restart does not re-admit a revoked access token.
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
| Cluster admin      | `/api/admin/cluster`                              | Peers, pairing, status — see [Cluster](#cluster-multi-node-replication) |
| Cluster channel    | `/cluster/v1/*`                                   | Node-to-node only; encrypted frames, own authentication, 404 while no peer is configured |
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

In a [cluster](#cluster-multi-node-replication) these four run on one node only (the leader), so a
notification is never sent once per node. Backups and request-log cleanup stay per node.

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

### AI vocabulary trainer service

The self-hosted, CPU-only Ollama container starts automatically with the rest
of the stack — a plain `docker compose up -d` (which is how Dokploy and
similar platforms deploy this file directly, without
`scripts/compose-stack.sh`) brings it up along with `mysql`/`redis`/`app`. No
profile flag is needed. It stays functionally dormant until an operator sets
`LEARN_AI_ENABLED=true` (the model is only pulled once that flag is on) — see
"AI vocabulary trainer" configuration above.

It runs on its own internal-only network with no host port, is not a hard
dependency of `app` (every non-AI route keeps working if it is stopped,
disabled, or still pulling its model), and persists its downloaded model in
the named `ollama_data` volume so it is not re-fetched on every restart. Grant
a pilot user access with `npm run grant-ai-access <username>` (revoke with
`npm run revoke-ai-access <username>`), or a whole team at once with `npm run
grant-ai-access-team <team-id-or-name>` — there is no platform-wide toggle for
end users, only the admin `LEARN_AI_ENABLED` kill-switch plus at least one of
these grants. No GPU is requested anywhere in the compose file; do not
install `nvidia-container-toolkit` for this service.

**Size `OLLAMA_MEM_LIMIT`/`OLLAMA_CPUS` to the real host, always leaving
headroom for MySQL/Redis/the app/OS** — see the commented block in
`.env.example`. These two, plus `OLLAMA_KEEP_ALIVE`/`OLLAMA_NUM_PARALLEL`/
`OLLAMA_MAX_LOADED_MODELS`/`OLLAMA_NUM_THREAD`, only reach the deployed
container through `scripts/compose-stack.sh` (it extracts this specific
non-secret set and exports them as real shell variables) — setting them in
`.env` alone does nothing if the stack is started any other way, since
Compose's own `.env` auto-loading is deliberately disabled here to protect
`$`-containing secrets elsewhere in that file.

### Logs

The `app` service emits structured JSON events to stdout/stderr, so inspect a
running deployment with `docker compose logs -f app`. Docker's local log driver
keeps this container stream bounded to five 10 MiB files. The existing local
daily files under `./logs/` remain available outside Docker and are bounded by
`LOG_FILE_RETENTION_DAYS`. A defense-in-depth redaction formatter masks common
credential fields and connection-string credentials, but request bodies and
secrets must still never be passed to logger calls.

---

## Cluster (multi-node replication)

Several backend nodes — each with its **own** MySQL database — can be linked so that they hold
the same data. A change made through any node reaches the others within about a second, nodes
watch each other, and a node that was offline catches up by itself when it returns. The feature is
dormant until the first peer is added: a standalone server installs no trigger and behaves exactly
as before.

### Adding a node

Admin panel → **Cluster** on **both** nodes:

1. On node A enter node B's address (IP or host, optional port — default `4000`) and a pairing
   key. *Erzeugen* creates a strong one; any key of at least 16 characters is accepted.
2. On node B enter node A's address and **the same** pairing key.
3. The nodes find each other, verify that both know the key and agree on a link key. Both sides
   then show the peer as *Online* and the initial transfer starts. The pairing key is discarded;
   an unused pairing window closes after `CLUSTER_PAIRING_TTL_MINUTES` and locks after repeated
   wrong keys.

For more than two nodes, pair each new node with at least one existing node; changes are passed
on, so every node receives everything. Pairing every node with every other is still recommended,
because it keeps replication going when one node is down.

Requirements: the nodes must reach each other's API port in both directions; they must run the
same version (replication with a peer pauses while the database schemas differ, e.g. during a
rolling upgrade); their clocks must be synchronised (NTP); and the database account must be
allowed to create triggers (the bundled Compose stack qualifies). For clients to move freely
between nodes, give all nodes the same `JWT_SECRET`, `REFRESH_TOKEN_SECRET`, `API_KEY` and
`SERVER_KEY` — the Cluster page warns when they differ. Routing clients to a healthy node (DNS,
load balancer) is outside this repository.

### What protects the link

- **Pairing**: the pairing key is stretched with scrypt and a random salt, and authenticates an
  ephemeral X25519 key exchange with confirmation on both sides. The result is a 256-bit link key
  that never travels over the network.
- **Every connection**: a fresh ephemeral X25519 exchange, authenticated with the link key —
  recorded traffic stays unreadable even if a link key leaks later.
- **Every message**: AES-256-GCM with separate keys per direction and a unique counter; altered,
  replayed or foreign messages are rejected.
- **At rest**: link keys are stored encrypted (key derived from `CLUSTER_SECRET`, or from
  `JWT_SECRET` when unset) and are never logged or returned by any API.

The channel does not depend on TLS, so it also works between bare IP addresses. It protects the
data in transit and makes sure only paired nodes take part; it cannot protect against a node that
is itself compromised, or against someone who obtains the pairing key while a pairing is open. A
paired node receives the complete data set — only pair nodes you control.

### How data is kept consistent

- Triggers record each change in the same transaction as the change itself, whatever wrote it
  (API, raw SQL, the CLI scripts). Replicated: every table except `request_logs`,
  `frontend_activity_logs`, `backup_config` and the `cluster_*` bookkeeping tables (plus
  `CLUSTER_EXCLUDE_TABLES`).
- Rows travel in their current state. If the same row was changed on two nodes, the **later
  change wins** on every node. Deleting a parent removes its dependants everywhere.
- The same unique value created independently on two nodes (the same account, for instance): the
  row created first is kept and the other is removed on all nodes. Two different courses with the
  same address, or two list entries at the same position, are both kept and one is adjusted.
- Counters that are incremented on several nodes at once keep the later node's total.
- Live updates (SSE), the menu cache and session revocations follow replicated changes, so a
  client connected to one node sees a change made through another.

### Failure handling

Each node sends its peers an authenticated heartbeat every `CLUSTER_HEARTBEAT_INTERVAL_MS`. After
`CLUSTER_SUSPECT_AFTER_FAILURES` missed answers a peer is shown as *Antwortet nicht*, after
`CLUSTER_OFFLINE_AFTER_FAILURES` as *Offline*; both are logged (`cluster_peer_suspect`,
`cluster_peer_offline`, `cluster_peer_online`). Changes are queued for an offline peer and
delivered when it is back. The leader — the node that runs the once-only background jobs — is the
reachable node with the smallest id; when it goes offline the next one takes over.

A peer that was out of contact for longer than `CLUSTER_TOMBSTONE_RETENTION_DAYS` may still hold
rows that were deleted in the meantime. Replication with it is put on hold until an administrator
confirms a resync (or, better, sets the node up again with an empty database).

### Backups and manual changes

Backups stay per node. **Restoring** a backup on a node with peers makes the restored rows the
current version on every node; rows created after the backup are kept. If the database was
changed underneath the application (a restore done by hand, trigger removal), the Cluster page
reports that changes went unrecorded and offers to publish this node's data to all peers
(`POST /api/admin/cluster/rebuild`).

### Limits worth knowing

- Consistency is eventual: for about a second after a write, another node may still return the
  old state.
- The initial transfer of an existing database runs at a few hundred rows per second.
- Rate limits and the optional Redis cache are per node.
- Two classes created for the same WebUntis class on two separated nodes are both kept, since no
  database constraint identifies them as the same.

### Verifying

`npm run test:cluster` starts a throw-away MySQL container and three backend processes and runs
the whole life cycle against them: pairing, initial transfer, live replication, node failure and
recovery, conflicting changes on separated nodes, replayed and tampered traffic, backup restore.
It needs Docker and does not touch a local `.env` or database.

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
├── cluster/            # node pairing, encrypted channel, change capture, replication
├── middleware/         # apiKey, auth (JWT), rateLimiter, requireAdmin, requestLogger
├── routes/             # auth, users, todos, classes, reminders(+comments),
│                       # dishes/ratings/comments, subjectImages, sse, admin, setup, push
├── services/           # webuntis, sse, archiver, schoolYearArchiver, pushPoller
└── utils/              # cache, errors, logger, uid, revokedTokens
prisma/schema.prisma    # database schema (source of truth)
admin/                  # React + Vite admin panel (built into admin/dist)
scripts/                # admin/user management CLIs
tests/                  # unit tests (npm test) and the multi-node test (npm run test:cluster)
Dockerfile · docker-compose.yml · entrypoint.sh
```

---

## Troubleshooting

| Symptom                                   | Likely cause / fix                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Logins fail with **429** at scale         | `TRUST_PROXY` unset → all clients share one IP bucket. Set `TRUST_PROXY=loopback`. Server-to-server logins must send a valid `X-Server-Key` (those bypass the limiter). |
| Browser **CORS** error from the frontend  | Add the frontend origin to `CORS_ORIGIN`. Its conventional `www`/apex counterpart is accepted too; list every other subdomain explicitly. |
| `/auth/me` returns **401** right after login | The frontend/iOS didn't receive a token — check the server-to-server login response and `X-Server-Key`/`X-API-Key`. |
| **422** on `/auth/login`                  | Body validation failed — `klasseId` may be `0` (no class); the schema accepts that, but check the logged Zod error. |
| Prisma **"property does not exist"**      | Run `npx prisma generate` after schema changes.                                    |
| DB unreachable on boot                    | Non-fatal — the server retries with backoff. Check `DATABASE_URL` and the MySQL healthcheck. |
| Cluster peer stays *Kopplung läuft*       | The other node has no open pairing for this node yet, the address is not reachable in one direction, or the keys differ (the entry then locks — enter the key again on both nodes). |
| Cluster page: capture could not be set up | The database account may not create triggers. Grant `TRIGGER` on the database (with binary logging and a non-`SUPER` account also set `log_bin_trust_function_creators=1`). |
| Cluster peer *Online* but nothing arrives | Check the warnings on the Cluster page: different schema (finish the upgrade on both nodes) or a peer on hold after a very long absence. |

---

<div align="center">

Part of the **POKYH** project · Frontend (Next.js) · iOS (SwiftUI) · Backend (this repo)

</div>
