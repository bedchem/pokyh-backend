# Pokyh backend delivery contract

The Learn work in this repository is additive to the existing Pokyh API. Do
not replace existing routes, authentication, database behavior, configuration,
or a real `.env` file to make a Learn change easier.

## Coordination and release protocol

- Before material work, inspect `git status` and relevant open pull requests
  for this repository and its Learn/frontend siblings. Inspect a relevant PR's
  merge state first and resolve only confirmed merge conflicts.
- Preserve every contributor's tracked and untracked work. Never delete, reset,
  clean, rename, or overwrite it without the human owner's explicit direction;
  record a hand-off instead when the scope is unclear.
- Record every material API, schema, security, operations, documentation,
  verification, PR, commit, or push step in the central factual worklog at
  `../pokyh_learn-frontend/docs/worklog/`. Include intent, outcome, affected
  area, verification, remaining risk, and release state. Never log secrets,
  credentials, request bodies, personal data, or private reasoning.
- Run the relevant tests before any commit. After a coherent tested checkpoint,
  ask once for the precise commit/push scope and Git identity in the exact form
  `Name <email>`; do not create a commit or push until both are confirmed.
- Use only that confirmed identity in local Git configuration. Do not change
  global identity, force-push, rewrite shared history, or add an
  AI/assistant co-author trailer, signature, branding, or attribution unless
  the human owner explicitly asks for it.
