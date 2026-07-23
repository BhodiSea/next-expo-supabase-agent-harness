-- supabase/tests/rls_structure.test.sql — the SHAPE of the authorization
-- boundary, read back out of pg_catalog.
--
-- Run with `supabase test db`. Everything happens inside one transaction that
-- ends in ROLLBACK, so the suite leaves no residue and can run against a seeded
-- database without disturbing it.
--
-- WHY A STRUCTURAL SUITE EXISTS AT ALL, given that rls_isolation.test.sql
-- already proves tenants cannot see each other: a behavioural test proves the
-- boundary holds for the two rows it created. It cannot tell you that FORCE is
-- on (a test never runs as the table owner), that the fourth policy exists (it
-- may only exercise three), that a predicate is not `USING (true)` (with one
-- tenant seeded, `true` and `owner = me` return the same rows), or that the
-- owner column is indexed (two rows plan identically either way). Those are
-- properties of the SCHEMA, and the schema is where they have to be asserted.
--
-- This suite reads what the DATABASE COMPILED, not what the migration text
-- said. A migration that never ran, ran partially, or was undone by a later one
-- is exactly the case the static gate cannot see and this one can.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT plan(13);

-- The tables under the RLS contract, and the column their policies filter on.
-- Adding a table to the domain means adding a row here; a table that never
-- arrives in this list is a table nothing in this file has an opinion about,
-- which is why the migration checklist ends with "and add it to rls_targets".
CREATE TEMPORARY TABLE rls_targets (table_name text PRIMARY KEY, owner_column text NOT NULL);
INSERT INTO rls_targets (table_name, owner_column) VALUES
  ('profiles', 'id'),
  ('notes', 'owner_id');

SELECT has_table('public', 'profiles', 'public.profiles exists');
SELECT has_table('public', 'notes', 'public.notes exists');

-- ENABLE alone leaves the table owner exempt, and the owner is the role that
-- runs migrations, seeds and every SQL-editor session — i.e. the role most
-- likely to be holding a connection when something goes wrong.
SELECT is_empty(
  $$ SELECT t.table_name
       FROM rls_targets t
       JOIN pg_class c ON c.oid = ('public.' || t.table_name)::regclass
      WHERE NOT (c.relrowsecurity AND c.relforcerowsecurity) $$,
  -- SOURCE: PostgreSQL row security — FORCE applies row security to the table
  -- owner as well [corpus: postgres/rls-force]
  'every RLS target has both ENABLE and FORCE ROW LEVEL SECURITY'
);

-- Per-operation coverage. This is also the anti-vacuity guard for the whole
-- file: if a target name is misspelled, every pg_policies query below matches
-- nothing and passes for the wrong reason — this one fails instead.
SELECT is_empty(
  $$ SELECT t.table_name, op
       FROM rls_targets t
       CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS op
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_policies p
         WHERE p.schemaname = 'public' AND p.tablename = t.table_name AND p.cmd = op) $$,
  'every RLS target carries a separate policy for SELECT, INSERT, UPDATE and DELETE'
);

-- A blanket FOR ALL policy would satisfy the check above by accident while
-- welding read intent and write intent together permanently.
SELECT is_empty(
  $$ SELECT p.tablename, p.policyname
       FROM pg_policies p JOIN rls_targets t ON t.table_name = p.tablename
      WHERE p.schemaname = 'public' AND p.cmd = 'ALL' $$,
  'no RLS target carries a blanket FOR ALL policy'
);

-- `USING (true)` is RLS switched off with the paperwork left in place: the
-- catalog says the table is protected and every row is readable.
SELECT is_empty(
  $$ SELECT p.tablename, p.policyname
       FROM pg_policies p JOIN rls_targets t ON t.table_name = p.tablename
      WHERE p.schemaname = 'public'
        AND (btrim(coalesce(p.qual, '')) IN ('true', '(true)')
          OR btrim(coalesce(p.with_check, '')) IN ('true', '(true)')) $$,
  'no policy predicate is the vacuous literal true'
);

