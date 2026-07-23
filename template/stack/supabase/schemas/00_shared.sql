-- supabase/schemas/00_shared.sql — helpers every domain table reuses.
--
-- DECLARATIVE FILE. This directory states the schema's DESIRED STATE; the files
-- under supabase/migrations/ are the applied history that gets there. The pair
-- moves together: edit a file here, run `supabase db diff -f <name>`, READ the
-- generated draft, then commit the schema file and the migration in one change.
-- Editing only one of the two is the drift this split exists to make visible.
--
-- Two things the diff engine does not see, so a reviewer must:
--   * DML is never captured (that is fine — data belongs in supabase/seed.sql,
--     and the migrations gate rejects DML in a migration outright);
--   * policy ALTERs and column privileges are documented blind spots, so a
--     policy CHANGE reads as drop+create in the draft, and a policy RENAME may
--     read as nothing at all. Never hand-edit a migration after it has been
--     applied — `supabase db push` records it by filename, so a retroactive
--     edit yields a database that no longer matches its own history and no
--     diff can tell you.
--
-- Keyword case is deliberate here and in every sibling file: the provenance
-- heuristic (tools/lib/provenance-rules.mjs) matches `CREATE POLICY` and
-- `FORCE ROW LEVEL SECURITY` case-SENSITIVELY, so lowercase DDL is invisible to
-- it. `supabase db diff` emits lowercase — re-case the RLS statements when you
-- review the draft, or the citation duty silently lapses for that table.

-- Sets updated_at on every UPDATE, in the database rather than in each caller.
-- A timestamp maintained by application code is a timestamp that is correct
-- until the second writer appears (a Server Action, a tRPC procedure, a psql
-- session, an Edge Function) — the trigger is the only place all four pass
-- through.
--
-- SECURITY INVOKER (the default, stated explicitly) so the function claims no
-- privilege of its own: it only ever touches the row already being written by a
-- statement RLS has already authorized. `SET search_path = ''` pins resolution
-- so a table or operator planted in a caller-controlled schema cannot be
-- resolved from inside the function body — which is why now() is spelled
-- pg_catalog.now(). SOURCE: PostgreSQL — writing SECURITY DEFINER/INVOKER
-- functions safely, search_path pinning
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
