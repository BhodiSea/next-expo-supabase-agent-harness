-- 20261007000000_trail_shared_functions — one deny_mutation() and one pair of partition
-- functions for both append-only trails, which 20260202000000_audit.sql and
-- 20260816000000_auth_event_trail.sql each defined for themselves.
--
-- APPLIED HISTORY, NOT DESIRED STATE. Append-only like every other migration here: the two
-- migrations that wrote the copies stay byte-identical, and this one moves the schema forward.
--
-- THE DEFECT. The auth-event trail copied audit's deny_mutation(), ensure_partitions(int) and
-- drop_partitions_older_than(interval) line for line, one schema over, and nothing reads the
-- copies: the duplication gate reads only .ts and .tsx under apps/ and packages/, and
-- tools/tenancy.json names audit.deny_mutation alone. They had already drifted three ways. The
-- trail's maintenance was never scheduled (20261006000000_auth_trail_partition_schedule.sql
-- fixed that). Its partition functions were revoked from PUBLIC only, where audit's are also
-- revoked from anon and authenticated. And no assertion proved that its ensure_partitions()
-- gives each month the TRUNCATE guard.
--
-- THE FIX, as the maintainer answered #146's decisions:
--   * audit.deny_mutation() serves both trails (D1). It names the schema it fired in, so a
--     refusal on auth_trail.events still says auth_trail. Every auth_trail trigger is
--     re-pointed to it in place, so no table is ever without one, and then
--     auth_trail.deny_mutation() is dropped WITHOUT CASCADE: the drop fails, and with it this
--     migration, if anything still calls it.
--   * The shared function lives in `audit` (D2), the name the seeded tools/tenancy.json already
--     pins, so the tenancy gate's register needs no edit on any install.
--   * audit.ensure_partitions(regclass, int) and audit.drop_partitions_older_than(regclass,
--     interval) take the parent and derive the schema and the partition names from it. They
--     refuse every parent but audit.events and auth_trail.events (D3), so neither becomes a
--     general DDL helper.
--   * The four old signatures stay, as one-line wrappers over the shared pair (D4). pg_cron
--     runs a job by its command text, and the jobs 20260202000000_audit.sql and
--     20261006000000_auth_trail_partition_schedule.sql scheduled call them by name on every
--     database that applied them. This migration re-points no job.
--
-- WHAT THE MERGE COSTS, stated because the audit migration's premise is that one careless
-- migration can remove any single layer. Disarming layers 3 and 4 on both trails now takes one
-- CREATE OR REPLACE FUNCTION instead of two, and auth_trail's triggers depend on a function in
-- another schema, so a DROP SCHEMA audit CASCADE would remove them too. Accepted for what it
-- buys: one fix reaches both trails, through the function the tenancy gate holds audit's
-- layers to.
--
-- PRIVILEGE. Every function here is SECURITY INVOKER (no SECURITY DEFINER clause, no OWNER TO)
-- and pins an empty search_path, as the copies did. deny_mutation() only raises. The partition
-- DDL needs ownership of the parent, which pg_cron's `postgres` has and no client role does,
-- so the functions grant nobody anything. EXECUTE is revoked from PUBLIC, anon and
-- authenticated on all six partition functions, which closes the REVOKE drift.
--
-- The upgrade runbook (docs/runbooks/harness-upgrade.md, 2.0.3) hands an existing install this
-- file's SQL for a migration of its own, without the second half where the trail was never
-- adopted. The DROP FUNCTION and the REVOKEs from authenticated are the decisions the records
-- explain:
-- adr: docs/adr/20260202-audit-trail.md
-- adr: docs/adr/20260816-auth-event-trail.md

-- CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE on a trail that takes a row on every
-- sign-in, and on every partition under it: fail fast rather than queue every writer behind a
-- long-running reader.
SET lock_timeout = '3s';

-- ─────────────────────────────────────────────────────────────────────────────
-- The shared machinery, in `audit`
-- ─────────────────────────────────────────────────────────────────────────────
-- Replaced in place, so its OID, its owner, its revoked EXECUTE and every audit trigger that
-- calls it stay as they are. The message for audit.events is byte-identical to before; the
-- schema now comes from TG_TABLE_SCHEMA rather than the function's text, so one body names
-- whichever trail refused. Every trail is called `events` (the parents below are a closed
-- set), and TG_TABLE_NAME names the partition a row trigger fired on, as it always did.
CREATE OR REPLACE FUNCTION audit.deny_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $deny$
BEGIN
  RAISE EXCEPTION '%.events is append-only (% on % refused)', TG_TABLE_SCHEMA, TG_OP, TG_TABLE_NAME
    USING ERRCODE = '42501',
          HINT = 'Rows are never updated or deleted. Remove history by dropping a partition: '
            || TG_TABLE_SCHEMA || '.drop_partitions_older_than(interval).';
