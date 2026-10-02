-- supabase/seed.sql — deterministic local fixtures for an ORG-SCOPED database.
--
-- Applied by `supabase start` and `supabase db reset`, after every migration.
-- Two organizations with data on both sides and a member in each, so a
-- cross-tenant leak is visible by eye in the app the moment it appears, not
-- only in a test.
--
-- DETERMINISTIC WHERE IT COUNTS. Fixed user UUIDs, fixed note ids and fixed
-- created_at values: a screenshot, a keyset-pagination cursor and an
-- expected-list assertion all have to mean the same thing after the next
-- `db reset`. ORG ids are the deliberate exception — they are minted by
-- public.create_org(), so this file addresses orgs by their stable SLUG and
-- never by a literal uuid. That is not a compromise: an org id a fixture could
-- hardcode would be an org id created outside the RPC, which is the one thing
-- this file exists to prove is unnecessary.
--
-- NO CREDENTIALS. The five auth.users rows carry no password hash, so they
-- cannot be used to sign in — they exist to give the domain rows a real owner
-- to hang from. Create a sign-in-capable user through the local Studio or the
-- Auth admin API; do NOT paste a password hash, an anon key or a service key
-- into this file. It is committed, and a committed credential is valid until
-- somebody remembers to rotate it.
--
-- ── SEEDED THROUGH THE POLICY WALL, AND NOW THROUGH THE RPCs ────────────────
-- Everything below the auth.users insert is written while impersonating the
-- user it belongs to, and every seat is created by calling the same
-- SECURITY DEFINER function the application calls. Three reasons.
--
-- First, it does not depend on what the SEEDING role can do, and that is not a
-- theoretical concern: locally `supabase start` runs this file as a SUPERUSER
-- `postgres`, which bypasses row security entirely and would happily write a
-- membership row directly. A hosted project's `postgres` is not a superuser. A
-- seed that took the direct path would therefore pass locally and be the first
-- thing to break against a real project — and it would prove nothing either
-- way, because the statement it exercised is not the statement the application
-- runs. Impersonating makes local and hosted the same code path.
--
-- Second, a `db reset` that fails here is a real defect report. The seed is the
-- cheapest positive control in the repo and it runs on every reset without
-- anybody asking it to: if create_org cannot create an org, if accept_invitation
-- cannot redeem a token, or if the rpc writer role lost its paired SELECT policy
-- and the seat writes started matching zero rows, this file goes red first.
--
-- Third, it is executable documentation of the ONE legal way to make a seat.
--
-- ── WHY plpgsql BLOCKS RATHER THAN FLAT STATEMENTS ─────────────────────────
-- public.create_invitation() returns the PLAINTEXT token exactly once and
-- stores only its sha256 digest; nothing can read it back. Redeeming it
-- therefore has to happen while the value is still in a variable, and that
-- variable has to survive a switch from the inviter's identity to the
-- invitee's. A DO block is the only construct in plain SQL that can hold it.
-- The awkwardness is the design telling the truth about itself.

BEGIN;

-- The identity rows. auth.users belongs to the Auth service, so this is the one
-- statement that runs as the migration role — `authenticated` has no grant on
-- that table, and should not.
INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
VALUES
  (
    'a11ce000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'alice@example.com',
    '{"display_name": "Alice Example"}'::jsonb,
    '2026-01-02T09:00:00Z', '2026-01-02T09:00:00Z'
  ),
  (
    'b0b00000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'bob@example.com',
    '{"display_name": "Bob Example"}'::jsonb,
    '2026-01-02T09:00:00Z', '2026-01-02T09:00:00Z'
  ),
  (
    'ca201000-0000-4000-8000-000000000003',
    'authenticated', 'authenticated', 'carol@example.com',
    '{"display_name": "Carol Example"}'::jsonb,
    '2026-01-02T09:00:00Z', '2026-01-02T09:00:00Z'
  ),
  (
    'da7e0000-0000-4000-8000-000000000004',
    'authenticated', 'authenticated', 'dave@example.com',
    '{"display_name": "Dave Example"}'::jsonb,
    '2026-01-02T09:00:00Z', '2026-01-02T09:00:00Z'
  ),
  (
    'e21e0000-0000-4000-8000-000000000005',
    'authenticated', 'authenticated', 'erin@example.com',
    '{"display_name": "Erin Example"}'::jsonb,
    '2026-01-02T09:00:00Z', '2026-01-02T09:00:00Z'
  )
