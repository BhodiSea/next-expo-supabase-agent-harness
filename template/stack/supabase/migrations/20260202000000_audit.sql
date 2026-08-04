-- supabase/migrations/20260202000000_audit.sql — the append-only audit trail.
--
-- adr: docs/adr/20260202-audit-trail.md
--
-- WHY THE TRAIL IS NOT IN `public`, stated first because it is the decision every
-- other line here follows from. PostgREST exposes every table in every schema listed
-- in [api].schemas, and RLS on a partitioned PARENT does not cascade to its
-- partitions. A `public.audit_events` partitioned by month is therefore readable at
-- `GET /rest/v1/audit_events_2026_08` with the publishable key and any valid JWT,
-- and that request is judged by the PARTITION's policies — of which there are none.
-- The parent's tenant predicate is never consulted. One URL, every tenant's history.
--
-- So the trail lives in `audit`, a schema absent from [api].schemas, on which anon,
-- authenticated and service_role hold no USAGE at all — the name does not resolve for
-- them even if a policy were added by mistake.
--
-- APPEND-ONLY IN FOUR LAYERS, because any single one of them can be removed by one
-- careless migration and none of them is sufficient alone:
--
--   1. No UPDATE or DELETE policy exists.          survives: a grant added by mistake
--   2. REVOKE ALL from anon/authenticated/         survives: a policy added by mistake
--      service_role; INSERT granted only to
--      app_audit_writer.
--   3. BEFORE UPDATE OR DELETE row trigger         survives: A ROLE HOLDING BYPASSRLS.
--      raising 42501.                              Verified: `postgres` on Supabase
--                                                  holds rolbypassrls and layers 1-2
--                                                  do nothing to it; the TRIGGER
--                                                  still fires.
--   4. BEFORE TRUNCATE statement trigger, on the   survives: TRUNCATE, which no row
--      parent AND ON EVERY PARTITION.              trigger can see at all.
--
-- LAYER 4's DUPLICATION IS REQUIRED, NOT DEFENSIVE. PostgreSQL clones ROW triggers to
-- partitions — including partitions created LATER, verified against 17 — but does NOT
-- clone TRUNCATE triggers, and `TRUNCATE audit.events_2026_08` on a leaf does not fire
-- the parent's. A trail protected only at the parent can be emptied one month at a
-- time. audit.ensure_partitions() therefore creates the trigger IN THE SAME BRANCH
-- that creates the partition, so the maintenance path that would open the gap is the
-- path that closes it.
--
-- Removal is only ever DETACH PARTITION + DROP TABLE: a DDL act requiring table
-- ownership, which no application role has.
-- SOURCE: docs/adr/20260202-audit-trail.md

-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on tables that are already serving
-- traffic (public.notes and the tenancy spine), so the file fails fast rather than
-- queueing every writer behind an open transaction. Plain SET, never SET LOCAL: the
-- Supabase CLI applies migrations outside an explicit transaction block, where SET
-- LOCAL warns and sets nothing.
SET lock_timeout = '3s';

-- ─────────────────────────────────────────────────────────────────────────────
-- Two roles, because one would be a read path
-- ─────────────────────────────────────────────────────────────────────────────
-- The writer may INSERT and nothing else; the reader may SELECT and nothing else.
-- A single `app_audit` role would mean every path that can append can also
-- exfiltrate every tenant's history, which is the failure mode an audit trail is
-- least able to detect — it would leave no audit row.
--
-- Both are NOLOGIN: they are reachable ONLY as the owner of a SECURITY DEFINER
-- function, never by connecting. Idempotent, because `supabase db reset` replays
-- migrations against a cluster whose ROLES survive the database drop — a bare
-- CREATE ROLE fails on the second reset.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_audit_writer') THEN
    CREATE ROLE app_audit_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_audit_reader') THEN
    CREATE ROLE app_audit_reader NOLOGIN;
  END IF;
END
$roles$;

-- `postgres` must be a MEMBER of a role to reassign ownership to it. Without this,
-- `ALTER FUNCTION ... OWNER TO app_audit_writer` fails with "must be able to SET ROLE"
-- and the function silently stays owned by postgres — which holds BYPASSRLS, so the
-- insert policy below would never be evaluated and layer 2 would be decorative.
GRANT app_audit_writer TO postgres;
GRANT app_audit_reader TO postgres;

