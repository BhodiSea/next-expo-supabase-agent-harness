-- supabase/migrations/20260812000000_mfa_aal2.sql — the MFA rail, enforced at the
-- database rather than in a screen.
--
-- WHAT THIS IS FOR. A session that has passed a second factor carries `aal2` in its
-- JWT; one that has only passed a password carries `aal1`. The claim is signed by the
-- auth server and PostgREST verifies the signature itself, so unlike a check in a
-- layout or a middleware this one also binds a client talking STRAIGHT to PostgREST
-- with a stolen anon key — there is no path around it that does not involve forging
-- a token. That is the whole reason the rail lives here.
--
-- WHAT IT DELIBERATELY IS NOT. It does not make MFA mandatory, because the platform
-- cannot: GoTrue's MFA configuration carries no `required` field anywhere, so
-- "every user has enrolled" is an application decision. What the rail does is make
-- enrolment MEAN something — a user who holds a verified factor can no longer reach
-- the data with a password alone, on any surface, including one nobody wrote. Until
-- an enrolment surface exists, the register grades the corresponding Essential Eight
-- rows honestly rather than claiming them (obligations: e8-mfa-enrolment-surface).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS IS NOT THE PUBLISHED SUPABASE POLICY, and this is the load-bearing part.
-- ─────────────────────────────────────────────────────────────────────────────
-- The vendor-documented opt-in aal2 policy reads roughly:
--
--   USING (array[(SELECT auth.jwt()->>'aal')] <@ (
--     SELECT CASE WHEN count(id) > 0 THEN array['aal2'] ELSE array['aal1','aal2'] END
--       FROM auth.mfa_factors WHERE auth.uid() = user_id AND status = 'verified'))
--
-- It is broken in THREE directions, and the second one is worse than the first:
--
--   1. `authenticated` holds NO privilege on auth.mfa_factors, so the subquery raises
--      42501 and every request to the table 403s. Loud, and therefore harmless.
--
--   2. "Fixed" with a naive `GRANT SELECT ON auth.mfa_factors TO authenticated`, the
--      table still has RLS enabled and NO policy — so it is default-deny, `count(id)`
--      is 0 for everyone including users who ARE enrolled, the CASE falls through to
--      `array['aal1','aal2']`, and the policy SILENTLY ACCEPTS aal1. A control that
--      reads as MFA enforcement in the diff, passes a naive test (an unenrolled user
--      is correctly admitted), and enforces nothing at all.
--
--   3. It DENIES every session that carries no JWT at all. `auth.jwt()->>'aal'` is
--      NULL there, and `array[NULL] <@ array['aal1','aal2']` evaluates to NULL rather
--      than true — which a RESTRICTIVE policy treats as a refusal. So a migration, a
--      seed file or a psql session cannot write the table. Not theory: swapping this
--      policy in during the 0.9.9 proof ladder failed `supabase db reset` outright,
--      at `Seeding data from supabase/seed.sql`, with SQLSTATE 42501. The shape below
--      has no such hole — `NOT mfa_is_required()` is TRUE for a caller with no
--      factors, and a caller with no JWT has none.
--
-- Failure 2 is the one this file is shaped against: a fall-through DEFAULT that opens.
-- So the shape here inverts it. `private.mfa_is_required()` is SECURITY DEFINER, which
-- is what actually gives it the read — no grant on auth.mfa_factors is created, and
-- none is needed — and it returns a BOOLEAN rather than a set the caller compares
-- against, so there is no array to fall through and no empty-result branch that means
-- "allow". A read that fails now yields an error, not a permission.
--
-- The pgTAP suite supabase/tests/mfa_aal2.test.sql exists to hold exactly this: an
-- ENROLLED user presenting an aal1 token gets ZERO ROWS. A test that only checks the
-- unenrolled case passes against the broken policy too, which is why it is not the
-- test that ships.
-- SOURCE: docs/adr/20260812-mfa-aal2.md

SET lock_timeout = '3s';

