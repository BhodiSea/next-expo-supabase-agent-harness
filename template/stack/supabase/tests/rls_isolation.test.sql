-- supabase/tests/rls_isolation.test.sql — cross-ORG behaviour of the
-- authorization boundary, exercised through the same role and the same claim
-- shape a real request arrives with.
--
-- Run with `supabase test db`. One transaction, ROLLBACK at the end: the suite
-- creates its own orgs and users (deliberately NOT the ones in seed.sql) so it
-- neither depends on nor disturbs the seeded state.
--
-- THE PRINCIPLE THIS FILE EXISTS TO PIN: a cross-tenant read returns the EMPTY
-- SET, never an error. A 403 on "note 91c3…" answers the question the caller was
-- not allowed to ask — it confirms that the row EXISTS and belongs to someone
-- else. Enumerate ids against that endpoint and you have mapped another tenant
-- without ever reading a byte of their data. Existence is data. RLS gets this
-- right by construction, because it filters rows rather than rejecting
-- statements — the value here is asserting that nobody has "improved" it by
-- adding a friendly 403 in front.
--
-- THE ONE DELIBERATE ASYMMETRY: the anonymous case at the bottom DOES raise
-- (SQLSTATE 42501, permission denied) rather than returning empty, because
-- `anon` holds no grant on the table at all. That denial is row-independent —
-- it discloses that the table exists, which is already in the API surface, and
-- nothing whatsoever about which rows are in it. Row-level denial must be
-- silent; role-level denial for a role with no business here is allowed to be
-- loud, and being loud is what makes the missing grant obvious in a log.
--
-- ── WHAT CHANGED WITH ORG SCOPE, AND WHY THIS FILE GREW ────────────────────
-- Under the old per-user model, "isolation" was one question: can B read A's
-- row? Under org scope there are three, and only the first survives from before:
--
--   1. can a member of org B read org A's rows?          (no — the boundary)
--   2. can a member of org A read a COLLEAGUE's rows?    (YES — the product)
--   3. can a member act above their RANK inside org A?   (no — the ladder)
--
-- Question 2 is why this suite carries a same-org/different-author positive
-- control. A policy tightened to `owner_id = auth.uid()` would pass every
-- isolation assertion in the old file while silently breaking the entire point
-- of a B2B product, and nothing would have noticed.
--
-- Question 3 is why every rank floor is exercised in BOTH directions: rank R
-- succeeds AND rank R−1 fails. Asserting only the denial passes against a
-- database where nobody can do anything; asserting only the success passes
-- against one where rank is ignored entirely.
--
-- ── HOW ORG IDS TRAVEL ─────────────────────────────────────────────────────
-- Org ids are minted by public.create_org(), so this file cannot hardcode them,
-- and it cannot look them up as the seeding role either (locally that role is a
-- superuser and sees everything; on a hosted project it may see nothing —
-- either way it is not the read the application performs). They are stashed in
-- transaction-local custom GUCs at bootstrap and read back through public.iso()
-- below, which is role-independent and needs no grant.
--
-- That detail is load-bearing for ANTI-VACUITY. The cross-org probes have to
-- name org B by its real id: if they resolved it with a sub-select run as a
-- member of org A, it would come back NULL, `org_id = NULL` would match nothing,
-- and every isolation assertion below would pass without testing anything.
-- A missing GUC raises instead — loudly, which is the point.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

-- The fixture reader. Org ids are minted by create_org() at bootstrap, so no
-- assertion below can name one as a literal; this concentrates the lookup in one
-- place rather than scattering it through thirty of them. It is created inside
-- the suite's transaction and disappears with the ROLLBACK at the bottom.
--
-- STABLE rather than IMMUTABLE: the value is fixed for the transaction but is
-- not a function of the arguments alone, and marking it IMMUTABLE would licence
-- the planner to fold it at plan time against whatever was set first.
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
CREATE FUNCTION public.iso(p_key text) RETURNS text LANGUAGE sql STABLE AS
  $iso$ SELECT current_setting('iso.' || p_key) $iso$;
GRANT EXECUTE ON FUNCTION public.iso(text) TO authenticated;

-- Count checked against the assertion calls below; pgTAP fails a plan mismatch,
-- so an assertion deleted in a hurry cannot pass as a smaller suite.
SELECT plan(61);