CREATE SCHEMA IF NOT EXISTS audit;

-- The schema is the outermost layer: with no USAGE, `audit.events` does not resolve
-- as a NAME for a client role, so a mistakenly-added policy or grant on the table
-- cannot be reached. PUBLIC is revoked explicitly because CREATE SCHEMA does not
-- grant it — the REVOKE is here as the statement a reviewer can point at, and so a
-- later `GRANT USAGE ON SCHEMA audit TO authenticated` reads as the reversal it is.
REVOKE ALL ON SCHEMA audit FROM PUBLIC;
REVOKE ALL ON SCHEMA audit FROM anon, authenticated, service_role;

-- CREATE, not merely USAGE: reassigning ownership of a function to a role requires
-- that role to hold CREATE on the schema the function lives in.
GRANT USAGE, CREATE ON SCHEMA audit TO app_audit_writer;
GRANT USAGE ON SCHEMA audit TO app_audit_reader;
GRANT USAGE, CREATE ON SCHEMA public TO app_audit_reader;
GRANT USAGE ON SCHEMA private TO app_audit_writer, app_audit_reader;

-- ─────────────────────────────────────────────────────────────────────────────
-- audit.events
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE audit.events (
  id bigint GENERATED ALWAYS AS IDENTITY,
  -- The partition key. First column of nothing and part of everything: a RANGE
  -- partitioned table's PRIMARY KEY must contain every partition key column.
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- THE TENANT KEY, AND DELIBERATELY NOT A FOREIGN KEY. Every other org_id in this
  -- schema REFERENCES public.orgs (id) ON DELETE CASCADE. Here that would mean
  -- deleting an org deletes the record of what was done inside it — the audit trail
  -- erasing its own evidence, triggered by the single act most likely to need
  -- investigating. The id is retained as an opaque value; it outlives the row it
  -- names, which is the entire point.
  org_id uuid NOT NULL,
  -- WHO, and it is NOT a column DEFAULT. `DEFAULT auth.uid()` looks equivalent and is
  -- not: a default is only applied when the client OMITS the column, so any writer
  -- that supplies actor_id chooses its own value. It is assigned inside
  -- audit.write_row() and cross-checked by the insert policy below.
  -- Nullable because a system write (signup provisioning, the seed) has no JWT and
  -- honestly has no actor.
  actor_id uuid,
  action text NOT NULL,
  table_name text NOT NULL,
  -- The identifying value of the row, as text, because the tables audited here do not
  -- agree on a key type: public.notes is keyed (org_id, id) and public.memberships is
  -- keyed (user_id, org_id). Which column carries it is declared per trigger.
  row_id text,
  -- METADATA BY DEFAULT: which columns changed, not what they became.
  changed_columns text[] NOT NULL DEFAULT '{}',
  -- Value capture, per-column opt-in, declared as trigger arguments in the DDL and
  -- mirrored in tools/audit-columns.json. Empty unless somebody opted in, because an
  -- audit table that copies values is a second and less-policied home for the data it
  -- audits: a rank-30 admin reading the trail would see every member's note bodies,
  -- and every table's confidentiality would quietly become the audit table's.
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- CORRELATION, NOT EVIDENCE — and the distinction is recorded here rather than
  -- discovered during an investigation. It is minted by the server on the paths the
  -- server controls; a client talking straight to PostgREST can send any value it
  -- likes. actor_id is the field with integrity, because it comes from the verified
  -- JWT and the insert policy re-checks it against the database's own opinion.
  request_id text,
  CONSTRAINT events_action_known CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  CONSTRAINT events_table_name_length CHECK (char_length(table_name) BETWEEN 1 AND 128),
  -- org_id leads: the read path is always "this org's recent events", so the PK
  -- serves it, and a tenant-blind unique on an audit table would be a cross-org
  -- oracle like any other.
  PRIMARY KEY (org_id, occurred_at, id)
)
-- Monthly RANGE partitions. Retention is then a DROP of a whole partition — an
-- O(1) DDL act on a table nobody may DELETE from — rather than a bulk delete the
-- immutability trigger would refuse anyway.
PARTITION BY RANGE (occurred_at);

