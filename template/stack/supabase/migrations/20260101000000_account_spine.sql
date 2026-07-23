-- 20260101000000_account_spine — the shared updated_at trigger and public.profiles.
--
-- APPLIED HISTORY, NOT DESIRED STATE. The desired state lives in
-- supabase/schemas/00_shared.sql and supabase/schemas/10_account.sql, and the
-- reasoning for every choice below lives there — this file is the forward step
-- that gets a database from empty to that state, and it exists to be replayed,
-- not read for rationale.
--
-- APPEND-ONLY, ABSOLUTELY. `supabase db push` records a migration by FILENAME in
-- supabase_migrations.schema_migrations. Editing an applied file therefore
-- changes nothing on any database that already ran it: the deployed schema and
-- the committed history diverge, and no diff, gate or reviewer can see it —
-- every environment is quietly running a schema that no file in this repo
-- describes. Change the schema by adding a NEW migration, always.
--
-- DML-FREE. Structure only; fixtures live in supabase/seed.sql. The `migrations`
-- gate rejects INSERT/UPDATE/DELETE here without an explicit reviewed marker,
-- because reference data that arrives through a migration is data no seed can
-- reproduce and no test can reset.

-- Maintains updated_at in the database rather than in each caller, so the web
-- Server Action, the tRPC procedure, a psql session and a future Edge Function
-- all get it. SECURITY INVOKER (it needs no privilege of its own) and a pinned
-- empty search_path (nothing planted in a caller-controlled schema can be
-- resolved from the body — hence pg_catalog.now()).
-- SOURCE: PostgreSQL CREATE FUNCTION — security and search_path
-- https://www.postgresql.org/docs/current/sql-createfunction.html
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = pg_catalog.now();
  RETURN NEW;
END;
$$;

-- One identity, one row: the primary key IS auth.users.id, so uniqueness is
-- structural and the ON DELETE CASCADE makes account deletion a single
-- statement against the root rather than a hand-maintained sweep list.
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  display_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profiles_display_name_length CHECK (char_length(display_name) <= 120)
);

CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- No owner-column index is created: the owner column is `id`, which the primary
-- key already indexes as its leading column. That is the property the policies
-- below need; a second index on id would be write amplification for nothing.

-- ENABLE turns policies on; FORCE additionally subjects the table OWNER to them,
-- which matters because `postgres` — the role this migration itself runs as —
-- owns the table and would otherwise read and write every row. A BYPASSRLS role
-- (service_role) still bypasses; the REVOKE below is the lever for that one.
-- SOURCE: PostgreSQL row security — FORCE applies row security to the table
-- owner as well [corpus: postgres/rls-force]
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;

-- Undo Supabase's default privileges for this table. anon has no business in a
-- private domain, and service_role's grant is the only control that exists over
-- a role that bypasses RLS by attribute — so an Edge Function reaches this table
-- only via a later, ADR'd migration that grants it explicitly.
REVOKE ALL ON TABLE public.profiles FROM anon;
REVOKE ALL ON TABLE public.profiles FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles TO authenticated;

-- Four per-operation policies, never FOR ALL — read and write intent must be
-- able to diverge later without rewriting the security boundary under pressure.
-- TO authenticated, never TO public, so an anonymous request matches NO policy
-- rather than a policy that happens to evaluate false. `(SELECT auth.uid())`
-- rather than a bare call: the sub-select is hoisted into an InitPlan and runs
-- once per statement instead of once per candidate row.
-- SOURCE: RLS performance — the initPlan sub-select pattern
-- [corpus: postgres/rls-initplan]
CREATE POLICY profiles_select_own ON public.profiles
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid()));

-- INSERT has no existing row to test, so WITH CHECK on the NEW row is the whole
-- defence against creating a profile under another user's id.
-- SOURCE: PostgreSQL row security — WITH CHECK validates the new row
-- [corpus: postgres/rls-force]
CREATE POLICY profiles_insert_own ON public.profiles
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (id = (SELECT auth.uid()));

-- Both clauses: USING picks the targetable rows, WITH CHECK constrains what
-- they may become — without it the owner could rewrite id and hand the row away.
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
