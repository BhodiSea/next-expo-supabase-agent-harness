-- supabase/migrations/20260203000000_quota.sql — per-org quota, enforced in the
-- database rather than in whichever caller remembered to check.
--
-- adr: docs/adr/20260203-resource-limits.md
--
-- WHY THE DATABASE. A quota checked in a Server Action is a quota the tRPC procedure
-- does not have, and neither binds a mobile client reading PostgREST directly with its
-- own JWT. The only place every path passes through is the table, so the limit lives
-- on the table.
--
-- WHY A STATEMENT-LEVEL TRIGGER, AND NOT THE TWO OBVIOUS ALTERNATIVES. Both were
-- designed and rejected for reasons that are specific rather than stylistic:
--
--   A PER-ROW trigger serializes every insert behind one hot tuple — the org's usage
--   row — so a 1000-row import becomes 1000 sequential lock acquisitions and 1000 dead
--   tuples on a single page. The counter becomes the throughput ceiling of the whole
--   product.
--
--   A RESTRICTIVE POLICY calling a STABLE counting function is worse, because it fails
--   OPEN and looks fine. The planner hoists a STABLE call to one evaluation per
--   statement, against the PRE-STATEMENT count — so a single multi-row INSERT of any
--   size is judged as though it were the first row and passes wholesale. The
--   optimization defeats the control, silently, and only on the large writes that
--   matter.
--
-- An AFTER INSERT ... FOR EACH STATEMENT trigger with REFERENCING NEW TABLE sees every
-- row the statement produced, exactly once, and raising from it aborts the statement —
-- verified: a table holding 4 rows still held 4 after a refused insert.
-- SOURCE: https://www.postgresql.org/docs/17/sql-createtrigger.html (transition tables are visible to a statement-level trigger, including from dynamic SQL)

SET lock_timeout = '3s';

-- ─────────────────────────────────────────────────────────────────────────────
-- The writer role
-- ─────────────────────────────────────────────────────────────────────────────
-- A user must not be able to edit their own usage counter, so `authenticated` holds no
-- write grant on it and the trigger cannot run as the caller. Same shape as the audit
-- writer: NOLOGIN, reachable only as the owner of one SECURITY DEFINER function, and
-- holding policies drawn from the same closed form set as everything else.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_quota_writer') THEN
    CREATE ROLE app_quota_writer NOLOGIN;
  END IF;
END
$roles$;

GRANT app_quota_writer TO postgres;
-- CREATE on both schemas, not merely USAGE: reassigning ownership of a function to a
-- role requires that role to hold CREATE on the schema the function lives in, and the
-- enforcement triggers live in `private` while reconcile_org_usage() is in `public`.
GRANT USAGE, CREATE ON SCHEMA public TO app_quota_writer;
GRANT USAGE, CREATE ON SCHEMA private TO app_quota_writer;

-- ─────────────────────────────────────────────────────────────────────────────
-- Reference data: the default ceiling per metric
-- ─────────────────────────────────────────────────────────────────────────────
-- Global, deliberately untenanted: it is the ceiling that applies to an org with no
-- negotiated override, so giving it an org_id would mean a row per org per metric for
-- a value that is the same everywhere. Registered in tools/tenancy.json
-- untenantedTables with that reason.
CREATE TABLE public.quota_defaults (
  metric text PRIMARY KEY,
  hard_limit bigint NOT NULL,
  CONSTRAINT quota_defaults_metric_length CHECK (char_length(metric) BETWEEN 1 AND 64),
  CONSTRAINT quota_defaults_limit_positive CHECK (hard_limit > 0)
);

ALTER TABLE public.quota_defaults ENABLE ROW LEVEL SECURITY;
-- SOURCE: FORCE ROW LEVEL SECURITY subjects the table owner to policies [corpus: postgres/rls-force]
ALTER TABLE public.quota_defaults FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.quota_defaults FROM anon;
REVOKE ALL ON TABLE public.quota_defaults FROM service_role;
GRANT SELECT ON TABLE public.quota_defaults TO authenticated, app_quota_writer;