END
$deny$;

-- The two-argument forms carry no DEFAULT on purpose. With one, a one-argument call such as
-- audit.ensure_partitions('auth_trail.events') matches both signatures and PostgreSQL refuses
-- it as "not unique" (verified against 17); without one, every two-argument call resolves.
CREATE FUNCTION audit.ensure_partitions(_parent regclass, _months_ahead int)
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $ensure$
DECLARE
  _schema name;
  _table name;
  _i int := 0;
  _created int := 0;
  _start date;
  _stop date;
  _name text;
BEGIN
  -- D3, the closed set. The parent is looked up by OID, never cast from a name, so a database
  -- that never adopted the auth-event trail still runs this for audit.events.
  SELECT n.nspname, c.relname INTO _schema, _table
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = _parent;
  IF NOT FOUND OR _table <> 'events' OR _schema NOT IN ('audit', 'auth_trail') THEN
    RAISE EXCEPTION 'audit.ensure_partitions: % is not an append-only trail', _parent
      USING ERRCODE = '22023',
            HINT = 'Only audit.events and auth_trail.events are partitioned here.';
  END IF;

  WHILE _i <= _months_ahead LOOP
    _start := (date_trunc('month', now()) + (_i || ' months')::interval)::date;
    _stop := (_start + interval '1 month')::date;
    _name := _table || '_' || to_char(_start, 'YYYY_MM');

    IF to_regclass(format('%I.%I', _schema, _name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
        _schema, _name, _schema, _table, _start, _stop
      );
      -- Direct access to a partition is judged by the PARTITION's own RLS, not the parent's,
      -- so each month carries ENABLE + FORCE with zero policies: deny-all for direct access,
      -- while writes routed through the parent are judged by the parent.
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', _schema, _name);
      -- SOURCE: FORCE ROW LEVEL SECURITY subjects the table owner to policies; a partition carrying RLS with no policy of its own is deny-all for direct access [corpus: postgres/rls-force]
      EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', _schema, _name);
      -- Layer 4's per-partition twin, in the branch that creates the partition. PostgreSQL
      -- does not clone TRUNCATE triggers to partitions, so without this a trail is emptiable
      -- one month at a time.
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation()',
        _name || '_no_truncate', _schema, _name
      );
      _created := _created + 1;
    END IF;
    _i := _i + 1;
  END LOOP;
  RETURN _created;
END
$ensure$;

-- Retention: the only sanctioned way rows ever leave a trail, and it is DDL that needs
-- ownership of the parent. The cutoff comes from the partition NAME, which ensure_partitions()
-- owns; the default partition does not match the pattern, so it is never a candidate.
CREATE FUNCTION audit.drop_partitions_older_than(_parent regclass, _keep interval)
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $retain$
DECLARE
  _schema name;
  _table name;
  _dropped int := 0;
  _rec record;
  _month date;
BEGIN
  SELECT n.nspname, c.relname INTO _schema, _table
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = _parent;
  IF NOT FOUND OR _table <> 'events' OR _schema NOT IN ('audit', 'auth_trail') THEN
    RAISE EXCEPTION 'audit.drop_partitions_older_than: % is not an append-only trail', _parent
      USING ERRCODE = '22023',
            HINT = 'Only audit.events and auth_trail.events are partitioned here.';
  END IF;

  FOR _rec IN
    SELECT c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid
     WHERE i.inhparent = _parent
     ORDER BY c.relname
  LOOP
    _month := to_date(substring(_rec.relname from _table || '_([0-9]{4}_[0-9]{2})$'), 'YYYY_MM');
    IF _month IS NOT NULL AND _month < date_trunc('month', now() - _keep) THEN
      EXECUTE format(
        'ALTER TABLE %I.%I DETACH PARTITION %I.%I',
        _schema, _table, _schema, _rec.relname
      );
      EXECUTE format('DROP TABLE %I.%I', _schema, _rec.relname);
      _dropped := _dropped + 1;
    END IF;
  END LOOP;
  RETURN _dropped;
END
$retain$;

