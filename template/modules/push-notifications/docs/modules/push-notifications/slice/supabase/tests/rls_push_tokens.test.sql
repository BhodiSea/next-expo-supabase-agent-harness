-- supabase/tests/rls_push_tokens.test.sql — cross-tenant behaviour of the
-- push_device_tokens authorization boundary (push-notifications module),
-- exercised through the same role and claim shape a real request arrives with.
--
-- Run with `supabase test db`. One transaction, ROLLBACK at the end: the suite
-- creates its own tenants (deliberately NOT the ones in seed.sql) so it neither
-- depends on nor disturbs the seeded state.
--
-- THE PRINCIPLE THIS FILE PINS, restated from rls_isolation.test.sql for a
-- second table: a cross-tenant read returns the EMPTY SET, never an error. A
-- stored push token is credential-adjacent material (the module README's honest
-- limits say so); a boundary that answered "that token exists, it just is not
-- yours" would turn every id into an existence oracle. RLS gets this right by
-- construction — it filters rows rather than rejecting statements — and this
-- suite asserts nobody has "improved" it with a friendly 403. The one deliberate
-- asymmetry is the anonymous case at the bottom, which is allowed to be loud
-- because `anon` holds no grant on the table at all.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT plan(11);

-- ── fixtures, as the migration role ─────────────────────────────────────────
-- auth.users belongs to the Auth service and `authenticated` holds no grant on
-- it, so the identities are created here and nothing else is.
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'tenant-a@example.com', now(), now()),
  ('22222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'tenant-b@example.com', now(), now());

-- ── tenant A registers a token, as tenant A ─────────────────────────────────
-- The claim is set before the role switch and the role is reset after, so no
-- GUC is ever written while impersonating. Both are transaction-scoped: a
-- session that kept an identity after the transaction ended is the
-- pooled-connection leak that makes every later statement act as the wrong user.
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true)
-- [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';
SET LOCAL ROLE authenticated;
-- owner_id and id omitted: owner_id defaults to auth.uid() (the path a client
-- takes), id defaults to gen_random_uuid(). That this insert succeeds at all is
-- itself proof the INSERT policy admits a legitimate self-registration.
INSERT INTO public.push_device_tokens (token, platform)
VALUES ('ExponentPushToken[tenant-a-device]', 'ios');
RESET ROLE;

-- ── tenant B registers a token, as tenant B ─────────────────────────────────
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true)
-- [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "22222222-2222-4222-8222-222222222222", "role": "authenticated"}';
SET LOCAL ROLE authenticated;
INSERT INTO public.push_device_tokens (token, platform)
VALUES ('ExponentPushToken[tenant-b-device]', 'android');
RESET ROLE;

-- ── assertions, as tenant A ─────────────────────────────────────────────────
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true)
-- [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

-- POSITIVE CONTROL, and it has to come first. Against a database that denied
-- everything to everyone, every isolation assertion below passes for the worst
-- possible reason. Exactly one row: A sees its own and only its own token, even
-- though tenant B has a token in this table.
SELECT results_eq(
  $$ SELECT count(*) FROM public.push_device_tokens $$,
  $$ VALUES (1::bigint) $$,
  'tenant A sees exactly its own one push token'
);

-- The two halves of the empty-set principle, asserted separately on purpose:
-- that the statement does not raise, and that it returns nothing.
SELECT lives_ok(
  $$ SELECT id FROM public.push_device_tokens WHERE owner_id = '22222222-2222-4222-8222-222222222222'::uuid $$,
  'a cross-tenant token read does not raise - RLS filters rows, it does not reject statements'
);

SELECT is_empty(
  $$ SELECT id FROM public.push_device_tokens WHERE owner_id = '22222222-2222-4222-8222-222222222222'::uuid $$,
  'a cross-tenant token read returns the EMPTY SET, disclosing not even existence'
);

-- Writes across the boundary match nothing and raise nothing. The absence of an
-- error is the point: a caller cannot distinguish "no such row" from "not yours".
SELECT lives_ok(
  $$ UPDATE public.push_device_tokens SET platform = 'ios'
      WHERE owner_id = '22222222-2222-4222-8222-222222222222'::uuid $$,
  'a cross-tenant UPDATE matches no rows and raises nothing'
);

SELECT lives_ok(
  $$ DELETE FROM public.push_device_tokens
      WHERE owner_id = '22222222-2222-4222-8222-222222222222'::uuid $$,
  'a cross-tenant DELETE matches no rows and raises nothing'
);

-- INSERT is the one operation that DOES raise, and must: there is no row to
-- filter, so WITH CHECK has to reject the statement outright. Nothing is
-- disclosed by that — the caller supplied the id, so they already knew it.
SELECT throws_ok(
  $$ INSERT INTO public.push_device_tokens (owner_id, token, platform)
     VALUES ('22222222-2222-4222-8222-222222222222'::uuid, 'ExponentPushToken[smuggled]', 'ios') $$,
  '42501'::char(5),
  NULL::text,
  'an INSERT smuggling another tenant owner_id is rejected by WITH CHECK (SQLSTATE 42501)'
);

-- ACCOUNT DELETION, the live half of the boundary. "Delete my account" issues an
-- unqualified DELETE, so under FORCE ROW LEVEL SECURITY the policy qual is the
-- ONLY thing between it and the whole table. Combined with the positive control
-- above (A saw one row), an empty result here proves the sweep removed A's tokens
-- rather than being blocked outright.
DELETE FROM public.push_device_tokens;

SELECT is_empty(
  $$ SELECT id FROM public.push_device_tokens $$,
  'after an unqualified DELETE, tenant A has no push tokens left'
);

RESET ROLE;

-- ── the survivors, as tenant B ──────────────────────────────────────────────
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true)
-- [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "22222222-2222-4222-8222-222222222222", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

-- B survived every one of A's statements above, including the unqualified sweep.
SELECT results_eq(
  $$ SELECT count(*) FROM public.push_device_tokens $$,
  $$ VALUES (1::bigint) $$,
  'tenant B still has its token after tenant A unqualified account sweep'
);

SELECT results_eq(
  $$ SELECT platform FROM public.push_device_tokens $$,
  $$ VALUES ('android'::text) $$,
  'tenant B token was not rewritten by the cross-tenant UPDATE'
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
  $$ SELECT id FROM public.push_device_tokens $$,
  'the authenticated role with no identity claim matches no row - absent identity fails closed'
);

RESET ROLE;

-- ── the anonymous role ──────────────────────────────────────────────────────
-- Deliberately loud: anon holds no grant on this table, so the denial happens at
-- the table level and is independent of which rows exist. This assertion also
-- fails if a future migration re-grants anon by accident (a `db diff` draft
-- re-adding Supabase default privileges is the likely way that happens).
-- SOURCE: transaction-local role/GUC scoping [corpus: postgres/guc-set-local]
SET LOCAL ROLE anon;

SELECT throws_ok(
  $$ SELECT id FROM public.push_device_tokens $$,
  '42501'::char(5),
  NULL::text,
  'the anon role is denied at the table level (SQLSTATE 42501) - it holds no grant here'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