-- Readable by every signed-in caller: a client that cannot see the ceiling cannot show
-- "you are at 80% of your plan", and the value is a published product fact, not tenant
-- data. Writes go through no policy at all — changing a default is a migration.
-- SOURCE: the initPlan sub-select pattern — one evaluation per statement, not per row [corpus: postgres/rls-initplan]
CREATE POLICY quota_defaults_select_all ON public.quota_defaults
  AS PERMISSIVE FOR SELECT TO authenticated, app_quota_writer
  USING (true);

-- SOURCE: PostgreSQL row security — USING restricts which rows the role may reach [corpus: postgres/rls-force]
CREATE POLICY quota_defaults_insert_none ON public.quota_defaults
  AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (false);
-- SOURCE: PostgreSQL row security — USING restricts which rows the role may reach [corpus: postgres/rls-force]
CREATE POLICY quota_defaults_update_none ON public.quota_defaults
  AS PERMISSIVE FOR UPDATE TO authenticated USING (false);
-- SOURCE: PostgreSQL row security — USING restricts which rows the role may reach [corpus: postgres/rls-force]
CREATE POLICY quota_defaults_delete_none ON public.quota_defaults
  AS PERMISSIVE FOR DELETE TO authenticated USING (false);

-- No metric is seeded here. A metric's ceiling is reference data that arrives WITH the
-- table it meters, in that table's own migration (`-- harness-allow-dml:` marks the
-- INSERT): the quota is meaningless without a default, and a metered table whose
-- defaults row is missing enforces nothing while every gate stays green. The notes rails
-- migration `init --with-demo` plants is the worked example.

-- ─────────────────────────────────────────────────────────────────────────────
-- Per-org override and per-org counter
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.org_quota (
  org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  metric text NOT NULL REFERENCES public.quota_defaults (metric) ON DELETE CASCADE,
  hard_limit bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_quota_limit_positive CHECK (hard_limit > 0),
  PRIMARY KEY (org_id, metric)
);

CREATE TABLE public.org_usage (
  org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  metric text NOT NULL REFERENCES public.quota_defaults (metric) ON DELETE CASCADE,
  used bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- No `used >= 0` CHECK, deliberately. A decrement that undershoots is a DRIFT
  -- symptom, and a constraint that turns it into a failed DELETE would make the
  -- symptom block the user's work instead of showing up in reconciliation.
  PRIMARY KEY (org_id, metric)
);

CREATE TRIGGER org_quota_freeze_org
  BEFORE UPDATE ON public.org_quota
  FOR EACH ROW EXECUTE FUNCTION private.freeze_org_id();
CREATE TRIGGER org_usage_freeze_org
  BEFORE UPDATE ON public.org_usage
  FOR EACH ROW EXECUTE FUNCTION private.freeze_org_id();

ALTER TABLE public.org_quota ENABLE ROW LEVEL SECURITY;
-- SOURCE: FORCE ROW LEVEL SECURITY subjects the table owner to policies [corpus: postgres/rls-force]
ALTER TABLE public.org_quota FORCE ROW LEVEL SECURITY;
ALTER TABLE public.org_usage ENABLE ROW LEVEL SECURITY;
-- SOURCE: FORCE ROW LEVEL SECURITY subjects the table owner to policies [corpus: postgres/rls-force]
ALTER TABLE public.org_usage FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.org_quota FROM anon;
REVOKE ALL ON TABLE public.org_quota FROM service_role;
REVOKE ALL ON TABLE public.org_usage FROM anon;
REVOKE ALL ON TABLE public.org_usage FROM service_role;

-- Members READ their org's limit and usage; nobody writes either from the client.
GRANT SELECT ON TABLE public.org_quota TO authenticated;
GRANT SELECT ON TABLE public.org_usage TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.org_quota TO app_quota_writer;
GRANT SELECT, INSERT, UPDATE ON TABLE public.org_usage TO app_quota_writer;

-- SOURCE: the initPlan sub-select pattern — one evaluation per statement, not per row [corpus: postgres/rls-initplan]
CREATE POLICY org_quota_select_member ON public.org_quota
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (org_id = ANY((SELECT private.member_org_ids())::uuid[]));

-- Deny-all for every client write. A quota a tenant can raise is not a quota, and the
-- shape that lets them is a self-keyed UPDATE policy that looks perfectly scoped.
-- SOURCE: PostgreSQL row security — USING restricts which rows the role may reach [corpus: postgres/rls-force]
CREATE POLICY org_quota_insert_none ON public.org_quota
  AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (false);
