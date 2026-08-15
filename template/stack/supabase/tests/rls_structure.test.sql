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

-- Count checked by hand against the SELECTs below. pgTAP fails a plan mismatch,
-- which is the point: an assertion deleted in a hurry cannot pass as a smaller
-- suite.
SELECT plan(34);

-- The tables under the RLS contract, and the column their policies filter on.
-- Adding a table to the domain means adding a row here; a table that never
-- arrives in this list is a table nothing in this file has an opinion about,
-- which is why the migration checklist ends with "and add it to rls_targets".
CREATE TEMPORARY TABLE rls_targets (table_name text PRIMARY KEY, owner_column text NOT NULL);
-- owner_column is the column the table's policies FILTER BY, which for every
-- org-scoped table is the TENANT key rather than a user id. profiles stays
-- user-scoped (it is account metadata, not org data).
INSERT INTO rls_targets (table_name, owner_column) VALUES
  ('profiles', 'id'),
  ('orgs', 'id'),
  ('memberships', 'user_id'),
  -- The JIT elevation table (1.0.0): filtered by user_id like the seat table —
  -- its policies are the self-only scalars the effective-rank fold depends on.
  ('admin_elevations', 'user_id'),
  ('invitations', 'org_id'),
  ('notes', 'org_id'),
  ('org_usage', 'org_id');

SELECT has_table('public', 'profiles', 'public.profiles exists');
SELECT has_table('public', 'orgs', 'public.orgs exists');
SELECT has_table('public', 'memberships', 'public.memberships exists');
SELECT has_table('public', 'invitations', 'public.invitations exists');
SELECT has_table('public', 'admin_elevations', 'public.admin_elevations exists');
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
--
-- PERMISSIVE only, and that word is load-bearing rather than decorative. A
-- restrictive policy can only ever SUBTRACT rows, so one covering an operation
-- grants nothing: counting it here would let a table whose permissive SELECT
-- policy was deleted stay green on the strength of a policy that denies.
SELECT is_empty(
  $$ SELECT t.table_name, op
       FROM rls_targets t
       CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS op
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_policies p
         WHERE p.schemaname = 'public' AND p.tablename = t.table_name AND p.cmd = op
           AND p.permissive = 'PERMISSIVE') $$,
  'every RLS target carries a separate PERMISSIVE policy for SELECT, INSERT, UPDATE and DELETE'
);

