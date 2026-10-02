-- 20260101000100_notes — the seeded reference vertical.
--
-- APPLIED HISTORY, NOT DESIRED STATE. The desired state and the full reasoning
-- live in supabase/schemas/20_notes.sql. Append-only and DML-free for the
-- reasons stated at the top of 20260101000000_account_spine.sql.
--
-- Ordered AFTER the account spine only for readability — this table's foreign
-- key points at auth.users, not at public.profiles, so the two migrations are
-- genuinely independent. That is deliberate: routing the FK through the spine
-- would make the first write after signup fail until some other code path had
-- created a profile row, and startup-ordering bugs of that shape are found in
-- production by the first real user, not in a test.
CREATE TABLE public.notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- DEFAULT auth.uid() is a convenience for callers that omit the column; it is
  -- NOT the control. A caller that sends someone else's id is rejected by the
  -- WITH CHECK below either way.
  owner_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Soft-archive marker: NULL is active, a timestamp is the archive instant.
  -- Nullable/defaultless so creation leaves it NULL; the list DAL hides archived
  -- rows (`archived_at IS NULL`) and the update path stamps it. NOTE_COLUMNS in
  -- @app/notes projects this on every SELECT, so the vertical errors without it.
  -- Full reasoning in supabase/schemas/20_notes.sql.
  archived_at timestamptz,
  CONSTRAINT notes_title_length CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT notes_body_length CHECK (char_length(body) <= 20000)
);

CREATE TRIGGER notes_set_updated_at
  BEFORE UPDATE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- owner_id LEADING. Every policy on this table filters by owner_id on every
-- statement, so this index is what turns the policy qual into an Index Cond. An
-- index with owner_id in second position does not serve `owner_id = $1`: the
-- policy degrades to a sequential scan over the whole table, which a two-row
-- test database can never reveal and a production table always does.
-- The (created_at DESC, id DESC) tail is the list screen's keyset order, so one
-- index serves both jobs; id breaks ties because a keyset cursor over a
-- non-unique key skips or repeats rows at page boundaries.
CREATE INDEX notes_owner_id_created_at_id_idx
  ON public.notes (owner_id, created_at DESC, id DESC);

-- FORCE subjects the table owner (`postgres`, the role running this migration)
-- to the policies. A BYPASSRLS role still bypasses — the REVOKE below is the
-- only lever over service_role.
-- SOURCE: PostgreSQL row security — FORCE applies row security to the table
-- owner as well [corpus: postgres/rls-force]
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notes FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.notes FROM anon;
REVOKE ALL ON TABLE public.notes FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notes TO authenticated;

-- Four per-operation policies, TO authenticated, each predicate real and each
-- identity call wrapped in a scalar sub-select (InitPlan: once per statement,
-- not once per row).
-- SOURCE: RLS performance — the initPlan sub-select pattern
-- [corpus: postgres/rls-initplan]
CREATE POLICY notes_select_own ON public.notes
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (owner_id = (SELECT auth.uid()));

-- SOURCE: PostgreSQL row security — WITH CHECK validates the new row, so a
-- client cannot INSERT under another user's owner_id [corpus: postgres/rls-force]
CREATE POLICY notes_insert_own ON public.notes
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (owner_id = (SELECT auth.uid()));

-- SOURCE: PostgreSQL row security — UPDATE evaluates USING then WITH CHECK, so
-- the row cannot be handed to another owner [corpus: postgres/rls-force]
CREATE POLICY notes_update_own ON public.notes
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));

-- Also the account-deletion guard: an unqualified DELETE issued by a signed-in
-- user removes exactly that user's rows, because this qual is the only WHERE
-- clause the statement has.
-- SOURCE: PostgreSQL row security — DELETE USING restricts which rows the role
-- may remove [corpus: postgres/rls-force]
CREATE POLICY notes_delete_own ON public.notes
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (owner_id = (SELECT auth.uid()));
