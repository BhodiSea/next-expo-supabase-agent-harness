-- 20260201000100_notes_org_scope — re-scope the reference vertical from one user to
-- one organization.
--
-- adr: docs/adr/20260201-org-scoped-tenancy.md
--
-- APPLIED HISTORY, NOT DESIRED STATE. Reasoning lives in supabase/schemas/20_notes.sql.
--
-- This migration DROPS the four owner-scoped policies and replaces them with
-- org-scoped ones. Dropping a policy removes an authorization control while leaving
-- every row and every query working, which is why the migrations gate requires the
-- `-- adr:` marker above and why this file exists as a single reviewable unit.
--
-- THE ATTRIBUTION DEMOTION IS THE POINT OF B2B. owner_id stops being the
-- authorization key and becomes a nullable attribution column with ON DELETE SET
-- NULL. In a per-user product, deleting the user should delete their rows; in a B2B
-- product the data controller is the ORG, so an employee deleting their account must
-- not delete the company's notes. The account-deletion property this replaces is
-- rewritten, not dropped — see the ADR and supabase/tests/rls_isolation.test.sql.

-- ACCESS EXCLUSIVE on a table that already holds rows queues every reader and writer
-- behind it; without a bound the migration waits on any open transaction and takes
-- the product down while it waits. Fail fast instead.
--
-- NOT `SET LOCAL`, which is the spelling this file shipped with first and which does
-- NOTHING here: the Supabase CLI does not wrap a migration in an explicit transaction
-- block, so `SET LOCAL` outside one raises `WARNING: SET LOCAL can only be used in
-- transaction blocks` and the timeout is never set. The warning is easy to miss in a
-- successful `db reset`, so the guard reads as present while being inert — the exact
-- shape of failure this harness exists to eliminate. Session-scoped SET applies either
-- way, and a lock timeout that leaks to the rest of the migration run is a feature.
-- SOURCE: https://www.postgresql.org/docs/17/explicit-locking.html (ACCESS EXCLUSIVE conflicts with every other lock mode)
SET lock_timeout = '3s';

-- The scaffold ships this table empty, so NOT NULL lands in one step. An install with
-- rows follows docs/runbooks/tenancy-adoption.md instead: add nullable, backfill out
-- of band, then SET NOT NULL. The tenancy gate folds column facts across the whole
-- history, so either shape reaches the same verdict.
ALTER TABLE public.notes
  ADD COLUMN org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE;

-- Attribution, not ownership: nullable, and the account sweep nulls it rather than
-- cascading the row away.
ALTER TABLE public.notes
  ALTER COLUMN owner_id DROP NOT NULL,
  ALTER COLUMN owner_id DROP DEFAULT;
ALTER TABLE public.notes
  DROP CONSTRAINT notes_owner_id_fkey,
  ADD CONSTRAINT notes_owner_id_fkey
    FOREIGN KEY (owner_id) REFERENCES auth.users (id) ON DELETE SET NULL;

-- Every UNIQUE on a tenant table must carry the tenant column: partitioning by tenant
-- requires it, and a tenant-blind unique is a cross-org information channel (an insert
-- failure discloses another org's value).
ALTER TABLE public.notes
  DROP CONSTRAINT notes_pkey,
  ADD CONSTRAINT notes_pkey PRIMARY KEY (org_id, id);

-- org_id LEADING, and the (created_at DESC, id DESC) tail is the list screen's keyset
-- order — one index serves the policy qual, the sort and the cursor range. The old
-- owner-leading index is superseded: every statement now filters by org_id first.
DROP INDEX public.notes_owner_id_created_at_id_idx;
CREATE INDEX notes_org_id_created_at_id_idx
  ON public.notes (org_id, created_at DESC, id DESC);

CREATE TRIGGER notes_freeze_org
  BEFORE UPDATE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION private.freeze_org_id();

DROP POLICY notes_select_own ON public.notes;
DROP POLICY notes_insert_own ON public.notes;
DROP POLICY notes_update_own ON public.notes;
DROP POLICY notes_delete_own ON public.notes;

-- Reading is membership; writing is rank. Both resolve through the uncorrelated
-- zero-argument helpers, which the planner hoists into one InitPlan per statement.
-- SOURCE: RLS performance — wrap the identity call in a scalar sub-select so the
-- planner hoists it into an InitPlan [corpus: postgres/rls-initplan]
CREATE POLICY notes_select_org ON public.notes
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (org_id = ANY((SELECT private.member_org_ids())::uuid[]));

-- SOURCE: PostgreSQL row security — WITH CHECK validates the new row, so a client
-- cannot INSERT into an org it may not write [corpus: postgres/rls-force]
CREATE POLICY notes_insert_org ON public.notes
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 20);

-- SOURCE: PostgreSQL row security — UPDATE evaluates USING then WITH CHECK
-- [corpus: postgres/rls-force]
CREATE POLICY notes_update_org ON public.notes
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 20)
  WITH CHECK (coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 20);

-- Two independently-scoped arms: an admin cleaning up anything in the org, or an
-- author removing their own note. Each arm carries a rank term, so neither can be
-- read as "or if you wrote it" without a membership.
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
