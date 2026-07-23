-- supabase/schemas/10_account.sql — the account spine.
--
-- DECLARATIVE FILE — see 00_shared.sql for how this directory relates to
-- supabase/migrations/ and what the diff engine does not see.
--
-- WHY A SPINE AT ALL. `auth.users` is Supabase's table, not this project's: its
-- columns change with GoTrue releases, it is not exposed through the API, and
-- writing to it is the auth service's job. `public.profiles` is the project's
-- own row for the same identity — the one place a display name, a locale, or a
-- future per-account flag can live where policies and foreign keys can reach it.
--
-- WHY IT IS KEYED BY auth.users.id RATHER THAN CARRYING ITS OWN SURROGATE KEY.
-- One identity, one row, enforced by the primary key instead of by a UNIQUE
-- constraint somebody can forget to add. The ON DELETE CASCADE is the
-- account-deletion story: deleting the auth user removes the profile, and every
-- owner_id in the domain hangs off the same root, so "delete my account" is one
-- statement against auth.users rather than a hand-maintained sweep list that
-- silently stops covering the table added last week.
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  display_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A bound, not a validation. The zod DTO in @app/contracts is the real input
  -- contract; this exists so a caller that reaches the table by some other path
  -- (psql, an Edge Function, a future admin tool) still cannot store a megabyte
  -- in a name field.
  CONSTRAINT profiles_display_name_length CHECK (char_length(display_name) <= 120)
);

CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- The owner column of this table IS its primary key, so the PK's index already
-- gives the policies below their leading-column index. No extra index is
-- created here, and none should be: a second index on id would be pure write
-- amplification. (Every other table in this tree needs an explicit one — see
-- 20_notes.sql.)

-- ENABLE turns policies on. FORCE additionally subjects the TABLE OWNER to
-- them; without it, the role that owns the table — `postgres`, the role every
-- migration, seed script and SQL-editor session runs as — reads and writes
-- every row regardless of what the policies say, and none of the tests below
-- would notice. Note the honest limit: a role holding the BYPASSRLS attribute
-- (`service_role`) still bypasses. That hole is closed with GRANTs, not
-- policies — see the REVOKE lines further down and supabase/functions/README.md.
-- SOURCE: PostgreSQL row security — FORCE applies row security to the table
-- owner as well [corpus: postgres/rls-force]
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;

-- GRANTS ARE THE OUTER GATE, POLICIES THE INNER ONE. Supabase's default
-- privileges hand every new table in `public` to anon, authenticated and
-- service_role; both revokes below undo that deliberately.
--   anon         — nothing in this domain is public, so the anon role has no
--                  business reaching the table at all. With the grant gone, a
--                  policy accidentally written `TO public` in some future
--                  migration still cannot be exercised by an unauthenticated
--                  caller. That is the whole point of a second wall.
--   service_role — bypasses RLS by role attribute, so the grant is the ONLY
--                  lever that exists over it. Revoking it here means an Edge
--                  Function cannot read this table until an ADR'd migration
--                  grants it, per table, deliberately.
REVOKE ALL ON TABLE public.profiles FROM anon;
REVOKE ALL ON TABLE public.profiles FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles TO authenticated;

-- FOUR PER-OPERATION POLICIES, NEVER `FOR ALL`. A blanket policy makes read
-- intent and write intent the same expression forever; the first time they need
-- to differ (a shared profile becomes readable by teammates while still only
-- self-writable) the change is a rewrite of the security boundary under time
-- pressure. Split from the start, each operation moves on its own.
--
-- TO authenticated, never TO public: a policy granted to `public` also applies
-- to `anon`, and "anonymous requests match no policy at all" is a much easier
-- property to verify than "anonymous requests match a policy that happens to
-- evaluate false".
--
-- `(SELECT auth.uid())` and not a bare `auth.uid()`: the scalar sub-select is
-- hoisted into an InitPlan and evaluated ONCE per statement instead of once per
-- candidate row. On this table it is invisible (the PK lookup touches one row);
-- copy the bare form into a table with two million rows and it is two million
-- calls. The pattern is uniform here so it cannot be learned wrong.
-- SOURCE: RLS performance — wrap the identity call in a scalar sub-select for
-- an initPlan [corpus: postgres/rls-initplan]
CREATE POLICY profiles_select_own ON public.profiles
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid()));

-- INSERT has no USING clause to give it — there is no existing row to test —
-- so WITH CHECK on the NEW row is the entire defence: it is what stops a caller
-- from creating a profile under somebody else's id.
-- SOURCE: PostgreSQL row security — WITH CHECK validates the new row
-- [corpus: postgres/rls-force]
CREATE POLICY profiles_insert_own ON public.profiles
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (id = (SELECT auth.uid()));

-- UPDATE needs BOTH: USING says which rows may be targeted, WITH CHECK says
-- what they may become. With only USING, a caller could take their own row and
-- rewrite its id to someone else's — handing the row away.
-- SOURCE: PostgreSQL row security — UPDATE evaluates USING then WITH CHECK
-- [corpus: postgres/rls-force]
CREATE POLICY profiles_update_own ON public.profiles
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));

-- SOURCE: PostgreSQL row security — DELETE USING restricts which rows the role
-- may remove [corpus: postgres/rls-force]
CREATE POLICY profiles_delete_own ON public.profiles
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (id = (SELECT auth.uid()));
