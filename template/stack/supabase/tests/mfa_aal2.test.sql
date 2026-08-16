-- supabase/tests/mfa_aal2.test.sql — the MFA rail, proven against a running database.
--
-- Run with `supabase test db`. One transaction, ROLLBACK at the end: the suite creates
-- its own org, users and factor and leaves no residue.
--
-- ── THE ASSERTION THAT DISTINGUISHES A WORKING RAIL FROM A BROKEN ONE ───────────
-- An ENROLLED user presenting an `aal1` token gets ZERO ROWS.
--
-- That sentence is the whole file. The vendor-documented aal2 policy — see
-- supabase/migrations/20260812000000_mfa_aal2.sql for all three of its defects — passes
-- every OTHER test anybody would write. An unenrolled user is correctly admitted; an
-- enrolled user at aal2 is correctly admitted; the policy exists, is restrictive, and
-- names the right table. Its `CASE` falls through to `array['aal1','aal2']` whenever
-- the factor read comes back empty, and a naive `GRANT SELECT ON auth.mfa_factors`
-- leaves that table default-deny — so the count is zero for everyone, including the
-- enrolled, and aal1 sails through. The ONLY case that separates the two is an
-- enrolled user who did not use their factor. Everything else here exists so that
-- this one assertion cannot pass for the wrong reason.
--
-- ── THE VACUITY CONTROLS, in both directions ───────────────────────────────────
-- A rail that refuses everybody would satisfy the assertion above and destroy the
-- product, so the unenrolled user reads the SAME rows throughout: the rail must be
-- invisible to a user who has no second factor. And the enrolled user at aal2 must
-- read those rows too, or "enforcement" is indistinguishable from "enrolment breaks
-- your account".
--
-- ── TWO TRAPS THIS FILE IS WRITTEN AROUND ──────────────────────────────────────
--   * The claim goes in `request.jwt.claims` — the PLURAL blob GUC. The singular
--     `request.jwt.claim.aal` form is also read by private.caller_aal(), but a suite
--     that set only the singular one and no blob would leave auth.uid() NULL, every
--     policy would match nothing, and the aal1 denial below would pass while proving
--     nothing about aal at all.
--   * auth.mfa_factors carries a GLOBAL UNIQUE on last_challenged_at, so the fixture
--     leaves it NULL. Two factors with the same challenge timestamp collide across
--     users, which reads as an unrelated fixture failure.
-- SOURCE: docs/adr/20260812-mfa-aal2.md

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

-- Org ids are minted by create_org(), so no assertion can name one as a literal.
-- Same fixture reader as rls_isolation.test.sql, for the same anti-vacuity reason: a
-- sub-select resolved as the wrong member returns NULL, and `org_id = NULL` matches
-- nothing, which is how a denial assertion passes without testing a denial.
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
CREATE FUNCTION public.mfa_fixture(p_key text) RETURNS text LANGUAGE sql STABLE AS
  $fx$ SELECT current_setting('mfa.' || p_key) $fx$;
GRANT EXECUTE ON FUNCTION public.mfa_fixture(text) TO authenticated;

-- Counted by hand against the assertions below. pgTAP fails a plan mismatch, so an
-- assertion deleted in a hurry cannot pass as a smaller suite.
SELECT plan(25);

-- ─────────────────────────────────────────────────────────────────────────────
-- Shape: the rail is built the way the migration claims
-- ─────────────────────────────────────────────────────────────────────────────
SELECT has_function('private', 'caller_aal', 'private.caller_aal() exists');
SELECT has_function('private', 'mfa_is_required', 'private.mfa_is_required() exists');
SELECT has_function('private', 'mfa_satisfied', 'private.mfa_satisfied() exists');

-- SECURITY DEFINER is not a style choice here: it is the ONLY thing that gives the
-- function its read of auth.mfa_factors, on which `authenticated` holds no privilege.
-- An INVOKER version raises 42501 for every caller — the vendor policy's first defect.
SELECT ok(
  (SELECT p.prosecdef FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'private' AND p.proname = 'mfa_is_required'),
  'private.mfa_is_required() is SECURITY DEFINER — the read of auth.mfa_factors depends on it'
);

