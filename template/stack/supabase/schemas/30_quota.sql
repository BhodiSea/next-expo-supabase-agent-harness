-- supabase/schemas/30_quota.sql — per-org quota: the ceiling, the counter, the default.
--
-- DECLARATIVE FILE — see 00_shared.sql for how this directory relates to
-- supabase/migrations/ and what the diff engine does not see. The forward step, the
-- enforcement trigger and the full design argument are
-- supabase/migrations/20260203000000_quota.sql; the decision record is
-- docs/adr/20260203-resource-limits.md.
--
-- As in 05_tenancy.sql and 40_audit.sql, everything naming a role that only a
-- migration creates (app_quota_writer's grants and policies, the SECURITY DEFINER
-- enforcement functions) lives in the migration rather than here: `supabase db diff`
-- builds this directory in a SHADOW database that has never run one, so a reference to
-- app_quota_writer would make the drift check fail to run at all.

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
GRANT SELECT ON TABLE public.quota_defaults TO authenticated;

-- Readable by every signed-in caller: a client that cannot see the ceiling cannot show
-- "you are at 80% of your plan", and the value is a published product fact rather than
-- tenant data. There is no tenant dimension to isolate, which is why it is registered
-- in tools/rls-exempt.json (the isolation MATRIX has nothing to prove here) and in
-- tools/tenancy.json untenantedTables. Writes are deny-all: changing a default is a
-- migration.
-- SOURCE: the initPlan sub-select pattern — one evaluation per statement, not per row [corpus: postgres/rls-initplan]
CREATE POLICY quota_defaults_select_all ON public.quota_defaults
  AS PERMISSIVE FOR SELECT TO authenticated
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

-- The negotiated ceiling for one org. Absent means "use quota_defaults".
CREATE TABLE public.org_quota (
  org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  metric text NOT NULL REFERENCES public.quota_defaults (metric) ON DELETE CASCADE,
  hard_limit bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_quota_limit_positive CHECK (hard_limit > 0),
  PRIMARY KEY (org_id, metric)
);

-- The counter. Maintained by a statement-level trigger on every metered table and
-- recomputed nightly from count(*), because every incrementing counter drifts.
CREATE TABLE public.org_usage (
  org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  metric text NOT NULL REFERENCES public.quota_defaults (metric) ON DELETE CASCADE,
  used bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- No `used >= 0` CHECK, deliberately: a decrement that undershoots is a DRIFT
  -- symptom, and a constraint would turn that symptom into a failed DELETE — the
  -- user's work blocked by a bookkeeping fault.
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

-- SELECT only. A tenant that can raise its own limit, or zero its own counter, has no
-- quota — so there is no client write path to either table at all.
GRANT SELECT ON TABLE public.org_quota TO authenticated;
GRANT SELECT ON TABLE public.org_usage TO authenticated;

-- SOURCE: the initPlan sub-select pattern — one evaluation per statement, not per row [corpus: postgres/rls-initplan]
CREATE POLICY org_quota_select_member ON public.org_quota
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (org_id = ANY((SELECT private.member_org_ids())::uuid[]));
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

-- The tenant column leads both indexes: every policy filters by it on every statement.
CREATE INDEX org_quota_org_idx ON public.org_quota (org_id, metric);
CREATE INDEX org_usage_org_idx ON public.org_usage (org_id, metric);