-- The DEFAULT partition is a BACKSTOP AND A TRAP, and both halves are load-bearing.
-- Backstop: if maintenance stops, a write still lands rather than failing and taking
-- the mutation down with it — an audit trail that can refuse a write is an audit
-- trail that can be used to deny service. Trap: a month partition CANNOT be created
-- once the default holds rows for that month, so ensure_partitions() runs three
-- months ahead to keep it empty. If it ever fills, the remedy is a manual move, not
-- a retry.
CREATE TABLE audit.events_default PARTITION OF audit.events DEFAULT;

-- The default partition gets the SAME hardening ensure_partitions() gives every
-- month, and it is spelled out rather than assumed because it is created by a
-- different code path and was therefore the one partition that had neither: RLS is
-- not inherited by a partition (verified — a newly attached partition shows
-- relrowsecurity = false regardless of the parent), and TRUNCATE triggers are not
-- cloned. The partition that exists precisely for when maintenance has stopped is
-- the worst one to leave unprotected. Its TRUNCATE trigger is created further down,
-- with the parent's, because the function it executes does not exist yet here.
ALTER TABLE audit.events_default ENABLE ROW LEVEL SECURITY;
-- SOURCE: FORCE ROW LEVEL SECURITY subjects the table owner to policies — and a partition with RLS on and NO policy is deny-all for direct access [corpus: postgres/rls-force]
ALTER TABLE audit.events_default FORCE ROW LEVEL SECURITY;

-- The read path's sort order, DESC to match it exactly: newest first, id breaking
-- ties because occurred_at is not unique and a keyset cursor over a non-unique key
-- skips or repeats rows at page boundaries. The PK cannot serve this (a PRIMARY KEY
-- has no direction), which is why both exist.
CREATE INDEX events_org_recent_idx ON audit.events (org_id, occurred_at DESC, id DESC);

ALTER TABLE audit.events ENABLE ROW LEVEL SECURITY;
-- FORCE, so the table OWNER is subject to the policies too — including, and this is
-- the point, the owner of any SECURITY DEFINER function that writes here.
-- SOURCE: FORCE ROW LEVEL SECURITY subjects the table owner to policies [corpus: postgres/rls-force]
ALTER TABLE audit.events FORCE ROW LEVEL SECURITY;

-- Layer 2. No client role reaches this table by any grant. service_role is included
-- explicitly even though it BYPASSES RLS: the bypass makes policies irrelevant to it,
-- so the GRANT is the only control that binds it at all.
REVOKE ALL ON TABLE audit.events FROM PUBLIC;
REVOKE ALL ON TABLE audit.events FROM anon, authenticated, service_role;
GRANT INSERT ON TABLE audit.events TO app_audit_writer;
GRANT SELECT ON TABLE audit.events TO app_audit_reader;

-- ─────────────────────────────────────────────────────────────────────────────
-- Layers 3 and 4: immutability that survives BYPASSRLS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION audit.deny_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $deny$
BEGIN
  RAISE EXCEPTION 'audit.events is append-only (% on % refused)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '42501',
          HINT = 'Rows are never updated or deleted. Remove history by dropping a partition: audit.drop_partitions_older_than(interval).';
END
$deny$;

-- SECURITY INVOKER by construction (no SECURITY DEFINER clause): it raises rather
-- than reading or writing anything, so it needs no authority of its own, and a
-- definer here would be an owned object with nothing to own.
REVOKE ALL ON FUNCTION audit.deny_mutation() FROM PUBLIC;

-- Layer 3. Cloned automatically to every partition, present and future — verified.
CREATE TRIGGER events_immutable
  BEFORE UPDATE OR DELETE ON audit.events
  FOR EACH ROW EXECUTE FUNCTION audit.deny_mutation();

-- Layer 4 on the parent. FOR EACH STATEMENT because TRUNCATE removes rows without
-- ever producing an OLD/NEW pair, so a row trigger — including the one directly
-- above — cannot see it. This one is NOT cloned to partitions; ensure_partitions()
-- creates the per-partition twin.
CREATE TRIGGER events_no_truncate
  BEFORE TRUNCATE ON audit.events
  FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();