-- A definer without a pinned search_path runs the owner's privileges against whatever
-- the caller planted in a schema ahead of it. The catalog stores the setting with the
-- empty string QUOTED — `search_path=""`, not `search_path=` — which is worth writing
-- down here because the unquoted form looks right, matches nothing, and the assertion
-- then fails against a function that is in fact correctly pinned.
SELECT ok(
  (SELECT p.proconfig @> ARRAY['search_path=""'] FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'private' AND p.proname = 'mfa_is_required'),
  'private.mfa_is_required() pins search_path to the empty string'
);

-- NO grant on auth.mfa_factors is created, and none is needed. The naive fix for the
-- vendor policy’s 42501 is exactly this grant, and it is what turns a loud failure
-- into a silent fail-open.
SELECT ok(
  NOT has_table_privilege('authenticated', 'auth.mfa_factors', 'SELECT'),
  'authenticated holds NO read on auth.mfa_factors — the definer function is the whole access path'
);

SELECT is(
  (SELECT permissive FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'notes' AND policyname = 'notes_mfa_aal2'),
  'RESTRICTIVE',
  'notes_mfa_aal2 is RESTRICTIVE — it ANDs onto the permissive set and can only subtract'
);

-- No `FOR` clause, so every command. The vendor’s other documentation page writes this
-- same policy `for update`, which gates writes and leaves SELECT wide open.
SELECT is(
  (SELECT cmd FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'notes' AND policyname = 'notes_mfa_aal2'),
  'ALL',
  'notes_mfa_aal2 covers every command, not just one'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixtures
-- ─────────────────────────────────────────────────────────────────────────────
-- auth.users belongs to the Auth service and `authenticated` holds no grant on it, so
-- the identities are created as the migration role and nothing else is.
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at)
VALUES
  ('77777777-7777-4777-8777-777777777777', 'authenticated', 'authenticated',
   'enrolled@example.com', now(), now()),
  ('88888888-8888-4888-8888-888888888888', 'authenticated', 'authenticated',
   'unenrolled@example.com', now(), now());

-- A VERIFIED TOTP factor for one of them, and only one. `last_challenged_at` stays
-- NULL: the column carries a GLOBAL unique constraint, so two fixtures that stamp it
-- collide across users and the failure reads as something else entirely.
INSERT INTO auth.mfa_factors
  (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
VALUES
  ('99999999-9999-4999-8999-999999999999', '77777777-7777-4777-8777-777777777777',
   'fixture authenticator', 'totp', 'verified', now(), now());

-- The fixture’s own positive control. If this row were `unverified`, every denial
-- below would still pass — because mfa_is_required() would be false and the rail would
-- be dormant — and the suite would be asserting nothing at all.
SELECT is(
  (SELECT status::text FROM auth.mfa_factors
    WHERE user_id = '77777777-7777-4777-8777-777777777777'),
  'verified',
  'the enrolled fixture user really does hold a VERIFIED factor (without this, every denial below is vacuous)'
);

-- Both users seated in one org, entirely through the RPCs — `authenticated` holds no
-- INSERT grant on orgs or memberships, so a broken definer write path dies here rather
-- than quietly asserting less.
DO $bootstrap$
DECLARE
  v_org uuid;
  v_token uuid;
BEGIN
  -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
  PERFORM set_config('request.jwt.claims',
    '{"sub": "77777777-7777-4777-8777-777777777777", "role": "authenticated", "aal": "aal2"}', true);
  PERFORM set_config('role', 'authenticated', true);
  v_org := public.create_org('MFA Org', 'mfa-org');
  -- The privilege lifecycle (1.0.0): the invitation mint below is judged against
  -- the EFFECTIVE rank, which requires an unexpired elevation (the JIT fold).
  PERFORM public.elevate(v_org);
  v_token := public.create_invitation(v_org, 'unenrolled@example.com', 20::smallint);
  -- SOURCE: transaction-local GUCs — the pooling identity hazard [corpus: postgres/guc-set-local]
  PERFORM set_config('role', 'none', true);

  -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
  PERFORM set_config('request.jwt.claims',
    '{"sub": "88888888-8888-4888-8888-888888888888", "role": "authenticated", "aal": "aal1"}', true);
  PERFORM set_config('role', 'authenticated', true);
  PERFORM public.accept_invitation(v_token);
  INSERT INTO public.notes (id, org_id, owner_id, title, body)
  VALUES ('cccc0001-0000-4000-8000-000000000001', v_org,
          '88888888-8888-4888-8888-888888888888', 'unenrolled note', 'written without a second factor');
  -- SOURCE: transaction-local GUCs — the pooling identity hazard [corpus: postgres/guc-set-local]
  PERFORM set_config('role', 'none', true);

  -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
  PERFORM set_config('mfa.org', v_org::text, true);
END;
$bootstrap$;

-- ════════════════════════════════════════════════════════════════════════════
-- The ENROLLED user at aal2 — the positive control, and it comes first
-- ════════════════════════════════════════════════════════════════════════════
-- Against a database where the rail refuses everybody, every denial below passes and
-- this one fails. Asserting the denial alone cannot tell the two apart.
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "77777777-7777-4777-8777-777777777777", "role": "authenticated", "aal": "aal2"}';
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT count(*)::int FROM public.notes WHERE org_id = public.mfa_fixture('org')::uuid),
  1,
  'aal2 + enrolled: the org''s note is readable — enrolling a factor does not lock a user out'
);

