# Database: layout, failure handling and recovery

How POKYH keeps its data safe, what happens when something breaks, and what an
operator does in each case. Settings are in [`.env.example`](../.env.example)
under *Backups and recovery*.

## The layers

| Protects against | Mechanism | Data lost at worst | Automatic |
| --- | --- | --- | --- |
| A server or its disk failing | the **cluster**: a second node at another location holds the same data (replication ≈ 1 s) | ≈ 1 second | yes — the other node keeps serving |
| A lost database volume on one node | **start-up rebuild** from the newest backup, then the other nodes fill the gap | nothing in a cluster; since the last backup alone | yes |
| A mistake that replicates (a wrong delete, a bug) | **backups** (versioned, checksummed) and **point-in-time recovery** | ≤ `PITR_FLUSH_MINUTES` (5 min) | restore is a deliberate admin step |
| Losing the whole host incl. its backups | **off-site copies**, encrypted, in an S3-compatible bucket | since the last copy (≤ `BACKUP_OFFSITE_SYNC_MINUTES`) | upload yes; restore with `DB_AUTO_RESTORE=offsite` or by hand |

Replication alone is not a backup: a wrong `DELETE` reaches every node within a
second. Backups alone are not availability: restoring takes minutes. POKYH uses
both, and the off-site copies keep the backups away from the host they describe.

### Why the application's own cluster and not MySQL replication

