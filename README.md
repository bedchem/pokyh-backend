<div align="center">

# POKYH Backend

**The API, WebUntis gateway, realtime layer and admin panel behind POKYH.**

Node.js 22 · Express 5 · TypeScript · Prisma · MySQL 8.4 · Redis · Server-Sent Events · Web Push · Docker

[Getting started](#getting-started) · [Configuration](#configuration) · [WebUntis gateway](#webuntis-gateway) · [API](#api-overview) · [Admin panel](#admin-panel) · [Deployment](#deployment) · [Cluster](docs/cluster.md)

</div>

> POKYH is an independent project and is not affiliated with, endorsed by or connected to Untis GmbH.
> WebUntis is a trademark of Untis GmbH. The backend acts only with the user's own WebUntis
> credentials and session, on their behalf.

---

## Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [WebUntis gateway](#webuntis-gateway)
- [Authentication and security](#authentication-and-security)
- [API overview](#api-overview)
- [Realtime (SSE) and push](#realtime-sse-and-push)
- [Background jobs](#background-jobs)
- [Data](#data)
- [Admin panel](#admin-panel)
- [Schools](#schools)
- [Cluster](#cluster)
- [Deployment](#deployment)
- [Testing](#testing)
- [Operations](#operations)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)
- [Further documentation](#further-documentation)
- [License](#license)

---

## Overview

POKYH adds a social and organisational layer on top of [WebUntis](https://www.untis.at/): class
reminders, personal to-dos, the school canteen with ratings and comments, announcement popups and
notifications. This backend is:

- **the single source of truth** for everything that is not WebUntis data;
- **the WebUntis gateway of the website**: the static [web frontend](../pokyh-frontend) signs in
  here and reads and writes the person's WebUntis through `/webuntis/*`, with the person's own
  session sealed in the browser's httpOnly cookies (the server keeps a session only for push
  notifications the person turned on);
- **the login partner of the apps**, which authenticate against WebUntis themselves and then do a
  trusted server-to-server login (`X-Server-Key`);
- **the admin panel** at `/admin/`;
- optionally **one node of a leaderless cluster** that keeps several databases in step.

Any school on WebUntis can use POKYH: a school joins on the first sign-in of one of its accounts,
and each school's data is kept apart.

---

## Architecture

```
┌──────────────┐   ┌──────────────┐
│ Web (static) │   │     Apps     │
└──────┬───────┘   └──────┬───────┘
       │  X-API-Key · Bearer JWT · sealed session cookies (web) · X-Server-Key (app login)
       ▼                  ▼
┌──────────────────────────────────────────────────────────┐
│                    POKYH Backend (node)                  │──► WebUntis of each school
│  Express 5 · JWT · rate limits · REST + SSE + Web Push   │    (the person's own session)
│  /webuntis/* · /admin/ (React SPA) · /cluster            │
└──────────┬──────────────────┬───────────────┬────────────┘
           │                  │               │ mutual TLS, pinned certificates
     ┌─────▼─────┐     ┌──────▼─────┐   ┌─────▼────────────────┐
     │ MySQL 8.4 │     │   Redis    │   │ other nodes (opt.)   │
     │  (Prisma) │     │ read cache │   │ same data, no leader │
     └───────────┘     └────────────┘   └──────────────────────┘
```

Design principles:

- **Stateless HTTP.** JWTs carry identity; refresh tokens and everything durable live in MySQL. The
  website's WebUntis session lives in the browser's cookies, sealed with AES-256-GCM.
- **Non-blocking boot.** The HTTP server starts at once; the database is created, brought to the
  schema (`prisma db push`, additive only) and connected in the background with retry and backoff.
- **Configuration only through the environment.** Origins, hosts, ports, limits, sources and
  WebUntis paths: nothing is hard-coded. [`.env.example`](.env.example) documents every setting.
- **Privacy by default.** Request bodies and secrets are never logged, a person's WebUntis data
  (grades, messages, absences) is never cached or stored, and every log and statistic has a finite
  retention.

---

## Getting started

### Prerequisites

- Node.js **22**
- MySQL **8.4** (local, or the bundled Docker service)
- Docker with Compose, for the full stack and the end-to-end tests

### Local development

```bash
npm install
cp .env.example .env         # fill in DATABASE_URL and the secrets (see Configuration)
npx prisma generate
npm run db:push              # apply the schema
npm run dev                  # API on http://localhost:4000, admin panel on /admin/
```

### Full stack in Docker

```bash
cp .env.example .env         # development example only; never commit the result
./scripts/compose-stack.sh up --build -d
```

`scripts/compose-stack.sh` passes one operator-owned environment file to the app and to the MySQL
initialisation with Compose's own `.env` interpolation disabled, so values containing `$` (bcrypt
hashes) arrive unchanged. Use another file with
`BACKEND_ENV_FILE=/secure/path/backend.env ./scripts/compose-stack.sh up --build -d`.

| Service | Role |
| --- | --- |
| `app` | The API and the admin panel (port 4000; cluster channel 4100 when enabled) |
| `mysql` | MySQL 8.4, the source of truth |
| `redis` | Read cache, never a source of truth (internal network only, protected mode off) |
| `db-archiver` | Binary-log archive for point-in-time recovery |

### First start

Open `/admin/`: while no administrator exists at all, a first-run setup creates the administrator
account. Afterwards the panel asks every administrator to set up an authenticator app.

---

## Configuration

Everything is configured through environment variables; required values fail fast at boot.

### Secrets

```bash
openssl rand -hex 32               # JWT_SECRET, REFRESH_TOKEN_SECRET, API_KEY, SERVER_KEY
npx web-push generate-vapid-keys   # VAPID key pair for Web Push
```

### The settings that matter most

| Area | Variables | Purpose |
| --- | --- | --- |
| Core | `PORT` · `NODE_ENV` · `TRUST_PROXY` | Port, mode, and the exact proxy topology in front (rate limits depend on it) |
| Database | `DATABASE_URL` or `DB_*` · `DB_AUTO_PUSH` | MySQL connection; additive schema sync at start |
| Clients | `API_KEY` · `SERVER_KEY` · `CORS_ORIGIN` | Key every client sends; secret server-to-server login key; allowed browser origins |
| Tokens | `JWT_SECRET` · `REFRESH_TOKEN_SECRET` · `JWT_EXPIRES_IN` | Access and refresh tokens |
| Website sign-in | `WEBUNTIS_SESSION_SECRET` · `WEBUNTIS_COOKIE_SECURE` · `RATE_LIMIT_WEB_LOGIN_*` · `RATE_LIMIT_WEB_MESSAGE_*` | Sealing key of the session cookies; HTTPS-only cookies; sign-in limits; messages per account (default 30 per 15 minutes) |
| Schools | `WEBUNTIS_BASE` · `WEBUNTIS_SCHOOL` · `SCHOOLS_AUTO_CREATE` · `SCHOOLS_MAX` · `WEBUNTIS_HOST_SUFFIXES` · `WEBUNTIS_SCHOOL_ALLOWLIST` | Default school, schools joining on their own, allowed WebUntis hosts, optional allow-list |
| WebUntis paths | `WEBUNTIS_API_PATH_*` · `WEBUNTIS_PARENT_ROLE` | Internal WebUntis paths that differ between instances (rarely needed) |
| Admin security | `ADMIN_REQUIRE_SECOND_FACTOR` · `ADMIN_REQUIRE_PASSKEY` · `ADMIN_USERNAMES` | Authenticator app for every admin (default on); default passkey requirement; server owners |
| Read cache | `REDIS_URL` | Optional; without it entries live in process memory |
| Backups | `BACKUP_*` | Schedule, retention, encryption and encrypted off-site copies |
| Push | `VAPID_*` | Web Push key pair and contact address |
| Canteen | `MENSA_IMPORT_URL` | Menu source for the dish import |
| Analytics and retention | `ANALYTICS_TIMEZONE` · `USAGE_ANALYTICS_RETENTION_DAYS` · `ACCOUNT_ACTIVITY_SCHOOL_YEAR` · `REQUEST_LOG_RETENTION_DAYS` · `LOG_FILE_RETENTION_DAYS` | Usage statistics (anonymous, named only with consent) and finite retention |
| School year | rollover settings | Date of the yearly archive and fresh start (default 1 August) |
| Cluster | `CLUSTER_*` · `POKYH_*` | See [docs/cluster.md](docs/cluster.md#cluster-settings) |

> A request with a valid `X-Server-Key` skips the per-address login limiter: every app login is
> proxied through one server address, and a shared bucket would lock everyone out.

---

## WebUntis gateway

The website is a static page. It signs in at `POST /webuntis/login`, where the password passes
through to the school's WebUntis and is never stored or logged. The resulting WebUntis session is
sealed (AES-256-GCM) into httpOnly, `Secure`, `SameSite=Strict` cookies on the API's address:

| Cookie | Holds | Lifetime |
| --- | --- | --- |
| `pokyh_session` | The WebUntis session | 4 hours |
| `pokyh_renew` | The sealed sign-in for automatic renewal, sent only to the sign-in path | 4 hours |
| `pokyh_api_refresh` | The POKYH refresh token | 30 days |

**Reads** (`GET`) are authenticated by the session cookie alone, so pictures and documents load
straight into the page. **Writes** need `X-API-Key` as well, which no browser sends to another site
without a CORS preflight against `CORS_ORIGIN`. Answers are `Cache-Control: private, no-store`, and
errors are clean, readable German without internals.

| Area | Routes |
| --- | --- |
| Sign-in and account | `POST /login` · `POST /password-reset` · `GET /schools` (public school search) · `GET /permissions` · `GET /profile-image` · `POST /password` |
| Timetable and school | `GET /timetable` · `/lesson-detail` · `/homework` · `/exams` · `/classregevents` · `/classservices` |
| Grades | `GET /grades` |
| Absences | `GET /absences` · `/absence-reasons` · `/absences/meta` · `POST /absences/create` · `/absences/delete` · `/absences/excuse` · `GET /absences/excuses` · `/absences/excuse-letter` (PDF) |
| Messages | `GET/POST /messages` · `GET /messages/recipients` · `GET/DELETE /messages/draft` · `POST /messages/send` · `GET/POST /messages/reply` · `GET /attachment` |

### Excusing absences

WebUntis lets students of age and guardians report an absence ahead
(`/absences/create`), but refuses to add a reason to one that is already over. For those,
`POST /absences/excuse` writes to the class teachers instead:

1. The absences are read from WebUntis by their ids (never taken from the request) and only those
   not yet excused are named. The account must have WebUntis' own permission to report absences.
2. The reason is checked against WebUntis' list, the class teachers are taken from the
   `CLASS_TEACHERS` recipients, and each gets one MessageCenter message (the `TEACHER` option takes
   one recipient per message), written in the reader's language (de, it, en) with the day, times,
   reason and note ([`src/webuntis/excuseMessage.ts`](src/webuntis/excuseMessage.ts)).
3. The subject names the absence in a fixed form. `GET /absences/excuses` finds the sent excuses
   again in the account's **Sent** folder, so the website can show *Message sent* until the school
   marks the absence excused. Nothing about it is stored on the server.
4. If WebUntis lets the account write to no teacher (a guardian, for example), the reason and note
   are saved on the absence through WebUntis' own excuse instead, where the school allows it.

Partial delivery is reported (`sentTo` / `failed`); every refusal carries a `code`
(`not_allowed`, `not_found`, `already_excused`, `invalid_reason`, `no_class_teacher`,
`messages_forbidden`, `send_failed`) for a message in the reader's language.

---

## Authentication and security

**Clients**

1. **API key**: every non-admin route requires `X-API-Key`.
2. **App login**: `POST /auth/login` with `X-Server-Key` after the app's own WebUntis login yields a
   short-lived **JWT access token** and a long-lived, hashed **refresh token**. The class comes from
   WebUntis through the app's session (`untisSessionId`), never from the app ([docs/class-assignment.md](docs/class-assignment.md)).
3. **Website**: `/webuntis/login` (see above); the POKYH tokens are renewed at `/auth/web/refresh`
   with the httpOnly refresh cookie. POKYH-only accounts use `/auth/web/local-login`.

**Administrators**

- Password stored as a bcrypt hash; every admin also needs an **authenticator app** (TOTP, with
  recovery codes). Only the server can switch that off (`ADMIN_REQUIRE_SECOND_FACTOR`).
- **Passkeys** are optional and can be made required per admin; `ADMIN_REQUIRE_PASSKEY` sets the
  default. Last sign-in and second-factor status are shown in the panel.
- Rights are granted **per school or globally**, deny by default, from presets or individually; no
  admin can grant more than they hold. Every change lands in the audit log.

**Hardening**

`helmet` headers; allow-list CORS; tiered rate limits (global, login, refresh, read, write, SSE,
admin login) and a per-account limit on messages to teachers, so nobody can flood a school's
teachers through POKYH; refresh tokens stored hashed (SHA-256); force-revoked sessions persisted, so a
restart does not re-admit them and every cluster node enforces them; `timingSafeEqual` for every
key comparison; SSRF-safe WebUntis access limited to `WEBUNTIS_HOST_SUFFIXES`; structured JSON
logs with a redaction formatter; error reports of the clients scrubbed before storage.

---

## API overview

All times are ISO-8601 UTC. Mount points:

| Group | Mount | Notes |
| --- | --- | --- |
| Auth | `/auth/login` · `/refresh` · `/logout` · `/me` · `/register` | App login and token life cycle |
| Website sign-in | `/auth/web/local-login` · `/register` · `/refresh` · `/logout` | POKYH-only accounts and the website's tokens |
| WebUntis (website) | `/webuntis/*` | See [WebUntis gateway](#webuntis-gateway) |
| Users | `/users/:username` · `/users/me/bell` | Profile; seen and cleared notifications of the bell |
| To-dos | `/users/:username/todos` | Per user, CRUD + SSE |
| Classes | `/classes` · `/classes/mine` · `/classes/:id` | The class WebUntis confirms for a student ([docs/class-assignment.md](docs/class-assignment.md)) |
| Reminders | `/classes/:classId/reminders` (+ `/comments`) | Class-wide, CRUD + SSE |
| Dishes | `/dishes` | Public, read-only menu per school |
| Dish ratings and comments | `/dish-ratings` · `/dish-comments/:dishId` | Stars and comments + SSE |
| Subject images | `/subject-images` | Icon catalogue (read public, write admin) |
| Popups | `/popups/active?platform=web\|android&audience=user\|guest` | Active announcements, targeted ones only to their users |
| Push | `/push` | Web Push subscription |
| Usage and privacy | `/usage/ping` · `/privacy` | Usage statistics; privacy notice record and consent |
| Client errors | `/client-errors` | Validated, scrubbed error reports of the web app and the apps |
| Activity log | `/activity-log` | Frontend telemetry |
| Admin | `/api/admin/*` | Administrator JWT only |
| Cluster | `/api/admin/cluster/*` · `/cluster/v1/*` · `/setup` | Cluster admin, node-to-node channel, one-line installer (404 unless an install is open) |
| First-run setup | `/api/setup` | Only while no administrator exists |
| Health | `/health` · `/readyz` | Liveness; database-aware readiness |

---

## Realtime (SSE) and push

Live updates arrive as **Server-Sent Events** under `/sse/*`: to-dos, reminders and their comments,
dish ratings and comments. `EventSource` cannot set headers, so these endpoints accept the token
and API key as query parameters; heartbeats every `SSE_HEARTBEAT_MS`. In a cluster a client
connected to one node also receives changes made through another.

**Web Push** (VAPID) delivers due reminders and to-dos and new WebUntis messages. For the messages,
a subscription keeps the WebUntis session id and token it was registered with, so the poller can
check the inbox; `DELETE /push/unsubscribe` removes them. Without VAPID keys the push poller does
nothing.

---

## Background jobs

Started once the database is reachable:

| Job | What it does |
| --- | --- |
| Session cleanup | Prunes expired and revoked refresh tokens |
| Archiver | Moves to-dos and reminders overdue by `ARCHIVE_AFTER_HOURS` into an archive |
| Push poller | Sends due notifications and checks for new messages |
| School-year rollover | On the configured date snapshots users, classes, to-dos and reminders into the school-year archive and starts the year fresh (idempotent) |
| Backups | Scheduled, checksummed and optionally encrypted database backups with off-site copies |
| Retention | Deletes request logs, log files, usage links and bell marks after their retention |

In a [cluster](docs/cluster.md) per-item work is spread over the reachable nodes; work that must
happen exactly once (archiving, rollover) runs on one node and only while every node is reachable.
Backups and log clean-up stay per node.

---

## Data

### Database

Prisma is the schema's single source ([`prisma/schema.prisma`](prisma/schema.prisma)):

| Area | Models |
| --- | --- |
| Identity | `User`, `RefreshToken`, `ApiKey`, `TokenRevocation` |
| Administration | `Admin`, `AdminTotp`, `AdminPasskey`, `AdminSecurity`, `AdminGrant`, `AdminPreset`, `AdminAuditEvent` |
| Schools and classes | `School`, `Class`, `ClassMember` (students only; guardians are never assigned) |
| Content | `Todo`, `Reminder`, `Comment`, `DishComment`, `Popup`, `PopupTargetUser`, `PopupTargetClass`, `BellMark`, `PushSubscription` |
| Canteen | `Dish`, `DishImage`, `DishRating`, `MensaMenu`, `MensaMenuSchool` |
| Subjects | `KnownSubject`, `SubjectImage` |
| School-year archive | `SchoolYear`, `ArchivedUser`, `ArchivedClass`, `ArchivedTodo`, `ArchivedReminder`, `ArchivedActivity` |
| Privacy and usage | `PrivacyConsent`, `UsageSession`, `UsageDaySalt`, `UsageClassDay`, `UsageSchoolClassDay`, `WebVisit`, `RequestAccountDay` |
| Telemetry | `RequestLog`, `FrontendActivityLog`, `ClientErrorLog` (node-local) |
| Operations | `BackupConfig`, `AppMigration` |
| Cluster | `ClusterNode`, `ClusterPeer`, `ClusterInstall`, `ClusterRowState`, `ClusterDeferred`, `Relay`, `UpdateSettings` |

```bash
npm run db:push      # apply the schema (idempotent, additive)
npm run db:studio    # Prisma Studio
npm run db:migrate   # create a development migration
npm run db:reset     # drop and recreate: destroys all data
```

With `DB_AUTO_PUSH=true` the server applies additive schema changes at every start. That is a
deployment convenience, not a reviewed migration: take and test a backup before a production schema
change.

### Read cache

What the API reads often and changes rarely (menus, popups, to-dos, reminders and their comments,
dish ratings and comments, subject images, the WebUntis school search) is kept in Redis
([`src/services/cache.ts`](src/services/cache.ts)). Every entry is stored under the versions of the
tables it was built from, and any write to one of them raises the version, so an outdated answer is
never served: writes through Prisma, raw SQL, changes replicated from other nodes and restores.
MySQL stays the only source of truth; without Redis the entries live in process memory. WebUntis
data of a person is never cached.

### Backups and recovery

The layers (cluster, checksummed backups, start-up rebuild of a lost database, point-in-time
recovery through `db-archiver`, encrypted off-site copies) and what an operator does in each case
are described in [`docs/database.md`](docs/database.md). Encrypted backups are opened with
`npm run decrypt-backup`.

---

## Admin panel

A React + Vite single-page app built into the image and served at **`/admin/`** (same origin,
JWT-protected): dashboard, analytics, users, classes, sessions, dishes and images, comments, to-dos
and reminders, popups, school years, requests, frontend and backend logs, audit, admins and rights,
schools, privacy overview, API keys, backups and the cluster. Press `/` to search the
panel.

**Popups** are announcements in the apps and on the website, with a live preview: for all
platforms or one, for signed-in users, guests or both, once or several times in a period, and
optionally only for chosen classes and users. A targeted popup is filtered on the server from the
caller's own session and is never sent to anyone else.

```bash
npm run admin:dev      # the panel in development (Vite, proxies /api to localhost:4000)
npm run admin:build    # build into admin/dist (also part of the Docker build)
```

---

## Schools

A school joins on the first WebUntis sign-in of one of its accounts and is never created by hand
(`SCHOOLS_AUTO_CREATE`, capped by `SCHOOLS_MAX`). Each school's data is kept apart by id, admins
hold rights per school or globally, and the panel switches between the global view and one school.
Canteen plans are assigned to schools; a school without one shows no canteen.
`WEBUNTIS_SCHOOL_ALLOWLIST` optionally limits sign-in to approved schools. Details:
[`docs/multi-school.md`](docs/multi-school.md).

---

## Cluster

Several nodes, each with its own MySQL database, can hold the same data with **no leader**: every
node accepts reads and writes, changes reach the others within about a second, a node that was
offline catches up by itself, and nodes check each other regularly. Nodes are added with a
**one-line installer** or an invite code, talk over **mutual TLS with pinned certificates** (direct,
through your proxy, or through a relay for nodes behind NAT) and **update themselves one by one
without downtime** (blue/green). A single node needs none of it; the feature is dormant until the
first link.

Everything about it is in **[docs/cluster.md](docs/cluster.md)**.

---

## Deployment

The multi-stage [`Dockerfile`](Dockerfile) builds the API and the admin panel, records the commit
the image was built from (`dist/build-info.json`) and runs the server as an unprivileged user. On
start the server brings up its database by itself.

```bash
./scripts/compose-stack.sh up --build -d
```

- The Compose stack waits for MySQL and Redis to be healthy; the container's health check calls
  `/readyz`.
- Publish the API through your own TLS reverse proxy or load balancer and set `TRUST_PROXY` to
  match it.
- Logs go to stdout as structured JSON (`docker compose logs -f app`, bounded by the local log
  driver) and to rotating files bounded by `LOG_FILE_RETENTION_DAYS`.
- The website's origin must be in `CORS_ORIGIN` and on the same site as the API
  (`pokyh.com` and `api.pokyh.com`), or the browser does not send the session cookies.

One Compose stack is one host, as durable as its storage. Against losing it, add a second node at
another location and set up the encrypted off-site backups ([`docs/database.md`](docs/database.md)).
Servers set up with the one-line installer run their own stack
([`deploy/node`](deploy/node)) with blue/green updates.

---

## Testing

```bash
npm test                # unit tests: pure modules, crypto, permissions, WebUntis helpers, excuse
                        # messages, installer, edge, updater policy, rollout, scope, ...
npm run test:admin      # schools, permissions and the admin API against a real MySQL (Docker)
npm run test:cluster    # multi-node end-to-end tests (Docker; never touches your .env or database)
npm run test:updater    # the updater's blue/green switch against real Docker with Caddy
npm run bench           # endpoint timings and SQL per request on a seeded month of data (Docker)
```

[`tests/admin/access.e2e.mjs`](tests/admin/access.e2e.mjs) covers schools joining on their first
sign-in, isolation between schools by id, header and body, deny-by-default permissions, no
self-elevation, immediate revocation, user filters across pages, request logs apart from the panel's
own traffic, menus and comments per school, scrubbed error reports, the audit trail and the one-time
migration of existing admins. The cluster and updater suites are described in
[docs/cluster.md](docs/cluster.md#testing).

---

## Operations

| Command | What it does |
| --- | --- |
| `npm run make-admin <username>` | Grant admin rights |
| `npm run revoke-admin <username>` | Revoke admin rights |
| `npm run set-admin-password` | Set or replace an admin password (bcrypt) |
| `npm run reset-admin-2fa` | Reset an admin's authenticator app |
| `npm run create-user` | Create a local (non-WebUntis) user |
| `npm run decrypt-backup` | Decrypt an encrypted backup |

More commands, including test data, MySQL and the cluster, are in [`COMMANDS.md`](COMMANDS.md).

---

## Project layout

```
src/
├── index.ts            bootstrap, middleware, CORS, database start-up, background jobs
├── config.ts           every environment setting (fail-fast on required secrets)
├── routes/             auth, webuntis, users, to-dos, classes, reminders, dishes, popups, admin, ...
├── webuntis/           WebUntis client, sessions and sealing, schools, app data, absences, messages
├── security/           admin login, second factor, permissions, API key policy, error scrubbing
├── services/           SSE, push, archiver, school year, backups, cache, analytics, ...
├── middleware/         API key, JWT auth, rate limits, admin, request id and logging
├── cluster/            pairing, channel (mTLS), replication, ways, relays, installer, updates
└── utils/              cache, errors, logger, ids, revoked tokens, ...
prisma/schema.prisma    database schema (source of truth)
admin/                  React + Vite admin panel (built into admin/dist)
deploy/db/              binary-log archiver and point-in-time restore
deploy/node/            one-line installer, node stack, edge forwarder, updater
deploy/relay/           relay and its installer
scripts/                admin and user CLIs, test data, build info, Compose wrapper
tests/                  unit tests, admin and cluster end-to-end tests, updater test, benchmark
docs/                   cluster, database, schools
```

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Logins fail with **429** at scale | `TRUST_PROXY` unset, so all clients share one address. Set it to your proxy topology; server-to-server logins must send `X-Server-Key`. |
| Browser CORS error | Add the frontend's origin to `CORS_ORIGIN`. |
| Website: every request says `session_expired` | The browser did not send the API's cookies: the website must be on the same site as the API and listed in `CORS_ORIGIN`. |
| `/auth/me` returns **401** right after login | The client received no token: check the server-to-server login and `X-Server-Key` / `X-API-Key`. |
| Log: *Redis cache unavailable; using process memory* | The API keeps working without the cache. Check that Redis runs and `REDIS_URL` points to it. A Redis of your own that answers `DENIED ... protected mode` refuses every client without a password: give it one (in `REDIS_URL` too) or, on an internal network, turn protected mode off as the bundled stacks do. |
| Prisma "property does not exist" | Run `npx prisma generate` after schema changes. |
| Database unreachable at boot | Not fatal; the server retries. Check `DATABASE_URL` and MySQL's health. |
| Docker build fails at `prisma generate` | The build downloads Prisma engines and needs internet access. |
| Excuse refused with `no_class_teacher` | The class has no class teacher in WebUntis; the school sets it there. |
| Dish import says the address is missing | Set `MENSA_IMPORT_URL` or enter the menu's address in the import dialog. |
| Cluster problems (`/setup` 404, join hangs, peer on hold, updates waiting) | See the troubleshooting notes in [docs/cluster.md](docs/cluster.md). |

---

## Further documentation

| Document | Contents |
| --- | --- |
| [`docs/cluster.md`](docs/cluster.md) | Cluster: nodes, ways, relays, replication, updates, security model, settings, tests |
| [`docs/database.md`](docs/database.md) | Database layers, failure handling, backups and recovery, MySQL upgrades |
| [`docs/multi-school.md`](docs/multi-school.md) | Schools, data isolation, admin permissions, what the clients send |
| [`COMMANDS.md`](COMMANDS.md) | Command reference |
| [`.env.example`](.env.example) | Every setting, with explanations |

---

## License

[MIT](LICENSE). WebUntis and Untis are trademarks of Untis GmbH; POKYH is not affiliated with it.

<div align="center">

**POKYH** · [Web frontend](../pokyh-frontend) · Backend (this repository) · iOS and Android apps

</div>
