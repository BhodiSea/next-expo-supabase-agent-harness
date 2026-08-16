-- supabase/tests/auth_trail.test.sql — the authentication-event trail, proven
-- against a running database.
--
-- Run with `supabase test db`. One transaction, ROLLBACK at the end.
--
-- WHAT ONLY THIS SUITE CAN PROVE, and the one role it cannot wear. The hooks are
-- called by GoTrue with a payload this suite synthesizes byte-for-byte. The
-- harness role CANNOT `SET ROLE supabase_auth_admin` — it is platform-owned and
-- postgres is not a member, locally exactly as hosted — so the auth server's
-- licence is asserted STRUCTURALLY (has_function_privilege), and the behavioural
-- calls run as the function OWNER instead: the hooks are SECURITY DEFINER, so
-- the body executes as app_auth_trail_writer for EVERY licensed caller and the
-- privilege path inside the function is identical. The as-GoTrue half — that a
-- real attempt actually calls the hook — lives in tests/rls/auth-trail.test.ts,
-- which performs a REAL failed signInWithPassword over HTTP and counts the row.
--
-- THE ASSERTION THAT MATTERS MOST is (7): a broken trail must NEVER fail the
-- sign-in it observes. The hook's exception wrap is the one line standing
-- between "a partition filled up" and "every user is locked out"; this suite
-- breaks the trail on purpose and asserts the hook still answers continue.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT plan(23);

-- ── (1) shape: the wall, read from the catalog ──────────────────────────────
SELECT has_schema('auth_trail', 'schema auth_trail exists');
SELECT has_table('auth_trail', 'events', 'auth_trail.events exists');

SELECT ok(
  NOT has_schema_privilege('authenticated', 'auth_trail', 'USAGE')
  AND NOT has_schema_privilege('anon', 'auth_trail', 'USAGE')
  AND NOT has_schema_privilege('service_role', 'auth_trail', 'USAGE'),
  'no client role holds USAGE on auth_trail — the table name does not even resolve for them'
);

SELECT ok(
  (SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_class c
    WHERE c.oid = 'auth_trail.events'::regclass),
  -- SOURCE: FORCE ROW LEVEL SECURITY subjects the table owner to policies [corpus: postgres/rls-force]
  'auth_trail.events has ENABLE and FORCE ROW LEVEL SECURITY'
);

SELECT ok(
  (SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_class c
    WHERE c.oid = 'auth_trail.events_default'::regclass),
  'the default partition carries its own ENABLE + FORCE (RLS is not inherited by partitions)'
);

-- supabase_auth_admin executes the definers and touches NOTHING directly — the
-- functions are its whole reach.
SELECT ok(
  NOT has_table_privilege('supabase_auth_admin', 'auth_trail.events', 'INSERT')
  AND NOT has_table_privilege('supabase_auth_admin', 'auth_trail.events', 'SELECT'),
  'supabase_auth_admin holds no direct privilege on the table — the definer hooks are the only path'
);

-- There is deliberately NO SELECT policy for any role: the read posture is the
-- operator's own database access, recorded in the migration header. A SELECT
-- policy appearing here is somebody quietly adding a read path.
SELECT is_empty(
  $$ SELECT polname FROM pg_policy p
      WHERE p.polrelid = 'auth_trail.events'::regclass AND p.polcmd = 'r' $$,
  'no SELECT policy exists on the trail — the no-reader posture is structural, not habit'
);

-- ── (2) the auth server's licence, read from the catalog ───────────────────
SELECT ok(
  has_function_privilege('supabase_auth_admin', 'auth_trail.password_verification_hook(jsonb)', 'EXECUTE'),
  'supabase_auth_admin may execute the password hook — the licence GoTrue actually uses'
);
SELECT ok(
  has_function_privilege('supabase_auth_admin', 'auth_trail.mfa_verification_hook(jsonb)', 'EXECUTE'),
  'supabase_auth_admin may execute the MFA hook too'
);

-- ── (3) the hooks, behaviourally, as the function owner ─────────────────────
-- The creator's implicit ADMIN OPTION on app_auth_trail_writer (postgres created
-- the role in the migration) lets this transaction grant itself SET; the grant
-- rolls back with everything else. The extensions USAGE is test-scoped too: the
-- writer role deliberately holds no reach beyond auth_trail, but the pgTAP
-- functions live in `extensions` and must resolve while this suite wears it.
GRANT app_auth_trail_writer TO postgres;
GRANT USAGE ON SCHEMA extensions TO app_auth_trail_writer;
-- SOURCE: transaction-local role scoping [corpus: postgres/guc-set-local]
SET LOCAL ROLE app_auth_trail_writer;

SELECT is(
  (SELECT auth_trail.password_verification_hook(
    '{"user_id": "aaaaaaaa-0000-4000-8000-000000000001", "valid": false}'::jsonb) ->> 'decision'),
  'continue',
  'the password hook answers continue on a FAILED attempt — it observes, it does not decide'
);