-- A blanket permissive FOR ALL policy would satisfy the check above by accident
-- while welding read intent and write intent together permanently.
--
-- RESTRICTIVE and FOR ALL are ORTHOGONAL AXES, and reading them as one is how this
-- assertion first reddened on a correct policy. The ban is on a permissive blanket:
-- a restrictive policy with no `FOR` clause is the opposite shape — it ANDs onto the
-- permissive set and can only remove rows, so covering every command is the SAFE
-- choice and splitting it per operation would be four copies of one predicate with
-- four chances to omit one. The seeded `notes_mfa_aal2` rail is exactly that, and
-- Supabase's own documentation writes the same policy `for update`, which gates
-- writes while leaving SELECT wide open.
SELECT is_empty(
  $$ SELECT p.tablename, p.policyname
       FROM pg_policies p JOIN rls_targets t ON t.table_name = p.tablename
      WHERE p.schemaname = 'public' AND p.cmd = 'ALL'
        AND p.permissive = 'PERMISSIVE' $$,
  'no RLS target carries a blanket PERMISSIVE FOR ALL policy'
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
      WHERE p.schemaname = 'public' AND pred IS NOT NULL
        AND btrim(pred) NOT IN ('false', '(false)')
        AND pred !~* '\(\s*select' $$,
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
--
-- The allowlist is the whole point: it is a CLOSED list of (table, privilege)
-- pairs, so the assertion still reds if service_role gains anything beyond the
-- single reviewed grant. `orgs`/SELECT and `orgs`/DELETE are the account-deletion
-- sweep (migration 20260201000200, docs/adr/20260201-org-scoped-tenancy.md);
-- notice there is no INSERT, no UPDATE, and nothing on memberships or
-- invitations — those rows leave by FK cascade, which bypasses row security
-- without needing a grant.
-- See supabase/functions/README.md and supabase/functions/delete-account/index.ts.
CREATE TEMPORARY TABLE service_role_grant_allow (table_name text, priv text, PRIMARY KEY (table_name, priv));
INSERT INTO service_role_grant_allow (table_name, priv) VALUES
  ('orgs', 'SELECT'),
  ('orgs', 'DELETE');

SELECT is_empty(
  $$ SELECT t.table_name, priv
       FROM rls_targets t
       CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS priv
      WHERE has_table_privilege('service_role'::name, 'public.' || t.table_name, priv)
        AND NOT EXISTS (
          SELECT 1 FROM service_role_grant_allow a
           WHERE a.table_name = t.table_name AND a.priv = priv) $$,
  'service_role holds no DML grant on any RLS target beyond the reviewed allowlist'
);

-- The allowlist's own anti-vacuity guard. An allowlist entry naming a grant that
-- was never made would silently widen the assertion above forever — and the way
-- that happens is somebody reverting the migration and leaving the list behind.
SELECT is_empty(
  $$ SELECT a.table_name, a.priv
       FROM service_role_grant_allow a
      WHERE NOT has_table_privilege('service_role'::name, 'public.' || a.table_name, a.priv) $$,
  'every service_role grant allowlist entry corresponds to a grant that actually exists'
);

-- POSITIVE CONTROL. Without this, a database that granted nothing to anybody
-- would pass every assertion above. The suite has to be able to fail in the
-- direction of "too locked down" as well.
--
-- Scoped to the DIRECTLY-WRITABLE targets on purpose. The three seat tables are
-- read-only to `authenticated` by design (every write goes through a definer
-- RPC), so sweeping them in here would assert the exact opposite of the
-- assertion below it.
SELECT is_empty(
  $$ SELECT t, priv
       FROM unnest(ARRAY['profiles', 'notes']) AS t
       CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS priv
      WHERE NOT has_table_privilege('authenticated'::name, 'public.' || t, priv) $$,
  'authenticated holds all four DML grants on every directly-writable RLS target'
);

-- The seat tables are READ-ONLY to authenticated: every write goes through an
-- allowlisted SECURITY DEFINER RPC running as app_tenancy_rpc. A DML grant here would
-- let a client bypass the RPC entirely and write seats over PostgREST.
SELECT is_empty(
  $$ SELECT t, priv
       FROM unnest(ARRAY['orgs', 'memberships', 'invitations', 'admin_elevations']) AS t
       CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) AS priv
      WHERE has_table_privilege('authenticated'::name, 'public.' || t, priv) $$,
  'authenticated holds NO write grant on orgs, memberships, invitations or admin_elevations'
);

-- POSITIVE CONTROL for the seat tables: they must still be READABLE, or every
-- assertion above would pass against a database that denied everything.
SELECT is_empty(
  $$ SELECT t
       FROM unnest(ARRAY['orgs', 'memberships', 'invitations', 'admin_elevations']) AS t
      WHERE NOT has_table_privilege('authenticated'::name, 'public.' || t, 'SELECT') $$,
  'authenticated can still SELECT orgs, memberships, invitations and admin_elevations'
);

-- ── the RPC writer role ─────────────────────────────────────────────────────
-- app_tenancy_rpc is the only role in the database that may write a seat. Every
-- claim the design makes about it is a claim about role ATTRIBUTES, which live
-- in a shared catalog `supabase db reset` does not touch — so they are exactly
-- the kind of thing that can be true on the day it was written and false a year
-- later with nothing in the migration history to show for it.
--
-- NOLOGIN: no credential reaches it directly. NOT superuser and NOT BYPASSRLS:
-- the policies on the seat tables actually constrain it. If it held either
-- attribute, every write policy in migration 20260201000000 would be decoration
-- and this suite's isolation twin would still pass.
SELECT is(
  (SELECT count(*)::int FROM pg_catalog.pg_roles
    WHERE rolname = 'app_tenancy_rpc'
      AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls),
  1,
  'app_tenancy_rpc exists and is NOLOGIN, non-superuser, non-BYPASSRLS'
);

