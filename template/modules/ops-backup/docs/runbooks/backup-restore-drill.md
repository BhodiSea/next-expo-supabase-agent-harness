<!-- cspell:ignore pgbackrest basebackup pgarchive pgbackups Xnone PITR -->

# Runbook: backup + restore drill (ops-backup module)

A backup you have never restored is a rumor. This runbook has two halves: the
LOCAL DRILL (practice the mechanics quarterly, ~20 minutes, zero production
access) and the PRODUCTION configuration skeleton (pgBackRest on the DB host).

## Local drill (docker compose overlay)

Bring the rig up and open the workbench:

```sh
docker compose -f docker-compose.yml -f docker-compose.pgbackrest.yml up -d db
docker compose -f docker-compose.yml -f docker-compose.pgbackrest.yml run --rm backup-drill bash
```

### 1. Take a base backup

```sh
pg_basebackup -D /var/lib/pgbackups/base-$(date +%Y%m%d) -Ft -z -Xnone -c fast
```

### 2. Create evidence AFTER the backup (this is what PITR must recover)

From the host: `pnpm db:migrate` if needed, then insert a marker row through the
app path, and note the timestamp:

```sql
-- as app_api through the normal app path, or psql for the drill
INSERT INTO notes (owner_id, title, body)
VALUES ('11111111-1111-4111-8111-111111111111', 'drill-marker', 'created after base backup');
SELECT now();
```

### 3. Simulate the disaster

```sh
docker compose stop db
docker compose rm -f db && docker volume rm <project>_db-data
```

### 4. Restore base + replay WAL to a point in time

Recreate the volume, unpack the base backup into it, drop a `recovery.signal`,
set `restore_command = 'cp /var/lib/pgarchive/%f %p'` and
`recovery_target_time = '<timestamp from step 2>'`, start `db`, and watch the log
until `recovery stopping before commit` + promotion.

### 5. Verify — the drill's PASS criteria (all three, every time)

- [ ] the marker row from step 2 exists,
- [ ] `pnpm test:rls` is green against the restored database (RLS survived the
      restore: policies, FORCE flags, roles — a restore that loses policies is
      WORSE than downtime),
- [ ] the server starts and the mobile app's connection status indicator reports
      connected (it probes `/healthz`).

Record date, operator, wall-clock restore time, and any surprises in the ops log.
The wall-clock time IS your real RTO — not the number in the slide deck.

## Production skeleton (pgBackRest on the DB host)

```ini
# /etc/pgbackrest/pgbackrest.conf — adjust paths/stanza to your host layout
[global]
repo1-type=s3            # or posix onto mounted, off-host storage
repo1-retention-full=2
repo1-retention-diff=7
repo1-cipher-type=aes-256-cbc
process-max=4
log-level-console=info

[main]
pg1-path=/var/lib/postgresql/16/main
```

```ini
# postgresql.conf on the host
archive_mode = on
archive_command = 'pgbackrest --stanza=main archive-push %p'
```

Schedule: `pgbackrest backup --stanza=main --type=full` weekly,
`--type=diff` nightly; `pgbackrest check --stanza=main` after every config
change. Run THIS SAME DRILL against a scratch host from the production
repository quarterly — the local rig proves the mechanics, the production drill
proves the repository.

## Anti-vacuity

Once, deliberately: skip step 2's marker (or restore WITHOUT the archive volume)
and watch verification fail. A drill that cannot fail proves nothing.