REVOKE ALL ON FUNCTION audit.ensure_partitions(regclass, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.ensure_partitions(regclass, int) FROM anon, authenticated;
REVOKE ALL ON FUNCTION audit.drop_partitions_older_than(regclass, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.drop_partitions_older_than(regclass, interval) FROM anon, authenticated;

-- D4: audit's old signatures, the ones its pg_cron jobs name, as one-line wrappers. Replaced
-- in place, so they keep their revoked EXECUTE; a CREATE OR REPLACE may change the language
-- and body but keeps the parameter names and defaults callers rely on.
CREATE OR REPLACE FUNCTION audit.ensure_partitions(_months_ahead int DEFAULT 3)
RETURNS int
LANGUAGE sql
SET search_path = ''
AS $wrap$
  SELECT audit.ensure_partitions('audit.events'::pg_catalog.regclass, _months_ahead);
$wrap$;

CREATE OR REPLACE FUNCTION audit.drop_partitions_older_than(_keep interval DEFAULT interval '24 months')
RETURNS int
LANGUAGE sql
SET search_path = ''
AS $wrap$
  SELECT audit.drop_partitions_older_than('audit.events'::pg_catalog.regclass, _keep);
$wrap$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The auth-event trail joins it
-- ─────────────────────────────────────────────────────────────────────────────
-- Everything below names auth_trail, which 20260816000000_auth_event_trail.sql created. A
-- fresh scaffold always has it; the runbook tells an install that never adopted the trail to
-- leave this half out.
--
-- Layers 3 and 4 on the parent, re-pointed in place. CREATE OR REPLACE TRIGGER swaps the
-- function inside one statement, so the table is never without its trigger, and on the
-- partitioned parent it re-points the row trigger's clone on every partition too (verified
-- against 17).
CREATE OR REPLACE TRIGGER events_immutable
  BEFORE UPDATE OR DELETE ON auth_trail.events
  FOR EACH ROW EXECUTE FUNCTION audit.deny_mutation();
CREATE OR REPLACE TRIGGER events_no_truncate
  BEFORE TRUNCATE ON auth_trail.events
  FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();

-- Layer 4's twin on every partition: the default one, and each month however many the
-- database holds (the trail migration made four, the schedule adds one a month). Read from the
-- catalog because the months exist only at runtime. tgparentid = 0 skips the row trigger's
-- clones, which the statement above already re-pointed, and tgtype 34 is BEFORE (2) plus
-- TRUNCATE (32), statement-level. A DO block is one statement, so it re-points all of them
-- or none.
DO $repoint$
DECLARE
  _t record;
BEGIN
  FOR _t IN
    SELECT t.tgname, c.relname
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_inherits i ON i.inhrelid = t.tgrelid
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
     WHERE i.inhparent = 'auth_trail.events'::pg_catalog.regclass
       AND t.tgfoid = 'auth_trail.deny_mutation()'::pg_catalog.regprocedure
       AND t.tgparentid = 0
       AND t.tgtype = 34
     ORDER BY c.relname
  LOOP
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER %I BEFORE TRUNCATE ON auth_trail.%I FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation()',
      _t.tgname, _t.relname
    );
  END LOOP;
END
$repoint$;

-- D4 again: the trail's old signatures, which its pg_cron jobs name, as one-line wrappers.
CREATE OR REPLACE FUNCTION auth_trail.ensure_partitions(_months_ahead int DEFAULT 3)
RETURNS int
LANGUAGE sql
SET search_path = ''
AS $wrap$
  SELECT audit.ensure_partitions('auth_trail.events'::pg_catalog.regclass, _months_ahead);
$wrap$;

CREATE OR REPLACE FUNCTION auth_trail.drop_partitions_older_than(_keep interval DEFAULT interval '24 months')
RETURNS int
LANGUAGE sql
SET search_path = ''
AS $wrap$
  SELECT audit.drop_partitions_older_than('auth_trail.events'::pg_catalog.regclass, _keep);
$wrap$;

-- The REVOKE drift, closed: audit revoked its pair from anon and authenticated as well as
-- PUBLIC, and the trail's copies only from PUBLIC. Unreachable either way (no client role holds
-- USAGE on auth_trail), and now the same statement on both.
REVOKE ALL ON FUNCTION auth_trail.ensure_partitions(int) FROM anon, authenticated;
REVOKE ALL ON FUNCTION auth_trail.drop_partitions_older_than(interval) FROM anon, authenticated;

-- Last, and without CASCADE. Every trigger above now calls audit.deny_mutation(), so nothing
-- depends on the copy; if anything still did (a trigger this file did not know about), the
-- default RESTRICT refuses the drop and the whole migration fails rather than leaving a table
-- whose guard was removed with it.
DROP FUNCTION auth_trail.deny_mutation();
