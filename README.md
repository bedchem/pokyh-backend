# pokyh-backend

Production-ready Node.js/Express/TypeScript backend replacing Firebase (Auth + Firestore) for the Pokyh school app.

## Stack

- **Runtime**: Node.js + Express 5 + TypeScript
- **Database**: MySQL 8+ via Prisma ORM (local only)
- **Auth**: JWT (8h) + Refresh Tokens (30d)
- **Real-time**: Server-Sent Events (SSE)
- **Security**: Helmet, CORS, rate limiting, Zod validation, timing-safe comparisons

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Required variables:

| Variable | Description |
|---|---|
| `DATABASE_URL` | MySQL connection string — `mysql://USER:PASS@localhost:3306/pokyh` |
| `JWT_SECRET` | 64-char random hex for JWT signing |
| `REFRESH_TOKEN_SECRET` | 64-char random hex for refresh tokens |
| `API_KEY` | Shared secret sent in `X-API-Key` header by the frontend |
| `SERVER_KEY` | Server-to-server secret for Next.js → backend calls |
| `CORS_ORIGIN` | Allowed frontend origin (e.g. `http://localhost:3000`) |

Generate secrets:
```bash
node -e "const {randomBytes}=require('crypto'); ['JWT_SECRET','REFRESH_TOKEN_SECRET','API_KEY','SERVER_KEY'].forEach(k => console.log(k+'='+randomBytes(32).toString('hex')))"
```

### 3. Create the MySQL database