-- SOURCE: PostgreSQL row security — USING restricts which rows the role may reach [corpus: postgres/rls-force]
CREATE POLICY org_quota_update_none ON public.org_quota
  AS PERMISSIVE FOR UPDATE TO authenticated USING (false);
-- SOURCE: PostgreSQL row security — USING restricts which rows the role may reach [corpus: postgres/rls-force]
CREATE POLICY org_quota_delete_none ON public.org_quota
  AS PERMISSIVE FOR DELETE TO authenticated USING (false);

-- SOURCE: the initPlan sub-select pattern — one evaluation per statement, not per row [corpus: postgres/rls-initplan]
CREATE POLICY org_usage_select_member ON public.org_usage
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (org_id = ANY((SELECT private.member_org_ids())::uuid[]));

-- SOURCE: PostgreSQL row security — USING restricts which rows the role may reach [corpus: postgres/rls-force]
CREATE POLICY org_usage_insert_none ON public.org_usage
  AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (false);
-- SOURCE: PostgreSQL row security — USING restricts which rows the role may reach [corpus: postgres/rls-force]
CREATE POLICY org_usage_update_none ON public.org_usage
  AS PERMISSIVE FOR UPDATE TO authenticated USING (false);
-- SOURCE: PostgreSQL row security — USING restricts which rows the role may reach [corpus: postgres/rls-force]
CREATE POLICY org_usage_delete_none ON public.org_usage
  AS PERMISSIVE FOR DELETE TO authenticated USING (false);

-- THE WRITER'S POLICIES, AND WHY THE ORDINARY SCOPE FORM IS THE RIGHT ONE HERE.
-- The enforcement trigger runs inside the caller's own transaction, so auth.uid() is
-- still the human — private.member_org_ids() therefore returns exactly the orgs whose
-- rows the statement was already allowed to write. The counter can only ever move for
-- an org RLS has already admitted the caller to, which is precisely the property a
-- reviewed scope form states. Nothing here needs a wider grant, and a wider one would
-- make the writer role a cross-tenant primitive reachable from any audited table.
-- SOURCE: the initPlan sub-select pattern — one evaluation per statement, not per row [corpus: postgres/rls-initplan]
CREATE POLICY org_usage_select_writer ON public.org_usage
  AS PERMISSIVE FOR SELECT TO app_quota_writer
  USING (org_id = ANY((SELECT private.member_org_ids())::uuid[]));
-- SOURCE: the initPlan sub-select pattern — one evaluation per statement, not per row [corpus: postgres/rls-initplan]
CREATE POLICY org_usage_insert_writer ON public.org_usage
  AS PERMISSIVE FOR INSERT TO app_quota_writer
  WITH CHECK (org_id = ANY((SELECT private.member_org_ids())::uuid[]));
-- SOURCE: the initPlan sub-select pattern — one evaluation per statement, not per row [corpus: postgres/rls-initplan]
CREATE POLICY org_usage_update_writer ON public.org_usage
  AS PERMISSIVE FOR UPDATE TO app_quota_writer
  USING (org_id = ANY((SELECT private.member_org_ids())::uuid[]))
  WITH CHECK (org_id = ANY((SELECT private.member_org_ids())::uuid[]));

-- SOURCE: the initPlan sub-select pattern — one evaluation per statement, not per row [corpus: postgres/rls-initplan]
CREATE POLICY org_quota_select_writer ON public.org_quota
  AS PERMISSIVE FOR SELECT TO app_quota_writer
  USING (org_id = ANY((SELECT private.member_org_ids())::uuid[]));

-- THE PAIRING, without which every quota check reads an empty rank/scope set and
-- passes. private.member_org_ids() is SECURITY INVOKER, so during the definer trigger
-- it reads public.memberships AS app_quota_writer; with no SELECT policy there the read
-- hits RLS default-deny, the scope array comes back empty, every policy above is false,
-- and the usage UPSERT matches nothing — which for an INSERT means 42501 on every
-- audited write, and for the check means a limit that never binds. Self-only and
-- helper-free, because auth.uid() is GUC-derived and still resolves to the human.
-- SOURCE: FORCE ROW LEVEL SECURITY subjects the table owner to policies [corpus: postgres/rls-force]
CREATE POLICY memberships_select_quota_writer ON public.memberships
  AS PERMISSIVE FOR SELECT TO app_quota_writer
  USING (user_id = (SELECT auth.uid()));