-- A policy with neither clause is the same failure wearing a different hat.
SELECT is_empty(
  $$ SELECT p.tablename, p.policyname
       FROM pg_policies p JOIN rls_targets t ON t.table_name = p.tablename
      WHERE p.schemaname = 'public' AND p.qual IS NULL AND p.with_check IS NULL $$,
  'every policy carries at least one real predicate'
);

-- The initPlan check, made against what the planner actually stored rather than
-- against migration text: pg_policies pretty-prints the compiled expression, so
-- a bare per-row identity call shows up here with no sub-select in it. This is a
-- performance property with a correctness-shaped failure — it is invisible at
-- two rows and quadratic-feeling at two million, which is precisely the size at
-- which nobody wants to be rewriting policies.
-- SOURCE: RLS performance — wrap the identity call in a scalar sub-select so the
-- planner hoists it into an InitPlan [corpus: postgres/rls-initplan]
SELECT is_empty(
  $$ SELECT p.tablename, p.policyname, pred
       FROM pg_policies p
       JOIN rls_targets t ON t.table_name = p.tablename
       CROSS JOIN LATERAL unnest(ARRAY[p.qual, p.with_check]) AS pred
      WHERE p.schemaname = 'public' AND pred IS NOT NULL AND pred !~* '\(\s*select' $$,
  'every policy resolves identity through a scalar sub-select, not a per-row call'
);

-- A policy granted to `public` also applies to `anon`. "Anonymous requests match
-- no policy at all" is a property you can verify by reading one column; "match a
-- policy that happens to evaluate false for them" is a property you have to
-- reason about every time somebody edits the predicate.
SELECT is_empty(
  $$ SELECT p.tablename, p.policyname, p.roles
       FROM pg_policies p JOIN rls_targets t ON t.table_name = p.tablename
      WHERE p.schemaname = 'public'
        AND (p.roles IS NULL OR p.roles && ARRAY['public', 'anon']::name[]) $$,
  'no policy is granted to public or anon'
);

-- Leading-column coverage is what turns the policy qual into an Index Cond. An
-- index carrying the owner column in second position does not serve
-- `owner = $1`, and every statement against these tables filters by it.
SELECT is_empty(
  $$ SELECT t.table_name, t.owner_column
       FROM rls_targets t
      WHERE NOT EXISTS (
        SELECT 1
          FROM pg_index i
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
         WHERE i.indrelid = ('public.' || t.table_name)::regclass
           AND a.attname = t.owner_column) $$,
  'every owner column is the LEADING column of some index'
);

-- The GRANT wall, the outer half of the boundary. Supabase grants every new
-- table in `public` to anon by default; these tables revoke it, so a policy
-- accidentally opened to `public` in some future migration still cannot be
-- exercised by an unauthenticated caller.
SELECT is_empty(
  $$ SELECT t.table_name, priv
       FROM rls_targets t
       CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS priv
      WHERE has_table_privilege('anon'::name, 'public.' || t.table_name, priv) $$,
  'anon holds no DML grant on any RLS target'
);

-- service_role bypasses row security by role attribute, so no policy in this
-- repo constrains it and the GRANT is the only lever that exists. Revoked by
-- default means an Edge Function reaches a table only through a migration that
-- grants it explicitly, which is the change an ADR is attached to.
-- See supabase/functions/README.md.
SELECT is_empty(
  $$ SELECT t.table_name, priv
       FROM rls_targets t
       CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS priv
      WHERE has_table_privilege('service_role'::name, 'public.' || t.table_name, priv) $$,
  'service_role holds no DML grant on any RLS target'
);

-- POSITIVE CONTROL. Without this, a database that granted nothing to anybody
-- would pass every assertion above. The suite has to be able to fail in the
-- direction of "too locked down" as well.
SELECT is_empty(
  $$ SELECT t.table_name, priv
       FROM rls_targets t
       CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS priv
      WHERE NOT has_table_privilege('authenticated'::name, 'public.' || t.table_name, priv) $$,
  'authenticated holds all four DML grants on every RLS target'
);

SELECT * FROM finish();

ROLLBACK;