-- Layer 4 on the DEFAULT partition — the twin of what ensure_partitions() gives each
-- month. Without it `TRUNCATE audit.events_default` succeeds, and the default
-- partition is exactly where the rows accumulate when the maintenance job has stopped.
CREATE TRIGGER events_default_no_truncate
  BEFORE TRUNCATE ON audit.events_default
  FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();

-- ─────────────────────────────────────────────────────────────────────────────
-- Policies
-- ─────────────────────────────────────────────────────────────────────────────
-- INSERT, and the predicate is the whole reason the writer role can be trusted with
-- the trail. It asserts that the row's actor_id matches the DATABASE's opinion of who
-- is acting — so even a caller who somehow reached app_audit_writer could not write a
-- row blaming somebody else. `IS NOT DISTINCT FROM` rather than `=` because a system
-- write legitimately has no JWT and both sides are then NULL, which `=` answers NULL
-- (i.e. deny) and would make signup provisioning fail.
--
-- The policy says auth.uid() while audit.write_row()'s BODY says private.caller_id().
-- That asymmetry is deliberate and is documented in the tenancy spine: a policy
-- expression is parsed once as `postgres` and stored by OID, so evaluating it never
-- re-checks USAGE on schema `auth`; a function body is parsed in the caller's own
-- privilege context, where app_audit_writer cannot resolve the name at all.
-- SOURCE: a policy predicate resolves identity through the hoisted scalar sub-select, and request.jwt.claims is role-switch-independent [corpus: postgres/rls-initplan]
CREATE POLICY events_insert_writer ON audit.events
  AS PERMISSIVE FOR INSERT TO app_audit_writer
  WITH CHECK (actor_id IS NOT DISTINCT FROM (SELECT auth.uid()));

-- SELECT, rank >= 30 (admin) in the reviewed rank-floor form: one uncorrelated scalar
-- sub-select the planner hoists into a single InitPlan per statement, never a
-- per-row lookup. This is the ONLY read path into the trail, and it is reached only
-- through public.org_audit_events() — authenticated holds no USAGE on this schema.
-- SOURCE: the initPlan sub-select pattern — one evaluation per statement, not per row [corpus: postgres/rls-initplan]
CREATE POLICY events_select_admin ON audit.events
  AS PERMISSIVE FOR SELECT TO app_audit_reader
  USING (coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 30);

-- THE PAIRING WITHOUT WHICH THE POLICY ABOVE READS EMPTY AND REPORTS SUCCESS.
-- private.member_ranks() is SECURITY INVOKER, so during the definer read it queries
-- public.memberships AS app_audit_reader. With no SELECT policy for that role the
-- read hits RLS default-deny, the helper returns an empty map, every rank comparison
-- is false, and org_audit_events() returns ZERO ROWS to a legitimate admin — with no
-- error anywhere. Self-only, and helper-free: auth.uid() is GUC-derived and therefore
-- still resolves to the human caller inside the definer, and a helper here would be
-- re-entered by the helper that called it.
-- SOURCE: FORCE ROW LEVEL SECURITY subjects the table owner to policies [corpus: postgres/rls-force]
CREATE POLICY memberships_select_audit_reader ON public.memberships
  AS PERMISSIVE FOR SELECT TO app_audit_reader
  USING (user_id = (SELECT auth.uid()));

GRANT SELECT ON TABLE public.memberships TO app_audit_reader;
GRANT EXECUTE ON FUNCTION private.member_ranks() TO app_audit_reader;
GRANT EXECUTE ON FUNCTION private.caller_id() TO app_audit_writer, app_audit_reader;

-- ─────────────────────────────────────────────────────────────────────────────
-- audit.write_row() — the only thing that ever inserts
-- ─────────────────────────────────────────────────────────────────────────────
-- Trigger arguments, positionally:
--   TG_ARGV[0]  the TENANT column on the audited table ('org_id'; 'id' on public.orgs,
--               whose own primary key IS the tenant key)
--   TG_ARGV[1]  the IDENTITY column recorded as row_id
--   TG_ARGV[2…] columns whose VALUES are captured, per-column opt-in, mirrored in
--               tools/audit-columns.json and refused for anything in
--               tools/pii-columns.json
--
-- Declaring capture as trigger arguments rather than a config table is deliberate on
-- two counts: it is visible in the migration diff a reviewer reads, and it costs
-- nothing at runtime — there is no per-row lookup on the write path of every table.
CREATE FUNCTION audit.write_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $write$
DECLARE
  _tenant_column text := TG_ARGV[0];
  _identity_column text := TG_ARGV[1];
  _new jsonb;
  _old jsonb;
  _org uuid;
  _changed text[] := '{}';
  _payload jsonb := '{}'::jsonb;
  _headers jsonb;
  _raw_headers text;
  _col text;
  _i int;