GRANT SELECT ON TABLE public.memberships TO app_quota_writer;
GRANT EXECUTE ON FUNCTION private.member_org_ids() TO app_quota_writer;
GRANT EXECUTE ON FUNCTION private.caller_id() TO app_quota_writer;

CREATE INDEX org_quota_org_idx ON public.org_quota (org_id, metric);
CREATE INDEX org_usage_org_idx ON public.org_usage (org_id, metric);

-- ─────────────────────────────────────────────────────────────────────────────
-- Enforcement
-- ─────────────────────────────────────────────────────────────────────────────
-- Generic over (metric, tenant column) so a second metered table adopts it by adding
-- two triggers and one quota_defaults row, not by copying this function.
--   TG_ARGV[0]  the metric name
--   TG_ARGV[1]  the tenant column on the audited table
CREATE FUNCTION private.enforce_org_quota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $enforce$
DECLARE
  _metric text := TG_ARGV[0];
  _tenant_column text := TG_ARGV[1];
  _over text;
BEGIN
  -- A zero-row statement still fires a statement-level trigger — verified — so
  -- without this the counter row is locked for a write that added nothing, turning
  -- every no-op insert into contention on the org's hottest tuple.
  IF NOT EXISTS (SELECT 1 FROM new_rows) THEN
    RETURN NULL;
  END IF;

  -- ONE upsert, not SELECT-then-UPDATE. The upsert takes the row lock and applies the
  -- delta atomically, so two concurrent statements cannot both read the same
  -- pre-value; ORDER BY makes the lock acquisition order deterministic across
  -- statements, which is what removes the deadlock class rather than merely making it
  -- rare. (A multi-org statement is the case that needs it: two transactions touching
  -- orgs A and B in opposite orders deadlock without a total order.)
  EXECUTE format($sql$
    WITH added AS (
      SELECT %I AS org_id, count(*)::bigint AS delta
        FROM new_rows
       GROUP BY 1
    ), applied AS (
      INSERT INTO public.org_usage (org_id, metric, used, updated_at)
      SELECT a.org_id, $1, a.delta, pg_catalog.now() FROM added a ORDER BY a.org_id
      ON CONFLICT (org_id, metric) DO UPDATE
        SET used = public.org_usage.used + excluded.used, updated_at = pg_catalog.now()
      RETURNING org_id, used
    )
    SELECT pg_catalog.string_agg(
             ap.org_id::text || ' (' || ap.used || '/' || coalesce(q.hard_limit, d.hard_limit) || ')',
             ', ' ORDER BY ap.org_id::text)
      FROM applied ap
      CROSS JOIN LATERAL (SELECT hard_limit FROM public.quota_defaults WHERE metric = $1) d
      LEFT JOIN public.org_quota q ON q.org_id = ap.org_id AND q.metric = $1
     WHERE ap.used > coalesce(q.hard_limit, d.hard_limit)
  $sql$, _tenant_column)
  INTO _over
  USING _metric;

  IF _over IS NOT NULL THEN
    -- 53400 configuration_limit_exceeded, and deliberately NOT a rate-limit code: a
    -- quota is not retryable and has an upgrade path, so a client that conflates the
    -- two enters a retry loop that can never succeed.
    RAISE EXCEPTION 'quota exceeded for metric % — %', _metric, _over
      USING ERRCODE = '53400',
            HINT = 'Raise public.org_quota.hard_limit for this org, or remove rows.';
  END IF;

  RETURN NULL;
END
$enforce$;

ALTER FUNCTION private.enforce_org_quota() OWNER TO app_quota_writer;
REVOKE ALL ON FUNCTION private.enforce_org_quota() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enforce_org_quota() FROM anon;

-- The decrement. Same shape, opposite sign, and it never raises: freeing rows can only
-- move usage down, and a DELETE that failed because a counter looked wrong would make
-- a bookkeeping fault into an outage.
CREATE FUNCTION private.release_org_quota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $release$
DECLARE
  _metric text := TG_ARGV[0];
  _tenant_column text := TG_ARGV[1];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM old_rows) THEN
    RETURN NULL;
  END IF;

  EXECUTE format($sql$
    WITH removed AS (
      SELECT %I AS org_id, count(*)::bigint AS delta FROM old_rows GROUP BY 1
    )
    UPDATE public.org_usage u
       SET used = greatest(u.used - r.delta, 0), updated_at = pg_catalog.now()
      FROM removed r
     WHERE u.org_id = r.org_id AND u.metric = $1
  $sql$, _tenant_column)
  USING _metric;

  RETURN NULL;