SELECT is(
  (SELECT auth_trail.password_verification_hook(
    '{"user_id": "aaaaaaaa-0000-4000-8000-000000000001", "valid": true}'::jsonb) ->> 'decision'),
  'continue',
  'the password hook answers continue on a SUCCESSFUL attempt too'
);

SELECT is(
  (SELECT auth_trail.mfa_verification_hook(
    '{"user_id": "aaaaaaaa-0000-4000-8000-000000000001", "factor_id": "bbbbbbbb-0000-4000-8000-000000000002", "valid": false}'::jsonb) ->> 'decision'),
  'continue',
  'the MFA hook answers continue on a failed verification'
);

RESET ROLE;
REVOKE app_auth_trail_writer FROM postgres;

-- ── (4) the rows landed, with the trail's own vocabulary ────────────────────
-- Read as the harness superuser: the operator posture the header records.
SELECT results_eq(
  $$ SELECT event_kind FROM auth_trail.events
      WHERE user_id = 'aaaaaaaa-0000-4000-8000-000000000001'::uuid
      ORDER BY id $$,
  $$ VALUES ('password_failure'::text), ('password_success'::text), ('mfa_failure'::text) $$,
  'three synthetic attempts landed as three rows in the trail''s own closed vocabulary'
);

SELECT results_eq(
  $$ SELECT factor_id::text FROM auth_trail.events
      WHERE event_kind = 'mfa_failure'
        AND user_id = 'aaaaaaaa-0000-4000-8000-000000000001'::uuid $$,
  $$ VALUES ('bbbbbbbb-0000-4000-8000-000000000002'::text) $$,
  'the MFA row records WHICH factor was exercised'
);

-- A payload the hook cannot map still cannot fail the attempt.
GRANT app_auth_trail_writer TO postgres;
-- SOURCE: transaction-local role scoping [corpus: postgres/guc-set-local]
SET LOCAL ROLE app_auth_trail_writer;
SELECT is(
  (SELECT auth_trail.password_verification_hook('{"valid": null}'::jsonb) ->> 'decision'),
  'continue',
  'a payload with no valid flag still answers continue (the row is a CASE fallthrough, the attempt is unaffected)'
);
RESET ROLE;
REVOKE app_auth_trail_writer FROM postgres;

-- ── (5) client denial ───────────────────────────────────────────────────────
-- SOURCE: transaction-local role scoping [corpus: postgres/guc-set-local]
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT id FROM auth_trail.events LIMIT 1 $$,
  '42501',
  NULL,
  'authenticated cannot reach the trail at all — the schema wall denies before any policy is consulted'
);
SELECT throws_ok(
  $$ SELECT auth_trail.password_verification_hook('{}'::jsonb) $$,
  '42501',
  NULL,
  'authenticated cannot execute the hook either — EXECUTE belongs to the auth server alone'
);
RESET ROLE;

-- ── (6) immutability, including against the superuser ───────────────────────
SELECT throws_ok(
  $$ UPDATE auth_trail.events SET event_kind = 'password_success' $$,
  '42501',
  NULL,
  'UPDATE is refused even for postgres — layer 3 binds BYPASSRLS'
);
SELECT throws_ok(
  $$ DELETE FROM auth_trail.events $$,
  '42501',
  NULL,
  'DELETE is refused even for postgres'
);
SELECT throws_ok(
  $$ TRUNCATE auth_trail.events $$,
  '42501',
  NULL,
  'TRUNCATE on the parent is refused — layer 4'
);
SELECT throws_ok(
  $$ TRUNCATE auth_trail.events_default $$,
  '42501',
  NULL,
  'TRUNCATE on the default partition is refused — TRUNCATE triggers are not cloned, so the twin must exist'
);

-- ── (7) a broken trail must never fail the sign-in ──────────────────────────
-- Break the write path on purpose (revoke the writer's INSERT inside this
-- rolled-back transaction) and prove the hook still answers continue. This is
-- the exception wrap doing the one job it exists for: the failure direction is
-- a lost row, never a locked-out user.
REVOKE INSERT ON TABLE auth_trail.events FROM app_auth_trail_writer;

GRANT app_auth_trail_writer TO postgres;
-- SOURCE: transaction-local role scoping [corpus: postgres/guc-set-local]
SET LOCAL ROLE app_auth_trail_writer;
SELECT is(
  (SELECT auth_trail.password_verification_hook(
    '{"user_id": "aaaaaaaa-0000-4000-8000-000000000001", "valid": false}'::jsonb) ->> 'decision'),
  'continue',
  'with the trail BROKEN the hook still answers continue — a trail fault can never deny sign-in'
);
RESET ROLE;
REVOKE app_auth_trail_writer FROM postgres;

GRANT INSERT ON TABLE auth_trail.events TO app_auth_trail_writer;

SELECT results_eq(
  $$ SELECT count(*)::int FROM auth_trail.events
      WHERE user_id = 'aaaaaaaa-0000-4000-8000-000000000001'::uuid
        AND event_kind = 'password_failure' $$,
  $$ VALUES (1) $$,
  'the broken-trail attempt lost its row (count still 1) — the failure direction is the recorded one'
);

SELECT * FROM finish();

ROLLBACK;