BEGIN
  IF TG_OP <> 'DELETE' THEN _new := to_jsonb(NEW); END IF;
  IF TG_OP <> 'INSERT' THEN _old := to_jsonb(OLD); END IF;

  _org := coalesce(_new ->> _tenant_column, _old ->> _tenant_column)::uuid;
  -- A row that reaches the trail with no tenant is a row nobody can ever be shown,
  -- because every read filters by org. Raising is correct rather than defensive: it
  -- means the trigger was attached with the wrong tenant column, which is a migration
  -- bug that must not be discovered years later as a silently empty history.
  IF _org IS NULL THEN
    RAISE EXCEPTION 'audit.write_row: % has no tenant column %', TG_TABLE_NAME, _tenant_column
      USING ERRCODE = '23502';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT coalesce(array_agg(k ORDER BY k), '{}')
      INTO _changed
      FROM jsonb_object_keys(_new) AS k
     WHERE _new -> k IS DISTINCT FROM _old -> k;
  END IF;

  _i := 2;
  WHILE _i < TG_NARGS LOOP
    _col := TG_ARGV[_i];
    _payload := _payload || jsonb_build_object(_col, jsonb_build_object('old', _old -> _col, 'new', _new -> _col));
    _i := _i + 1;
  END LOOP;

  -- The server-minted correlation id ONLY. `x-request-id` is deliberately not read:
  -- it is set by proxies and by callers, so joining a compliance trail on it would
  -- mean joining on a value the subject of the investigation can choose.
  --
  -- THE PARSE MUST BE TOTAL, and the naive `::jsonb` cast is not. `request.headers` is
  -- a GUC — PostgREST writes JSON into it, but nothing in the database constrains it,
  -- and a cast of a non-JSON value raises 22P02 INSIDE THIS TRIGGER. That aborts the
  -- statement that fired it, which means one malformed GUC stops every INSERT, UPDATE
  -- and DELETE on every audited table in the product. An audit trail is a passive
  -- observer: it may refuse to record a write it cannot attribute (the tenant check
  -- above), but it must never be the reason an otherwise valid write fails.
  -- pg_input_is_valid rather than a BEGIN/EXCEPTION block: exception handling opens a
  -- subtransaction per audited row, and this is the write path of every table.
  -- SOURCE: https://www.postgresql.org/docs/17/functions-info.html (pg_input_is_valid tests a cast without raising)
  _raw_headers := current_setting('request.headers', true);
  IF _raw_headers IS NOT NULL AND pg_input_is_valid(_raw_headers, 'jsonb') THEN
    _headers := _raw_headers::jsonb;
  END IF;

  INSERT INTO audit.events (org_id, actor_id, action, table_name, row_id, changed_columns, payload, request_id)
  VALUES (
    _org,
    private.caller_id(),
    TG_OP,
    TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
    coalesce(_new ->> _identity_column, _old ->> _identity_column),
    _changed,
    _payload,
    _headers ->> 'x-harness-request-id'
  );

  -- AFTER triggers ignore the return value; NULL is the conventional spelling.
  RETURN NULL;
END
$write$;

ALTER FUNCTION audit.write_row() OWNER TO app_audit_writer;
-- A trigger function is invoked by the executor, which does NOT re-check EXECUTE at
-- fire time — verified. So revoking PUBLIC costs nothing operationally and removes
-- the RPC surface entirely: without this, `POST /rest/v1/rpc/write_row` exists.
REVOKE ALL ON FUNCTION audit.write_row() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.write_row() FROM anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- Partition maintenance
-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY INVOKER, deliberately: creating a partition requires ownership of
-- audit.events, so the function grants nobody anything they did not already have.
-- pg_cron runs it as `postgres`, which owns the table.
CREATE FUNCTION audit.ensure_partitions(_months_ahead int DEFAULT 3)
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $ensure$
DECLARE
  _i int := 0;
  _created int := 0;
  _start date;
  _stop date;
  _name text;