END
$release$;

ALTER FUNCTION private.release_org_quota() OWNER TO app_quota_writer;
REVOKE ALL ON FUNCTION private.release_org_quota() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.release_org_quota() FROM anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- Reconciliation
-- ─────────────────────────────────────────────────────────────────────────────
-- EVERY incrementing counter drifts. A trigger disabled for a bulk load, a restore
-- from a logical dump, a partition detached, a bug in a decrement — each leaves the
-- counter and the truth apart, and the two directions fail differently: drift UP
-- blocks a paying customer from writing rows they are entitled to, drift DOWN gives
-- the product away. Recomputing from count(*) is the only thing that closes both.
--
-- Not generic: it names each metric's source table explicitly, because a function that
-- took a table name from a caller would be a definer that runs arbitrary SQL as its
-- owner. No table is metered yet, so it reconciles nothing. Adding a metric means
-- replacing this function in the metered table's own reviewed migration, with one
-- recount per metric (the notes rails migration `init --with-demo` plants is the worked
-- example): CREATE OR REPLACE keeps the owner and the revokes below.
CREATE FUNCTION public.reconcile_org_usage()
RETURNS TABLE (metric_name text, orgs_corrected bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $reconcile$
BEGIN
  RETURN;
END
$reconcile$;

-- DELIBERATELY NOT REASSIGNED TO app_quota_writer, and this is the one ownership
-- decision in the file that must not be "tidied up" for consistency.
--
-- Reconciliation is inherently a whole-database read: it recomputes every org's usage
-- from count(*) over every row. A tenant-scoped owner cannot do that, and the way it
-- FAILS is silent and catastrophic. app_quota_writer's policies resolve through
-- private.member_org_ids(), which derives from auth.uid() — and pg_cron runs with no
-- JWT at all. The scope array would come back EMPTY, the truth CTE would produce zero
-- rows, and the second statement below would then set every counter in the database to
-- zero. Every quota in the product would silently become unlimited, on a schedule,
-- with no error anywhere.
--
-- So it stays owned by `postgres` (the role that created it, which holds BYPASSRLS),
-- and safety comes from unreachability instead: EXECUTE is revoked from PUBLIC, anon
-- and authenticated, so no client can call it by any path. tools/check-db-limits.mjs
-- reds if an ALTER FUNCTION ever reassigns it.
REVOKE ALL ON FUNCTION public.reconcile_org_usage() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_org_usage() FROM anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Wiring a metered table
-- ─────────────────────────────────────────────────────────────────────────────
-- A metered table attaches two statement-level triggers in its own migration:
--   AFTER INSERT ... REFERENCING NEW TABLE AS new_rows
--     FOR EACH STATEMENT EXECUTE FUNCTION private.enforce_org_quota('<metric>', 'org_id')
--   AFTER DELETE ... REFERENCING OLD TABLE AS old_rows
--     FOR EACH STATEMENT EXECUTE FUNCTION private.release_org_quota('<metric>', 'org_id')

-- The limit is a commercial fact about a customer, so changing one is an auditable
-- act. org_usage is deliberately NOT audited — it is a derived counter that moves on
-- every metered write, and the underlying write is already in the trail; auditing it
-- would record the same event twice and double the trail's volume. Registered in
-- tools/tenancy.json auditExemptTables with that reason.
CREATE TRIGGER org_quota_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.org_quota
  FOR EACH ROW EXECUTE FUNCTION audit.write_row('org_id', 'metric', 'hard_limit');

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('quota-reconcile', '15 4 * * *', $job$SELECT public.reconcile_org_usage()$job$);
  ELSE
    RAISE NOTICE 'pg_cron unavailable: schedule public.reconcile_org_usage() nightly by hand';
  END IF;
EXCEPTION
  WHEN insufficient_privilege OR feature_not_supported THEN
    RAISE NOTICE 'pg_cron present but not schedulable here (%); schedule reconcile_org_usage() manually', SQLERRM;
END
$cron$;
