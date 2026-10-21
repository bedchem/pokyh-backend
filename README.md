<div align="center">

# POKYH — Backend

**The API, realtime layer and admin panel behind POKYH, the school companion app.**

Node.js 22 · Express 5 · TypeScript · Prisma · MySQL 8.4 · Redis · Server-Sent Events · Web Push · Docker

[Quick start](#quick-start) · [Configuration](#configuration) · [API](#api-overview) · [Admin panel](#admin-panel) · [Cluster](#cluster) · [Testing](#testing)

</div>

---

## Table of contents

- [What this is](#what-this-is)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Database](#database)
- [Authentication & security](#authentication--security)
- [API overview](#api-overview)
- [Realtime (SSE)](#realtime-sse)
- [Background jobs](#background-jobs)
- [Admin panel](#admin-panel)
- [Pokyh Learn](#pokyh-learn)
- [Deployment](#deployment)
- [Cluster](#cluster)
  - [Concepts](#concepts)
  - [Adding a server with one command](#adding-a-server-with-one-command)
  - [Adding a node with an invite code](#adding-a-node-with-an-invite-code)
  - [How the nodes reach each other](#how-the-nodes-reach-each-other)
  - [What is exchanged — Pokyh Learn in or out](#what-is-exchanged--pokyh-learn-in-or-out)
  - [Updates without downtime, node by node](#updates-without-downtime-node-by-node)
  - [Security model](#security-model)
  - [Consistency and failure handling](#consistency-and-failure-handling)
  - [Cluster settings](#cluster-settings)
- [Testing](#testing)
- [Operations & maintenance](#operations--maintenance)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)

---

## What this is

POKYH adds a social and organisational layer on top of [WebUntis](https://www.untis.at/): shared
class reminders, personal to-dos, the cafeteria menu with ratings and comments, announcement
popups, push notifications — and, additively, the separate learning product **Pokyh Learn**.
This backend is the **single source of truth** for everything that is *not* WebUntis data.

The **website** is a static page and talks to this API directly: it signs in at `/webuntis/login`,
where the password passes through to the school's WebUntis and is never stored or logged, and
reads its WebUntis data through `/webuntis/*` with the person's own WebUntis session. That
session lives sealed (AES-GCM) in httpOnly cookies on the API's address, never on the server.
The **apps** authenticate against WebUntis themselves and then perform a trusted
**server-to-server** login here (guarded by a shared `SERVER_KEY`). Parents and guardians receive
no POKYH class identity or membership.

The backend also serves a built-in **React admin panel** at `/admin/`, and can run as a
**leaderless cluster** of several nodes that hold the same data.

---

## Architecture

```
┌──────────────┐   ┌──────────────┐   ┌──────────────────┐
│ Web (static) │   │     App      │   │  Learn web app   │
└──────┬───────┘   └──────┬───────┘   └────────┬─────────┘
       │  X-API-Key · Bearer <JWT> · session cookies (web) · X-Server-Key (app login)
       ▼                  ▼                    ▼
┌─────────────────────────────────────────────────────────┐
│                    POKYH Backend (node)                  │──► WebUntis (per school,
│  Express 5 · JWT · rate limits · REST + SSE + Web Push   │    the person's own session)
│  /webuntis/* · /admin/ (React SPA) · /learn/* · /cluster │
└──────────┬──────────────────┬───────────────┬────────────┘
           │                  │               │ mutual TLS, pinned certificates
     ┌─────▼─────┐     ┌──────▼─────┐   ┌─────▼───────────────┐
     │ MySQL 8.4 │     │   Redis    │   │ other nodes (opt.)  │
     │  (Prisma) │     │ read cache │   │ same data, no leader│
     └───────────┘     └────────────┘   └─────────────────────┘
```

- **Stateless HTTP** — JWTs carry identity; refresh tokens, sessions and everything durable live
  in MySQL.
- **Non-blocking boot** — the HTTP server starts at once; the database is created, brought to the
  schema (`prisma db push`, additive only) and connected in the background with retry and backoff.
- **Configuration only through the environment** — origins, hosts, ports, limits, sources: nothing
  is hard-coded. [`.env.example`](.env.example) lists every setting with an explanation.

---

## Quick start

### Prerequisites

- Node.js ≥ 22
- MySQL 8.4 (local, or the bundled Docker service)

### Local development

```bash
npm install                 # backend dependencies
cp .env.example .env        # then fill in DATABASE_URL and the secrets (see Configuration)
npx prisma generate
npm run db:push             # apply the schema
npm run dev                 # API on http://localhost:4000, admin panel on /admin/
```

On first start, open `/admin/` to create the administrator account (the first-run setup is
reachable only while no administrator exists at all).

### Everything in Docker

```bash
cp .env.example .env        # development example only — never commit the result
./scripts/compose-stack.sh up --build -d
```

`scripts/compose-stack.sh` passes one operator-owned environment file to the app and to the MySQL
initialisation, with Compose's own `.env` interpolation disabled, so values containing `$` (bcrypt
hashes) arrive unchanged. MySQL receives only its root password and database name. Redis is
internal and non-persistent: the API's read cache and the Learn analytics cache, never a source
of truth (see [Read cache](#read-cache)). Use another file with
`BACKEND_ENV_FILE=/secure/path/backend.env ./scripts/compose-stack.sh up --build -d`.

---

## Configuration

Everything is configured through environment variables; required values fail fast at boot.
[`.env.example`](.env.example) is the complete, commented reference.

### Secrets

```bash
openssl rand -hex 32               # JWT_SECRET, REFRESH_TOKEN_SECRET, API_KEY, SERVER_KEY
npx web-push generate-vapid-keys   # VAPID key pair for Web Push
```

### The settings that matter most

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | MySQL connection string; built from the `DB_*` fields when blank. |
| `JWT_SECRET` · `REFRESH_TOKEN_SECRET` | Sign access tokens; refresh-token handling. |
| `API_KEY` | Key every client sends as `X-API-Key`. |
| `SERVER_KEY` | **Secret.** Trusted server-to-server login key (`X-Server-Key`); only the web and app servers hold it. |
| `CORS_ORIGIN` | Allowed browser origins (comma separated). The matching `www`/apex host is accepted too. |
| `TRUST_PROXY` | `false` for direct exposure; the exact proxy topology when one is in front (e.g. `loopback`). |
| `PUBLIC_BASE_URL` | Absolute base for self-hosted asset links; empty = relative links. |
| `MENSA_IMPORT_URL` | Menu source (`mensa.json`) for the dish import; empty = enter it in the import dialog. |
| `VAPID_*` | Web Push key pair and contact address. |
| `LEARN_*` | Pokyh Learn: allowed origins, legal activation gate, dictionary adapter, AI trainer, imports, review, analytics cache — see [Pokyh Learn](#pokyh-learn). |
| `ANALYTICS_TIMEZONE` · `USAGE_ANALYTICS_RETENTION_DAYS` | Day/hour grouping of the usage statistics behind the admin Analytics page, and how long a visit stays linked to an account that opted in (30–365 days, default 90). Without consent, and afterwards, visits are anonymous aggregates. |
| `ACCOUNT_ACTIVITY_SCHOOL_YEAR` | `true` (default): an account's active days, device kinds and sign-ins per day (`request_account_days`) and, with consent, the link of its visits to it are kept for the running school year instead of 30 days / `USAGE_ANALYTICS_RETENTION_DAYS`; the school-year rollover archives each account's year (`archived_activity`, shown under Schuljahre) and the rows are deleted. `false`: the shorter periods apply. |
| `REQUEST_LOG_RETENTION_DAYS` · `LOG_FILE_RETENTION_DAYS` | Finite retention of request logs and log files. |
| `CLUSTER_*` · `POKYH_*` | The cluster — see [Cluster settings](#cluster-settings). |

> A request carrying a valid `X-Server-Key` skips the per-IP login limiter: every user's login is
> proxied through the frontend server's address, and a shared bucket would lock everyone out.

---

## Database

Prisma is the schema's single source ([`prisma/schema.prisma`](prisma/schema.prisma)).

- **Identity** — `User`, `Admin`, `RefreshToken`, `ApiKey`, `TokenRevocation`
- **Classes** — `Class`, `ClassMember` (students only; parents are never assigned)
- **Content** — `Todo`, `Reminder`, `Comment`, `DishComment`, `Popup` (+ `PopupTargetUser`, `PopupTargetClass`)
- **Cafeteria** — `Dish`, `DishImage`, `DishRating`
- **Subjects** — `KnownSubject`, `SubjectImage`
- **School-year archive** — `SchoolYear`, `ArchivedUser`, `ArchivedClass`, `ArchivedTodo`, `ArchivedReminder`
- **Privacy & usage** — `PrivacyConsent`, `UsageSession` (usage statistics: anonymous day keys, named only with consent), `UsageDaySalt`
- **Pokyh Learn** — every `Learn*` model (tables `learn_*`)
- **Cluster** — `cluster_*` bookkeeping (node-local), replicated `relays` and `update_settings`
- **Telemetry** — `RequestLog`, `FrontendActivityLog` (node-local)

```bash
npm run db:push      # apply the schema (idempotent, additive)
npm run db:studio    # Prisma Studio
npm run db:migrate   # create a development migration
npm run db:reset     # ⚠ drop and recreate — destroys all data
```

With `DB_AUTO_PUSH=true` the server applies additive schema changes at every start. That is a
deployment convenience, not a reviewed migration: before a production schema change, take and test
a backup.

**Failure handling and recovery** — [`docs/database.md`](docs/database.md): the layers (cluster,
checksummed backups, point-in-time recovery through the `db-archiver` service, encrypted off-site
copies), the start-up rebuild of a lost database, and the MySQL 8.4 upgrade with its way back.

### Read cache

What the API reads often and changes rarely — menus, popups, to-dos, reminders and their
comments, dish ratings and comments, subject images, the WebUntis school search — is kept in
Redis (`services/cache.ts`). Every entry is stored under the versions of the tables it was built
from; any write to one of them raises the version, so an outdated answer is never served:
writes through Prisma anywhere in the process, raw SQL (the tables are read from the statement),
changes replicated from other nodes and restores. MySQL stays the only source of truth; without
Redis the entries live in process memory. WebUntis data of a person is never cached.

---

## Authentication & security

1. **API key** — every non-admin route requires `X-API-Key`.
2. **User session** — a trusted WebUntis login (`POST /auth/login` with `X-Server-Key`) yields a
   short-lived **JWT access token** and a long-lived, hashed **refresh token**; user requests send
   `Authorization: Bearer <JWT>`.
3. **Administrators** — admin routes (`/api/admin/*`) require an administrator JWT; the admin
   password is stored as a bcrypt hash.

Hardening: `helmet` headers; allow-list CORS (`CORS_ORIGIN`, `LEARN_ALLOWED_ORIGINS`); tiered rate
limits (global, login, refresh, read, write, SSE, admin login); refresh tokens stored hashed
(SHA-256), one active session per user; force-revoked sessions persisted in `token_revocations`
(a restart does not re-admit a revoked token, and in a cluster every node enforces it);
`timingSafeEqual` for every key comparison; structured logs with a redaction formatter — request
bodies and secrets are never logged.

---

## API overview

> Base URL: the HTTPS origin your infrastructure serves the API under. All times are ISO-8601 UTC.

| Group | Mount | Notes |
| --- | --- | --- |
| Auth | `/auth/login` · `/refresh` · `/logout` · `/me` · `/register` | Server-to-server login and token life cycle |
| Website sign-in | `/auth/web/local-login` · `/register` · `/refresh` · `/logout` | POKYH-only accounts and the token life cycle of the website; refresh token in an httpOnly cookie |
| WebUntis (website) | `/webuntis/login` · `/schools` · `/password-reset` · `/timetable` · `/grades` · `/absences/*` · `/messages/*` · `/attachment` · `/profile-image` · `/permissions` · `/password` · … | The person's WebUntis through their sealed session cookie; reads by cookie, writes also need `X-API-Key` |
| Users | `/users/:username` | Profile lookup |
| To-dos | `/users/:username/todos` | Per user, CRUD + SSE |
| Classes | `/classes` · `/classes/mine` · `/classes/:id` | Joined/created by WebUntis class |
| Reminders | `/classes/:classId/reminders` (+ `/comments`) | Class-wide, CRUD + SSE |
| Dishes | `/dishes` | **Public**, read-only menu |
| Dish ratings / comments | `/dish-ratings` · `/dish-comments/:dishId` | Stars and comments + SSE |
| Subject images | `/subject-images` | Icon catalogue (read public, write admin) |
| Popups | `/popups/active?platform=web\|android&audience=user\|guest` | Active announcement popups; popups meant for chosen users or classes only with a matching user session |
| Push | `/push` | Web Push subscription |
| Usage & privacy | `/usage/ping` · `/privacy` | Usage statistics (anonymous, named only with consent); privacy notice record and consent |
| Activity log | `/activity-log` | Frontend telemetry |
| Learn | `/learn/*` · `/learn/ai/*` · `/auth/learn-login` | Pokyh Learn (own origins and gates) |
| Admin | `/api/admin/*` | Administrator JWT only (no API key) |
| Cluster admin | `/api/admin/cluster/*` | Invites, one-line installs, peers, ways, relays, scope, updates, certificate |
| Cluster channel | `/cluster/v1/*` | Node-to-node only: sealed frames, own authentication |
| Node setup | `/setup` · `/setup/provision` · `/setup/bundle` | One-line installer; **404 unless an install command is open** |
| First-run setup | `/api/setup` | Only while no administrator exists at all, never on a cluster node |
| Health | `/health` · `/readyz` | Liveness; database-aware readiness |

---

## Realtime (SSE)

Live updates arrive as **Server-Sent Events** under `/sse/*` (to-dos, reminders and their
comments, dish ratings and comments). `EventSource` cannot set headers, so these endpoints accept
the token and API key as query parameters; heartbeats every `SSE_HEARTBEAT_MS`. In a cluster a
client connected to one node also receives changes made through another.

---

## Background jobs

Started once the database is reachable:

- **Session cleanup** — prunes expired and revoked refresh tokens.
- **Archiver** — moves to-dos and reminders overdue by `ARCHIVE_AFTER_HOURS` into an archive.
- **Push poller** — sends due reminder notifications (no-op without VAPID keys).
- **School-year rollover** — on the configured date (default 1 August) snapshots users, classes,
  to-dos and reminders into the school-year archive and starts the new year fresh. Idempotent.

In a [cluster](#cluster) per-item work (notifications, polling) is spread over the reachable
nodes; work that must happen exactly once (archiving, rollover) runs on one node and only while
every node is reachable. Backups and log clean-up stay per node.

---

## Admin panel

A React + Vite single-page app built into the image and served at **`/admin/`** (same origin,
JWT-protected): dashboard, analytics, users, classes, sessions, dishes and images, comments,
to-dos and reminders, popups, school years, requests, frontend and backend logs, audit, admins and
permissions, schools, privacy overview, API keys, backups, Pokyh Learn and the cluster.
Every cluster setting carries an **ⓘ** that explains in plain words what it does.

**Schools and permissions** — any school on WebUntis can use Pokyh: a school joins on the first
WebUntis sign-in of one of its accounts and is never created by hand. Each school's data is kept
apart, admins hold rights per school or globally, and the panel switches between the global view
and one school (top left). Mensa plans are assigned to schools; a school without one shows no
Mensa. See [`docs/multi-school.md`](docs/multi-school.md).

**Popups** — announcements shown in the app and on the website, with a live preview. Each popup
can be shown on all platforms or one, to signed-in users, guests or both, once or several times in
a period — and **to chosen people only**: any number of classes (WebUntis classes, the class a
student signs in with) and/or single users, searched by name. A targeted popup is filtered on the
server from the caller's own session; it is never sent to a request without a valid session of a
chosen user, and never to guests.

```bash
npm run admin:dev      # the admin panel in development (Vite)
npm run admin:build    # build into admin/dist (also part of the Docker build)
```

---

## Pokyh Learn

The additive `/learn` router serves the separate Pokyh Learn product; it changes no existing Pokyh
route or data. The admin panel's **Learn** area manages Learn policy and groups separately from
school records.

- Learn accepts only accounts whose login was confirmed against WebUntis. In production the Learn
  sign-in stays closed until the operator configures a non-secret authorisation reference and a
  versioned HTTPS privacy notice (`LEARN_LEGAL_*`).
- Course content, access grants, team membership, quiz grading, review state, progress and imports
  are MySQL-backed server decisions. Personal export/import covers only the caller's own content.
- An optional dictionary adapter (`LEARN_DICTIONARY_*`) only suggests; it never decides an answer.
- The optional, self-hosted, CPU-only AI vocabulary trainer (Ollama) is off until
  `LEARN_AI_ENABLED=true` and then usable only with a person or team grant
  (`npm run grant-ai-access <username>`, `npm run grant-ai-access-team <team>`). It runs on an
  internal network without a host port; size `OLLAMA_MEM_LIMIT`/`OLLAMA_CPUS` to the host.
- The optional Redis cache holds only already-authorised, course-specific analytics — no answers,
  credentials, permissions or durable state — and falls back to MySQL.

In a cluster, whether Learn data is shared between the nodes is a switch:
[What is exchanged](#what-is-exchanged--pokyh-learn-in-or-out).

---

## Deployment

The multi-stage [`Dockerfile`](Dockerfile) builds the API and the admin panel, records the commit
the image was built from (`dist/build-info.json`), and runs the server as an unprivileged user. On
start the server brings up its database by itself.

```bash
./scripts/compose-stack.sh up --build -d
```

The bundled Compose stack waits for MySQL and Redis to be healthy; the container's healthcheck
calls `/readyz`. Publish the API through your own TLS reverse proxy or load balancer. Logs go to
stdout as structured JSON (`docker compose logs -f app`, bounded by the local log driver) and to
rotating files bounded by `LOG_FILE_RETENTION_DAYS`.

One Compose stack is one host: its volumes are as durable as that host's storage. Against losing
it, add a second node at another location ([Cluster](#cluster)) and set up the encrypted off-site
copies of the backups; the `db-archiver` service adds point-in-time recovery. See
[`docs/database.md`](docs/database.md).

To run several nodes, see [Cluster](#cluster); servers set up with the one-line installer run their
own stack ([`deploy/node`](deploy/node)) with blue/green updates.

---

## Cluster

### Concepts

Several backend nodes — each with its **own** MySQL database — hold the same data. There is **no
leader**: every node accepts reads and writes, a change made on any node reaches the others within
about a second, a node that was offline catches up by itself, and every node checks the others
regularly. One node works on its own exactly as before; more nodes make it fail-safe and can be
added at any time, also several at once. The feature is dormant until the first link: a standalone
server installs no trigger.

The admin panel's **Cluster** page shows every node, the ways they reach each other, the relays,
what is exchanged, updates and the latest events.

### Adding a server with one command

A fresh Debian 12+ or Ubuntu 22.04+ server becomes a complete node — Docker, database,
configuration, hardening, joining — with a single command. Any node can add servers.

1. On a node with the mutually authenticated channel, open the admin panel under its public
   **https** address → **Cluster** → **Server per Einzeiler hinzufügen**. Enter a name and,
   optionally, the new server's address — empty (its public IP is detected when it sets itself
   up), a domain, or an IP. Choose its **web access**:

   | Web access | The new server … | Open ports |
   | --- | --- | --- |
   | **None** (default) | has no web address of its own; clients keep using your existing ones | cluster port |
   | **Own domain** | serves its domain with HTTPS itself (Caddy, Let's Encrypt) | cluster port, 80, 443 |
   | **Behind your proxy** | publishes the API on a port of your choice for your own reverse proxy, which does TLS and spreads requests over the nodes | cluster port, API port — only from your proxy's addresses |

   The cluster port, the API port, the addresses to listen on (e.g. only the WireGuard interface)
   and the addresses allowed to connect (`10.8.0.0/24`, your proxy's IP …) are all chosen in the
   dialog; the defaults are those of the inviting node.
2. Run the command it shows on the new server, as root or a user with sudo:

   ```bash
   curl -fsSL --proto '=https' -o pokyh.sh 'https://api.example.org/setup' \
     && echo '<sha256>  pokyh.sh' | sha256sum -c - && sh pokyh.sh 'pokyhnode1.…'
   ```

`/setup` exists only while an install command is open (at most `CLUSTER_INSTALL_TTL_MINUTES`, 30 by
default); at any other time it answers 404 like any unknown path. It works through whatever sits in
front of the API (proxy, CDN), because nothing on that way has to be trusted: `sha256sum` accepts
only this exact script, and everything else is protected by the key in the command.

What the installer ([`deploy/node/install.sh`](deploy/node/install.sh)) does: checks the system,
installs Docker from Docker's repository (key fingerprint pinned), fetches the cluster's shared
configuration and the inviting node's exact build (over the public address, or — if that does not
answer correctly — over the inviting node's pinned channel), writes `/opt/pokyh/.env` (mode 0600)
with a database password and `CLUSTER_SECRET` of its own, **hardens the server** (automatic security
updates; a firewall that lets in SSH — on the port(s) `sshd` really uses — and only the chosen
ports from the chosen sources; `POKYH_HARDEN=0` skips it), starts the stack and waits until the node
has joined and received the data. Running the same command again resumes after a failure;
`/opt/pokyh/pokyh` is `docker compose` for that stack.

The stack ([`deploy/node/compose.yml`](deploy/node/compose.yml)): MySQL, Redis, the backend as
`app-blue`/`app-green` (see [Updates](#updates-without-downtime-node-by-node)), `edge` (owns the
cluster port and passes connections on unchanged), `updater` (the only part with Docker access; no
port), `caddy` (own domain) or `gateway` (behind your proxy; trusts your proxy's addresses for the
client address), and Ollama if chosen.

How the command is protected:

- **The key** (`pokyhnode1.…`) names the inviting node's public address and channel, its
  certificate pin, the install and a 256-bit secret that never travels. From it the new server
  derives a proof key (every request carries an HMAC over a fresh nonce and the time), the key that
  opens the configuration (AES-256-GCM, bound to that very request — readable by nobody else, not by
  a proxy or CDN in between), and a one-time pairing secret.
- **Once, briefly**: started within the time limit; the configuration is handed out once; wrong
  proofs lock the install; the panel can revoke it; the secret is forgotten once the node joined;
  neither key nor command is stored or logged.
- **The build** is checked against the SHA-256 sealed into the configuration.
- **Joining** happens over the mutually authenticated channel only, both certificates bound into
  the handshake.

What the new node takes over: the settings that must be equal on every node (secrets, admin login,
CORS, `PUBLIC_BASE_URL`, WebUntis, Learn, rate limits, school year, cluster and update settings —
[`src/cluster/sharedEnv.ts`](src/cluster/sharedEnv.ts)). Never: database credentials,
`CLUSTER_SECRET`, its own addresses, ports, proxy trust or paths.

### Adding a node with an invite code

For a node you set up yourself: **Cluster** → **Node einladen** on an existing node creates a
one-time code (valid `CLUSTER_PAIRING_TTL_MINUTES`, locked after wrong attempts); **Beitreten** on
the new node uses it. Whoever holds a valid code can join and receives all data — pass it on only
over a channel you trust. With `CLUSTER_AUTO_MESH` (on) every new node is introduced to all others,
so all nodes end up linked with each other; a link an administrator removed is never re-created.

### How the nodes reach each other

**The channel.** With `CLUSTER_MTLS_PORT` a node serves the node-to-node channel over TLS 1.3 with
**certificates on both ends**. Each node creates its own certificate (ECDSA P-256; the private key
never leaves it); nodes **pin** each other's public key (`sha256//…`). A connection without a pinned
certificate is cut off right after the handshake. Inside, the frame layer runs with its own keys and
binds both certificates into its handshake — something that terminated TLS in between makes it fail.
Links made before the channel existed move onto it by themselves and are then **locked** to it.
**Zertifikat erneuern** replaces a node's certificate without interruption.

**Several ways**, tried in order, each switchable in the panel (**Erreichbarkeit dieser Node**) or
listed in `CLUSTER_MTLS_ENDPOINTS`; the others stay with the way that works and give preferred ways
another chance regularly:

| Way | Example | Notes |
| --- | --- | --- |
| Direct | `https://10.8.0.2:4100` | public address or a WireGuard/Tailscale address |
| Proxy · own port | `https://vps.example.org:4100` | your proxy passes a TCP port on unchanged |
| Proxy · 443 (SNI) | `https://node1.cluster.example.org:443` | your proxy passes TLS for that name on 443 on unchanged; web traffic stays as it is |
| Relay | automatic | for nodes without open ports, see below |
| Proxy · API path | `https://api.example.org/cluster-node/homelab` | **switched off unless enabled** — see below |

All of these but the last end at the node's own pinned certificate: proxies and relays carry
ciphertext only. For every proxy way the panel shows ready-made configuration for nginx, HAProxy,
Traefik and Caddy, and **Weg testen** checks that a way really arrives at this node (pinned ways:
by the certificate presented; the API path: by a challenge only this process can answer).

**Through your web proxy on the API's own address.** Where only the API's public port is open, a
node can offer a way through your reverse proxy: the proxy serves `api.example.org` with its own
certificate, as it does anyway, and passes one path prefix (e.g. `/cluster-node/homelab/`) on —
prefix removed — to the node's cluster entry inside your network (its API port with
`CLUSTER_PUBLIC_PATH`, or `CLUSTER_PORT`). On this way the frames stay end-to-end encrypted and
mutually authenticated with the link key, with forward secrecy — but there is **no certificate
pinning**. Therefore it is off by default, the other nodes take it only when every pinned way fails,
a node accepts such sessions only while it offers such a way, and switching it off closes them at
once. Configure it in the panel (kind *Proxy · API-Pfad*) or with `CLUSTER_PATH_ENDPOINTS`.

**Relays** ([`deploy/relay`](deploy/relay)) — for a node behind NAT without a VPN. **Relay auf VPS
einrichten** prints a command for any server with a public address; it runs the relay as an
unprivileged container and prints a **relay key**. **Relay hinzufügen** stores the key (encrypted,
replicated), and every node — also nodes added later — registers there and announces its relay
ways. The relay reads only the TLS server name and splices connections; it never terminates TLS,
and a compromised relay can do no more than refuse to carry traffic.

| Entry point | Setting |
| --- | --- |
| Mutually authenticated channel | `CLUSTER_MTLS_PORT`, `CLUSTER_MTLS_URL`, `CLUSTER_MTLS_BIND_ADDRESS`, `CLUSTER_MTLS_PUBLISH` (Compose) |
| On the API port (`/cluster/v1`) | `CLUSTER_PUBLIC_PATH` |
| Own plain port | `CLUSTER_PORT`, `CLUSTER_BIND_ADDRESS` |
| Address restriction (both plain entry points) | `CLUSTER_ALLOWLIST` (IPs and CIDR ranges) |

### What is exchanged — Pokyh Learn in or out

Pokyh itself (users, to-dos, classes, menu, popups, …) is always exchanged. **Pokyh Learn**
(courses, vocabulary, progress, teams, AI settings — every `learn_*` table) can be left out:
**Cluster** → **Was wird abgeglichen**, or `CLUSTER_REPLICATE_LEARN`. The setting is the same on
every node: changed on one node, it travels with the heartbeat and the newest setting wins
everywhere (equal ages are settled the same way on every node). While nodes disagree, replication
between them pauses for a moment.

When Learn is left out, every node keeps its own Learn data; route Learn users to the same node in
your proxy. Changes keep being recorded meanwhile, and deletions in Learn are kept, so switching it
back on **merges** the Learn data of all nodes: a complete transfer runs to every peer and, for the
same row, the newer change wins.

### Updates without downtime, node by node

Set the repository and branch in the panel (**Cluster** → **Updates**) or with
`CLUSTER_UPDATE_REPO`/`CLUSTER_UPDATE_BRANCH`. Every node checks the branch (git's own HTTP
protocol, any git host) and, with `CLUSTER_UPDATE_REQUIRE_CI`, accepts a commit only when all its
GitHub checks passed. With `CLUSTER_UPDATE_AUTO` new versions roll out by themselves; otherwise the
panel waits for **Jetzt ausrollen**. Settings changed in the panel apply to every node.

There is **no leader**: every node sorts all nodes by SHA-256(commit, node id) — the same order
everywhere, a different one for every version — and updates itself when every node before it runs
the new version, is not updated by Pokyh (e.g. a node deployed with Dokploy: update it there), or
has been unreachable longer than `CLUSTER_UPDATE_SKIP_OFFLINE_MINUTES`. The first node builds from
git; the others take its build over the channel (SHA-256 checked). A failed update stops the
rollout there: that node keeps its version and the next ones wait until an administrator chooses
**Erneut versuchen**. **Auf vorherige Version zurück** switches one node back.

On a server set up by the installer, the `updater` service carries an update out: it builds the
new image, starts it as the other colour next to the running one — serving HTTP, but taking over the
cluster and background work only once named active — waits until it is healthy, waits for Caddy
or the gateway to see it healthy too, stops the old colour gracefully and names the new one active.
Caddy and the gateway send requests only to a colour whose `/readyz` answers and retry another one
while a colour goes away, so no request is dropped; a version that never becomes healthy is removed
again. The updater's own files and the stack definition come only from the repository and branch
fixed at install time (`POKYH_RUNTIME_REPO`/`POKYH_RUNTIME_BRANCH` in `/opt/pokyh/compose.env`),
fetched by the updater itself and used only if the commit is on that branch; a new `compose.yml` must
pass a policy check (no privileged containers, only the expected files mounted, the Docker socket
for the updater only, no extra ports). A compromised app can therefore never gain more rights
through an update.

**Moving a node deployed elsewhere onto the Pokyh stack:** add a fresh server with the one-line
command, wait until it is *Online* without pending rows, point your proxy at it, then remove the old
node (**Verbindung entfernen**). The data never leaves the cluster.

### Security model

- **Pairing**: a 256-bit one-time secret, stretched with scrypt, authenticates an ephemeral X25519
  exchange; the result is a link key that never travels over the network.
- **Every connection**: a fresh ephemeral X25519 exchange authenticated with the link key — forward
  secrecy; over the channel additionally bound to both pinned certificates.
- **Every message**: compressed, padded, sealed with AES-256-GCM under per-direction keys and unique
  counters; altered, replayed or foreign messages are rejected.
- **At rest**: link keys and the node's private key are stored encrypted (`CLUSTER_SECRET`, or
  derived from `JWT_SECRET`); never logged, never returned by any API — nor are invite codes,
  install keys or relay keys.
- **Limits of the model**: the channel protects data in transit and admits only linked nodes; it
  cannot protect against a node that is itself compromised, or someone holding a valid invite
  code or install command. A linked node receives the complete data set — link only nodes you
  control.

### Consistency and failure handling

- Triggers record every change in the same transaction, whatever wrote it (API, SQL, scripts). Each
  peer has a read position in the change feed; batches go out right away when quiet and are
  collected under load.
- The **later change wins** on every node; deleting a parent removes its dependants everywhere; the
  same unique value created on two nodes is reconciled the same way on every node.
- **Self-check**: every `CLUSTER_VERIFY_INTERVAL_MINUTES` each node compares checksums with each
  peer and repairs whatever differs (**Jetzt prüfen** in the panel).
- Heartbeats mark a peer *Antwortet nicht* and then *Offline*; changes for it wait in the feed. A
  peer that was away longer than `CLUSTER_TOMBSTONE_RETENTION_DAYS` is held until an administrator
  decides, so deleted rows cannot come back.
- Restoring a backup on a node makes the restored rows the current version everywhere, keeping
  newer rows; changes made underneath the application are detected and can be published.
- Consistency is eventual (about a second). Rate limits and the Redis cache are per node.

### Cluster settings

The complete list with explanations is in [`.env.example`](.env.example). The most important:

| Setting | Purpose |
| --- | --- |
| `CLUSTER_ENABLED` | The cluster layer (dormant until the first link). |
| `CLUSTER_NODE_NAME` · `CLUSTER_ADVERTISE_URL` | Name and address of this node. |
| `CLUSTER_MTLS_PORT` · `CLUSTER_MTLS_URL` · `CLUSTER_MTLS_ENDPOINTS` | The mutually authenticated channel and the ways to it. |
| `CLUSTER_MTLS_PROXY_PROTOCOL` · `CLUSTER_MTLS_PROXY_FROM` | A forwarder in front of the channel names the client (PROXY protocol), accepted only from these ranges. |
| `CLUSTER_PATH_ENDPOINTS` | Ways through your web proxy on the API address (unpinned; used last). |
| `CLUSTER_CHANNEL_RETRY_SECONDS` | How long calls take another way before the channel is tried again. |
| `CLUSTER_RELAY_KEYS` · `CLUSTER_RELAY_LABEL` · `CLUSTER_RELAY_DEFAULT_PORT` | Relays for this node only; its name there; the relay port shown in proxy configuration. |
| `CLUSTER_REPLICATE_LEARN` | Exchange Pokyh Learn (default for the panel switch). |
| `CLUSTER_INSTALL_TTL_MINUTES` · `CLUSTER_PAIRING_TTL_MINUTES` | How long install commands and invite codes stay valid. |
| `CLUSTER_UPDATE_*` | Repository, branch, automatic, checks, polling, skipping offline nodes, health timeout, optional GitHub token. |
| `CLUSTER_ALLOWLIST` · `CLUSTER_PUBLIC_PATH` · `CLUSTER_PORT` | Plain entry points and their address restriction. |
| `CLUSTER_SECRET` | Protects stored link keys (derived from `JWT_SECRET` when empty). |
| `POKYH_COLOR` · `POKYH_UPDATE_DIR` · `POKYH_ACTIVATION_FILE` | Set by the installer's stack (blue/green); leave empty elsewhere. |

On a node deployed with Docker Compose or Dokploy: set `CLUSTER_MTLS_PORT=4100` and
`CLUSTER_MTLS_PUBLISH=0.0.0.0:4100` (or the address of your VPN interface), and `CLUSTER_MTLS_URL`
when the API's domain is proxied — then open that port to the other nodes.

---

## Testing

```bash
npm test                # unit tests: pure modules, crypto, installer, edge, updater policy, rollout, scope …
npm run test:cluster    # multi-node end-to-end tests (needs Docker; never touches your .env or database)
npm run test:updater    # the updater's blue/green switch against real Docker with Caddy
npm run test:admin      # schools, permissions and the admin API against a real MySQL (needs Docker)
npm run bench           # endpoint timings and SQL per request on a seeded month of data (needs Docker)
```

[`tests/admin/access.e2e.mjs`](tests/admin/access.e2e.mjs) — schools joining on their first
sign-in, isolation between schools by id, header and body, deny-by-default permissions, no
self-elevation, revocation at once, user filters across pages, request logs apart from the panel's
own traffic, menus and comments per school, scrubbed error reports, the audit trail and the one-time
migration of existing admins.

`npm run test:cluster` starts a throw-away MySQL container and real backend processes:

- [`e2e.mjs`](tests/cluster/e2e.mjs) — invite and join, auto-mesh, initial transfer, live
  replication, self-check, node failure and recovery, conflicting changes, replayed and tampered
  traffic, backup restore, schema differences.
- [`install.e2e.mjs`](tests/cluster/install.e2e.mjs) — the one-line installer: `/setup` only while
  open, the command as shown, a fake public address, an impostor certificate, guessed keys until
  the lock, revocation, single use, IP detection, several installs at once, the new node joining
  by itself, certificate renewal, links moving onto the channel, the first-run setup.
- [`relay.e2e.mjs`](tests/cluster/relay.e2e.mjs) — a real relay, a node reachable only through it,
  a server installed through it, the relay going away and back, SNI routing taking over.
- [`update.e2e.mjs`](tests/cluster/update.e2e.mjs) — leaderless rollout: a single node, nodes
  catching up with the build of a node that has it, a failure stopping the rollout, retry, release
  by hand, shared settings, the edge forwarder in front of the channel.
- [`features.e2e.mjs`](tests/cluster/features.e2e.mjs) — targeted popups on every node, Pokyh Learn
  left out and merged back in, *Weg testen*, the way through a web proxy carrying a locked link when
  the channel fails — only while it is offered — with nothing readable on it.

`npm run test:updater` ([`tests/deploy/updater.docker.mjs`](tests/deploy/updater.docker.mjs)) runs
the real stack definition with stand-in app images: the policy check on the real `compose.yml`, a
blue→green switch while clients keep sending HTTPS requests through Caddy (none fails), a version
that never becomes healthy (no request reaches it), roll back, and a tampered build.

---

## Operations & maintenance

```bash
npm run make-admin <username>        # grant admin
npm run revoke-admin <username>      # revoke admin
npm run set-admin-password           # set or replace the admin password (bcrypt)
npm run create-user                  # create a local (non-WebUntis) user
```

More commands, including the cluster and installer ones, are in [`COMMANDS.md`](COMMANDS.md).

---

## Project layout

```
src/
├── index.ts            # bootstrap, middleware, CORS, database start-up, background jobs
├── config.ts           # every environment setting (fail-fast on required secrets)
├── cluster/            # pairing, channel (mTLS), replication, ways, relays, installer, updates, scope
├── middleware/         # API key, auth (JWT), rate limits, admin, request logging
├── routes/             # auth, users, to-dos, classes, reminders, dishes, popups, learn, admin, …
├── services/           # WebUntis, SSE, archiver, school year, push, analytics, …
└── utils/              # cache, errors, logger, ids, revoked tokens
prisma/schema.prisma    # database schema (source of truth)
admin/                  # React + Vite admin panel (built into admin/dist)
deploy/node/            # one-line installer, node stack, edge forwarder, updater
deploy/relay/           # relay and its installer
scripts/                # admin and user CLIs, build info
tests/                  # unit tests, cluster end-to-end tests, Docker updater test
```

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Logins fail with **429** at scale | `TRUST_PROXY` unset → all clients share one address. Set it to your proxy topology; server-to-server logins must send `X-Server-Key`. |
| Browser **CORS** error | Add the frontend's origin to `CORS_ORIGIN`. |
| `/auth/me` returns **401** right after login | The client did not receive a token — check the server-to-server login and `X-Server-Key`/`X-API-Key`. |
| Prisma "property does not exist" | Run `npx prisma generate` after schema changes. |
| Database unreachable at boot | Not fatal — the server retries. Check `DATABASE_URL` and MySQL's health. |
| Dish import says the address is missing | Set `MENSA_IMPORT_URL` or enter the menu's address in the import dialog. |
| `/setup` answers 404 | No install command is open (or it expired) — create one in **Cluster**. |
| Install command refused: "public https address" | Open the admin panel under the node's public https address (not an internal one). |
| Cluster join stays *Tritt bei…* | Invite used or expired, or one node cannot reach the other — check the ways and **Weg testen**. |
| Cluster page: capture could not be set up | The database account may not create triggers: grant `TRIGGER` (with binary logging and a non-`SUPER` account also `log_bin_trust_function_creators=1`). |
| Peer *Online* but nothing arrives | See the warnings on the Cluster page: a different schema (finish the update), a different Learn setting being taken over, or a peer on hold after a long absence. |
| Peer shows *über Web-Proxy (ohne Pinning)* | Its pinned ways fail — check them with **Weg testen**; the link falls back to the API path until they work again. |
| An update waits | The rollout order shows who is next; a failed node stops it until **Erneut versuchen**. Nodes without the Pokyh updater (e.g. Dokploy) are updated where they are deployed. |

---

<div align="center">

Part of the **POKYH** project · Web frontend · App · Backend (this repository)

</div>
