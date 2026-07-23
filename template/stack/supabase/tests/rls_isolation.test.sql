-- supabase/tests/rls_isolation.test.sql — cross-tenant behaviour of the
-- authorization boundary, exercised through the same role and the same claim
-- shape a real request arrives with.
--
-- Run with `supabase test db`. One transaction, ROLLBACK at the end: the suite
-- creates its own tenants (deliberately NOT the ones in seed.sql) so it neither
-- depends on nor disturbs the seeded state.
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

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT plan(12);

-- ── fixtures, as the migration role ─────────────────────────────────────────
-- auth.users belongs to the Auth service and `authenticated` holds no grant on
-- it, so the identities are created here and nothing else is.
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'tenant-a@example.com', now(), now()),
  ('22222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'tenant-b@example.com', now(), now());

-- ── tenant A writes, as tenant A ────────────────────────────────────────────
-- The claim is set before the role switch and the role is reset after, so no
-- GUC is ever written while impersonating. Both are transaction-scoped: a
-- session that kept an identity after the transaction ended is the
-- pooled-connection leak that makes every later statement act as the wrong user.
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true)
-- [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';
SET LOCAL ROLE authenticated;
INSERT INTO public.profiles (id, display_name) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Tenant A');
-- owner_id omitted: it defaults to auth.uid(), which is the path a client
-- actually takes. That these two inserts succeed at all is itself the proof
-- that the INSERT policies admit a legitimate self-write.
INSERT INTO public.notes (title, body) VALUES ('A original note', 'owned by tenant A');
RESET ROLE;

-- ── tenant B writes, as tenant B ────────────────────────────────────────────
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true)
-- [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "22222222-2222-4222-8222-222222222222", "role": "authenticated"}';
SET LOCAL ROLE authenticated;
INSERT INTO public.profiles (id, display_name) VALUES
  ('22222222-2222-4222-8222-222222222222', 'Tenant B');
INSERT INTO public.notes (title, body) VALUES ('B original note', 'owned by tenant B');
RESET ROLE;

-- ── assertions, as tenant A ─────────────────────────────────────────────────
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true)
-- [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

-- POSITIVE CONTROL, and it has to come first. Against a database that denied
-- everything to everyone, every isolation assertion below passes for the worst
-- possible reason. Exactly one row: A sees its own and only its own, even though
-- the seeded tenants and tenant B all have rows in this table.
SELECT results_eq(
  $$ SELECT count(*) FROM public.notes $$,
  $$ VALUES (1::bigint) $$,
  'tenant A sees exactly its own one note'
);

-- The two halves of the empty-set principle, asserted separately on purpose:
-- that the statement does not raise, and that it returns nothing.
SELECT lives_ok(
  $$ SELECT id FROM public.notes WHERE owner_id = '22222222-2222-4222-8222-222222222222'::uuid $$,
  'a cross-tenant read does not raise - RLS filters rows, it does not reject statements'
);

SELECT is_empty(
  $$ SELECT id FROM public.notes WHERE owner_id = '22222222-2222-4222-8222-222222222222'::uuid $$,
  'a cross-tenant note read returns the EMPTY SET, disclosing not even existence'
);

SELECT is_empty(
  $$ SELECT id FROM public.profiles WHERE id = '22222222-2222-4222-8222-222222222222'::uuid $$,
  'a cross-tenant profile read returns the EMPTY SET'
);

-- Writes across the boundary match nothing and raise nothing. The absence of an
-- error is the point: a caller cannot distinguish "no such row" from "not yours".
SELECT lives_ok(
  $$ UPDATE public.notes SET title = 'tampered'
      WHERE owner_id = '22222222-2222-4222-8222-222222222222'::uuid $$,
  'a cross-tenant UPDATE matches no rows and raises nothing'
);

SELECT lives_ok(
  $$ DELETE FROM public.notes
      WHERE owner_id = '22222222-2222-4222-8222-222222222222'::uuid $$,
  'a cross-tenant DELETE matches no rows and raises nothing'
);

-- INSERT is the one operation that DOES raise, and must: there is no row to
-- filter, so WITH CHECK has to reject the statement outright. Nothing is
-- disclosed by that — the caller supplied the id, so they already knew it.
SELECT throws_ok(
  $$ INSERT INTO public.notes (owner_id, title)
     VALUES ('22222222-2222-4222-8222-222222222222'::uuid, 'smuggled') $$,
  '42501'::char(5),
  NULL::text,
  'an INSERT smuggling another tenant owner_id is rejected by WITH CHECK (SQLSTATE 42501)'
);

-- ACCOUNT DELETION, the live half of the boundary. "Delete my account" issues an
-- unqualified DELETE, so under FORCE ROW LEVEL SECURITY the policy qual is the
-- ONLY thing standing between it and the whole table. Combined with the positive
-- control above (A saw one row), an empty result here proves the sweep removed
-- A rows rather than being blocked outright.
DELETE FROM public.notes;

SELECT is_empty(
  $$ SELECT id FROM public.notes $$,
  'after an unqualified DELETE, tenant A has no notes left'
);

RESET ROLE;

-- ── the survivors, as tenant B ──────────────────────────────────────────────
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true)
-- [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "22222222-2222-4222-8222-222222222222", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

-- B survived every one of A statements above, including the unqualified sweep.
SELECT results_eq(
  $$ SELECT count(*) FROM public.notes $$,
  $$ VALUES (1::bigint) $$,
  'tenant B still has its note after tenant A unqualified account sweep'
);

SELECT results_eq(
  $$ SELECT title FROM public.notes $$,
  $$ VALUES ('B original note'::text) $$,
  'tenant B note was not rewritten by the cross-tenant UPDATE'
);

RESET ROLE;

-- ── no identity at all ──────────────────────────────────────────────────────
-- An empty claim string, not an absent one: a connection returned to a pool
-- after a transaction that ran SET LOCAL reports '' rather than NULL, and both
-- must mean the same thing. auth.uid() maps both to NULL, NULL equals no
-- owner_id, so "no identity" fails CLOSED to the empty set rather than opening.
-- SOURCE: transaction-local GUCs — the pooling identity hazard
-- [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '';
SET LOCAL ROLE authenticated;

SELECT is_empty(
  $$ SELECT id FROM public.notes $$,
  'the authenticated role with no identity claim matches no row - absent identity fails closed'
);

RESET ROLE;

-- ── the anonymous role ──────────────────────────────────────────────────────
-- Deliberately loud, for the reason argued in the header: anon holds no grant
-- on this table, so the denial happens at the table level and is independent of
-- which rows exist. This assertion is also what fails if a future migration
-- re-grants anon by accident (a `db diff` draft re-adding Supabase default
-- privileges is the likely way that happens).
-- SOURCE: transaction-local role/GUC scoping [corpus: postgres/guc-set-local]
SET LOCAL ROLE anon;

SELECT throws_ok(
  $$ SELECT id FROM public.notes $$,
  '42501'::char(5),
  NULL::text,
  'the anon role is denied at the table level (SQLSTATE 42501) - it holds no grant here'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
