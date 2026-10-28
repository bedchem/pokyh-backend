# Cluster

The POKYH backend can run as a **leaderless cluster**: several nodes, each with its own database,
that hold the same data. This document covers how nodes are added, how they reach each other, what
they exchange, how updates roll out without downtime, the security model and every setting. A
single node needs none of it; the feature stays dormant until the first link.

Back to the [README](../README.md) · settings in [`.env.example`](../.env.example) · database
layers in [`database.md`](database.md)

## Contents

- [Concepts](#concepts)
- [Adding a server with one command](#adding-a-server-with-one-command)
- [Adding a node with an invite code](#adding-a-node-with-an-invite-code)
- [How the nodes reach each other](#how-the-nodes-reach-each-other)
- [What is exchanged](#what-is-exchanged)
- [Updates without downtime, node by node](#updates-without-downtime-node-by-node)
- [Security model](#security-model)
- [Consistency and failure handling](#consistency-and-failure-handling)
- [Cluster settings](#cluster-settings)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

## Concepts

Several backend nodes, each with its **own** MySQL database, hold the same data. There is **no
leader**: every node accepts reads and writes, a change made on any node reaches the others within
about a second, a node that was offline catches up by itself, and every node checks the others
regularly. One node works on its own exactly as before; more nodes make it fail-safe and can be
added at any time, also several at once. The feature is dormant until the first link: a standalone
server installs no trigger.

The admin panel's **Cluster** page shows every node, the ways they reach each other, the relays,
what is exchanged, updates and the latest events.

## Adding a server with one command

A fresh Debian 12+ or Ubuntu 22.04+ server becomes a complete node (Docker, database,
configuration, hardening, joining) with a single command. Any node can add servers.

1. On a node with the mutually authenticated channel, open the admin panel under its public
   **https** address → **Cluster** → **Server per Einzeiler hinzufügen**. Enter a name and,
   optionally, the new server's address: empty (its public IP is detected when it sets itself
   up), a domain, or an IP. Choose its **web access**:

   | Web access | The new server … | Open ports |
   | --- | --- | --- |
   | **None** (default) | has no web address of its own; clients keep using your existing ones | cluster port |
   | **Own domain** | serves its domain with HTTPS itself (Caddy, Let's Encrypt) | cluster port, 80, 443 |
   | **Behind your proxy** | publishes the API on a port of your choice for your own reverse proxy, which does TLS and spreads requests over the nodes | cluster port, API port (only from your proxy's addresses) |

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

What the installer ([`deploy/node/install.sh`](../deploy/node/install.sh)) does: checks the system,
installs Docker from Docker's repository (key fingerprint pinned), fetches the cluster's shared
configuration and the inviting node's exact build (over the public address or, if that does not
answer correctly, over the inviting node's pinned channel), writes `/opt/pokyh/.env` (mode 0600)
with a database password and `CLUSTER_SECRET` of its own, **hardens the server** (automatic security
updates; a firewall that lets in SSH (on the port(s) `sshd` really uses) and only the chosen
ports from the chosen sources; `POKYH_HARDEN=0` skips it), starts the stack and waits until the node
has joined and received the data. Running the same command again resumes after a failure;
`/opt/pokyh/pokyh` is `docker compose` for that stack.

The stack ([`deploy/node/compose.yml`](../deploy/node/compose.yml)): MySQL, Redis, the backend as
`app-blue`/`app-green` (see [Updates](#updates-without-downtime-node-by-node)), `edge` (owns the
cluster port and passes connections on unchanged), `updater` (the only part with Docker access; no
port), `caddy` (own domain) or `gateway` (behind your proxy; trusts your proxy's addresses for the
client address).

How the command is protected:

- **The key** (`pokyhnode1.…`) names the inviting node's public address and channel, its
  certificate pin, the install and a 256-bit secret that never travels. From it the new server
  derives a proof key (every request carries an HMAC over a fresh nonce and the time), the key that
  opens the configuration (AES-256-GCM, bound to that very request: readable by nobody else, not by
  a proxy or CDN in between), and a one-time pairing secret.
- **Once, briefly**: started within the time limit; the configuration is handed out once; wrong
  proofs lock the install; the panel can revoke it; the secret is forgotten once the node joined;
  neither key nor command is stored or logged.
- **The build** is checked against the SHA-256 sealed into the configuration.
- **Joining** happens over the mutually authenticated channel only, both certificates bound into
  the handshake.

What the new node takes over: the settings that must be equal on every node (secrets, admin login,
CORS, `PUBLIC_BASE_URL`, WebUntis, rate limits, school year, cluster and update settings;
see [`src/cluster/sharedEnv.ts`](../src/cluster/sharedEnv.ts)). Never: database credentials,
`CLUSTER_SECRET`, its own addresses, ports, proxy trust or paths.

## Adding a node with an invite code

For a node you set up yourself: **Cluster** → **Node einladen** on an existing node creates a
one-time code (valid `CLUSTER_PAIRING_TTL_MINUTES`, locked after wrong attempts); **Beitreten** on
the new node uses it. Whoever holds a valid code can join and receives all data, so pass it on only
over a channel you trust. With `CLUSTER_AUTO_MESH` (on) every new node is introduced to all others,
so all nodes end up linked with each other; a link an administrator removed is never re-created.

## How the nodes reach each other

**The channel.** With `CLUSTER_MTLS_PORT` a node serves the node-to-node channel over TLS 1.3 with
**certificates on both ends**. Each node creates its own certificate (ECDSA P-256; the private key
never leaves it); nodes **pin** each other's public key (`sha256//…`). A connection without a pinned
certificate is cut off right after the handshake. Inside, the frame layer runs with its own keys and
binds both certificates into its handshake, so something that terminated TLS in between makes it fail.
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
| Proxy · API path | `https://api.example.org/cluster-node/homelab` | **switched off unless enabled**, see below |

All of these but the last end at the node's own pinned certificate: proxies and relays carry
ciphertext only. For every proxy way the panel shows ready-made configuration for nginx, HAProxy,
Traefik and Caddy, and **Weg testen** checks that a way really arrives at this node (pinned ways:
by the certificate presented; the API path: by a challenge only this process can answer).

**Through your web proxy on the API's own address.** Where only the API's public port is open, a
node can offer a way through your reverse proxy: the proxy serves `api.example.org` with its own
certificate, as it does anyway, and passes one path prefix (e.g. `/cluster-node/homelab/`) on,
prefix removed, to the node's cluster entry inside your network (its API port with
`CLUSTER_PUBLIC_PATH`, or `CLUSTER_PORT`). On this way the frames stay end-to-end encrypted and
mutually authenticated with the link key, with forward secrecy, but there is **no certificate
pinning**. Therefore it is off by default, the other nodes take it only when every pinned way fails,
a node accepts such sessions only while it offers such a way, and switching it off closes them at
once. Configure it in the panel (kind *Proxy · API-Pfad*) or with `CLUSTER_PATH_ENDPOINTS`.

**Relays** ([`deploy/relay`](../deploy/relay)): for a node behind NAT without a VPN. **Relay auf VPS
einrichten** prints a command for any server with a public address; it runs the relay as an
unprivileged container and prints a **relay key**. **Relay hinzufügen** stores the key (encrypted,
replicated), and every node (also nodes added later) registers there and announces its relay
ways. The relay reads only the TLS server name and splices connections; it never terminates TLS,
and a compromised relay can do no more than refuse to carry traffic.

| Entry point | Setting |
| --- | --- |
| Mutually authenticated channel | `CLUSTER_MTLS_PORT`, `CLUSTER_MTLS_URL`, `CLUSTER_MTLS_BIND_ADDRESS`, `CLUSTER_MTLS_PUBLISH` (Compose) |
| On the API port (`/cluster/v1`) | `CLUSTER_PUBLIC_PATH` |
| Own plain port | `CLUSTER_PORT`, `CLUSTER_BIND_ADDRESS` |
| Address restriction (both plain entry points) | `CLUSTER_ALLOWLIST` (IPs and CIDR ranges) |

## What is exchanged

Every table of POKYH is exchanged, except the ones that only make sense on the node that wrote
them (request logs, error reports, backup settings, the cluster's own bookkeeping) and
`CLUSTER_EXCLUDE_TABLES`. Tables an earlier version of Pokyh Learn left in a database (`learn_*`)
stay on their node and are never exchanged.

## Updates without downtime, node by node

Set the repository and branch in the panel (**Cluster** → **Updates**) or with
`CLUSTER_UPDATE_REPO`/`CLUSTER_UPDATE_BRANCH`. Every node checks the branch (git's own HTTP
protocol, any git host) and, with `CLUSTER_UPDATE_REQUIRE_CI` (off by default: the repository runs
no checks of its own), accepts a commit only when all its GitHub checks passed. With `CLUSTER_UPDATE_AUTO` new versions roll out by themselves; otherwise the
panel waits for **Jetzt ausrollen**. Settings changed in the panel apply to every node.

There is **no leader**: every node sorts all nodes by SHA-256(commit, node id), the same order
everywhere and a different one for every version, and updates itself when every node before it runs
the new version, is not updated by Pokyh (e.g. a node deployed with Dokploy: update it there), or
has been unreachable longer than `CLUSTER_UPDATE_SKIP_OFFLINE_MINUTES`. The first node builds from
git; the others take its build over the channel (SHA-256 checked). A failed update stops the
rollout there: that node keeps its version and the next ones wait until an administrator chooses
**Erneut versuchen**. **Auf vorherige Version zurück** switches one node back.

On a server set up by the installer, the `updater` service carries an update out: it builds the
new image, starts it as the other colour next to the running one (serving HTTP, but taking over the
cluster and background work only once named active), waits until it is healthy, waits for Caddy
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

## Security model

- **Pairing**: a 256-bit one-time secret, stretched with scrypt, authenticates an ephemeral X25519
  exchange; the result is a link key that never travels over the network.
- **Every connection**: a fresh ephemeral X25519 exchange authenticated with the link key, for forward
  secrecy; over the channel additionally bound to both pinned certificates.
- **Every message**: compressed, padded, sealed with AES-256-GCM under per-direction keys and unique
  counters; altered, replayed or foreign messages are rejected.
- **At rest**: link keys and the node's private key are stored encrypted (`CLUSTER_SECRET`, or
  derived from `JWT_SECRET`); never logged, never returned by any API, and neither are invite codes,
  install keys or relay keys.
- **Limits of the model**: the channel protects data in transit and admits only linked nodes; it
  cannot protect against a node that is itself compromised, or someone holding a valid invite
  code or install command. A linked node receives the complete data set, so link only nodes you
  control.

## Consistency and failure handling

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

## Cluster settings

The complete list with explanations is in [`.env.example`](../.env.example). The most important:

| Setting | Purpose |
| --- | --- |
| `CLUSTER_ENABLED` | The cluster layer (dormant until the first link). |
| `CLUSTER_NODE_NAME` · `CLUSTER_ADVERTISE_URL` | Name and address of this node. |
| `CLUSTER_MTLS_PORT` · `CLUSTER_MTLS_URL` · `CLUSTER_MTLS_ENDPOINTS` | The mutually authenticated channel and the ways to it. |
| `CLUSTER_MTLS_PROXY_PROTOCOL` · `CLUSTER_MTLS_PROXY_FROM` | A forwarder in front of the channel names the client (PROXY protocol), accepted only from these ranges. |
| `CLUSTER_PATH_ENDPOINTS` | Ways through your web proxy on the API address (unpinned; used last). |
| `CLUSTER_CHANNEL_RETRY_SECONDS` | How long calls take another way before the channel is tried again. |
| `CLUSTER_RELAY_KEYS` · `CLUSTER_RELAY_LABEL` · `CLUSTER_RELAY_DEFAULT_PORT` | Relays for this node only; its name there; the relay port shown in proxy configuration. |
| `CLUSTER_INSTALL_TTL_MINUTES` · `CLUSTER_PAIRING_TTL_MINUTES` | How long install commands and invite codes stay valid. |
| `CLUSTER_UPDATE_*` | Repository, branch, automatic, checks, polling, skipping offline nodes, health timeout, optional GitHub token. |
| `CLUSTER_ALLOWLIST` · `CLUSTER_PUBLIC_PATH` · `CLUSTER_PORT` | Plain entry points and their address restriction. |
| `CLUSTER_SECRET` | Protects stored link keys (derived from `JWT_SECRET` when empty). |
| `POKYH_COLOR` · `POKYH_UPDATE_DIR` · `POKYH_ACTIVATION_FILE` | Set by the installer's stack (blue/green); leave empty elsewhere. |

On a node deployed with Docker Compose or Dokploy: set `CLUSTER_MTLS_PORT=4100` and
`CLUSTER_MTLS_PUBLISH=0.0.0.0:4100` (or the address of your VPN interface), and `CLUSTER_MTLS_URL`
when the API's domain is proxied; then open that port to the other nodes.

---

## Testing

`npm run test:cluster` starts a throw-away MySQL container and real backend processes; it never
touches your `.env` or database:

- [`e2e.mjs`](../tests/cluster/e2e.mjs): invite and join, auto-mesh, initial transfer, live
  replication, self-check, node failure and recovery, conflicting changes, replayed and tampered
  traffic, backup restore, schema differences.
- [`install.e2e.mjs`](../tests/cluster/install.e2e.mjs): the one-line installer. `/setup` only while
  open, the command as shown, a fake public address, an impostor certificate, guessed keys until
  the lock, revocation, single use, IP detection, several installs at once, the new node joining by
  itself, certificate renewal, links moving onto the channel, the first-run setup.
- [`relay.e2e.mjs`](../tests/cluster/relay.e2e.mjs): a real relay, a node reachable only through it,
  a server installed through it, the relay going away and back, SNI routing taking over.
- [`update.e2e.mjs`](../tests/cluster/update.e2e.mjs): leaderless rollout. A single node, nodes
  catching up with the build of a node that has it, a failure stopping the rollout, retry, release
  by hand, shared settings, the edge forwarder in front of the channel.
- [`features.e2e.mjs`](../tests/cluster/features.e2e.mjs): targeted popups on every node,
  *Weg testen*, the way through a web proxy carrying a locked
  link when the channel fails (only while it is offered) with nothing readable on it.

`npm run test:updater` ([`updater.docker.mjs`](../tests/deploy/updater.docker.mjs)) runs the real
stack definition with stand-in app images: the policy check on the real `compose.yml`, a blue/green
switch while clients keep sending HTTPS requests through Caddy (none fails), a version that never
becomes healthy (no request reaches it), roll back, and a tampered build.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `/setup` answers 404 | No install command is open (or it expired); create one under **Cluster**. |
| Install command refused: "public https address" | Open the admin panel under the node's public https address, not an internal one. |
| Join stays *Tritt bei...* | The invite was used or expired, or one node cannot reach the other: check the ways and **Weg testen**. |
| Capture could not be set up | The database account may not create triggers: grant `TRIGGER` (with binary logging and a non-`SUPER` account also `log_bin_trust_function_creators=1`). |
| Peer *Online* but nothing arrives | See the warnings on the Cluster page: a different schema (finish the update) or a peer on hold after a long absence. |
| Peer shows *über Web-Proxy (ohne Pinning)* | Its pinned ways fail; check them with **Weg testen**. The link falls back to the API path until they work again. |
| An update waits | The rollout order shows who is next; a failed node stops it until **Erneut versuchen**. Nodes without the POKYH updater (e.g. Dokploy) are updated where they are deployed. |