-- ── identities, as the migration role ───────────────────────────────────────
-- auth.users belongs to the Auth service and `authenticated` holds no grant on
-- it, so the identities are created here and nothing else is. Four seats in org
-- A, one outsider who founds org B.
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'owner-a@example.com', now(), now()),
  ('22222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'admin-a@example.com', now(), now()),
  ('33333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated',
   'member-a@example.com', now(), now()),
  ('44444444-4444-4444-8444-444444444444', 'authenticated', 'authenticated',
   'viewer-a@example.com', now(), now()),
  ('55555555-5555-4555-8555-555555555555', 'authenticated', 'authenticated',
   'outsider-b@example.com', now(), now());

-- ── bootstrap, entirely through the RPCs ────────────────────────────────────
-- There is no other way. `authenticated` holds no INSERT grant on orgs,
-- memberships or invitations, and the deny-all write policies mean not even the
-- table owner can reach them. If any RPC below is broken the suite dies here
-- rather than quietly asserting less — which makes this block the positive
-- control for the entire definer write path.
DO $bootstrap$
DECLARE
  v_seat record;
  v_org_a uuid;
  v_org_b uuid;
  v_token uuid;
BEGIN
  -- The claim is set BEFORE the role switch and the role is dropped after, so no
  -- GUC is ever written while impersonating. Both are transaction-scoped: a
  -- session that kept an identity after the transaction ended is the
  -- pooled-connection leak that makes every later statement act as the wrong user.
  -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
  PERFORM set_config('request.jwt.claims',
    '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
  PERFORM set_config('role', 'authenticated', true);
  v_org_a := public.create_org('Org A', 'iso-org-a');
  -- The privilege lifecycle (1.0.0): minting invitations is judged against the
  -- EFFECTIVE rank, which for rank >= 30 exists only while an unexpired elevation
  -- does (the JIT fold in private.member_ranks()). The owner elevates once for
  -- the whole bootstrap — making this block a positive control for the JIT door
  -- exactly as it already is for the definer write path.
  PERFORM public.elevate(v_org_a);
  -- SOURCE: transaction-local GUCs — the pooling identity hazard [corpus: postgres/guc-set-local]
  PERFORM set_config('role', 'none', true);

  FOR v_seat IN
    SELECT * FROM (VALUES
      (1, '22222222-2222-4222-8222-222222222222'::uuid, 'admin-a@example.com', 30::smallint),
      (2, '33333333-3333-4333-8333-333333333333'::uuid, 'member-a@example.com', 20::smallint),
      (3, '44444444-4444-4444-8444-444444444444'::uuid, 'viewer-a@example.com', 10::smallint)
    ) AS s(ord, id, email, role_rank)
    ORDER BY s.ord
  LOOP
    -- Minted as the owner (rank 40), because an admin may not invite at or above
    -- their own rank.
    -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
    PERFORM set_config('request.jwt.claims',
      '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
    PERFORM set_config('role', 'authenticated', true);
    v_token := public.create_invitation(v_org_a, v_seat.email, v_seat.role_rank);
    -- SOURCE: transaction-local GUCs — the pooling identity hazard [corpus: postgres/guc-set-local]
    PERFORM set_config('role', 'none', true);

    -- Redeemed by the invitee, who holds no seat in org A until this call lands.
    -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_seat.id, 'role', 'authenticated')::text, true);
    PERFORM set_config('role', 'authenticated', true);
    PERFORM public.accept_invitation(v_token);
    -- SOURCE: transaction-local GUCs — the pooling identity hazard [corpus: postgres/guc-set-local]
    PERFORM set_config('role', 'none', true);
  END LOOP;

  -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
  PERFORM set_config('request.jwt.claims',
    '{"sub": "55555555-5555-4555-8555-555555555555", "role": "authenticated"}', true);
  PERFORM set_config('role', 'authenticated', true);
  v_org_b := public.create_org('Org B', 'iso-org-b');

  -- SOURCE: transaction-local GUCs — the pooling identity hazard [corpus: postgres/guc-set-local]
  PERFORM set_config('role', 'none', true);

  -- Carried out of this block for the assertions below. A plain sub-select would
  -- be evaluated as a member of the wrong org and come back NULL, which is how a
  -- cross-tenant assertion passes without testing anything.
  -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
  PERFORM set_config('iso.org_a', v_org_a::text, true);
  PERFORM set_config('iso.org_b', v_org_b::text, true);
END;
$bootstrap$;

-- ── domain rows, each written by its author ─────────────────────────────────
DO $rows$
BEGIN
  -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
  PERFORM set_config('request.jwt.claims',
    '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
  PERFORM set_config('role', 'authenticated', true);
  INSERT INTO public.notes (id, org_id, owner_id, title, body)
  VALUES ('aaaa0001-0000-4000-8000-000000000001', public.iso('org_a')::uuid,
          '11111111-1111-4111-8111-111111111111', 'owner note', 'written by the owner');
  -- SOURCE: transaction-local GUCs — the pooling identity hazard [corpus: postgres/guc-set-local]
  PERFORM set_config('role', 'none', true);

  -- A colleague's row in the SAME org. Question 2 in the header depends on this
  -- existing and on it belonging to somebody else.
  -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
  PERFORM set_config('request.jwt.claims',
    '{"sub": "33333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
  PERFORM set_config('role', 'authenticated', true);
  INSERT INTO public.notes (id, org_id, owner_id, title, body)
  VALUES ('aaaa0002-0000-4000-8000-000000000002', public.iso('org_a')::uuid,
          '33333333-3333-4333-8333-333333333333', 'member note', 'written by a rank-20 member');
  INSERT INTO public.notes (id, org_id, owner_id, title, body)
  VALUES ('aaaa0003-0000-4000-8000-000000000003', public.iso('org_a')::uuid,
          '33333333-3333-4333-8333-333333333333', 'member second note', 'for the self-delete case');
  -- SOURCE: transaction-local GUCs — the pooling identity hazard [corpus: postgres/guc-set-local]
  PERFORM set_config('role', 'none', true);

  -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
  PERFORM set_config('request.jwt.claims',
    '{"sub": "55555555-5555-4555-8555-555555555555", "role": "authenticated"}', true);
  PERFORM set_config('role', 'authenticated', true);
  INSERT INTO public.notes (id, org_id, owner_id, title, body)
  VALUES ('bbbb0001-0000-4000-8000-000000000001', public.iso('org_b')::uuid,
          '55555555-5555-4555-8555-555555555555', 'outsider note', 'a different tenant entirely');

  -- SOURCE: transaction-local GUCs — the pooling identity hazard [corpus: postgres/guc-set-local]
  PERFORM set_config('role', 'none', true);
END;
$rows$;

-- ════════════════════════════════════════════════════════════════════════════
-- as the OWNER of org A (rank 40)
-- ════════════════════════════════════════════════════════════════════════════
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

-- POSITIVE CONTROL, and it has to come first. Against a database that denied
-- everything to everyone, every isolation assertion below passes for the worst
-- possible reason. Three rows: both of the member's and the owner's own — and
-- NOT the outsider's, even though it exists in the same table.
SELECT results_eq(
  $$ SELECT count(*)::bigint FROM public.notes $$,
  $$ VALUES (3::bigint) $$,
  'the owner of org A sees exactly the three notes in org A'
);

-- QUESTION 2, the one the old per-user suite could not ask. This is the entire
-- point of the B2B re-scope, and a policy tightened back to
-- `owner_id = (SELECT auth.uid())` would break it while passing every
-- cross-tenant assertion in this file.
SELECT results_eq(
  $$ SELECT title FROM public.notes
      WHERE owner_id = '33333333-3333-4333-8333-333333333333'::uuid
      ORDER BY title $$,
  $$ VALUES ('member note'::text), ('member second note'::text) $$,
  'a colleague in the SAME org is visible — org scope, not owner scope'
);

-- The two halves of the empty-set principle, asserted separately on purpose:
-- that the statement does not raise, and that it returns nothing. The literal
-- note id is what keeps this non-vacuous — that row certainly exists.
SELECT lives_ok(
  $$ SELECT id FROM public.notes WHERE id = 'bbbb0001-0000-4000-8000-000000000001'::uuid $$,
  'a cross-org read does not raise - RLS filters rows, it does not reject statements'
);

SELECT is_empty(
  $$ SELECT id FROM public.notes WHERE id = 'bbbb0001-0000-4000-8000-000000000001'::uuid $$,
  'a cross-org note read returns the EMPTY SET, disclosing not even existence'
);

SELECT is_empty(
  $$ SELECT id FROM public.orgs WHERE id = public.iso('org_b')::uuid $$,
  'an org the caller holds no seat in is invisible'
);

SELECT is_empty(
  $$ SELECT user_id FROM public.memberships
      WHERE user_id = '55555555-5555-4555-8555-555555555555'::uuid $$,
  'another org seat roster is invisible'
);

-- SELF-ONLY, and this is deliberate rather than incidental: the scope helpers
-- read public.memberships, so a policy here that called one would be re-entered
-- by it (SQLSTATE 54001 — stack depth, not the tidy 42P17). The member directory is a casualty of that, recorded
-- in docs/adr/20260201-org-scoped-tenancy.md rather than faked.
SELECT results_eq(
  $$ SELECT count(*)::bigint FROM public.memberships $$,
  $$ VALUES (1::bigint) $$,
  'a caller sees only their OWN seats - one, not the four this org actually has'
);

-- Writes across the boundary match nothing and raise nothing. The absence of an
-- error is the point: a caller cannot distinguish "no such row" from "not yours".
SELECT lives_ok(
  $$ UPDATE public.notes SET title = 'tampered'
      WHERE id = 'bbbb0001-0000-4000-8000-000000000001'::uuid $$,
  'a cross-org UPDATE matches no rows and raises nothing'
);

SELECT lives_ok(
  $$ DELETE FROM public.notes
      WHERE id = 'bbbb0001-0000-4000-8000-000000000001'::uuid $$,
  'a cross-org DELETE matches no rows and raises nothing'
);

-- INSERT is the one operation that DOES raise, and must: there is no row to
-- filter, so WITH CHECK has to reject the statement outright. Nothing is
-- disclosed by that — the caller supplied the org id, so they already knew it.
SELECT throws_ok(
  $$ INSERT INTO public.notes (org_id, owner_id, title)
     VALUES (public.iso('org_b')::uuid,
             '11111111-1111-4111-8111-111111111111'::uuid, 'smuggled') $$,
  '42501'::char(5),
  NULL::text,
  'an INSERT naming another org is rejected by WITH CHECK (SQLSTATE 42501)'
);

-- The seat tables are read-only to `authenticated`. A self-keyed INSERT policy
-- here would be a self-service seat grant: any user could award themselves any
-- rank in any org whose id they can name.
SELECT throws_ok(
  $$ INSERT INTO public.memberships (user_id, org_id, role_rank)
     VALUES ('11111111-1111-4111-8111-111111111111'::uuid,
             public.iso('org_b')::uuid, 40) $$,
  '42501'::char(5),
  NULL::text,
  'a direct membership INSERT is refused even for the caller themselves (SQLSTATE 42501)'
);

-- THE RECURSION PROBE, executable rather than inferred. The scope helpers read
-- public.memberships and are invoked from other tables' policies; if the
-- memberships SELECT policy ever calls one of them, every read in the application
-- dies at once — as `54001 stack depth limit exceeded`, not the `42P17 infinite
-- recursion detected in policy` you would grep for (see the note at the top of this
-- file: `SET search_path = ''` blocks the inlining the rewriter's cycle check needs).
-- Which SQLSTATE it is does not matter here, and that is the point of probing by
-- EXECUTION: `lives_ok` asserts the reads succeed, so it catches the failure under
-- either code, and under whatever a future PostgreSQL decides to raise. A static gate
-- can only apply a smell test. This runs it, across every RLS target in one statement.
SELECT lives_ok(
  $$ SELECT (SELECT count(*) FROM public.orgs)
          + (SELECT count(*) FROM public.memberships)
          + (SELECT count(*) FROM public.invitations)
          + (SELECT count(*) FROM public.notes)
          + (SELECT count(*) FROM public.profiles) $$,
  'no policy recurses (54001 stack depth exceeded) when authenticated reads every RLS target'
);

RESET ROLE;

-- ════════════════════════════════════════════════════════════════════════════
-- the RANK LADDER, both directions
-- ════════════════════════════════════════════════════════════════════════════
-- Every floor is exercised twice: the rank that clears it succeeds, and the rank
-- immediately below it fails. Asserting only the denial passes against a
-- database where nobody can do anything; asserting only the success passes
-- against one where rank is ignored.

-- ── viewer, rank 10: below the write floor of 20 ────────────────────────────
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "44444444-4444-4444-8444-444444444444", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

-- A viewer READS the org — that is what the seat is for.
SELECT results_eq(
  $$ SELECT count(*)::bigint FROM public.notes $$,
  $$ VALUES (3::bigint) $$,
  'a rank-10 viewer reads every note in their org'
);

SELECT throws_ok(
  $$ INSERT INTO public.notes (org_id, owner_id, title)
     VALUES (public.iso('org_a')::uuid,
             '44444444-4444-4444-8444-444444444444'::uuid, 'viewer write') $$,
  '42501'::char(5),
  NULL::text,
  'a rank-10 viewer CANNOT insert - one rank below the floor of 20 (SQLSTATE 42501)'
);

-- A viewer cannot delete even their own org's rows.
DELETE FROM public.notes WHERE id = 'aaaa0002-0000-4000-8000-000000000002'::uuid;
SELECT results_eq(
  $$ SELECT count(*)::bigint FROM public.notes
      WHERE id = 'aaaa0002-0000-4000-8000-000000000002'::uuid $$,
  $$ VALUES (1::bigint) $$,
  'a rank-10 viewer DELETE matches no rows - the note survives'
);

RESET ROLE;

-- ── member, rank 20: at the write floor, below the admin floor of 30 ────────
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "33333333-3333-4333-8333-333333333333", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

-- THE OTHER DIRECTION of the same floor: rank 20 succeeds where rank 10 failed.
SELECT lives_ok(
  $$ INSERT INTO public.notes (org_id, owner_id, title)
     VALUES (public.iso('org_a')::uuid,
             '33333333-3333-4333-8333-333333333333'::uuid, 'member write') $$,
  'a rank-20 member CAN insert - the floor admits exactly the rank above the one it refused'
);

-- A member may delete their OWN note (the `owner_id = auth.uid() AND rank >= 20`
-- arm of the delete policy).
DELETE FROM public.notes WHERE id = 'aaaa0003-0000-4000-8000-000000000003'::uuid;
SELECT is_empty(
  $$ SELECT id FROM public.notes WHERE id = 'aaaa0003-0000-4000-8000-000000000003'::uuid $$,
  'a rank-20 member CAN delete their own note - the author arm of the delete policy'
);

-- …but not a colleague's, which needs rank 30. Both arms of that policy carry a
-- rank term, so neither can be read as "or if you wrote it" without a seat.
DELETE FROM public.notes WHERE id = 'aaaa0001-0000-4000-8000-000000000001'::uuid;
SELECT results_eq(
  $$ SELECT count(*)::bigint FROM public.notes
      WHERE id = 'aaaa0001-0000-4000-8000-000000000001'::uuid $$,
  $$ VALUES (1::bigint) $$,
  'a rank-20 member CANNOT delete a colleague note - one rank below the floor of 30'
);

RESET ROLE;

-- ── admin, rank 30: clears the moderation floor ─────────────────────────────
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "22222222-2222-4222-8222-222222222222", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

-- The privilege lifecycle (1.0.0): rank 30 is EFFECTIVE only while elevated (the
-- JIT fold), so the admin elevates before administering. One elevation carries
-- this whole transaction — now() is frozen at transaction start, so the one-hour
-- bound cannot lapse mid-suite. Asserted rather than performed silently: this is
-- the positive control for the JIT door on the admin rank.
SELECT lives_ok(
  $$ SELECT public.elevate(public.iso('org_a')::uuid) $$,
  'a rank-30 admin elevates before administering — the JIT door (RAP-13)'
);

DELETE FROM public.notes WHERE id = 'aaaa0001-0000-4000-8000-000000000001'::uuid;
SELECT is_empty(
  $$ SELECT id FROM public.notes WHERE id = 'aaaa0001-0000-4000-8000-000000000001'::uuid $$,
  'a rank-30 admin CAN delete a colleague note - the same statement the member could not run'
);

-- Admins see pending invitations for their org — the digest, which is not
-- redeemable, so this read discloses who was invited and at what rank, never a
-- credential.
SELECT lives_ok(
  $$ SELECT count(*) FROM public.invitations $$,
  'a rank-30 admin may read the invitation list without raising'
);

RESET ROLE;

-- ════════════════════════════════════════════════════════════════════════════
-- the outsider: org B survived everything above
-- ════════════════════════════════════════════════════════════════════════════
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "55555555-5555-4555-8555-555555555555", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

SELECT results_eq(
  $$ SELECT title FROM public.notes $$,
  $$ VALUES ('outsider note'::text) $$,
  'org B still holds exactly its own note, unrenamed by the cross-org UPDATE and unremoved by the cross-org DELETE'
);

SELECT is_empty(
  $$ SELECT id FROM public.notes WHERE org_id = public.iso('org_a')::uuid $$,
  'org B sees none of org A rows - isolation holds in both directions'
);

-- Naming another org in an RPC argument is not a way in. The RPCs derive the
-- CALLER from auth.uid() and never from a parameter, but the ORG is a parameter,
-- and the rank floor evaluated against the caller's real seats is what closes it.
SELECT throws_ok(
  $$ SELECT public.create_invitation(public.iso('org_a')::uuid,
                                     'intruder@example.com', 20::smallint) $$,
  '42501'::char(5),
  NULL::text,
  'an RPC aimed at an org the caller has no seat in is refused (SQLSTATE 42501)'
);

RESET ROLE;

-- ════════════════════════════════════════════════════════════════════════════
-- the seat lifecycle, behaviourally
-- ════════════════════════════════════════════════════════════════════════════
-- Structural assertions cannot see any of this. A seat RPC that raises nothing
-- and changes nothing looks identical from pg_catalog to one that works, which
-- is precisely the failure mode the paired rpc-role SELECT policy exists to
-- prevent — so it is asserted here, on the rows, after the call.

-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

-- create_org() writes the org AND the founder's rank-40 seat in one transaction.
-- An org whose owner seat is missing is unreachable by every predicate form in
-- the system, so the two rows are one atomic fact — and this reads the seat back
-- rather than trusting the return value.
SELECT results_eq(
  $$ SELECT role_rank::int FROM public.memberships
      WHERE org_id = public.iso('org_a')::uuid
        AND user_id = '11111111-1111-4111-8111-111111111111'::uuid $$,
  $$ VALUES (40) $$,
  'create_org() left the founder holding rank 40 - the seat exists, not just the org'
);

-- Idempotence, asserted as an equality rather than as "does not raise". The
-- membership is re-ensured on every call rather than inferred from the org
-- existing, because an org row whose owner seat went missing would otherwise
-- leave the user permanently zero-org with this function reporting success.
SELECT results_eq(
  $$ SELECT public.ensure_personal_org() = public.ensure_personal_org() $$,
  $$ VALUES (true) $$,
  'ensure_personal_org() is idempotent - two calls resolve the same org'
);

-- An admin may not mint a seat at or above their own rank. Without this, an
-- admin could invite an OWNER and then redeem that invitation from a second
-- account they control — seat discipline bypassed with no privileged read at all.
SELECT throws_ok(
  $$ SELECT public.create_invitation(public.iso('org_a')::uuid,
                                     'escalation@example.com', 40::smallint) $$,
  '42501'::char(5),
  NULL::text,
  'inviting at or above the caller own rank is refused (SQLSTATE 42501)'
);

-- ── seat management, asserted ON THE ROW ────────────────────────────────────
-- THE SECTION THIS FILE MOST NEEDED. A seat RPC that raises nothing and changes
-- nothing is indistinguishable, from pg_catalog, from one that works — and that is
-- not hypothetical: the first version of this schema had a self-only SELECT policy on
-- the seat table, PostgreSQL AND-ed it onto every seat UPDATE's WHERE clause, and
-- EVERY promotion matched zero rows. `pnpm validate`, the structural suite and the
-- client suite were all green. Only reading the row back after the call finds it, so
-- every assertion here calls the RPC and then reads the row.
SELECT lives_ok(
  $$ SELECT public.set_member_role(public.iso('org_a')::uuid,
       '44444444-4444-4444-8444-444444444444'::uuid, 30::smallint) $$,
  'an owner may promote a member'
);

RESET ROLE;

-- READ BACK AS THE SUBJECT, not as the caller who made the change. The seat table's
-- human-facing SELECT policy is SELF-ONLY, so the owner who just issued the promotion
-- cannot see the row they changed — asserting from their side would read NULL whether
-- the write landed or not, and asserting `is_empty` from their side would pass
-- vacuously forever. The person whose rank it is can see it, and only they can.
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "44444444-4444-4444-8444-444444444444", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

SELECT results_eq(
  $$ SELECT role_rank::int FROM public.memberships
      WHERE org_id = public.iso('org_a')::uuid $$,
  $$ VALUES (30) $$,
  'the promotion CHANGED THE ROW - not a zero-row UPDATE that reported success'
);

RESET ROLE;

-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

-- The other direction, because a rank ladder that only goes up is not a ladder.
SELECT lives_ok(
  $$ SELECT public.set_member_role(public.iso('org_a')::uuid,
       '44444444-4444-4444-8444-444444444444'::uuid, 10::smallint) $$,
  'an owner may demote a member'
);

RESET ROLE;

-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "44444444-4444-4444-8444-444444444444", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

SELECT results_eq(
  $$ SELECT role_rank::int FROM public.memberships
      WHERE org_id = public.iso('org_a')::uuid $$,
  $$ VALUES (10) $$,
  'the demotion CHANGED THE ROW back'
);

RESET ROLE;

-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

-- Rank 40 is below nobody, so the rank-below-caller predicate makes an owner seat
-- undemotable — including one's own. That is what makes the last-owner rule
-- STRUCTURAL: no policy can perform the count that "is this the last owner?" needs,
-- so the invariant is expressed in the ordering instead. The cost is that ownership
-- transfer does not exist; docs/adr/20260201-org-scoped-tenancy.md records it.
SELECT throws_ok(
  $$ SELECT public.set_member_role(public.iso('org_a')::uuid,
       '11111111-1111-4111-8111-111111111111'::uuid, 20::smallint) $$,
  '42501'::char(5),
  NULL::text,
  'an owner cannot demote THEMSELVES - the last owner cannot walk out of their own org'
);

RESET ROLE;

-- ── the admin ceiling ───────────────────────────────────────────────────────
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "22222222-2222-4222-8222-222222222222", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

-- Without this an admin could promote a second account to admin, then use it to
-- promote the first to owner. Both halves of the predicate (USING on the old row,
-- WITH CHECK on the new one) say STRICTLY BELOW the caller, which closes the ladder.
SELECT throws_ok(
  $$ SELECT public.set_member_role(public.iso('org_a')::uuid,
       '33333333-3333-4333-8333-333333333333'::uuid, 30::smallint) $$,
  '42501'::char(5),
  NULL::text,
  'a rank-30 admin cannot grant rank 30 - no promoting anyone to your own rank'
);

SELECT throws_ok(
  $$ SELECT public.remove_member(public.iso('org_a')::uuid,
       '11111111-1111-4111-8111-111111111111'::uuid) $$,
  '42501'::char(5),
  NULL::text,
  'a rank-30 admin cannot remove the rank-40 owner'
);

-- …but CAN remove someone strictly below them, and the row must actually go.
SELECT lives_ok(
  $$ SELECT public.remove_member(public.iso('org_a')::uuid,
       '33333333-3333-4333-8333-333333333333'::uuid) $$,
  'a rank-30 admin may remove a rank-20 member'
);

RESET ROLE;

-- Read back AS THE REMOVED MEMBER, for the same reason as the promotion above: they
-- are the only caller whose SELECT policy ever admitted that row, so they are the only
-- caller for whom its absence means anything. Asserted from the admin's side this
-- would have been vacuous — the admin could never see it either way.
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "33333333-3333-4333-8333-333333333333", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

SELECT is_empty(
  $$ SELECT user_id FROM public.memberships
      WHERE org_id = public.iso('org_a')::uuid $$,
  'the removal DELETED THE ROW - the removed member no longer holds the seat they could see a moment ago'
);

-- …and the org's data goes with the seat. This is the revocation-immediate property
-- the whole table-anchored design was chosen for: no token to expire, no cache to
-- clear, the next statement simply returns nothing.
SELECT is_empty(
  $$ SELECT id FROM public.notes WHERE org_id = public.iso('org_a')::uuid $$,
  'a removed member loses the org data immediately - revocation is a row delete, not a token expiry'
);

RESET ROLE;

-- ── the floor from below, and leaving voluntarily ───────────────────────────
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "44444444-4444-4444-8444-444444444444", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

-- Rank 10 is below the admin floor of 30, so the seat is invisible to the UPDATE and
-- the IF NOT FOUND guard turns the miss into a loud refusal.
SELECT throws_ok(
  $$ SELECT public.set_member_role(public.iso('org_a')::uuid,
       '22222222-2222-4222-8222-222222222222'::uuid, 10::smallint) $$,
  '42501'::char(5),
  NULL::text,
  'a rank-10 viewer cannot change anyone else seat'
);

-- The self arm of the delete policy: anyone below rank 40 may leave.
SELECT lives_ok(
  $$ SELECT public.remove_member(public.iso('org_a')::uuid,
       '44444444-4444-4444-8444-444444444444'::uuid) $$,
  'a member may remove their OWN seat - leaving an org needs no admin'
);

SELECT is_empty(
  $$ SELECT user_id FROM public.memberships
      WHERE org_id = public.iso('org_a')::uuid $$,
  'after leaving, the org is invisible to them entirely - self-only SELECT, and the seat is gone'
);

RESET ROLE;

-- ── redemption is single-use ────────────────────────────────────────────────
-- The DELETE inside accept_invitation is the expiry check, the used-check and
-- the consume in ONE statement, so two sessions racing the same token cannot
-- both proceed and a redeemed token cannot be replayed: the row is gone.
DO $replay$
DECLARE
  v_token uuid;
BEGIN
  -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
  PERFORM set_config('request.jwt.claims',
    '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
  PERFORM set_config('role', 'authenticated', true);
  v_token := public.create_invitation(public.iso('org_a')::uuid,
                                      'outsider-b@example.com', 20::smallint);
  -- SOURCE: transaction-local GUCs — the pooling identity hazard [corpus: postgres/guc-set-local]
  PERFORM set_config('role', 'none', true);
  -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
  PERFORM set_config('request.jwt.claims',
    '{"sub": "55555555-5555-4555-8555-555555555555", "role": "authenticated"}', true);
  PERFORM set_config('role', 'authenticated', true);
  PERFORM public.accept_invitation(v_token);
  -- SOURCE: transaction-local GUCs — the pooling identity hazard [corpus: postgres/guc-set-local]
  PERFORM set_config('role', 'none', true);
  PERFORM set_config('iso.spent_token', v_token::text, true);
END;
$replay$;

-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "55555555-5555-4555-8555-555555555555", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

-- The redemption actually landed: the outsider now holds a rank-20 seat in org A.
-- Without this the replay assertion below would pass against an accept_invitation
-- that never worked in the first place.
SELECT results_eq(
  $$ SELECT role_rank::int FROM public.memberships
      WHERE org_id = public.iso('org_a')::uuid
        AND user_id = '55555555-5555-4555-8555-555555555555'::uuid $$,
  $$ VALUES (20) $$,
  'accept_invitation() granted the seat the invitation described'
);

SELECT throws_ok(
  $$ SELECT public.accept_invitation(public.iso('spent_token')::uuid) $$,
  '22023'::char(5),
  NULL::text,
  'a spent token cannot be replayed - redemption consumed the row (SQLSTATE 22023)'
);

-- One message for invalid, expired and already-used, so this endpoint is not a
-- token oracle: a caller cannot tell a real-but-spent token from a guess.
SELECT throws_ok(
  $$ SELECT public.accept_invitation('00000000-0000-4000-8000-000000000000'::uuid) $$,
  '22023'::char(5),
  NULL::text,
  'an invented token fails with the SAME error as a spent one - no oracle'
);

RESET ROLE;

-- ════════════════════════════════════════════════════════════════════════════
-- no identity at all
-- ════════════════════════════════════════════════════════════════════════════
-- An empty claim string, not an absent one: a connection returned to a pool
-- after a transaction that ran SET LOCAL reports '' rather than NULL, and both
-- must mean the same thing. auth.uid() maps both to NULL, and NULL is a member
-- of no org, so "no identity" fails CLOSED to the empty set rather than opening.
-- SOURCE: transaction-local GUCs — the pooling identity hazard [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '';
SET LOCAL ROLE authenticated;

SELECT is_empty(
  $$ SELECT id FROM public.notes $$,
  'the authenticated role with no identity claim matches no row - absent identity fails closed'
);

-- `= ANY(<empty array>)` is false, not NULL-true, and that is what makes the
-- above hold. This pins the reason as well as the outcome.
SELECT results_eq(
  $$ SELECT count(*)::bigint FROM public.memberships $$,
  $$ VALUES (0::bigint) $$,
  'an identity-less caller holds no seats, so every scope predicate is empty rather than absent'
);

RESET ROLE;

-- ════════════════════════════════════════════════════════════════════════════
-- the anonymous role
-- ════════════════════════════════════════════════════════════════════════════
-- Deliberately loud, for the reason argued in the header: anon holds no grant
-- on these tables, so the denial happens at the table level and is independent
-- of which rows exist. This is also what fails if a future migration re-grants
-- anon by accident (a `db diff` draft re-adding Supabase default privileges is
-- the likely way that happens).
-- SOURCE: transaction-local role/GUC scoping [corpus: postgres/guc-set-local]
SET LOCAL ROLE anon;

SELECT throws_ok(
  $$ SELECT id FROM public.notes $$,
  '42501'::char(5),
  NULL::text,
  'the anon role is denied at the table level (SQLSTATE 42501) - it holds no grant here'
);

SELECT throws_ok(
  $$ SELECT user_id FROM public.memberships $$,
  '42501'::char(5),
  NULL::text,
  'the anon role cannot read the seat roster either'
);

-- PostgreSQL grants EXECUTE to PUBLIC on every new function and Supabase's
-- default privileges additionally grant anon, so a definer function that names
-- no grants is ALREADY callable by an unauthenticated caller. The REVOKE in the
-- spine migration is the control; this is that control observed from outside.
SELECT throws_ok(
  $$ SELECT public.ensure_personal_org() $$,
  '42501'::char(5),
  NULL::text,
  'anon cannot execute a tenancy RPC - the REVOKE from PUBLIC and anon actually took'
);

RESET ROLE;

-- ─────────────────────────────────────────────────────────────────────────────
-- The tenant key is SET-ONCE, not never-set
-- ─────────────────────────────────────────────────────────────────────────────
-- private.freeze_org_id() permits NULL -> value and refuses everything else. That
-- asymmetry is not decoration: it is the single reason an install already holding
-- production rows can adopt org scope at all (docs/runbooks/tenancy-adoption.md).
-- The expand phase adds a NULLable org_id to a populated table and the backfill that
-- fills it in is an UPDATE, so a strict `IS DISTINCT FROM` freeze would refuse every
-- row of it — and would do so for `postgres` too, since a trigger fires regardless of
-- BYPASSRLS. The relaxation closes itself: after the contract phase's SET NOT NULL,
-- OLD.org_id can never be NULL again and the permissive branch is unreachable.
--
-- Proven on a scratch table because every shipped table already has the column NOT
-- NULL — which is exactly the state this asymmetry is invisible in, and therefore
-- exactly why it would rot unasserted.
-- SOURCE: PostgreSQL trigger firing is independent of row security [corpus: postgres/rls-force]
CREATE TABLE public.freeze_probe (
  id int PRIMARY KEY,
  org_id uuid REFERENCES public.orgs (id)
);
CREATE TRIGGER freeze_probe_freeze BEFORE UPDATE ON public.freeze_probe
  FOR EACH ROW EXECUTE FUNCTION private.freeze_org_id();
INSERT INTO public.freeze_probe VALUES (1, NULL);

SELECT lives_ok(
  $$ UPDATE public.freeze_probe SET org_id = (SELECT id FROM public.orgs WHERE slug = 'acme') WHERE id = 1 $$,
  'the backfill move NULL -> org is PERMITTED - without this no populated install could ever adopt org scope'
);

SELECT throws_ok(
  $$ UPDATE public.freeze_probe SET org_id = (SELECT id FROM public.orgs WHERE slug = 'globex') WHERE id = 1 $$,
  '42501'::char(5),
  NULL::text,
  'once set, org -> a DIFFERENT org is refused: a row may not walk between tenants'
);

SELECT throws_ok(
  $$ UPDATE public.freeze_probe SET org_id = NULL WHERE id = 1 $$,
  '42501'::char(5),
  NULL::text,
  'org -> NULL is refused too - un-scoping a row would hide it from everyone including its author'
);

-- ════════════════════════════════════════════════════════════════════════════
-- the privilege lifecycle + JIT, behaviourally (1.0.0)
-- ════════════════════════════════════════════════════════════════════════════
-- The register rows this section discharges (e8-privilege-lifecycle, e8-jit-admin)
-- demanded WINDOW PROOFS: an aged fixture must actually demote, an expired
-- elevation must actually stop satisfying the predicate, and the recovery paths
-- must actually recover. Fixture AGING is performed as the superuser on purpose —
-- FORCE RLS subjects every in-model role to policy, so only the harness itself
-- can move a clock — and every assertion then runs as the SUBJECT, like the rest
-- of this file. now() is frozen per transaction, so the arithmetic is exact.

-- (1) Expiry is CONSULTED, not recorded. Age the owner's elevation past its bound…
UPDATE public.admin_elevations SET expires_at = now() - interval '1 minute'
 WHERE user_id = '11111111-1111-4111-8111-111111111111'::uuid
   AND org_id = public.iso('org_a')::uuid;

-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT public.set_member_role(public.iso('org_a')::uuid,
       '22222222-2222-4222-8222-222222222222'::uuid, 20::smallint) $$,
  '42501'::char(5),
  NULL::text,
  'an EXPIRED elevation stops satisfying the admin predicate — the fold consults expires_at, it does not merely record it (RAP-13)'
);

SELECT lives_ok(
  $$ SELECT public.elevate(public.iso('org_a')::uuid) $$,
  're-elevation mints a fresh one-hour bound'
);

SELECT lives_ok(
  $$ SELECT public.set_member_role(public.iso('org_a')::uuid,
       '22222222-2222-4222-8222-222222222222'::uuid, 20::smallint) $$,
  'the SAME statement succeeds under the fresh elevation — demoting the admin below the privilege floor'
);

RESET ROLE;

-- …and the demotion cleaned up after itself: a seat that is no longer privileged
-- has nothing to be elevated about, and a leftover row would re-arm the moment
-- someone re-promoted them without a fresh elevate().
SELECT is_empty(
  $$ SELECT user_id FROM public.admin_elevations
      WHERE user_id = '22222222-2222-4222-8222-222222222222'::uuid
        AND org_id = public.iso('org_a')::uuid $$,
  'demotion below the privilege floor DELETED the target elevation'
);

-- (2) RAP-02: the 12-month revalidation window, consulted by every predicate.
UPDATE public.memberships SET revalidated_at = now() - interval '13 months'
 WHERE user_id = '11111111-1111-4111-8111-111111111111'::uuid
   AND org_id = public.iso('org_a')::uuid;

-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT public.create_invitation(public.iso('org_a')::uuid,
       'lapsed-owner-probe@example.com', 10::smallint) $$,
  '42501'::char(5),
  NULL::text,
  'a seat outside the 12-month revalidation window reads as rank 20 EVERYWHERE — RAP-02 folds into the rank map, live elevation or not'
);

SELECT lives_ok(
  $$ SELECT public.elevate(public.iso('org_a')::uuid) $$,
  'the lapsed owner re-enters through elevate()''s self-revalidation branch — aal2-gated, vacuously satisfied for this unenrolled fixture user; the ENROLLED-at-aal1 refusal is proven in mfa_aal2.test.sql'
);

-- (3) RAP-03: the 45-day inactivity window, at the door. Restore the admin seat…
SELECT lives_ok(
  $$ SELECT public.set_member_role(public.iso('org_a')::uuid,
       '22222222-2222-4222-8222-222222222222'::uuid, 30::smallint) $$,
  'the revalidated owner re-promotes the admin — a rank change is itself a revalidation'
);

RESET ROLE;

-- …age the seat past the activity window (within 12 months, past 45 days; the
-- demotion in (1) deleted their elevation, so revalidated_at IS the last activity):
UPDATE public.memberships SET revalidated_at = now() - interval '50 days'
 WHERE user_id = '22222222-2222-4222-8222-222222222222'::uuid
   AND org_id = public.iso('org_a')::uuid;

-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "22222222-2222-4222-8222-222222222222", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT public.elevate(public.iso('org_a')::uuid) $$,
  '42501'::char(5),
  NULL::text,
  'a 45-day-inactive privileged seat cannot elevate — RAP-03 at the door, and rank 30 has no self-service escape'
);

RESET ROLE;

-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ SELECT public.revalidate_member(public.iso('org_a')::uuid,
       '22222222-2222-4222-8222-222222222222'::uuid) $$,
  'an ELEVATED owner revalidates the inactive seat — the human half of RAP-02, taking the same door as every admin act'
);

RESET ROLE;

-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "22222222-2222-4222-8222-222222222222", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ SELECT public.elevate(public.iso('org_a')::uuid) $$,
  'the revalidated seat elevates again — the lifecycle round-trips'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