-- The spine grants app_tenancy_rpc TO postgres so that ALTER FUNCTION … OWNER TO
-- can run, then revokes it in the same file. Left in place, `postgres` would
-- INHERIT the seat write policies into every later migration, seed and
-- SQL-editor session — turning a deny-all write wall into impersonation-shaped
-- write access for the role most likely to be holding a connection when
-- something goes wrong. This asserts the REVOKE actually took; a static reading
-- of the migration text cannot, because role membership is cluster state and
-- `supabase db reset` drops the DATABASE, not the role.
--
-- It asserts the PROPERTY, not the absence of a row, and the difference is not
-- pedantry. From PostgreSQL 16 a CREATEROLE role that runs CREATE ROLE receives an
-- implicit membership WITH ADMIN OPTION whose grantor is the bootstrap superuser —
-- so `postgres` keeps a pg_auth_members row that it cannot revoke from itself, and
-- an "is there a row" assertion would red forever against a perfectly healthy
-- database. What that residual row carries is `inherit_option = false,
-- set_option = false`: administer the role, but neither inherit its privileges nor
-- assume it. Those two flags ARE the security property, so they are what is checked.
SELECT is_empty(
  $$ SELECT m.rolname
       FROM pg_catalog.pg_auth_members am
       JOIN pg_catalog.pg_roles m ON m.oid = am.member
       JOIN pg_catalog.pg_roles r ON r.oid = am.roleid
      WHERE r.rolname = 'app_tenancy_rpc'
        AND (am.inherit_option OR am.set_option) $$,
  'no role inherits app_tenancy_rpc privileges or can SET ROLE to it — the ownership-transfer grant was revoked'
);

-- The client-facing roles must not hold the attributes either. `authenticated`
-- with BYPASSRLS is every policy in this repo switched off at once.
SELECT is_empty(
  $$ SELECT rolname FROM pg_catalog.pg_roles
      WHERE rolname IN ('authenticated', 'anon')
        AND (rolsuper OR rolbypassrls) $$,
  'neither authenticated nor anon holds superuser or BYPASSRLS'
);

-- ── the definer RPCs ────────────────────────────────────────────────────────
-- Read out of pg_proc rather than out of migration text: a function replaced by
-- a later CREATE OR REPLACE that dropped the SET clause looks fine in the file
-- that first created it.
--
-- An empty search_path is what stops a caller-controlled schema shadowing an
-- unqualified name inside a function running with the owner's authority. The
-- two spellings below are the same value — PostgreSQL stores the empty string
-- quoted or bare depending on version, and asserting one spelling would red on
-- a healthy database.
SELECT is_empty(
  $$ SELECT n.nspname || '.' || p.proname AS fn
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_catalog.pg_roles o ON o.oid = p.proowner
      WHERE o.rolname = 'app_tenancy_rpc'
        AND (NOT p.prosecdef
          OR NOT EXISTS (
            SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c
             WHERE c IN ('search_path=', 'search_path=""'))) $$,
  'every function owned by app_tenancy_rpc is SECURITY DEFINER with an empty search_path'
);

-- PostgreSQL grants EXECUTE to PUBLIC on every new function and Supabase's
-- default privileges additionally grant anon, so a definer function that names
-- no grants is ALREADY callable by an unauthenticated caller. Checking `anon`
-- catches a PUBLIC grant too, since PUBLIC flows into every role's effective
-- privileges — which is why this reads the effective privilege rather than the
-- catalog's ACL text.
SELECT is_empty(
  $$ SELECT n.nspname || '.' || p.proname AS fn
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_catalog.pg_roles o ON o.oid = p.proowner
      WHERE o.rolname = 'app_tenancy_rpc'
        AND has_function_privilege('anon'::name, p.oid, 'EXECUTE') $$,
  'anon can execute none of the tenancy RPCs'
);

