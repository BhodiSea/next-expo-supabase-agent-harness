-- supabase/schemas/20_notes.sql — the seeded reference vertical.
--
-- DECLARATIVE FILE — see 00_shared.sql for how this directory relates to
-- supabase/migrations/ and what the diff engine does not see.
--
-- This is the shape every later vertical is copied from, so every rule the
-- harness enforces is visible in it exactly once: FORCE row security, four
-- per-operation policies, no vacuous predicate, the initPlan sub-select, and an
-- index whose LEADING column is the owner column.
CREATE TABLE public.notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- owner_id references auth.users directly, NOT public.profiles. The spine is
  -- a place to hang account attributes, not a gate a note has to pass through:
  -- routing the FK via profiles would mean the first write after signup fails
  -- until some other code path has created a profile row, which is a startup
  -- ordering bug waiting to be introduced by whoever forgets it. Both tables
  -- cascade from the same root, so account deletion is still one statement.
  --
  -- DEFAULT auth.uid() is a convenience, never the control: a client may omit
  -- owner_id and get its own id, and a client that SENDS someone else's id is
  -- still rejected by the WITH CHECK below. The default removes a footgun from
  -- the happy path without moving the boundary.
  owner_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
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
  CONSTRAINT notes_body_length CHECK (char_length(body) <= 20000)
);

CREATE TRIGGER notes_set_updated_at
  BEFORE UPDATE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- The owner column MUST be the leading column. Every policy on this table
-- filters by owner_id on every statement, so this index is what turns the
-- policy qual into an Index Cond; an index with owner_id in second position
-- does not serve `owner_id = $1` and the policy degrades to a sequential scan
-- over the whole table — a correctness-shaped performance failure that a
-- two-row test database can never reveal.
--
-- The trailing (created_at DESC, id DESC) does a second job: it is the sort
-- order of the list screen's keyset pagination, so the same index that makes
-- the policy cheap also makes the query that runs most often ordered-by-index.
-- id breaks ties, because created_at alone is not unique and a keyset cursor
-- over a non-unique key silently skips or repeats rows at page boundaries.
CREATE INDEX notes_owner_id_created_at_id_idx
  ON public.notes (owner_id, created_at DESC, id DESC);

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
CREATE POLICY notes_select_own ON public.notes
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (owner_id = (SELECT auth.uid()));

-- SOURCE: PostgreSQL row security — WITH CHECK validates the new row, so a
-- client cannot INSERT under another user's owner_id [corpus: postgres/rls-force]
CREATE POLICY notes_insert_own ON public.notes
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (owner_id = (SELECT auth.uid()));

-- USING alone would let an owner rewrite owner_id and hand the row to someone
-- else; WITH CHECK is what keeps the result owned by the same user.
-- SOURCE: PostgreSQL row security — UPDATE evaluates USING then WITH CHECK
-- [corpus: postgres/rls-force]
CREATE POLICY notes_update_own ON public.notes
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));

-- The delete policy is also the account-deletion guard: an unqualified
-- `DELETE FROM public.notes` issued by a signed-in user removes exactly that
-- user's rows, because the policy qual is the only WHERE clause the statement
-- has. That property is asserted in supabase/tests/rls_isolation.test.sql.
-- SOURCE: PostgreSQL row security — DELETE USING restricts which rows the role
-- may remove [corpus: postgres/rls-force]
CREATE POLICY notes_delete_own ON public.notes
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (owner_id = (SELECT auth.uid()));
