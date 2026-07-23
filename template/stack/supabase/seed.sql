-- supabase/seed.sql — deterministic local fixtures.
--
-- Applied by `supabase start` and `supabase db reset`, after every migration.
-- Two tenants with data on both sides, so a cross-tenant leak is visible by
-- eye in the app the moment it appears, not only in a test.
--
-- DETERMINISTIC. Fixed UUIDs and fixed created_at values, not gen_random_uuid()
-- and now(): a screenshot, a keyset-pagination cursor and an expected-list
-- assertion all have to mean the same thing after the next `db reset`. Random
-- fixtures produce tests that pass until they don't and nobody can say why.
-- Every statement is ON CONFLICT DO NOTHING so re-running is a no-op rather
-- than a duplicate-key failure.
--
-- NO CREDENTIALS. The two auth.users rows carry no password hash, so they
-- cannot be used to sign in — they exist to give the domain rows a real owner
-- to hang from. Create a sign-in-capable user through the local Studio or the
-- Auth admin API; do NOT paste a password hash, an anon key or a service key
-- into this file. It is committed, and a committed credential is valid until
-- somebody remembers to rotate it.
--
-- SEEDED THROUGH THE POLICY WALL. Everything below the auth.users insert is
-- written while impersonating the user who owns it, not as the migration role.
-- Two reasons. First, it does not depend on whether the seeding role happens to
-- hold BYPASSRLS — under FORCE ROW LEVEL SECURITY a plain owner insert would be
-- refused, and "seed works on my machine" is not a property worth having.
-- Second, and mainly: a `db reset` that fails here means the INSERT policies
-- reject a legitimate self-write. The seed is the cheapest positive control in
-- the repo, and it runs on every reset without anybody asking it to.

BEGIN;

-- The identity rows. auth.users belongs to the Auth service, so this is the one
-- statement that runs as the migration role — `authenticated` has no grant on
-- that table, and should not.
INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
VALUES
  (
    'a11ce000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'alice@example.com',
    '{"display_name": "Alice Example"}'::jsonb,
    '2026-01-02T09:00:00Z',
    '2026-01-02T09:00:00Z'
  ),
  (
    'b0b00000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'bob@example.com',
    '{"display_name": "Bob Example"}'::jsonb,
    '2026-01-02T09:00:00Z',
    '2026-01-02T09:00:00Z'
  )
ON CONFLICT (id) DO NOTHING;

-- ── tenant A ────────────────────────────────────────────────────────────────
-- The claim is set BEFORE the role switch, and the role is reset after, so no
-- GUC is ever written while impersonating. SET LOCAL scopes both to this
-- transaction: if the seed aborts halfway, the session does not keep an
-- identity that a later statement could silently inherit.
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true)
-- [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "a11ce000-0000-4000-8000-000000000001", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

INSERT INTO public.profiles (id, display_name, created_at, updated_at)
VALUES (
  'a11ce000-0000-4000-8000-000000000001',
  'Alice Example',
  '2026-01-02T09:00:00Z',
  '2026-01-02T09:00:00Z'
)
ON CONFLICT (id) DO NOTHING;

-- owner_id is omitted deliberately on the first row: the column defaults to
-- auth.uid(), so this exercises the happy path a client actually takes. The
-- second row states it explicitly — both go through the same WITH CHECK.
INSERT INTO public.notes (id, title, body, created_at, updated_at)
VALUES (
  'a0000001-0000-4000-8000-000000000011',
  -- Literal text, deliberately not the project-name placeholder: a rendered
  -- project name containing an apostrophe would terminate this string literal
  -- and break `db reset` on the very first run after init.
  'Your first note',
  'This note belongs to Alice. Signed in as anyone else, it does not exist.',
  '2026-01-02T09:05:00Z',
  '2026-01-02T09:05:00Z'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.notes (id, owner_id, title, body, created_at, updated_at)
VALUES (
  'a0000002-0000-4000-8000-000000000012',
  'a11ce000-0000-4000-8000-000000000001',
  'Second note, newer',
  'Two rows for one owner, so list ordering and keyset pagination have something to order.',
  '2026-01-02T09:06:00Z',
  '2026-01-02T09:06:00Z'
)
ON CONFLICT (id) DO NOTHING;

RESET ROLE;

-- ── tenant B ────────────────────────────────────────────────────────────────
-- Bob exists so that "Alice sees her own rows" is not vacuously true. A seed
-- with one tenant cannot distinguish a working policy from a deny-all database.
-- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true)
-- [corpus: postgres/guc-set-local]
SET LOCAL "request.jwt.claims" TO '{"sub": "b0b00000-0000-4000-8000-000000000002", "role": "authenticated"}';
SET LOCAL ROLE authenticated;

INSERT INTO public.profiles (id, display_name, created_at, updated_at)
VALUES (
  'b0b00000-0000-4000-8000-000000000002',
  'Bob Example',
  '2026-01-02T09:00:00Z',
  '2026-01-02T09:00:00Z'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.notes (id, title, body, created_at, updated_at)
VALUES (
  'b0000001-0000-4000-8000-000000000021',
  'Bob has his own notes',
  'If this row is ever visible to Alice, the policies are broken and the isolation suite should have said so first.',
  '2026-01-02T09:07:00Z',
  '2026-01-02T09:07:00Z'
)
ON CONFLICT (id) DO NOTHING;

RESET ROLE;

COMMIT;