-- POSITIVE CONTROL: the RPCs in the exposed schema must remain callable by the
-- role that is supposed to call them, or a database that revoked EXECUTE from
-- everybody would pass the assertion above and every seat operation would fail
-- at runtime. Restricted to `public` because the private helpers are policy
-- machinery, not an API surface.
SELECT is_empty(
  $$ SELECT p.proname
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_catalog.pg_roles o ON o.oid = p.proowner
      WHERE o.rolname = 'app_tenancy_rpc' AND n.nspname = 'public'
        AND NOT has_function_privilege('authenticated'::name, p.oid, 'EXECUTE') $$,
  'authenticated can execute every tenancy RPC in the exposed schema'
);

-- ── the freeze triggers ─────────────────────────────────────────────────────
-- Without these, every scope predicate in the system is advisory: an UPDATE
-- that passes its policy could rewrite org_id and walk the row into another
-- tenant. Three properties are asserted that no static read of the migration
-- can establish: the trigger is still ENABLED (a later ALTER TABLE … DISABLE
-- TRIGGER leaves the CREATE statement in history looking untouched), it carries
-- no WHEN clause (a freeze that can be conditioned away is not a freeze), and
-- it is BEFORE UPDATE FOR EACH ROW rather than some weaker shape.
CREATE TEMPORARY TABLE freeze_triggers (table_name text, trigger_name text, PRIMARY KEY (table_name, trigger_name));
INSERT INTO freeze_triggers (table_name, trigger_name) VALUES
  ('memberships', 'memberships_freeze_identity'),
  -- Both twins on the elevation table: the tenant-key freeze every org-scoped
  -- table carries, and the identity freeze — an elevation whose user_id could be
  -- UPDATEd would walk one seat's privilege onto another user.
  ('admin_elevations', 'admin_elevations_freeze'),
  ('admin_elevations', 'admin_elevations_freeze_identity'),
  ('invitations', 'invitations_freeze_org'),
  ('notes', 'notes_freeze_org');

SELECT is_empty(
  $$ SELECT f.table_name, f.trigger_name
       FROM freeze_triggers f
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_trigger tg
         WHERE tg.tgrelid = ('public.' || f.table_name)::regclass
           AND tg.tgname = f.trigger_name
           AND NOT tg.tgisinternal
           AND tg.tgenabled <> 'D'
           AND tg.tgqual IS NULL
           AND (tg.tgtype & 1) = 1
           AND (tg.tgtype & 2) = 2
           AND (tg.tgtype & 16) = 16) $$,
  'every tenant key carries an ENABLED, unconditional BEFORE UPDATE FOR EACH ROW freeze trigger'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Per-role resource ceilings, read from pg_db_role_setting
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS PROVES AND WHAT IT DOES NOT, stated because the gap is the whole
-- subtlety of the control. `ALTER ROLE x SET y` writes the row read below, and
-- PostgreSQL applies it when role x STARTS A SESSION — `SET ROLE` does not, so
-- PostgreSQL alone would leave every ceiling inert. They bind because PostgREST
-- reads this very catalog for the role it impersonates and applies it per request.
--
-- So this assertion proves the row EXISTS, which is exactly what PostgREST reads.
-- It cannot prove PostgREST applied it — only a call arriving through the API can,
-- which is what the client suite does with public.effective_limits(). Both halves
-- are needed; neither is sufficient.
-- SOURCE: transaction-local GUCs and role settings [corpus: postgres/guc-set-local]
CREATE TEMPORARY TABLE role_ceilings (role_name text, knob text, PRIMARY KEY (role_name, knob));
INSERT INTO role_ceilings (role_name, knob) VALUES
  ('anon', 'statement_timeout'),
  ('anon', 'idle_in_transaction_session_timeout'),
  ('anon', 'lock_timeout'),
  ('authenticated', 'statement_timeout'),
  ('authenticated', 'idle_in_transaction_session_timeout'),
  ('authenticated', 'lock_timeout'),
  ('service_role', 'statement_timeout'),
  ('service_role', 'idle_in_transaction_session_timeout'),
  ('service_role', 'lock_timeout');