BEGIN
  WHILE _i <= _months_ahead LOOP
    _start := (date_trunc('month', now()) + (_i || ' months')::interval)::date;
    _stop := (_start + interval '1 month')::date;
    _name := 'events_' || to_char(_start, 'YYYY_MM');

    IF to_regclass('audit.' || quote_ident(_name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE audit.%I PARTITION OF audit.events FOR VALUES FROM (%L) TO (%L)',
        _name, _start, _stop
      );
      -- Direct access to a partition is judged by the PARTITION's own RLS, not the
      -- parent's — verified. Enabled with zero policies, a partition therefore denies
      -- every direct read while writes routed through the parent are unaffected,
      -- because those are judged by the parent. This is the positive control on the
      -- breach described at the top of this file, rather than a reliance on the
      -- schema staying unpublished.
      EXECUTE format('ALTER TABLE audit.%I ENABLE ROW LEVEL SECURITY', _name);
      -- SOURCE: FORCE ROW LEVEL SECURITY subjects the table owner to policies; a partition carrying RLS with no policy of its own is deny-all for direct access [corpus: postgres/rls-force]
      EXECUTE format('ALTER TABLE audit.%I FORCE ROW LEVEL SECURITY', _name);
      -- Layer 4's per-partition twin. PostgreSQL does not clone TRUNCATE triggers to
      -- partitions, so without this the trail is emptiable one month at a time.
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE TRUNCATE ON audit.%I FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation()',
        _name || '_no_truncate', _name
      );
      _created := _created + 1;
    END IF;
    _i := _i + 1;
  END LOOP;
  RETURN _created;
END
$ensure$;

-- Retention. The ONLY sanctioned way rows ever leave the trail, and it is DDL: it
-- requires ownership of audit.events, which no application role holds, and it removes
-- a whole month at a known boundary rather than a row somebody wanted gone.
--
-- The cutoff is derived from the partition NAME rather than from relpartbound,
-- because ensure_partitions() owns the naming and a name is unambiguous where parsing
-- a bound expression is not. events_default does not match the pattern and is
-- therefore never a candidate — which is correct: it holds exactly the rows whose
-- month is unknown.
CREATE FUNCTION audit.drop_partitions_older_than(_keep interval DEFAULT interval '24 months')
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $retain$
DECLARE
  _dropped int := 0;
  _rec record;
  _month date;
BEGIN
  FOR _rec IN
    SELECT c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid
     WHERE i.inhparent = 'audit.events'::regclass
     ORDER BY c.relname
  LOOP
    _month := to_date(substring(_rec.relname from 'events_([0-9]{4}_[0-9]{2})$'), 'YYYY_MM');
    IF _month IS NOT NULL AND _month < date_trunc('month', now() - _keep) THEN
      EXECUTE format('ALTER TABLE audit.events DETACH PARTITION audit.%I', _rec.relname);
      EXECUTE format('DROP TABLE audit.%I', _rec.relname);
      _dropped := _dropped + 1;
    END IF;
  END LOOP;
  RETURN _dropped;
END
$retain$;

