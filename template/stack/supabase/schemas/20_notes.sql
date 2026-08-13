-- supabase/schemas/20_notes.sql — the seeded reference vertical.
--
-- DECLARATIVE FILE — see 00_shared.sql for how this directory relates to
-- supabase/migrations/ and what the diff engine does not see.
--
-- This is the shape every later vertical is copied from, so every rule the harness
-- enforces is visible in it exactly once: FORCE row security, four per-operation
-- policies, no vacuous predicate, predicates drawn from the closed form set in
-- tools/tenancy.json, a freeze trigger on the tenant key, and an index whose LEADING
-- column is that key.
CREATE TABLE public.notes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  -- The TENANT KEY. Every policy on this table filters by it, and the freeze trigger
  -- makes it immutable so a row can never walk into another tenant.
  org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  -- ATTRIBUTION, NOT OWNERSHIP — and the demotion is what makes this table B2B.
  -- Nullable with ON DELETE SET NULL: in a per-user product deleting the user should
  -- delete their rows, but here the data controller is the ORG, so an employee
  -- deleting their account must not delete the company's notes. It survives only as
  -- "who wrote this", which the delete policy's second arm uses to let an author
  -- remove their own note without admin rank.
  owner_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Soft-archive marker: NULL is an active note, a timestamp is the instant it
  -- was archived. Nullable with no default, so creation leaves it NULL — the
  -- list DAL hides archived rows by default (`WHERE archived_at IS NULL`) and the
  -- update path stamps or clears it. A plain timestamp, not a status enum,
  -- because the only two states the surfaces model are "active" and "archived at
  -- time T" and one nullable timestamp carries both. It is projected by
  -- NOTE_COLUMNS in @app/notes, so its absence is not cosmetic: every SELECT the
  -- DAL issues names this column, and without it the whole vertical errors.
  archived_at timestamptz,
  -- Bounds, not validation — the zod DTO in @app/contracts is the input
  -- contract. These hold for callers that reach the table by another path.
  CONSTRAINT notes_title_length CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT notes_body_length CHECK (char_length(body) <= 20000),
  -- The tenant column leads the primary key: partition-ready, and every UNIQUE on a
  -- tenant table must carry it or an insert failure becomes a cross-org oracle.
  PRIMARY KEY (org_id, id)
);

CREATE TRIGGER notes_set_updated_at
  BEFORE UPDATE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- The TENANT column must be the leading column. Every policy on this table filters
-- by org_id on every statement, so this index is what turns the policy qual into an
-- Index Cond; an index with org_id in second position does not serve
-- `org_id = ANY($1)` and the policy degrades to a sequential scan over every tenant's
-- rows — a correctness-shaped performance failure that a two-row test database can
-- never reveal.
--
-- The trailing (created_at DESC, id DESC) does a second job: it is the sort
-- order of the list screen's keyset pagination, so the same index that makes
-- the policy cheap also makes the query that runs most often ordered-by-index.
-- id breaks ties, because created_at alone is not unique and a keyset cursor
-- over a non-unique key silently skips or repeats rows at page boundaries.
CREATE INDEX notes_org_id_created_at_id_idx
  ON public.notes (org_id, created_at DESC, id DESC);

-- The DSR export's seek (system.exportMyData): one org's notes AUTHORED BY the
-- subject, same keyset order. The index above serves the org list but leaves
-- owner_id to a per-row filter; this one carries the equality pair
-- (org_id leading — tenant tables lead with the tenant key) and then the
-- keyset tail, so the authored-notes walk is an ordered index scan too.
-- Applied by 20260808000000_notes_export_index.sql.
-- SOURCE: https://www.postgresql.org/docs/17/indexes-ordering.html
CREATE INDEX notes_org_id_owner_id_created_at_id_idx
  ON public.notes (org_id, owner_id, created_at DESC, id DESC);

