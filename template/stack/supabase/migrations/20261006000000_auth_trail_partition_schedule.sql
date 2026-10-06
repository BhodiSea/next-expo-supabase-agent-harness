-- 20261006000000_auth_trail_partition_schedule — schedule auth_trail's partition
-- maintenance, which 20260816000000_auth_event_trail.sql created and never scheduled.
--
-- APPLIED HISTORY, NOT DESIRED STATE. Append-only like every other migration here.
--
-- THE DEFECT. The trail migration calls auth_trail.ensure_partitions() once, at apply,
-- which creates the apply month and the three after it. Nothing ever calls it again, and
-- nothing calls auth_trail.drop_partitions_older_than() at all: the guarded pg_cron block
-- in 20260202000000_audit.sql schedules only audit's pair. So from the fifth month after
-- apply, every sign-in row lands in auth_trail.events_default, which retention never
-- drops, and that month's partition can never be created afterwards, because PostgreSQL
-- refuses a range partition while the default partition holds rows inside its range.
--
-- THE FIX is audit's schedule, one schema over: the same guarded block, the same horizon
-- (three months ahead, run on the first of each month) and the same 24-month retention,
-- fifteen minutes after audit's jobs. pg_cron runs a job as the role that scheduled it,
-- which is `postgres` here, the owner of auth_trail.events, so the partition DDL inside
-- both SECURITY INVOKER functions is the owner's own. Guarded rather than unconditional,
-- for audit's reason: pg_cron needs shared_preload_libraries and is a per-project setting
-- on hosted Supabase, and a bare CREATE EXTENSION would make this migration unappliable on
-- a project without it. There the functions still exist and the schedule is a documented
-- manual step (docs/adr/20260816-auth-event-trail.md, Consequences).
--
-- cron.schedule() with a job name replaces that job if it already exists, so this file
-- converges on the same two jobs however often a database applies an equivalent copy. The
-- upgrade runbook hands existing installs this same SQL for a migration of their own,
-- which is why the catch-up at the end handles a database that already ran out of months.
-- adr: docs/adr/20260816-auth-event-trail.md

-- On an existing install the catch-up below creates partitions of a table that takes a row
-- on every sign-in, under an ACCESS EXCLUSIVE lock on the parent: fail fast rather than
-- queue every sign-in behind a long-running reader.
SET lock_timeout = '3s';

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.schedule(
      'auth-trail-ensure-partitions',
      '15 3 1 * *',
      $job$SELECT auth_trail.ensure_partitions(3)$job$
    );
    PERFORM cron.schedule(
      'auth-trail-drop-old-partitions',
      '45 3 1 * *',
      $job$SELECT auth_trail.drop_partitions_older_than(interval '24 months')$job$
    );
  ELSE
    RAISE NOTICE 'pg_cron unavailable: schedule auth_trail.ensure_partitions(3) and auth_trail.drop_partitions_older_than() manually (see docs/adr/20260816-auth-event-trail.md)';
  END IF;
EXCEPTION
  WHEN insufficient_privilege OR feature_not_supported THEN
    RAISE NOTICE 'pg_cron present but not schedulable here (%); schedule the auth_trail partition jobs manually', SQLERRM;
END
$cron$;

-- Catch up now rather than at the first scheduled run. On a fresh database this creates
-- nothing (the trail migration just made the same four months). On a database that applied
-- the trail months ago it creates the months the schedule would otherwise reach only on the
-- next first of the month. On a database already past its last month, the current month's
-- rows sit in auth_trail.events_default, so that month can no longer be created and
-- ensure_partitions() raises check_violation: create the three months after it instead,
-- each exactly as ensure_partitions() would, so the schedule carries on from next month.
-- The rows already in the default partition stay there.
DO $catchup$
DECLARE
  _start date;
  _name text;
BEGIN
  PERFORM auth_trail.ensure_partitions(3);
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE 'auth_trail.events_default already holds rows for this month (%); creating the next three months only', SQLERRM;
    FOR _i IN 1..3 LOOP
      _start := (date_trunc('month', now()) + make_interval(months => _i))::date;
      _name := 'events_' || to_char(_start, 'YYYY_MM');
      IF to_regclass('auth_trail.' || quote_ident(_name)) IS NULL THEN
        EXECUTE format(
          'CREATE TABLE auth_trail.%I PARTITION OF auth_trail.events FOR VALUES FROM (%L) TO (%L)',
          _name, _start, (_start + interval '1 month')::date
        );
        EXECUTE format('ALTER TABLE auth_trail.%I ENABLE ROW LEVEL SECURITY', _name);
        -- SOURCE: FORCE ROW LEVEL SECURITY subjects the table owner to policies; a partition carrying RLS with no policy of its own is deny-all for direct access [corpus: postgres/rls-force]
        EXECUTE format('ALTER TABLE auth_trail.%I FORCE ROW LEVEL SECURITY', _name);
        EXECUTE format(
          'CREATE TRIGGER %I BEFORE TRUNCATE ON auth_trail.%I FOR EACH STATEMENT EXECUTE FUNCTION auth_trail.deny_mutation()',
          _name || '_no_truncate', _name
        );
      END IF;
    END LOOP;
END
$catchup$;
