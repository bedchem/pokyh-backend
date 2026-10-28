# Schools, permissions and the admin panel

Pokyh works with any school on WebUntis. This document describes how schools
come into the installation, how their data is kept apart, how admin
permissions work, and what the web app and the mobile apps send.

## Schools join on their own

Schools are **not created in the panel**. A school is added the first time one
of its accounts signs in:

1. The web app (or app) lets the person pick their school — the WebUntis school
   search returns its *login name* (`loginName`), *display name* and *server*.
2. The app's server validates the credentials at that school's WebUntis server
   and calls `POST /auth/login` with the `X-Server-Key` header and
   `school` (login name), `schoolName` (display name) and `schoolServer`
   (WebUntis host, e.g. `xyz.webuntis.com`).
3. The backend finds the school by its login name, or adds it
   (`services/schools.ts`, `schoolForLogin`): active, display name from
   WebUntis, **no Mensa plan**. The audit trail records `school.join`, and the
   panel updates live.

Only a caller holding the server key reaches this, after WebUntis accepted the
credentials — nobody can invent schools from outside. A login name must look
like a WebUntis login name; a server outside `WEBUNTIS_HOST_SUFFIXES` is not
stored. `SCHOOLS_MAX` is a safety net on how many schools may be added.
`SCHOOLS_AUTO_CREATE=false` turns joining off (only existing schools can sign
in).

The school of `WEBUNTIS_SCHOOL` exists from the first start (every account from
before schools existed belongs to it). A request without `school` lands there,
as every client did before. Pokyh Learn and local password accounts belong to
it as well.

In the panel (global view, **Schulen**) a global admin renames a school, gives
it a short name and identifier, assigns a Mensa plan, or **deactivates** it — a
deactivated school's sign-ins are refused (`403`); its data stays. The WebUntis
login name and server come from WebUntis and cannot be edited.

## What is kept apart

Every account belongs to exactly one school (`users.school_id`). Classes,
comments, ratings, request logs, usage statistics, web visits, popups, error
reports and the audit trail carry the school as well. A school's view in the
panel only ever shows its own data; a request naming another school's record by
id gets `404`.

Usernames are unique across the installation. A WebUntis login whose name
already belongs to an account of another school is refused with `409`
(fail-closed) rather than merged.

## Mensa plans

A Mensa plan (`mensa_menus`) can serve several schools; a school shows at most
one, and **none at all** when no plan is assigned — `GET /dishes` then answers
`{ "available": false, "menu": { "dishes": [] } }` and the app should hide the
Mensa entirely. New schools arrive without a plan.

Comments and ratings belong to the plan's dishes and to the commenting
account's school: two schools sharing a plan see the same dishes, each with its
own comments and ratings. Editing a shared plan requires `mensa.manage` in
every school that uses it.

## Permissions

Permissions are granted per scope — `global` or one school — as a list of
rights (`src/security/permissions.ts`). Presets: *viewer*, *moderator*,
*mensa_manager*, *school_admin*, *global_admin*. Rules:

- deny by default; every admin route names the permission it needs, and the
  school comes from the `X-Pokyh-School` header (the panel's current view);
- nobody changes their own rights, and nobody grants more than they hold
  (subset rule); a school admin never creates a global admin;
- password changes, removal and revocation of an admin need every right the
  target holds;
- the operators in `ADMIN_USERNAMES` hold everything and cannot be changed in
  the panel;
- permissions are read on every request: a revoked right stops working with
  the next request.

Existing admins became global admins once, on the first start with this
version (marker `admin-grants-v1`).

## Search in the panel

"/" (or the field at the top) opens one search over accounts, classes, admins,
dishes, comments, schools and pages — across every school the admin's rights
reach, whichever view is open (`GET /api/admin/search`). Each kind is filtered
by its own permission per school; a kind the admin may not see anywhere is
left out entirely. Results open in a view that may show them. Terms are not
stored: the request log keeps the path only. `ADMIN_SEARCH_PER_MINUTE`,
`ADMIN_SEARCH_LIMIT` and `ADMIN_SEARCH_DETAIL_LIMIT` bound it.

The view switcher (top left) always offers "Alle Schulen" first, then the
schools the admin opens most (learnt in their browser only), then all.

## Logs and error reports

- **Anfragen** (requests): the API traffic of the apps — not the panel's own,
  which only operators see. Full paths, status, duration; addresses and user
  agents only in the global view with `system.logs.view`.
- **Frontend-Logs**: error reports the web app and the apps send to
  `POST /client-errors`, scrubbed on the way in (no address, no account, no
  tokens or e-mail addresses in the text), kept `CLIENT_ERROR_RETENTION_DAYS`.
- **Backend-Logs**: the server's own log files — operators only.
- **Audit**: every sign-in to the panel and every change of rights, accounts,
  comments, menus, schools and popups, kept `AUDIT_RETENTION_DAYS` (at least
  180 days).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DEFAULT_SCHOOL_NAME` | *(WEBUNTIS_SCHOOL)* | Initial display name of the installation's own school |
| `SCHOOLS_AUTO_CREATE` | `true` | Schools join on their first WebUntis sign-in |
| `SCHOOLS_MAX` | `1000` | Safety net on the number of schools |
| `WEBUNTIS_HOST_SUFFIXES` | `webuntis.com` | WebUntis servers a login may name |
| `AUDIT_RETENTION_DAYS` | `365` | Audit trail, at least 180 |
| `CLIENT_ERRORS_ENABLED` | `true` | Accept error reports |
| `CLIENT_ERROR_RETENTION_DAYS` | `30` | Keep error reports |
| `CLIENT_ERRORS_PER_MINUTE` | `20` | Reports per address and minute |
| `CLIENT_ERRORS_PER_ERROR_PER_MINUTE` | `20` | Reports of one identical error per minute |
| `ADMIN_SEARCH_PER_MINUTE` | `120` | Panel searches per admin and minute |
| `ADMIN_SEARCH_LIMIT` | `6` | Results per kind |
| `ADMIN_SEARCH_DETAIL_LIMIT` | `30` | Results when one kind is searched |

## For the web app and the apps

- **Sign-in** (`POST /auth/login`, server key): send `school` (WebUntis login
  name), `schoolName` and `schoolServer` from the school search, and validate
  the credentials at `https://<server>/WebUntis/jsonrpc.do?school=<loginName>`.
  Send `untisSessionId` (the app's WebUntis JSESSIONID) as well: the class
  comes only from WebUntis, never from `klasseId` ([class-assignment.md](class-assignment.md)).
  Handle `403` (school deactivated) and `409` (name belongs to another school).
- **Mensa**: `GET /dishes` (signed in: always the account's own school; guests:
  `?school=<identifier>`). `available: false` → hide the Mensa.
- **Error reports**: `POST /client-errors` with `source` (`web`, `android`,
  `ios`), `message`, optional `name`, `stack`, `page`, `release`, `requestId`.
  Mention error reports and the school assignment in the privacy notice.

## Upgrading

`prisma db push` applies the additive schema on start; the start-up migration
(`services/multiSchool.ts`) fills the new columns once per marker in
`app_migrations` and is safe to run on several nodes. During a rolling update an
older node keeps writing accounts, classes, comments and ratings without a
school; they count for the installation's own school, and every start fills
them in. Log rows an older node writes during the update stay without a school
and appear in the global view only. Grant changes made on a new node while an
older one still serves the panel take effect on the older node only after it
is updated (it does not know permissions) — update all nodes promptly.