```bash
mysql -u root -e "CREATE DATABASE pokyh CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

(On macOS with Homebrew: `brew services start mysql` first)

### 4. Development

```bash
npm run dev
```

Automatically syncs the database schema and starts the server with hot-reload.

### 5. Production

```bash
npm run build   # compiles TypeScript + generates Prisma client
npm start       # syncs schema + starts compiled server
```

---

## API Reference

All endpoints require `X-API-Key: <your-api-key>` header.

Authenticated endpoints additionally require `Authorization: Bearer <jwt>`.

### Auth

#### `POST /auth/login`
Register or log in a user. Called server-to-server from Next.js.

Requires: `X-Server-Key: <server-key>` header

Request body:
```json
{
  "username": "maxi.muster",
  "klasseId": 123,
  "klasseName": "4AHIF"
}
```

Response:
```json
{
  "token": "<jwt>",
  "refreshToken": "<refresh-token>",
  "user": {
    "stableUid": "abc123...",
    "username": "maxi.muster",
    "webuntisKlasseId": 123,
    "webuntisKlasseName": "4AHIF",
    "classId": "def456...",
    "isAdmin": false
  }
}
```

#### `POST /auth/refresh`
Issue a new JWT using a refresh token.

Request body:
```json
{ "refreshToken": "<refresh-token>" }
```

Response:
```json
{ "token": "<new-jwt>" }
```

#### `POST /auth/logout`
Revoke a refresh token. Requires auth.

Request body:
```json
{ "refreshToken": "<refresh-token>" }
```

#### `GET /auth/me`
Get current user info. Requires auth.

---

### Users

#### `GET /users/me`
Get current user profile. Requires auth.

#### `GET /users/:userId`
Get user by username or stableUid. Requires auth.

---

### Todos

#### `GET /users/:username/todos`
List todos sorted by `createdAt` ascending. Requires auth (own user only).

#### `POST /users/:username/todos`
Create todo. Requires auth (own user only).

Request body:
```json
{
  "title": "Math homework",
  "details": "Page 42–45",
  "dueAt": "2026-05-10T15:00:00.000Z"
}
```

#### `PATCH /users/:username/todos/:todoId`
Update todo. Requires auth (own user only).

Request body (all fields optional):
```json
{
  "title": "Updated title",
  "done": true,
  "doneAt": "2026-05-02T10:00:00.000Z"
}
```

#### `DELETE /users/:username/todos/:todoId`
Delete todo. Requires auth (own user only).

---

### Classes

#### `GET /classes/mine`
Get the user's current class (matching WebUntis `klasseId`). Requires auth.

#### `GET /classes/:classId`
Get class with members. Requires auth + membership.

#### `POST /classes`
Create a class (admin only). Requires auth.

Request body:
```json
{ "name": "4AHIF", "webuntisKlasseId": 123 }
```

#### `POST /classes/join`
Join a class by code. Requires auth.

Request body:
```json
{ "code": "ABC123" }
```

#### `POST /classes/:classId/leave`
Leave class. Deletes class if no members remain. Requires auth.

---

### Reminders

#### `GET /classes/:classId/reminders`
List reminders sorted by `remindAt` ascending. Requires auth + membership.

#### `POST /classes/:classId/reminders`
Create reminder. Requires auth + membership.

Request body:
```json
{
  "title": "Math test",
  "body": "Chapter 5–8",
  "remindAt": "2026-05-10T08:00:00.000Z"
}
```

#### `DELETE /classes/:classId/reminders/:reminderId`
Delete reminder. Requires auth + (creator OR admin).

---

### Dish Ratings

#### `GET /dish-ratings/:dishId`
Get all ratings for a dish. Requires auth.

Response:
```json
{
  "ratings": { "<stableUid>": 4 },
  "myRating": 4
}
```

#### `POST /dish-ratings/batch`
Get ratings for multiple dishes at once. Requires auth.

Request body:
```json
{ "dishIds": ["dish-1", "dish-2"] }
```

#### `POST /dish-ratings/:dishId`
Rate a dish (1–5 stars). Upserts. Requires auth.

Request body:
```json
{ "stars": 4 }
```

---

### Server-Sent Events (SSE)

All SSE endpoints require auth via `Authorization: Bearer <token>` header. The connection sends the current state on connect, then pushes updates whenever data changes.

SSE event format:
```
event: <eventName>
data: <JSON payload>
```

#### `GET /sse/todos`
Subscribe to todo changes for the authenticated user.

Event: `todos` — payload is the full todos array.

#### `GET /sse/reminders/:classId`
Subscribe to reminder changes for a class. Requires membership.

Event: `reminders` — payload is the full reminders array.

#### `GET /sse/dish-ratings/:dishId`
Subscribe to rating changes for a dish.

Event: `dishRatings` — payload is `{ ratings, myRating }`.

Heartbeat: `data: {"type":"heartbeat"}` every 30 seconds.

---

## Security Features

- **Helmet**: HTTP security headers
- **CORS**: Strict origin allowlist (`pokyh.com`, `localhost:3000`)
- **Rate limiting**:
  - Global: 500 req/min per IP
  - Auth: 10 req/15min per IP
  - Writes: 60 req/min per IP
  - Reads: 300 req/min per IP
  - SSE: 10 connections per IP
- **API Key**: Timing-safe comparison via `crypto.timingSafeEqual`
- **JWT**: 8h expiry, RS256 signed
- **Refresh tokens**: 30-day expiry, hashed in DB, revocable
- **Input validation**: Zod on all request bodies
- **stableUid isolation**: Users can only access their own data
- **Class membership checks**: On all class/reminder operations
- **Admin checks**: On admin-only operations

---

## Deployment

### Environment

- Set `NODE_ENV=production`
- Use a strong, unique `DATABASE_URL` with a dedicated DB user
- Generate fresh secrets (don't reuse from dev)
- Set `CORS_ORIGIN=https://pokyh.com`

### Database

```bash
npx prisma migrate deploy
```

### Process manager

Use PM2 or systemd:

```bash
npm run build
pm2 start dist/index.js --name pokyh-backend
```

### Reverse proxy (nginx)

```nginx
location / {
  proxy_pass http://localhost:4000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection '';
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  # SSE: disable buffering
  proxy_buffering off;
  proxy_cache off;
  chunked_transfer_encoding on;
}
```