REVOKE ALL ON FUNCTION audit.ensure_partitions(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.ensure_partitions(int) FROM anon, authenticated;
REVOKE ALL ON FUNCTION audit.drop_partitions_older_than(interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.drop_partitions_older_than(interval) FROM anon, authenticated;

-- Create the current month plus three, at apply time, so the DEFAULT partition starts
-- and stays empty. Not DML — the function emits DDL.
SELECT audit.ensure_partitions(3);

-- ─────────────────────────────────────────────────────────────────────────────
-- The read path
-- ─────────────────────────────────────────────────────────────────────────────
-- `_org` is a SELECTOR, not an authorization input. Authorization is the SELECT
-- policy on audit.events (rank >= 30), evaluated as app_audit_reader with the human
-- caller's identity still resolving through the JWT GUC — so naming an org the caller
-- does not administer returns the empty set. The parameter can only ever narrow what
-- the policy already allows, which is why it is safe for it to be caller-supplied.
CREATE FUNCTION public.org_audit_events(
  _org uuid,
  _before timestamptz DEFAULT NULL,
  _limit int DEFAULT 50
)
RETURNS TABLE (
  id bigint,
  occurred_at timestamptz,
  actor_id uuid,
  action text,
  table_name text,
  row_id text,
  changed_columns text[],
  payload jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $read$
  SELECT e.id, e.occurred_at, e.actor_id, e.action, e.table_name, e.row_id, e.changed_columns, e.payload
    FROM audit.events e
   WHERE e.org_id = _org
     AND (_before IS NULL OR e.occurred_at < _before)
   ORDER BY e.occurred_at DESC, e.id DESC
   -- Unconditional and clamped: a caller-supplied limit is a caller-supplied amount
   -- of work, and NULL would mean no limit at all.
   LIMIT least(coalesce(_limit, 50), 200);
$read$;

ALTER FUNCTION public.org_audit_events(uuid, timestamptz, int) OWNER TO app_audit_reader;
REVOKE ALL ON FUNCTION public.org_audit_events(uuid, timestamptz, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.org_audit_events(uuid, timestamptz, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.org_audit_events(uuid, timestamptz, int) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- The closure: every org-scoped table is audited
-- ─────────────────────────────────────────────────────────────────────────────
-- AFTER, so a failed write leaves no audit row; FOR EACH ROW, so the record is
-- per-row rather than per-statement; and NO `WHEN` CLAUSE, ever. A conditional audit
-- trigger is a trail with a documented blind spot whose condition is written by
-- exactly the person the trail exists to record. tools/check-tenancy.mjs rejects one.
--
-- The trigger name pattern <table>_audit is what the gate closes over, so a new
-- org-scoped table without one reds at authoring time rather than at the first audit.
CREATE TRIGGER notes_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION audit.write_row('org_id', 'id');

-- The org table's own primary key IS the tenant key, so the tenant column is 'id'.
CREATE TRIGGER orgs_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.orgs
  FOR EACH ROW EXECUTE FUNCTION audit.write_row('id', 'id');

-- Seat changes are the most compliance-relevant events in the system, and role_rank
-- is the one value worth capturing: WHO was promoted TO WHAT is the question asked
-- after an incident, and "role_rank changed" without the rank does not answer it.
-- It is a small integer from a closed set, not personal data — the opt-in that
-- tools/pii-columns.json exists to keep rare.
CREATE TRIGGER memberships_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION audit.write_row('org_id', 'user_id', 'role_rank');

CREATE TRIGGER invitations_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.invitations
  FOR EACH ROW EXECUTE FUNCTION audit.write_row('org_id', 'id', 'role_rank');

-- ─────────────────────────────────────────────────────────────────────────────
-- Retention schedule
-- ─────────────────────────────────────────────────────────────────────────────
-- pg_cron RUNNING AS `postgres`, never an Edge Function: a function runs as
-- service_role, which cannot drop a postgres-owned partition, so the retention job
-- would fail silently on a schedule nobody watches.
--
-- Guarded rather than unconditional. pg_cron requires shared_preload_libraries and is
-- a per-project setting on hosted Supabase; a bare CREATE EXTENSION would make this
-- migration unappliable on any project without it, turning an operational nicety into
-- a deployment blocker. Without the extension the functions still exist and the
-- schedule is a documented manual step.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.schedule(
      'audit-ensure-partitions',
      '0 3 1 * *',
      $job$SELECT audit.ensure_partitions(3)$job$
    );
    PERFORM cron.schedule(
      'audit-drop-old-partitions',
      '30 3 1 * *',
      $job$SELECT audit.drop_partitions_older_than(interval '24 months')$job$
    );
  ELSE
    RAISE NOTICE 'pg_cron unavailable: schedule audit.ensure_partitions(3) and audit.drop_partitions_older_than() manually (see docs/adr/20260202-audit-trail.md)';
  END IF;
EXCEPTION
  WHEN insufficient_privilege OR feature_not_supported THEN
    RAISE NOTICE 'pg_cron present but not schedulable here (%); schedule the audit partition jobs manually', SQLERRM;
END
$cron$;
