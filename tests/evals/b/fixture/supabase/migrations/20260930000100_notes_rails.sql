-- 20260930000100_notes_rails — attach the tenancy spine's rails to the worked example's
-- table: the audit trail, the per-org quota, the second-factor gate and the three-role
-- grant shape.
--
-- WHY A MIGRATION OF ITS OWN (2.0.0). Through 1.x these lines lived inside the spine
-- migrations that define each rail (audit, quota, mfa_aal2, three_role_revoke), so the
-- example could not be removed without editing applied history. The worked example now
-- ships only with `init --with-demo`, and `eject` removes it again, so every line that
-- names public.notes lives in the demo's own migrations: the spine is the same file in
-- every install, and the demo's history can leave as a unit. Timestamped after every
-- migration that defines a rail used here: audit.write_row (20260202000000),
-- private.enforce_org_quota and private.release_org_quota (20260203000000),
-- private.mfa_satisfied (20260812000000) and the three-role doctrine (20260930000000).
--
-- APPLIED HISTORY, NOT DESIRED STATE. Append-only like every other migration here.
-- adr: docs/adr/20260930-three-role-revoke.md
-- SOURCE: docs/adr/20260202-audit-trail.md
-- SOURCE: docs/adr/20260203-resource-limits.md
-- SOURCE: docs/adr/20260812-mfa-aal2.md

-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on a table that may already be serving
-- traffic, so the file fails fast rather than queueing every writer behind an open
-- transaction. Plain SET, never SET LOCAL: the Supabase CLI applies migrations outside an
-- explicit transaction block, where SET LOCAL warns and sets nothing.
SET lock_timeout = '3s';

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit: every org-scoped table is audited
-- ─────────────────────────────────────────────────────────────────────────────
-- AFTER, so a failed write leaves no audit row; FOR EACH ROW, so the record is per-row
-- rather than per-statement; and NO `WHEN` CLAUSE, ever (tools/check-tenancy.mjs rejects
-- one). The <table>_audit name is what the gate closes over.
CREATE TRIGGER notes_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION audit.write_row('org_id', 'id');

-- ─────────────────────────────────────────────────────────────────────────────
-- Quota: the metric, its recount, and the two statement-level triggers
-- ─────────────────────────────────────────────────────────────────────────────
-- harness-allow-dml: the seeded metric ceiling is reference data, not fixtures — the
-- quota is meaningless without a default, and an install whose defaults table is empty
-- would enforce nothing while every gate stayed green.
INSERT INTO public.quota_defaults (metric, hard_limit) VALUES ('notes', 10000);

-- Replaces the spine's empty recount with one that names its source table explicitly: a
-- function that took a table name from a caller would be a definer that runs arbitrary
-- SQL as its owner. CREATE OR REPLACE keeps the owner (`postgres`, deliberately never
-- app_quota_writer — see 20260203000000_quota.sql) and the revokes; they are restated
-- below so this file reads whole.
CREATE OR REPLACE FUNCTION public.reconcile_org_usage()
RETURNS TABLE (metric_name text, orgs_corrected bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $reconcile$
DECLARE
  _corrected bigint;
BEGIN
  WITH truth AS (
    SELECT n.org_id, count(*)::bigint AS used FROM public.notes n GROUP BY 1
  ), upserted AS (
    INSERT INTO public.org_usage (org_id, metric, used, updated_at)
    SELECT t.org_id, 'notes', t.used, pg_catalog.now() FROM truth t ORDER BY t.org_id
    ON CONFLICT (org_id, metric) DO UPDATE
      SET used = excluded.used, updated_at = pg_catalog.now()
      WHERE public.org_usage.used IS DISTINCT FROM excluded.used
    RETURNING 1
  )
  SELECT count(*) INTO _corrected FROM upserted;

  -- An org whose rows are all gone must fall to zero rather than keep its last value:
  -- the truth CTE has no row for it, so the upsert above cannot reach it.
  UPDATE public.org_usage u
     SET used = 0, updated_at = pg_catalog.now()
   WHERE u.metric = 'notes'
     AND u.used <> 0
     AND NOT EXISTS (SELECT 1 FROM public.notes n WHERE n.org_id = u.org_id);

  metric_name := 'notes';
  orgs_corrected := _corrected;
  RETURN NEXT;
END
$reconcile$;

REVOKE ALL ON FUNCTION public.reconcile_org_usage() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_org_usage() FROM anon, authenticated;

CREATE TRIGGER notes_quota_add
  AFTER INSERT ON public.notes
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION private.enforce_org_quota('notes', 'org_id');

CREATE TRIGGER notes_quota_release
  AFTER DELETE ON public.notes
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION private.release_org_quota('notes', 'org_id');

-- ─────────────────────────────────────────────────────────────────────────────
-- AAL2: a restrictive policy on the whole table
-- ─────────────────────────────────────────────────────────────────────────────
-- Both USING and WITH CHECK, because USING alone governs which existing rows are visible
-- and would let an aal1 session INSERT rows it then cannot see.
-- SOURCE: PostgreSQL row security — a RESTRICTIVE policy is ANDed with the permissive
-- set, so it can only ever remove rows [corpus: postgres/rls-force]
CREATE POLICY notes_mfa_aal2 ON public.notes
  AS RESTRICTIVE TO authenticated
  USING ((SELECT private.mfa_satisfied()))
  WITH CHECK ((SELECT private.mfa_satisfied()));

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants: the three-role doctrine
-- ─────────────────────────────────────────────────────────────────────────────
-- 20260101000100_notes.sql created the table with the older two-revoke shape, so
-- authenticated still held the platform default (TRUNCATE, REFERENCES, TRIGGER and, on
-- PostgreSQL 17, MAINTAIN), none of which any policy admits. REVOKE ALL, then re-GRANT
-- the four verbs its policies admit, in one transaction.
-- SOURCE: https://www.postgresql.org/docs/17/ddl-priv.html
REVOKE ALL ON TABLE public.notes FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notes TO authenticated;