ON CONFLICT (id) DO NOTHING;

-- ── every user gets a profile and a personal org ────────────────────────────
-- public.ensure_personal_org() is what the authed session bootstrap calls on
-- every sign-in. Running it here for all five is both the fixture and a
-- positive control for the idempotent path: it is called once per user on a
-- fresh database and again on every re-run of this file, and must return the
-- same org id without raising.
--
-- There is deliberately NO org-less mode. `org_id = ANY(<array>)` is NULL-false,
-- so a row with a NULL org_id would be invisible to everyone including its
-- author, and the first fix anyone writes for that is `OR org_id IS NULL` — a
-- global leak. Every user therefore has somewhere to write from the first
-- moment they exist.
DO $bootstrap$
DECLARE
  v_user record;
BEGIN
  FOR v_user IN
    SELECT * FROM (VALUES
      (1, 'a11ce000-0000-4000-8000-000000000001'::uuid, 'Alice Example'),
      (2, 'b0b00000-0000-4000-8000-000000000002'::uuid, 'Bob Example'),
      (3, 'ca201000-0000-4000-8000-000000000003'::uuid, 'Carol Example'),
      (4, 'da7e0000-0000-4000-8000-000000000004'::uuid, 'Dave Example'),
      (5, 'e21e0000-0000-4000-8000-000000000005'::uuid, 'Erin Example')
    ) AS u(ord, id, display_name)
    -- Explicit ORDER BY: a seed that claims determinism does not lean on the
    -- evaluation order of a VALUES list.
    ORDER BY u.ord
  LOOP
    -- The claim is written BEFORE the role switch and the role is dropped after,
    -- so no GUC is ever set while impersonating. Both are transaction-local: if
    -- this file aborts halfway, the session does not keep an identity a later
    -- statement could silently inherit.
    -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_user.id, 'role', 'authenticated')::text, true);
    PERFORM set_config('role', 'authenticated', true);

    INSERT INTO public.profiles (id, display_name, created_at, updated_at)
    VALUES (v_user.id, v_user.display_name, '2026-01-02T09:00:00Z', '2026-01-02T09:00:00Z')
    ON CONFLICT (id) DO NOTHING;

    PERFORM public.ensure_personal_org();

    -- SOURCE: transaction-local GUCs — the pooling identity hazard [corpus: postgres/guc-set-local]
    PERFORM set_config('role', 'none', true);
  END LOOP;
END;
$bootstrap$;

-- ── two team organizations ──────────────────────────────────────────────────
-- The founder gets rank 40 in the same transaction as the org row. An org with
-- no owner seat is unreachable by every predicate form in the system, which is
-- why create_org() writes both or neither.
--
-- The existence guard runs AS ALICE, not as the seeding role, for the same
-- reason the writes do. Locally the seeding role is a superuser and sees every
-- org regardless of membership; on a hosted project it may see none. Asking the
-- question as the member turns an environment-dependent read into the exact
-- read the application performs — and makes the guard itself a positive
-- control, because an Alice who cannot see the org she founded is a bug.
DO $teams$
BEGIN
  -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
  PERFORM set_config('request.jwt.claims',
    '{"sub": "a11ce000-0000-4000-8000-000000000001", "role": "authenticated"}', true);
  PERFORM set_config('role', 'authenticated', true);
  IF NOT EXISTS (SELECT 1 FROM public.orgs o WHERE o.slug = 'acme') THEN
    PERFORM public.create_org('Acme Corp', 'acme');
  END IF;
  -- SOURCE: transaction-local GUCs — the pooling identity hazard [corpus: postgres/guc-set-local]
  PERFORM set_config('role', 'none', true);

  -- Erin founds a second org and is a member of NOTHING in Acme. Without her,
  -- "Alice sees her org's notes" is vacuously true and a deny-all database
  -- would look identical to a working one.
  -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
  PERFORM set_config('request.jwt.claims',
    '{"sub": "e21e0000-0000-4000-8000-000000000005", "role": "authenticated"}', true);
  PERFORM set_config('role', 'authenticated', true);
  IF NOT EXISTS (SELECT 1 FROM public.orgs o WHERE o.slug = 'globex') THEN
    PERFORM public.create_org('Globex', 'globex');
  END IF;
  -- SOURCE: transaction-local GUCs — the pooling identity hazard [corpus: postgres/guc-set-local]
  PERFORM set_config('role', 'none', true);