The backend already runs a leaderless cluster ([README → Cluster](../README.md#cluster)):
every node has its own MySQL, accepts writes, and replicates through triggers,
with checksummed self-checks that repair differences. Compared with the
alternatives for two locations:

- **MySQL Group Replication / InnoDB Cluster, Galera** need three members and
  low latency between them for their quorum; across two sites a network split
  stops writes (or needs a third site as tie-breaker).
- **Classic primary/replica** (asynchronous GTID replication) is simple, but
  failover is manual or needs extra tooling, and the old primary must be
  rebuilt after a failover.
- **The POKYH cluster** keeps working on either side of a split and merges
  afterwards (the later change wins per row), which fits a school app whose
  writes are small and mostly per person. It already exists and is tested
  (`npm run test:cluster`).

So: two (or more) nodes at different locations via the cluster, plus the
backup layers below on every node.

## Backups

- **Dumps** (`pokyh-backup-<UTC>.sql.gz`, admin panel → Backups): consistent
  `mysqldump` of the whole database, daily at `BACKUP_SCHEDULE_HOUR` or every
  `BACKUP_INTERVAL_HOURS`, kept `BACKUP_RETENTION_DAYS`.
- Each dump has a **manifest** (`<file>.json`: SHA-256, size, build commit,
  time). A restore checks the file against it and reads the whole archive back
  before a single statement reaches the database, so a damaged or swapped file
  is never loaded.
- After a restore the schema is brought up to date again (columns added since
  the dump, additively) and the read cache is emptied.
- **Schema changes** stay additive: `prisma db push` without data loss, and
  the fallback in `services/schemaSync.ts` executes only `CREATE` and
  `ALTER … ADD`. Nothing in the automatic path drops a table or a column.

## Point-in-time recovery

The `db-archiver` service ([`deploy/db/archiver.sh`](../deploy/db/archiver.sh))
runs next to MySQL with the same image and keeps in the backups volume:

- `pitr/base/base-<UTC>.sql.gz` — a consistent dump every `PITR_BASE_HOURS`,
  with the binary log position it starts at;
- `pitr/binlog/binlog.NNNNNN` — every closed binary log after it. The current
  log is closed whenever it has grown and is `PITR_FLUSH_MINUTES` old.

It reads the database's data volume read-only (closed log files only) and
never writes to the database. The files are uploaded off-site with the dumps.

**Rebuilding a moment** (the live database is not touched):

```bash
docker compose exec db-archiver bash /opt/pokyh-db/pitr-restore.sh "2026-10-21 14:03"   # UTC
```

A temporary MySQL server inside the container loads the newest base dump
before that moment and replays the archived logs on top through MySQL's own
replication applier, up to the last log closed before the moment. The result
is written as a new `pokyh-backup-<now>.sql.gz` (its manifest names the point
in time). It appears in the admin panel under Backups: download and check it,
then restore it there — in a cluster the restore reaches every node.

Try it once after setting it up (it changes nothing): pick a time a few hours
ago, run the command, and delete the resulting file in the panel.

## Off-site copies

With `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`,
`BACKUP_S3_SECRET_ACCESS_KEY` and `BACKUP_ENCRYPTION_KEY` set, every finished
dump, manifest, base dump and closed binary log is encrypted on the server
(AES-256-GCM) and uploaded to `BACKUP_S3_PREFIX/<node>/…` (node:
`CLUSTER_NODE_NAME`, or `main`). Copies older than
`BACKUP_OFFSITE_RETENTION_DAYS` are deleted; the newest dump always stays.

Keep `BACKUP_ENCRYPTION_KEY` in a password manager as well: the bucket holds
only ciphertext, and without the key nothing can be restored.

Restoring a copy by hand: download `…/pokyh-backup-<UTC>.sql.gz.enc`, then

```bash
npm run decrypt-backup pokyh-backup-<UTC>.sql.gz.enc      # needs BACKUP_ENCRYPTION_KEY
```

and put the file into the backups volume (it appears in the panel) or load it
with `gunzip -c pokyh-backup-….sql.gz | mysql <database>`.

## Start-up rebuild of a lost database

At start the server checks whether the database has **no tables at all**. If so,
and this node had data before (it has backups, or the state file it keeps in
the backups volume says so), it restores the newest backup that passes its
checks — before anything else uses the database — brings the schema up to date
and continues. In a cluster the other nodes then deliver every row that changed
since that backup (the regular self-check repairs all differences; *Jetzt
prüfen* in the panel starts it at once).

A database with its tables but few rows (for example right after the school
year rolled over) is never treated as lost. To start over with an empty
database on purpose, set `DB_AUTO_RESTORE=off` (or remove the backups).

`DB_AUTO_RESTORE=offsite` additionally restores the newest off-site copy on a
server that has neither local backups nor any trace of earlier data — a server
rebuilt after losing its disk. Use it only on the node whose copies those are.

## MySQL 8.4 upgrade (from 8.0)

MySQL 8.0 reached its end of life in April 2026; the stacks now run **8.4 LTS**
(supported until 2032). The upgrade is built so that the old data is never
changed:

- 8.4 keeps its data in a **new volume** (`mysql84_data`).
- The 8.0 volume (`mysql_data`) is mounted **read-only**. On the first start,
  when the new volume is empty, the 8.0 data is copied over and MySQL upgrades
  the **copy** in place (the supported path from 8.0 to 8.4).
- An interrupted copy is detected and redone.
- `stop_grace_period: 2m` gives the old server time for a clean shutdown,
  which the upgrade requires.

**Before deploying**

1. Admin panel → Backups: run a backup now, and download the file.
2. Make sure the disk has room for a second copy of the database.

**Deploy** as usual. In the MySQL log you see
`[pokyh] copying the MySQL 8.0 data …`, then MySQL's own upgrade messages.
The API starts once MySQL is healthy.

**If MySQL does not come up** (`docker compose logs mysql`): the 8.0 data is
still untouched. The most likely cause is *"Upgrade after a crash is not
supported"* — the old server was killed instead of shut down. Then:

1. Set the image back to `mysql:8.0.40` and its data volume back to
   `mysql_data:/var/lib/mysql` (remove the `/legacy` line), deploy: 8.0 runs
   on the original data again.
2. Stop the stack cleanly (`docker compose stop mysql`, wait until it exits).
3. Remove the half-done copy: `docker volume rm <project>_mysql84_data`.
4. Revert to the 8.4 settings and deploy again.

Should the new volume end up empty for any reason, the start-up rebuild
restores the newest backup by itself.

**Afterwards**: keep `mysql_data` until 8.4 has run well for a few weeks and an
off-site copy exists; then remove the `/legacy` mount and the volume.

The backup account keeps using `mysql_native_password` (the API image's
MariaDB client tools know no other method), enabled with
`--mysql-native-password=ON`, which 8.4 still supports.