SELECT lives_ok(
  $$ INSERT INTO public.notes (id, org_id, owner_id, title, body)
     VALUES ('cccc0002-0000-4000-8000-000000000002', public.mfa_fixture('org')::uuid,
             '77777777-7777-4777-8777-777777777777', 'enrolled note', 'written at aal2') $$,
  'aal2 + enrolled: a write lands'
);

RESET ROLE;

-- ════════════════════════════════════════════════════════════════════════════
-- The ENROLLED user at aal1 — THE assertion
-- ════════════════════════════════════════════════════════════════════════════
-- Same user, same org, same rows, one claim different.
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "77777777-7777-4777-8777-777777777777", "role": "authenticated", "aal": "aal1"}';
SET LOCAL ROLE authenticated;

SELECT is_empty(
  $$ SELECT id FROM public.notes $$,
  'aal1 + enrolled: ZERO ROWS. This is the case the vendor-documented policy admits, and the only one that separates a working rail from a fail-open.'
);

-- A restrictive policy filters rows rather than rejecting statements, so a read is
-- empty and a WRITE is the thing that raises: WITH CHECK refuses the new row.
SELECT throws_ok(
  $$ INSERT INTO public.notes (id, org_id, owner_id, title, body)
     VALUES ('cccc0003-0000-4000-8000-000000000003', public.mfa_fixture('org')::uuid,
             '77777777-7777-4777-8777-777777777777', 'smuggled', 'written at aal1') $$,
  '42501'::char(5),
  NULL::text,
  'aal1 + enrolled: INSERT is refused — WITH CHECK, not just USING, or an aal1 session could write rows it cannot see'
);

-- UPDATE and DELETE match no row rather than raising, which is the correct shape: a
-- row-level denial that RAISED would confirm to a caller not allowed to ask that the
-- rows exist. So both run as bare statements here and the assertion happens after the
-- role is dropped — checked against what a reader OUTSIDE the policy can see, which is
-- a stronger claim than a RETURNING count and needs no exotic syntax. (Two syntaxes
-- were tried first and both are outright errors: a data-modifying statement is legal
-- neither as a plain sub-select nor inside a CTE that is not at statement top level.)
UPDATE public.notes SET title = 'rewritten' WHERE org_id = public.mfa_fixture('org')::uuid;
DELETE FROM public.notes WHERE org_id = public.mfa_fixture('org')::uuid;

RESET ROLE;

SELECT is(
  (SELECT count(*)::int FROM public.notes WHERE title = 'rewritten'),
  0,
  'aal1 + enrolled: the UPDATE changed nothing — asserted from OUTSIDE the policy, so an empty result cannot be the policy hiding its own damage'
);

SELECT is(
  (SELECT count(*)::int FROM public.notes WHERE org_id = public.mfa_fixture('org')::uuid),
  2,
  'aal1 + enrolled: the DELETE removed nothing — both notes are still there'
);