END;
$teams$;

-- ── the invitation round trip, once per rank ────────────────────────────────
-- All four ranks end up represented in Acme: Alice 40, Bob 30, Carol 20,
-- Dave 10. A fixture set where every member is an owner cannot distinguish a
-- working rank floor from a database that ignores rank entirely, so the seed
-- carries the whole ladder.
--
-- Each iteration mints a token as Alice and redeems it as the invitee. The
-- plaintext exists only in v_token between those two calls — the table holds
-- sha256(token) and nothing can read the original back. Re-running is safe:
-- create_invitation() clears any prior invitation for the address first, and
-- accept_invitation() inserts the seat ON CONFLICT DO NOTHING.
DO $invites$
DECLARE
  v_invitee record;
  v_org_id uuid;
  v_token uuid;
BEGIN
  -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
  PERFORM set_config('request.jwt.claims',
    '{"sub": "a11ce000-0000-4000-8000-000000000001", "role": "authenticated"}', true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT o.id INTO v_org_id FROM public.orgs o WHERE o.slug = 'acme';
  -- SOURCE: transaction-local GUCs — the pooling identity hazard [corpus: postgres/guc-set-local]
  PERFORM set_config('role', 'none', true);

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'seed: Acme was not created, so its owner cannot see it — '
      'create_org() or the orgs SELECT policy is broken';
  END IF;

  -- The privilege lifecycle (1.0.0): minting an invitation is an admin act judged
  -- against the EFFECTIVE rank, and effective rank >= 30 exists only while an
  -- unexpired elevation does (RAP-13 — the JIT fold in private.member_ranks()).
  -- Alice elevates once for the whole loop, which makes the seed the first
  -- consumer of the JIT door and therefore a positive control: an elevate() that
  -- stopped minting elevations would break the seed, not merely a test.
  -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
  PERFORM set_config('request.jwt.claims',
    '{"sub": "a11ce000-0000-4000-8000-000000000001", "role": "authenticated"}', true);
  PERFORM set_config('role', 'authenticated', true);
  PERFORM public.elevate(v_org_id);
  -- SOURCE: transaction-local GUCs — the pooling identity hazard [corpus: postgres/guc-set-local]
  PERFORM set_config('role', 'none', true);

  FOR v_invitee IN
    SELECT * FROM (VALUES
      (1, 'b0b00000-0000-4000-8000-000000000002'::uuid, 'bob@example.com', 30::smallint),
      (2, 'ca201000-0000-4000-8000-000000000003'::uuid, 'carol@example.com', 20::smallint),
      (3, 'da7e0000-0000-4000-8000-000000000004'::uuid, 'dave@example.com', 10::smallint)
    ) AS i(ord, id, email, role_rank)
    ORDER BY i.ord
  LOOP
    -- Mint as Alice. An admin may not invite at or above their own rank, so
    -- rank 40 is what makes all three of these legal.
    -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
    PERFORM set_config('request.jwt.claims',
      '{"sub": "a11ce000-0000-4000-8000-000000000001", "role": "authenticated"}', true);
    PERFORM set_config('role', 'authenticated', true);
    v_token := public.create_invitation(v_org_id, v_invitee.email, v_invitee.role_rank);
    -- SOURCE: transaction-local GUCs — the pooling identity hazard [corpus: postgres/guc-set-local]
    PERFORM set_config('role', 'none', true);

    -- Redeem as the invitee, who holds NO seat in Acme at this point. That is
    -- the whole point of an invitation, and it is why the invitations policy
    -- for the rpc writer role carries an `expires_at > now()` arm alongside the
    -- rank arm: no rank or scope term can be true for a caller with no
    -- membership.
    -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_invitee.id, 'role', 'authenticated')::text, true);
    PERFORM set_config('role', 'authenticated', true);
    PERFORM public.accept_invitation(v_token);
    -- SOURCE: transaction-local GUCs — the pooling identity hazard [corpus: postgres/guc-set-local]
    PERFORM set_config('role', 'none', true);
  END LOOP;
END;
$invites$;

