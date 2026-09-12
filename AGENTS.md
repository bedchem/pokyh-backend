# Shared delivery coordination

This repository is receiving additive Pokyh Learn work alongside the sibling
`pokyh_learn-frontend` and `pokyh-frontend` repositories. Collaborate with
other contributors; do not collide with their uncommitted work.

1. Never delete, reset, clean, overwrite wholesale, or revert existing files
   or another contributor's changes without a human owner's explicit request.
2. Inspect `git status` and this file before editing. Treat unfamiliar changes
   as active shared work, not as cleanup candidates.
3. Keep the current Pokyh API behavior intact. Learn belongs in the additive
   Learn routes, models, middleware, configuration, and admin surfaces rather
   than changing unrelated product behavior.
4. Never copy real `.env` values into source, documentation, issue text,
   fixtures, logs, or Git. Use `.env.example` with safe placeholders only.
5. Record each material change and verification result in the frontend
   repository's `docs/worklog/` without credentials, personal data, request
   bodies, or private reasoning.
6. Before every commit or push, ask the human owner to confirm the exact
   release scope and the Git author name/email. Do not add automated
   co-author trailers.

## Active shared areas

- `src/routes/learn.ts`, `src/routes/admin.ts`, `src/routes/auth.ts` and
  `src/middleware/`: Learn access, permission checks, API-key lifecycle,
  audit logging, rate limits, and input handling.
- `src/config.ts`, `src/index.ts`, `prisma/schema.prisma`, service modules,
  Docker/config examples: safe runtime configuration and additive schema.
- `admin/` (if present): a separate Learn management entry point must not
  blend Learn administration with unrelated Pokyh data.

Keep the boundary explicit: authenticated WebUntis-backed Pokyh users only;
all authorisation, grading, identifiers, and audit decisions remain server
authoritative.