SELECT is_empty(
  $$ SELECT c.role_name || '.' || c.knob
       FROM role_ceilings c
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_db_role_setting s
          JOIN pg_roles r ON r.oid = s.setrole
         WHERE r.rolname = c.role_name
           AND EXISTS (SELECT 1 FROM unnest(s.setconfig) AS cfg WHERE cfg LIKE c.knob || '=%')
      ) $$,
  'every reviewed role x knob pair is present in pg_db_role_setting'
);

-- The INVERTED assertion, and the reason it is here rather than only in the static
-- gate: both knobs below can be WRITTEN by a migration that a reviewer waves through,
-- and neither binds anything on this platform. temp_file_limit is superuser-only, so
-- postgres cannot set it at all; a CONNECTION LIMIT binds at LOGIN and none of the
-- three client roles ever logs in (PostgREST logs in as `authenticator`).
SELECT is_empty(
  $$ SELECT r.rolname
       FROM pg_roles r
       JOIN pg_db_role_setting s ON s.setrole = r.oid
      WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
        AND EXISTS (SELECT 1 FROM unnest(s.setconfig) AS cfg WHERE cfg LIKE 'temp_file_limit=%') $$,
  'no client role carries temp_file_limit — it is superuser-only, so it could only ever be inert'
);
SELECT is_empty(
  $$ SELECT rolname FROM pg_roles
      WHERE rolname IN ('anon', 'authenticated', 'service_role') AND rolconnlimit <> -1 $$,
  'no client role carries a CONNECTION LIMIT — it binds at login, and none of them log in'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- The quota's shape, read from pg_trigger
-- ─────────────────────────────────────────────────────────────────────────────
-- tgtype bit 1 = FOR EACH ROW. Its ABSENCE is the assertion: a per-row quota trigger
-- serializes every insert behind the org's single usage tuple. The transition table
-- is what makes a statement-level trigger able to count at all, and pg_trigger records
-- it in tgnewtable / tgoldtable.
SELECT is_empty(
  $$ SELECT g.tgname FROM pg_trigger g
      WHERE g.tgfoid = 'private.enforce_org_quota()'::regprocedure
        AND NOT g.tgisinternal
        AND ((g.tgtype & 1) = 1 OR g.tgnewtable IS NULL) $$,
  'every quota trigger is FOR EACH STATEMENT and declares a NEW transition table'
);
SELECT is_empty(
  $$ SELECT g.tgname FROM pg_trigger g
      WHERE g.tgfoid = 'private.release_org_quota()'::regprocedure
        AND NOT g.tgisinternal
        AND ((g.tgtype & 1) = 1 OR g.tgoldtable IS NULL) $$,
  'every release trigger is FOR EACH STATEMENT and declares an OLD transition table'
);

-- A tenant that can write its own counter, or raise its own ceiling, has no quota.
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.org_usage', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.org_usage', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.org_quota', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.org_quota', 'INSERT'),
  'authenticated holds no write privilege on the usage counter or the quota ceiling'
);

-- The reconciler's safety is unreachability, not a scoped owner: a tenant-scoped
-- owner would read an empty scope under pg_cron (no JWT) and zero every counter.
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.reconcile_org_usage()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.reconcile_org_usage()', 'EXECUTE'),
  'the usage reconciler is callable by no client role'
);

SELECT * FROM finish();

ROLLBACK;