-- ─────────────────────────────────────────────────────────────────────────────
-- The caller's assurance level
-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY INVOKER and zero-argument, exactly like private.caller_id(): it reads only
-- the request's own GUCs, holds no privilege, and the planner hoists a zero-argument
-- call wrapped in a scalar sub-select into one InitPlan per statement.
--
-- Both GUC spellings, and for the same reason caller_id() reads both: PostgREST sets
-- the per-claim `request.jwt.claim.<name>` form as well as the blob, and a caller who
-- is one assurance level in a policy and another inside a function is a bug no test
-- would describe correctly. NULL when neither is set — a direct psql session or a
-- migration has no JWT, and the predicate below treats NULL as "not aal2", which is
-- the direction that fails closed.
-- SOURCE: transaction-local GUCs — identity travels in request.jwt.claims, which is
-- role-switch-independent [corpus: postgres/guc-set-local]
CREATE FUNCTION private.caller_aal()
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  -- SOURCE: transaction-local GUCs — request.jwt.claims, plus the legacy per-claim GUC PostgREST still sets [corpus: postgres/guc-set-local]
  SELECT coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.aal', true), ''),
    (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal')
  )
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Does this caller have a second factor at all?
-- ─────────────────────────────────────────────────────────────────────────────
-- THE ONE FUNCTION HERE THAT HOLDS PRIVILEGE, and its whole body is one existence
-- test over one table. SECURITY DEFINER is not a convenience: `authenticated` holds no
-- privilege on auth.mfa_factors and granting one would expose every user's factor
-- inventory to a table PostgREST does not serve but a definer function elsewhere might
-- reach. Running as the owner keeps the read inside this function, where the only
-- thing that escapes is a boolean about the caller themself.
--
-- `SET search_path = ''` is mandatory on a definer: without it a caller-controlled
-- schema can shadow the objects the body resolves, and the body then runs as the owner
-- against the attacker's table. The write guard `security-definer-no-search-path`
-- refuses the write that omits it, and every builtin below is pg_catalog-qualified for
-- the same reason.
--
-- STABLE, not VOLATILE: within one statement the answer cannot change, and STABLE is
-- what lets the planner hoist the wrapping sub-select into an InitPlan instead of
-- re-running this per candidate row.
-- SOURCE: PostgreSQL row security — a SECURITY DEFINER function's reads are judged
-- with the owner's privileges, which is how a policy reads a table the caller cannot
-- [corpus: postgres/rls-force]
CREATE FUNCTION private.mfa_is_required()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM auth.mfa_factors f
     WHERE f.user_id = (SELECT private.caller_id())
       AND f.status = 'verified'
  )
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The predicate the policies use
-- ─────────────────────────────────────────────────────────────────────────────
-- Reads as: this statement is allowed through unless the caller has a second factor
-- and did not use it. Written as a single boolean with no CASE and no set membership,
-- so there is no branch whose default is "allow" — the defect the vendor policy has.
--
-- SECURITY INVOKER: it needs no privilege of its own, and keeping the definer surface
-- to the one function that genuinely requires it is the point. A definer wrapper
-- around a predicate is a definer wrapper around every future edit to that predicate.
-- SOURCE: RLS performance — wrap the identity call in a scalar sub-select so the
-- planner hoists it into an InitPlan [corpus: postgres/rls-initplan]
CREATE FUNCTION private.mfa_satisfied()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT (SELECT private.caller_aal()) = 'aal2'
      OR NOT (SELECT private.mfa_is_required())
$$;

-- Nobody but a signed-in caller runs these. anon and PUBLIC are revoked explicitly
-- rather than left to default privileges, which is the same call every function in
-- 20260201000000_tenancy_spine.sql makes and for the same reason: Supabase's default
-- grants stop applying to projects created on or after 2026-10-30, so a migration that
-- relies on them works in the project it was written against and 403s in the next one.
REVOKE ALL ON FUNCTION private.caller_aal() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.mfa_is_required() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.mfa_satisfied() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.caller_aal() TO authenticated;
GRANT EXECUTE ON FUNCTION private.mfa_is_required() TO authenticated;
GRANT EXECUTE ON FUNCTION private.mfa_satisfied() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- The rail itself
-- ─────────────────────────────────────────────────────────────────────────────
-- RESTRICTIVE, and with no `FOR` clause. Two orthogonal axes that read as one:
--
--   * RESTRICTIVE means this policy ANDs onto the permissive set instead of ORing
--     into it. The four per-operation policies above still decide WHICH rows a member
--     may touch; this one can only ever subtract, so it cannot widen anything by
--     accident and it cannot be satisfied by adding another permissive policy.
--   * NO `FOR` clause means every command. Splitting it per operation would be four
--     copies of one predicate with four chances to omit one — and the vendor's own
--     other documentation page writes this same policy `for update`, which gates
--     UPDATE while leaving SELECT wide open. That is not a hypothetical mis-read; it
--     is published.
--
-- Both USING and WITH CHECK, because USING alone governs which existing rows are
-- visible and would let an aal1 session INSERT rows it then cannot see.
--
-- SCOPE, stated plainly: this rail is applied to public.notes — the worked vertical
-- every new slice is copied from — and not to every table in the tree. Which data
-- warrants a second factor is a product decision (a low-sensitivity lookup table
-- blocked at aal1 is a support ticket, not a control), so the harness ships the
-- correct shape and the proof that it binds, and the register grades accordingly: no
-- row claims "MFA is used to authenticate users of data repositories" on the strength
-- of one table.
-- SOURCE: PostgreSQL row security — a RESTRICTIVE policy is ANDed with the permissive
-- set, so it can only ever remove rows [corpus: postgres/rls-force]
CREATE POLICY notes_mfa_aal2 ON public.notes
  AS RESTRICTIVE TO authenticated
  USING ((SELECT private.mfa_satisfied()))
  WITH CHECK ((SELECT private.mfa_satisfied()));