-- ════════════════════════════════════════════════════════════════════════════
-- The ENROLLED user with NO aal claim at all — fails CLOSED
-- ════════════════════════════════════════════════════════════════════════════
-- A token minted before the claim existed, or a path that drops it. `caller_aal()`
-- returns NULL, `NULL = 'aal2'` is NULL, and the predicate resolves to NULL, which RLS
-- treats as false. Written down because the opposite convention — absent means
-- unrestricted — is the single commonest way a claim check fails open.
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "77777777-7777-4777-8777-777777777777", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

SELECT is_empty(
  $$ SELECT id FROM public.notes $$,
  'no aal claim + enrolled: ZERO ROWS — an absent claim is not an unrestricted one'
);

RESET ROLE;

-- ════════════════════════════════════════════════════════════════════════════
-- The UNENROLLED user — the rail is invisible to them, at either level
-- ════════════════════════════════════════════════════════════════════════════
-- The product half. A rail that refuses everybody satisfies every denial above.
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "88888888-8888-4888-8888-888888888888", "role": "authenticated", "aal": "aal1"}';
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT count(*)::int FROM public.notes WHERE org_id = public.mfa_fixture('org')::uuid),
  2,
  'aal1 + NOT enrolled: both notes readable — a user with no second factor is unaffected'
);

SELECT ok(
  NOT (SELECT private.mfa_is_required()),
  'private.mfa_is_required() is FALSE for a user holding no verified factor'
);

SELECT ok(
  (SELECT private.mfa_satisfied()),
  'private.mfa_satisfied() is TRUE at aal1 for a user holding no verified factor'
);

RESET ROLE;

-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "88888888-8888-4888-8888-888888888888", "role": "authenticated", "aal": "aal2"}';
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT count(*)::int FROM public.notes WHERE org_id = public.mfa_fixture('org')::uuid),
  2,
  'aal2 + NOT enrolled: still both notes — raising assurance never removes access'
);

RESET ROLE;

-- ════════════════════════════════════════════════════════════════════════════
-- The helper, judged directly for the enrolled user
-- ════════════════════════════════════════════════════════════════════════════
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "77777777-7777-4777-8777-777777777777", "role": "authenticated", "aal": "aal1"}';
SET LOCAL ROLE authenticated;

SELECT ok(
  (SELECT private.mfa_is_required()),
  'private.mfa_is_required() is TRUE for the enrolled user — read through the definer, with no grant on auth.mfa_factors'
);

SELECT ok(
  NOT (SELECT private.mfa_satisfied()),
  'private.mfa_satisfied() is FALSE at aal1 for the enrolled user'
);

SELECT is(
  (SELECT private.caller_aal()),
  'aal1',
  'private.caller_aal() reads the aal claim out of the request.jwt.claims blob'
);

RESET ROLE;

-- ════════════════════════════════════════════════════════════════════════════
-- The lifecycle's aal2 gate, for the ENROLLED owner (1.0.0)
-- ════════════════════════════════════════════════════════════════════════════
-- elevate()'s lapsed-owner self-revalidation branch is gated on
-- private.mfa_satisfied(). rls_isolation.test.sql proves the branch WORKS for an
-- unenrolled fixture (vacuously satisfied); this is the half only THIS suite can
-- prove, because only this suite stages a verified factor: an enrolled owner at
-- aal1 is REFUSED, and the same owner at aal2 passes. The enrolled user founded
-- this suite's org, so they are its rank-40 owner. Fixture aging runs as the
-- superuser — FORCE RLS bars every in-model role from moving a clock.
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
UPDATE public.memberships SET revalidated_at = now() - interval '13 months'
 WHERE user_id = '77777777-7777-4777-8777-777777777777'::uuid
   AND org_id = current_setting('mfa.org')::uuid;

-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "77777777-7777-4777-8777-777777777777", "role": "authenticated", "aal": "aal1"}';
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
  $$ SELECT public.elevate(current_setting('mfa.org')::uuid) $$,
  '42501'::char(5),
  NULL::text,
  'a lapsed ENROLLED owner at aal1 cannot self-revalidate — the branch demands the second factor it exists to demand'
);

RESET ROLE;

-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "77777777-7777-4777-8777-777777777777", "role": "authenticated", "aal": "aal2"}';
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
  $$ SELECT public.elevate(current_setting('mfa.org')::uuid) $$,
  'the SAME owner at aal2 self-revalidates and elevates — the gate asks for the factor, not for a support ticket'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