-- org_id is immutable: without this every scope predicate above is advisory, because
-- an UPDATE that passes its own policy could rewrite org_id and hand the row to
-- another tenant. No WHEN clause — a freeze that can be disarmed is not a freeze.
CREATE TRIGGER notes_freeze_org
  BEFORE UPDATE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION private.freeze_org_id();

-- FORCE subjects the table OWNER to these policies as well — without it the
-- `postgres` role that runs migrations, seeds and SQL-editor sessions reads and
-- writes every row and no test notices. A BYPASSRLS role (`service_role`) still
-- bypasses; that hole is closed by the REVOKE below, not by a policy.
-- SOURCE: PostgreSQL row security — FORCE applies row security to the table
-- owner as well [corpus: postgres/rls-force]
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notes FORCE ROW LEVEL SECURITY;

-- Grants are the outer gate (see 10_account.sql for the full reasoning):
-- anon has no business here, and service_role's grant is revoked because
-- BYPASSRLS makes the grant the only lever over it.
REVOKE ALL ON TABLE public.notes FROM anon;
REVOKE ALL ON TABLE public.notes FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notes TO authenticated;

-- Four per-operation policies, TO authenticated, each with a real predicate and
-- the identity call wrapped in a scalar sub-select so the planner hoists it into
-- an InitPlan and runs it once per statement rather than once per candidate row.
-- SOURCE: RLS performance — wrap the identity call in a scalar sub-select for
-- an initPlan [corpus: postgres/rls-initplan]
CREATE POLICY notes_select_org ON public.notes
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (org_id = ANY((SELECT private.member_org_ids())::uuid[]));

-- SOURCE: PostgreSQL row security — WITH CHECK validates the new row, so a client
-- cannot INSERT into an org it may not write [corpus: postgres/rls-force]
CREATE POLICY notes_insert_org ON public.notes
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 20);

-- USING alone would let a member move the row; WITH CHECK keeps the result inside an
-- org they may still write. The freeze trigger is the belt to this braces.
-- SOURCE: PostgreSQL row security — UPDATE evaluates USING then WITH CHECK
-- [corpus: postgres/rls-force]
CREATE POLICY notes_update_org ON public.notes
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 20)
  WITH CHECK (coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 20);

-- Two independently-scoped arms: an admin cleaning up anything in the org, or an
-- author removing their own note. Each arm carries its own rank term, so neither
-- reads as "or if you wrote it" without a membership — which is exactly the shape
-- that would quietly re-open per-user scope on an org table.
-- SOURCE: PostgreSQL row security — DELETE USING restricts which rows the role may
-- remove [corpus: postgres/rls-force]
CREATE POLICY notes_delete_org ON public.notes
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (
    coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 30
    OR (
      owner_id = (SELECT auth.uid())
      AND coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 20
    )
  );

-- The MFA rail. RESTRICTIVE, so it ANDs onto the four permissive policies above and
-- can only ever subtract; no `FOR` clause, so it covers every command rather than
-- being four copies of one predicate with four chances to omit one (the vendor's own
-- documentation writes this policy `for update`, which gates UPDATE and leaves SELECT
-- wide open). A caller who holds a verified second factor and presents an `aal1` token
-- matches no row and can write none.
--
-- The predicate is deliberately a single boolean rather than the published
-- set-membership form, whose empty-result branch DEFAULTS TO ALLOW — see
-- supabase/migrations/20260812000000_mfa_aal2.sql for the full account of both ways
-- the documented policy fails, and supabase/tests/mfa_aal2.test.sql for the proof
-- that this one binds for an ENROLLED user, which is the only case that distinguishes
-- them.
-- SOURCE: PostgreSQL row security — a RESTRICTIVE policy is ANDed with the permissive
-- set, so it can only ever remove rows [corpus: postgres/rls-force]
CREATE POLICY notes_mfa_aal2 ON public.notes
  AS RESTRICTIVE TO authenticated
  USING ((SELECT private.mfa_satisfied()))
  WITH CHECK ((SELECT private.mfa_satisfied()));
