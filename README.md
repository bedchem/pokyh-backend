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
| Cluster admin      | `/api/admin/cluster`                              | Invites, one-line installs, joining, peers, certificate renewal, updates, status — see [Cluster](#cluster-multi-node-replication) |
| Cluster channel    | `/cluster/v1/*`                                   | Node-to-node only (API port with `CLUSTER_PUBLIC_PATH`, `CLUSTER_PORT`, or the mutually authenticated `CLUSTER_MTLS_PORT`); encrypted frames, own authentication, pinned certificates, optional IP allowlist |
| Node setup         | `/setup`, `/setup/provision`, `/setup/bundle`     | The one-line installer; answers 404 unless an administrator has an install command open. Everything it hands out is sealed with or checked against the command's key |
| Setup              | `/api/setup`                                      | First-run wizard. Reachable without credentials only while no administrator can sign in at all (none in the env file, none with a password in the database) and never on a cluster node; usernames are restricted to letters, digits, `.`, `_`, `-`, nothing multi-line reaches the env file, rate limited, one at a time |
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

In a [cluster](#cluster-multi-node-replication) there is no leader: notifications and polling are
shared out per item over the reachable nodes, and archiving and the rollover run on one node only
while every node is reachable. Backups and request-log cleanup stay per node.

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
the same data. There is **no leader**: every node accepts reads and writes, every node holds all
data, and the nodes keep checking each other. A change made through any node reaches the others
within about a second, a node that was offline catches up by itself when it returns, and a client
can be served by whichever node is nearest or least busy. The feature is dormant until the first
invite: a standalone server installs no trigger and behaves exactly as before.

### Adding a server with one command

A fresh Debian 12+ or Ubuntu 22.04+ server becomes a complete node with a single command — Docker,
database, configuration, hardening and joining the cluster included. Any node can add servers;
several can be added at the same time, each with its own command.

1. On any node that has the mutually authenticated channel (see below), open the admin panel under
   its public **https** address → **Cluster** → **Server per Einzeiler hinzufügen**. Enter a name
   and, optionally, the new server's address:
   - **empty** (default): the new server's public IP is taken from where its setup comes from. It
     gets no web address of its own — clients keep using your existing addresses; the nodes reach
     it on port 4100, or through a relay when it is behind NAT;
   - **a domain** (`node2.example.org`, already pointing at it): it also serves HTTPS itself (Caddy,
     Let's Encrypt; ports 80 and 443 must be open);
   - **an IP**: like empty, but fixed.

   Or through the API: `POST /api/admin/cluster/node-installs`
   `{"name": "Homelab", "address": "", "origin": "https://api.example.org"}` with an admin token.
2. Run the command it shows on the new server, as root or as a user with sudo:

   ```bash
   curl -fsSL --proto '=https' -o pokyh.sh 'https://api.example.org/setup' \
     && echo '<sha256>  pokyh.sh' | sha256sum -c - && sh pokyh.sh 'pokyhnode1.…'
   ```

`/setup` exists on the API port only while an install command is open (at most
`CLUSTER_INSTALL_TTL_MINUTES`, 30 by default); at any other time it answers 404 like any unknown
path. It works through whatever is in front of the API (a proxy, a CDN), because nothing on that
way has to be trusted: `sha256sum` accepts only this exact script, and everything else is protected
by the key in the command (below).

The installer ([deploy/node/install.sh](deploy/node/install.sh)) checks the system (OS, memory,
disk, the cluster port, clock synchronisation), installs Docker Engine from Docker's repository (key
fingerprint pinned), fetches the cluster's shared configuration and the inviting node's exact build
(over the public address, or — if that does not answer correctly — over the inviting node's pinned
channel), writes `/opt/pokyh/.env` (mode 0600) with a database password and `CLUSTER_SECRET` of its
own, hardens the server, starts the stack and waits until the node has paired and received the
cluster's data. Run the same command again to resume after a failure. Afterwards `/opt/pokyh/pokyh`
is `docker compose` for that stack (`/opt/pokyh/pokyh ps`, `… logs -f app-blue`, `… logs -f updater`).

The stack ([deploy/node/compose.yml](deploy/node/compose.yml)): MySQL, Redis, the backend as
`app-blue`/`app-green` (one active; see *Updates* below), `edge` (owns the cluster port and passes
connections on unchanged, with a PROXY protocol line naming the client), `updater` (the only part
with Docker access; opens no port), Caddy with a domain, Ollama if chosen.

Hardening (skip with `POKYH_HARDEN=0 sh pokyh.sh …`): automatic security updates
(`unattended-upgrades`) and a firewall (`ufw`) that lets in only SSH — on the port(s) `sshd` really
listens on, so nobody is locked out — the cluster port and, with a domain, 80/443. SSH itself is
not changed.

What the new node takes over: the settings that have to be equal on every node — `JWT_SECRET`,
`REFRESH_TOKEN_SECRET`, `API_KEY`, `SERVER_KEY`, `VAPID_*`, the admin login as currently in effect,
`CORS_ORIGIN`, `PUBLIC_BASE_URL` (exactly as on the inviting node, so stored links never point at one node),
`WEBUNTIS_*`, `LEARN_*`, rate limits, school-year, cluster and update settings
([src/cluster/sharedEnv.ts](src/cluster/sharedEnv.ts)). Never: database credentials,
`CLUSTER_SECRET`, the node's own addresses, ports, proxy trust, paths.

How the command is protected:

- **The script**: `sha256sum` accepts only this exact script; a script changed on the way stops the
  command before anything runs. It holds nothing secret.
- **The key** (`pokyhnode1.…`) names the inviting node's public address and channel, its
  certificate pin, the install and a 256-bit secret that never travels. From it the new server
  derives a proof key (every request carries an HMAC over a fresh nonce and the time), the key that
  opens the configuration (AES-256-GCM, bound to that very request — readable by nobody else, not
  by a proxy or CDN in between), and the one-time pairing secret.
- **Once, briefly**: the command must be started within `CLUSTER_INSTALL_TTL_MINUTES`; the
  configuration is handed out exactly once; `CLUSTER_PAIRING_MAX_FAILURES` wrong proofs lock the
  install; the panel can revoke it; the secret is forgotten as soon as the node joined. Neither the
  key nor the command is stored or logged.
- **The build**: the download is checked against the SHA-256 that arrived inside the sealed
  configuration. The new node runs exactly the inviting node's version.
- **Joining**: the new node pairs over the mutually authenticated channel only, with both
  certificates bound into the handshake. Its join instruction is deleted from disk at its first
  start.

The installing node must run a build (`npm run build && npm start` or the Docker image), since it
hands that build out.

### Updates without downtime, node by node

Set the repository in the panel (**Cluster → Updates**) or with `CLUSTER_UPDATE_REPO` (e.g.
`https://github.com/bedchem/pokyh-backend`) and `CLUSTER_UPDATE_BRANCH` (`main`). Every node then
checks the branch every `CLUSTER_UPDATE_POLL_MINUTES` (git's own HTTP protocol, any git host) and,
with `CLUSTER_UPDATE_REQUIRE_CI` (on), accepts a commit only when all its GitHub checks passed.
With `CLUSTER_UPDATE_AUTO` (on) new versions roll out by themselves; off, the panel shows the new
version with **Jetzt ausrollen**. Settings changed in the panel apply to every node (replicated
table `update_settings`); without them the `CLUSTER_UPDATE_*` values apply.

The rollout has **no leader**. Every node sorts all nodes by SHA-256(commit, node id) — the same
order everywhere, different for every version — and updates itself when every node before it runs
the new version, is not updated by Pokyh (e.g. a Dokploy node — update it there), or has been
unreachable for longer than `CLUSTER_UPDATE_SKIP_OFFLINE_MINUTES`. The first node builds from git;
the others take its build over the cluster channel (SHA-256 checked). A single node simply goes
first. A failed update stops the rollout there: the node keeps running its previous version and the
nodes after it wait until an administrator chooses **Erneut versuchen**. **Auf vorherige Version
zurück** switches one node back.

On a node set up by the installer, the app asks the `updater` service (through files in
`/opt/pokyh/data/update`; the app has no Docker access): it builds the new image, starts it as the
other colour next to the running one — it serves HTTP but takes over the cluster and background
jobs only once named active — waits until it is healthy (`CLUSTER_UPDATE_HEALTH_TIMEOUT_SECONDS`),
stops the old one gracefully and names the new one active. Caddy and the edge forwarder follow the
shared name `app`, so no request is dropped. If the new version does not become healthy, it is
removed and nothing else changes.

The updater's own files (`updater.mjs`, `edge.mjs`, `compose.yml`) — the part that runs with more
than the app's rights — are taken only from the repository and branch fixed in
`/opt/pokyh/compose.env` at install time (`POKYH_RUNTIME_REPO`, `POKYH_RUNTIME_BRANCH`), fetched by
the updater itself and used only if the commit is on that branch; a new `compose.yml` must also pass
a policy check (no privileged containers, only the expected files mounted, the Docker socket for the
updater only, no extra ports). A compromised app can therefore never gain more rights through an
update.

### Moving a Dokploy node onto the Pokyh stack

A node deployed with Dokploy (or any other way) works in the cluster as it is, but is updated where
it is deployed; the rollout passes over it. To give it automatic updates too:

1. Add a fresh server with the one-line command above (or add one on the same machine's new VM).
2. Wait until it shows *Online* and the Cluster page shows no pending rows.
3. Point clients (DNS, your proxy) at the new node, then remove the old node in the panel
   (**Verbindung entfernen**) and shut it down.

The data never leaves the cluster: the new node received all of it while joining.

### Adding a node with an invite code

1. On any existing node: admin panel → **Cluster** → **Node einladen**. Enter the address the new
   node will reach this one at (prefilled from `CLUSTER_ADVERTISE_URL`, otherwise from the address
   the panel is open under) and create the code.
2. On the new node: **Cluster** → **Beitreten**, paste the code and enter the new node's own
   address (how the others reach it).
3. The new node contacts the inviting one, both prove they know the code's one-time secret and
   agree on a link key; both then show the other as *Online* and the initial transfer starts.

An invite code is valid once and for `CLUSTER_PAIRING_TTL_MINUTES` (15 by default), and locks
after `CLUSTER_PAIRING_MAX_FAILURES` wrong attempts. Whoever holds a valid code can join and
receives all data — pass it on only over a channel you trust.

With `CLUSTER_AUTO_MESH` (on by default) a node invited by one member is introduced to all the
others automatically, so every node ends up linked directly with every other. The mesh also heals
itself: whenever a node is linked with two peers that are not linked with each other, it introduces
them. A link an administrator removed or switched off is never re-created by the mesh.

Requirements: the nodes must reach each other in both directions (see *Network* below); they must
run the same version (replication with a peer pauses while the database schemas differ, e.g. during
a rolling upgrade); their clocks must be synchronised (NTP); and the database account must be
allowed to create triggers (the bundled Compose stack qualifies). For clients to move freely between
nodes, give all nodes the same `JWT_SECRET`, `REFRESH_TOKEN_SECRET`, `API_KEY` and `SERVER_KEY` —
the nodes compare fingerprints of them (never the values) and the Cluster page warns when they
differ. Routing clients to a node (GeoDNS, load balancer) is outside this repository; for
read-your-own-writes, route a client to the same node for the duration of its session.

### Network

The node-to-node channel (`/cluster/v1`) can be served in two places, switched in `.env` and shown
on the Cluster page:

| Setting | Effect |
|---------|--------|
| `CLUSTER_PUBLIC_PATH=true` (default) | Served on the ordinary API port — for nodes that reach each other through a reverse proxy (`https://node1.example.org`). |
| `CLUSTER_PORT=4100`, `CLUSTER_BIND_ADDRESS` | A listener of its own that serves nothing but the channel (`http://10.0.0.5:4100`), to be opened only to the other nodes. With Docker Compose, publish the port as well (`ports: - "4100:4100"`). |
| `CLUSTER_ALLOWLIST=203.0.113.10,10.0.0.0/8` | Only these addresses (IPs or CIDR ranges) may use the channel, on both entry points. Behind a reverse proxy the address is the one `TRUST_PROXY` lets through. |

Both entry points can be on at the same time. `CLUSTER_ADVERTISE_URL` is the address the other
nodes should use for this one.

### The mutually authenticated channel (mTLS)

With `CLUSTER_MTLS_PORT` (4100 by convention) a node serves the node-to-node channel over TLS 1.3
with **certificates on both ends**:

- Every node creates its own certificate (ECDSA P-256) on first start; the private key never leaves
  it and is stored only wrapped (like link keys). There is no certificate authority: nodes **pin**
  each other's public key (`sha256//…`, as `curl --pinnedpubkey`). Pins are learned only over
  authenticated paths — the install token, an invite code, an introduction by a common peer, or the
  already encrypted link — and removing a peer revokes it immediately.
- A connection without a certificate, or with one nobody pinned, is cut off right after the
  handshake, before any HTTP is read — unless a pairing or an install is open, and then it reaches
  only the endpoints those need (`/pair/*`; `install.sh`, `/provision`, `/provision/bundle` — the
  installer's fallback when the public `/setup` does not answer correctly).
- Outgoing, the peer's certificate is the only trust anchor and its pin is checked again; a
  different certificate ends the connection before any request data is written.
- Inside, the frame layer keeps running with its own keys, and its handshakes cover both
  certificates of the connection (protocol version 3): something that terminated TLS in between,
  even with a trusted certificate, makes them fail. Two independent, mutually authenticated layers.
- Links made before the channel existed move onto it by themselves: the nodes exchange their
  certificates over the encrypted link and switch. Once both directions have worked there, the link
  is **locked** to the channel and nothing else is accepted from or tried towards that peer.
- **Zertifikat erneuern** (panel) or `POST /api/admin/cluster/certificate/rotate` replaces a node's
  certificate; every linked node (all must be online) pins the new one first, the old one stays
  accepted for 15 minutes.

| Setting | Effect |
|---------|--------|
| `CLUSTER_MTLS_PORT=4100` | Serves the channel; required for one-line installs. |
| `CLUSTER_MTLS_URL=https://node1.example.org:4100` | How the other nodes reach it; derived from the host of `CLUSTER_ADVERTISE_URL` (or `PUBLIC_BASE_URL`) when empty. Must reach this server directly, not through a proxy that terminates TLS. |
| `CLUSTER_MTLS_BIND_ADDRESS` | Interface to listen on (`0.0.0.0`). |
| `CLUSTER_MTLS_PUBLISH=0.0.0.0:4100` | Docker Compose / Dokploy: publishes the channel port (by default only a random loopback port is published, so nothing is exposed). |
| `CLUSTER_MTLS_PROXY_PROTOCOL=true` | A forwarder in front of the port (the installer's `edge`) names each client in a PROXY protocol v1 line; accepted only from `CLUSTER_MTLS_PROXY_FROM` (private and loopback ranges by default). Changes nothing about authentication. |

On a Dokploy node: set `CLUSTER_MTLS_PORT=4100`, `CLUSTER_MTLS_PUBLISH=0.0.0.0:4100` and, if the
domain is proxied (e.g. by Cloudflare), `CLUSTER_MTLS_URL` with a name that resolves to the server
itself; open TCP 4100 in the firewall.

### Several ways to reach a node: direct, proxy, relay

A node can announce several ways to reach its channel, in its order of preference. The others try
them in turn, stay with the one that works, fall back to the next when it fails and give the
preferred ones another chance every few minutes. Changes reach every peer with the next heartbeat.
Whichever way a connection takes, it ends at the node's own pinned certificate: proxies and relays
carry ciphertext only and can neither read, alter nor impersonate anything.

Admin panel → **Cluster** → **Erreichbarkeit dieser Node** (each switchable, reorderable), or
`CLUSTER_MTLS_ENDPOINTS` (comma separated; listed first):

| Way | Example | |
|-----|---------|---|
| Direct | `https://10.8.0.2:4100` | public address, or a WireGuard/Tailscale address the others share |
| Proxy · own port | `https://vps.example.org:4100` | a proxy (VPS) passes TCP 4100 on to the node unchanged |
| Proxy · 443 (SNI) | `https://node1.cluster.example.org:443` | the proxy passes TLS for that name on 443 on unchanged, web traffic stays as it is |
| Relay | (automatic) | see below |

For the proxy ways the panel shows ready-made configuration for nginx (`stream` + `ssl_preread`),
HAProxy, Traefik (TCP, `passthrough`) and Caddy (`layer4`) once the address behind the proxy (e.g.
the node's WireGuard address and port) is entered. Whatever proxy is used: it must pass the TCP
connection on and never terminate TLS. An endpoint's server name can differ from the host
connected to: `https://vps.example.org:4100?sni=node1.cluster.example.org`.

### Relays (no open ports needed)

A Pokyh relay ([deploy/relay/relay.mjs](deploy/relay/relay.mjs), no dependencies) runs on any
server with a public address. A node that cannot accept connections (homelab behind NAT, no VPN)
keeps a few connections open *to* the relay; when another node connects to the relay, the relay
reads the server name of the TLS ClientHello — without terminating TLS — and splices the connection
onto one of them. The nodes then run their own mutual TLS through it, end to end.

1. **Cluster** → **Relay auf VPS einrichten**: enter the VPS's public name and choose the relay's
   own port (4100) and/or 443 through your proxy under a domain (`*.cluster.example.org` → VPS, the
   proxy passes those names on 443 to the relay). Run the command on the VPS as root; it installs
   Docker if needed, runs the relay as a container (unprivileged, read-only, restarted by itself)
   and prints the **relay key**.
2. **Relay hinzufügen** → paste the key. That is all: the relay is stored (encrypted, under a key
   every node derives from the shared `JWT_SECRET`) in a replicated table, so every node of the
   cluster — also every node added later — registers itself and announces its relay ways. Or, for
   one node only, put the key into `CLUSTER_RELAY_KEYS`.

There is still no leader: a relay is one more path, not a coordinator. Several relays can be used;
any node can add, switch (own port / 443) or remove them and the change reaches all nodes through
replication; when a relay is down the nodes keep using every other way and re-register by
themselves when it is back.

What protects the relay path:
- A node parks only at the relay whose certificate matches the pin in the key, and proves the
  key's registration secret for every parked connection (HMAC over route, time, a fresh nonce and
  the node's own certificate); replays, wrong secrets, names outside the relay's domain and a
  route another node is using are refused.
- The relay sees server names and ciphertext, nothing else; unknown names are dropped silently.
  Connections are rate limited per address, bounded in number and closed when idle.
- What the relay could do if it were compromised: refuse to carry traffic. Nothing more — the
  nodes authenticate each other by their pinned certificates through it.

### What protects the link

- **Pairing**: the invite's 256-bit one-time secret is stretched with scrypt and a random salt and
  authenticates an ephemeral X25519 key exchange with confirmation on both sides. The joining node
  checks that the node named in the code answers; the joining node's own address is covered by the
  proof, so it cannot be swapped in transit. The result is a 256-bit link key that never travels
  over the network.
- **Every connection**: a fresh ephemeral X25519 exchange, authenticated with the link key —
  recorded traffic stays unreadable even if a link key leaks later.
- **Every message**: compressed, padded to a fixed size step (so its length says little about its
  content), then sealed with AES-256-GCM under separate keys per direction and a unique counter;
  altered, replayed or foreign messages are rejected. Through an HTTPS reverse proxy TLS adds a
  second, independent layer.
- **Who may connect**: optionally only the addresses in `CLUSTER_ALLOWLIST`, on a port of its own.
- **At rest**: link keys and the node's certificate key are stored encrypted (key derived from
  `CLUSTER_SECRET`, or from `JWT_SECRET` when unset) and are never logged or returned by any API;
  neither is an invite code or an install token.
- **Certificates**: with the mutually authenticated channel, pinned certificates on both ends and
  the handshakes bound to them (see above).

The channel protects the data in transit and makes sure only linked nodes take part; it cannot
protect against a node that is itself compromised, or against someone who obtains a valid invite
code. A linked node receives the complete data set — only link nodes you control.

### How data is kept consistent

- Triggers record each change in the same transaction as the change itself, whatever wrote it
  (API, raw SQL, the CLI scripts): one small write per change — the row's version record moves to
  the end of the change feed. Nothing is written per peer; each peer has a read position in the
  feed that is stored about every 30 seconds, not per row. Replicated: every table except
  `request_logs`, `frontend_activity_logs`, `backup_config` and the `cluster_*` bookkeeping tables
  (plus `CLUSTER_EXCLUDE_TABLES`).
- Changes are sent in adaptive batches: right away when it is quiet (after
  `CLUSTER_BATCH_IDLE_MS`), collected for at most `CLUSTER_BATCH_MAX_DELAY_MS` under load. A
  received package is applied in one transaction (one disk flush for hundreds of rows) and falls
  back to row-by-row handling when anything in it needs more than a plain write.
- Rows travel in their current state. If the same row was changed on two nodes, the **later
  change wins** on every node. Deleting a parent removes its dependants everywhere.
- The same unique value created independently on two nodes (the same account, for instance): the
  row created first is kept and the other is removed on all nodes. Two different courses with the
  same address, or two list entries at the same position, are both kept and one is adjusted.
- Counters that are incremented on several nodes at once keep the later node's total.
- Live updates (SSE), the menu cache and session revocations follow replicated changes, so a
  client connected to one node sees a change made through another.
- **Self-check**: every `CLUSTER_VERIFY_INTERVAL_MINUTES` (15) each node compares checksums of all
  its version records with each peer, descends only into groups that differ, and sends whatever
  the peer holds in an older version. Anything that slipped through is repaired by itself; the
  Cluster page shows the last check and offers *Jetzt prüfen*.

### Background work without a leader

Work done per item — push notifications, WebUntis message polling, idempotent clean-ups — belongs
to exactly one of the nodes that can currently be reached, chosen by hashing the item (rendezvous
hashing). It spreads evenly over all nodes, and when a node goes away only its share moves, each
item to the next node. While nodes cannot see each other, each side carries on, so a notification
may then go out twice rather than not at all.

Work that must happen once and only once — archiving and the school-year rollover — runs on one
node, and only while every linked node is reachable, so two separated halves can never both run it.

### Failure handling

Each node sends its peers an authenticated heartbeat every `CLUSTER_HEARTBEAT_INTERVAL_MS`. After
`CLUSTER_SUSPECT_AFTER_FAILURES` missed answers a peer is shown as *Antwortet nicht*, after
`CLUSTER_OFFLINE_AFTER_FAILURES` as *Offline*; both are logged (`cluster_peer_suspect`,
`cluster_peer_offline`, `cluster_peer_online`). Changes for an offline peer simply stay in the feed
and are delivered when it is back.

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

`npm test` covers the pure parts (trigger SQL, crypto and its binding to the channel, framing,
invite codes, allowlist, work distribution, node certificates and real mutual TLS handshakes, the
install token, its keys and sealing on both sides, what is shared, the bundle, the installer script
through `sh -n` and shellcheck, endpoints and proxy configuration, the relay protocol on both sides
and the relay itself carrying end-to-end TLS). `npm run test:cluster` starts a throw-away MySQL container and three backend
processes and runs the whole life cycle against them: invite and join, auto-mesh, initial transfer,
live replication, the self-check, node failure and recovery, conflicting changes on separated
nodes, replayed and tampered traffic, backup restore. Its second part
(`tests/cluster/install.e2e.mjs`) runs the one-line installer against real nodes: the command as
shown, an impostor certificate, guessed tokens until the lock, revocation, single use, the new node
started from the handed-out build joining by itself over the channel, a third node joined through
the second and linked by the mesh, certificate renewal, links moving onto the channel by
themselves, and attempts to abuse the first-run setup. The third part (`tests/cluster/relay.e2e.mjs`)
runs a real relay: a node reachable only through it, a server installed and joined through it, the
relay setting reaching that server through replication, a forged relay key, the relay going away and
coming back, a proxy routing by server name taking over when the relay is switched off, and the
relay setup command. It needs Docker (or `CLUSTER_E2E_MYSQL_URL`
pointing at a throw-away MySQL server) and does not touch a local `.env` or database.

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
| Cluster join stays *Tritt bei…*           | The invite was already used or has expired (create a new one), the inviting node's address is not reachable from the new node, or the new node's own address is not reachable from the inviting node. Wrong codes lock the invite after a few attempts. |
| Cluster page: capture could not be set up | The database account may not create triggers. Grant `TRIGGER` on the database (with binary logging and a non-`SUPER` account also set `log_bin_trust_function_creators=1`). |
| Cluster peer *Online* but nothing arrives | Check the warnings on the Cluster page: different schema (finish the upgrade on both nodes) or a peer on hold after a very long absence. |

---

<div align="center">

Part of the **POKYH** project · Frontend (Next.js) · iOS (SwiftUI) · Backend (this repo)

</div>