-- ── domain rows ─────────────────────────────────────────────────────────────
-- Notes are written by the member who authored them, into the org that owns
-- them. owner_id is stated explicitly on every row because the column no longer
-- defaults to auth.uid(): after the org re-scope it is nullable ATTRIBUTION,
-- not the authorization key, and a column that decides nothing should not be
-- filled in by magic.
--
-- Carol is rank 20 (member), which is the floor the notes INSERT policy
-- requires. Dave is rank 10 (viewer) and deliberately writes nothing — a seed
-- in which every member can write cannot tell a rank floor from a no-op.
DO $notes$
DECLARE
  v_acme uuid;
  v_globex uuid;
BEGIN
  -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
  PERFORM set_config('request.jwt.claims',
    '{"sub": "a11ce000-0000-4000-8000-000000000001", "role": "authenticated"}', true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT o.id INTO v_acme FROM public.orgs o WHERE o.slug = 'acme';

  -- Literal text, deliberately not the project-name placeholder: a rendered
  -- project name containing an apostrophe would terminate this string literal
  -- and break `db reset` on the very first run after init.
  INSERT INTO public.notes (id, org_id, owner_id, title, body, created_at, updated_at)
  VALUES (
    'a0000001-0000-4000-8000-000000000011', v_acme,
    'a11ce000-0000-4000-8000-000000000001',
    'Your first note',
    'This note belongs to Acme Corp. Signed in as Erin, it does not exist.',
    '2026-01-02T09:05:00Z', '2026-01-02T09:05:00Z'
  )
  ON CONFLICT (org_id, id) DO NOTHING;

  INSERT INTO public.notes (id, org_id, owner_id, title, body, created_at, updated_at)
  VALUES (
    'a0000002-0000-4000-8000-000000000012', v_acme,
    'a11ce000-0000-4000-8000-000000000001',
    'Second note, newer',
    'Two rows in one org, so list ordering and keyset pagination have something to order.',
    '2026-01-02T09:06:00Z', '2026-01-02T09:06:00Z'
  )
  ON CONFLICT (org_id, id) DO NOTHING;
  -- SOURCE: transaction-local GUCs — the pooling identity hazard [corpus: postgres/guc-set-local]
  PERFORM set_config('role', 'none', true);

  -- Carol, rank 20, writing into the SAME org. This row is what makes
  -- "a colleague's note is visible to me" a testable claim rather than an
  -- assumption — in a per-user model it would be invisible to Alice, and the
  -- whole point of the B2B re-scope is that it is not.
  -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
  PERFORM set_config('request.jwt.claims',
    '{"sub": "ca201000-0000-4000-8000-000000000003", "role": "authenticated"}', true);
  PERFORM set_config('role', 'authenticated', true);
  INSERT INTO public.notes (id, org_id, owner_id, title, body, created_at, updated_at)
  VALUES (
    'c0000003-0000-4000-8000-000000000013', v_acme,
    'ca201000-0000-4000-8000-000000000003',
    'Carol writes to the org, not to herself',
    'Alice can read this. That is the B2B model working, and a per-user policy would hide it.',
    '2026-01-02T09:07:00Z', '2026-01-02T09:07:00Z'
  )
  ON CONFLICT (org_id, id) DO NOTHING;
  -- SOURCE: transaction-local GUCs — the pooling identity hazard [corpus: postgres/guc-set-local]
  PERFORM set_config('role', 'none', true);

  -- The other tenant. If this row is ever visible inside Acme, the policies are
  -- broken and supabase/tests/rls_isolation.test.sql should have said so first.
  -- SOURCE: transaction-local GUCs — SET LOCAL / set_config(..., true) [corpus: postgres/guc-set-local]
  PERFORM set_config('request.jwt.claims',
    '{"sub": "e21e0000-0000-4000-8000-000000000005", "role": "authenticated"}', true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT o.id INTO v_globex FROM public.orgs o WHERE o.slug = 'globex';
  INSERT INTO public.notes (id, org_id, owner_id, title, body, created_at, updated_at)
  VALUES (
    'e0000004-0000-4000-8000-000000000021', v_globex,
    'e21e0000-0000-4000-8000-000000000005',
    'Globex has its own notes',
    'A different tenant entirely. Nobody in Acme holds a seat here.',
    '2026-01-02T09:08:00Z', '2026-01-02T09:08:00Z'
  )
  ON CONFLICT (org_id, id) DO NOTHING;
  -- SOURCE: transaction-local GUCs — the pooling identity hazard [corpus: postgres/guc-set-local]
  PERFORM set_config('role', 'none', true);
END;
$notes$;

COMMIT;
