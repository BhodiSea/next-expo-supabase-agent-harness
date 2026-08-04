-- 20260201000000_tenancy_spine — orgs, seats, invitations, and the one role that
-- may write a seat.
--
-- APPLIED HISTORY, NOT DESIRED STATE. The desired state and the full reasoning live
-- in supabase/schemas/05_tenancy.sql. Append-only and DML-free for the reasons at the
-- top of 20260101000000_account_spine.sql.
--
-- ── WHY A SEPARATE WRITER ROLE EXISTS ──────────────────────────────────────────
-- Every table here ships FORCE ROW LEVEL SECURITY, which subjects the table OWNER to
-- its own policies. A SECURITY DEFINER function runs as the role that owns it — so
-- the definer is NOT exempt either. Seat writes must be denied to `authenticated`
-- (an INSERT policy keyed on the caller is a self-service seat grant: any user could
-- award themselves any rank in any org they can name). Those two facts together mean
-- that without a THIRD role holding a write policy, no role in this database could
-- ever create a membership row: the first create_org would fail 42501 and
-- `supabase db reset` would die at seed.
--
-- `app_tenancy_rpc` is that role. It is NOLOGIN and holds no grant any client can
-- reach; the only way to act as it is to execute one of the allowlisted definer
-- functions below, each of which re-derives the caller from auth.uid() internally.
--
-- ── THE PAIRING THAT KEEPS IT FROM FAILING SILENTLY ───────────────────────────
-- The rank-scoped write policies call private.member_ranks(), which is SECURITY
-- INVOKER — so during a definer call it reads public.memberships AS app_tenancy_rpc.
-- Give that role no SELECT policy and the read hits RLS default-deny, the rank map
-- comes back empty, every comparison is false, and the write matches ZERO ROWS AND
-- RETURNS SUCCESS. Every promotion in production would report OK and change nothing.
-- Hence memberships_select_rpc below, and the `IF NOT FOUND THEN RAISE` guard in each
-- seat RPC as the second line of defence. tools/check-tenancy.mjs enforces the pair.
--
-- Identity reads request.jwt.claims through current_setting(), which is a GUC and
-- therefore role-switch-independent: inside a definer running as app_tenancy_rpc it
-- still resolves to the human caller. That is the property the whole design turns on.
-- Policies say auth.uid(); function BODIES say private.caller_id(), because app_tenancy_rpc
-- cannot resolve a name in schema auth — see the note above private.caller_id() below.
--
-- ── SELECT POLICIES GOVERN WRITES TOO, AND THAT IS NOT OPTIONAL ──────────────
-- An UPDATE or DELETE whose WHERE clause reads the target table's columns requires
-- SELECT permission on them, so PostgreSQL AND-s that table's SELECT policies onto the
-- write policy's USING clause. No RETURNING is needed to trigger it; every seat RPC
-- here says `WHERE org_id = $1 AND user_id = $2`, which is enough.
--
-- The consequence is the single most expensive thing to learn about this design late:
-- with a SELF-ONLY SELECT policy on public.memberships, an owner promoting a member
-- matched ZERO ROWS. Not an error — the write policy admitted the row and the SELECT
-- policy filtered it away first. That is why memberships_select_rpc carries an admin
-- arm, why that arm has to resolve through a definer owned by a DIFFERENT role
-- (private.rpc_admin_org_ids — anything else re-enters this table's own policy), and
-- why every seat RPC still ends in `IF NOT FOUND THEN RAISE`: the guard converts a
-- policy miss into a loud 42501 instead of a success that changed nothing. It is the
-- reason the defect was findable at all.
-- SOURCE: PostgreSQL row security — FORCE applies row security to the table owner as
-- well [corpus: postgres/rls-force]

-- Cluster-scoped, and `supabase db reset` drops the DATABASE, not the role — so a
-- bare CREATE ROLE would fail on the second reset. Idempotent by construction.
DO $tenancy_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_tenancy_rpc') THEN
    CREATE ROLE app_tenancy_rpc NOLOGIN;
  END IF;
  -- The SECOND role, and the only reason it exists is to break a cycle. See the
  -- note above private.rpc_admin_org_ids().
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_tenancy_reader') THEN
    CREATE ROLE app_tenancy_reader NOLOGIN;
  END IF;
END;
$tenancy_role$;

-- Reassigning ownership requires membership in the new owning role, and the new
-- owner needs CREATE on the function's schema. Both are revoked at the END of this
-- migration, so `postgres` does not keep inheriting these roles' policies into
-- every later migration, seed and SQL-editor session.
GRANT app_tenancy_rpc TO postgres;
GRANT app_tenancy_reader TO postgres;
GRANT USAGE, CREATE ON SCHEMA public TO app_tenancy_rpc;

-- The helper schema. Never listed in [api].schemas, so PostgREST cannot reach it —
-- which is what makes "forgot to lock this down" fail closed here instead of open.
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated, app_tenancy_rpc;
GRANT USAGE, CREATE ON SCHEMA private TO app_tenancy_reader;

-- ─────────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE public.orgs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  -- 'personal' is every user's own single-seat org; 'team' is everything else.
  -- There is deliberately NO org-less mode: `= ANY(array)` is NULL-false, so a NULL
  -- org_id row would be invisible to everyone including its author, and the first
  -- fix anyone writes for that is `OR org_id IS NULL` — a global leak.
  kind text NOT NULL DEFAULT 'team',
  -- NULLABLE, ON DELETE SET NULL: in B2B the data controller is the ORG. Firing an
  -- employee, or that employee deleting their account, must not delete the company's
  -- org. Attribution is a convenience; it is not ownership.
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orgs_kind_known CHECK (kind IN ('personal', 'team')),
  CONSTRAINT orgs_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  -- Shape AND reserved words in one constraint: a slug is a path segment, and an org
  -- that grabs 'api' or 'auth' collides with the app's own routes.
  --
  -- THE LENGTH BOUND IS ARITHMETIC, NOT TASTE. ensure_personal_org() mints
  -- 'personal-' || replace(uuid::text, '-', '') = 9 + 32 = 41 characters, so a bound
  -- of 40 (the first spelling of this constraint) made the personal org — the one
  -- every single user gets — impossible to create. 1 + 46 + 1 = 48 leaves headroom
  -- and still fits a path segment comfortably.
  CONSTRAINT orgs_slug_shape CHECK (
    slug ~ '^[a-z0-9][a-z0-9-]{0,46}[a-z0-9]$'
    AND slug NOT IN ('admin', 'api', 'app', 'auth', 'assets', 'internal', 'static', 'support', 'www')
  )
);

CREATE TRIGGER orgs_set_updated_at
  BEFORE UPDATE ON public.orgs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Idempotency for ensure_personal_org(), as a PARTIAL unique index because only
-- personal orgs are one-per-creator. NULLS DISTINCT means a SET NULL creator drops
-- out of the constraint — the pgTAP suite asserts no personal org has a null creator,
-- because such a row is unreachable by every predicate form and could never be swept.
CREATE UNIQUE INDEX orgs_personal_creator_key
  ON public.orgs (created_by) WHERE kind = 'personal';

CREATE TABLE public.memberships (
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  -- Ranks, not names: every authorization question this system asks is an ordering
  -- question ("at least admin"), and an ordering over an enum is a join.
  role_rank smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_id),
  CONSTRAINT memberships_rank_known CHECK (role_rank IN (10, 20, 30, 40))
);

CREATE TRIGGER memberships_set_updated_at
  BEFORE UPDATE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- org_id LEADING: private.member_org_ids() and every rank lookup filter this table by
-- the caller's seats, and the PK's leading column is user_id, which serves the
-- self-only policy but not the per-org reads.
CREATE INDEX memberships_org_id_role_rank_idx
  ON public.memberships (org_id, role_rank);

CREATE TABLE public.invitations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  email text NOT NULL,
  role_rank smallint NOT NULL,
  -- THE DIGEST, NEVER THE TOKEN. create_invitation returns the plaintext exactly
  -- once and stores sha256 of it. Without this, every rank-30 admin could read the
  -- pending token of a rank-40 invitation straight out of the table and redeem it —
  -- seat-change discipline bypassed using nothing but a granted read.
  token_digest bytea NOT NULL UNIQUE,
  invited_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- (org_id, id): partition-ready, and it makes org_id the leading indexed column.
  PRIMARY KEY (org_id, id),
  -- One live invitation per address per org. create_invitation deletes any existing
  -- row first, so re-inviting is never a 23505 the UI has to explain.
  UNIQUE (org_id, email),
  CONSTRAINT invitations_rank_known CHECK (role_rank IN (10, 20, 30, 40)),
  CONSTRAINT invitations_email_length CHECK (char_length(email) BETWEEN 3 AND 320)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- The caller's id, without reaching into schema auth
-- ─────────────────────────────────────────────────────────────────────────────
-- A byte-for-byte re-derivation of Supabase's auth.uid(), and it exists for a
-- privilege reason rather than a stylistic one.
--
-- Schema `auth` is owned by supabase_admin. `postgres` holds USAGE on it but no GRANT
-- OPTION, so `GRANT USAGE ON SCHEMA auth TO app_tenancy_rpc` silently grants nothing
-- ("WARNING: no privileges were granted") — on a hosted project and locally alike.
-- app_tenancy_rpc therefore cannot resolve the NAME `auth.uid` at all.
--
-- That distinction bites in exactly one direction. A POLICY expression was parsed once,
-- as `postgres`, and is stored with the function's OID; evaluating it re-checks EXECUTE
-- (which app_tenancy_rpc has) but never re-checks schema USAGE — so `(SELECT auth.uid())`
-- inside a policy works fine as the rpc role. A FUNCTION BODY is parsed when it runs, in
-- the caller's own privilege context, so the same expression inside member_ranks() or
-- inside a definer RPC fails with `42501: permission denied for schema auth` — which is
-- how the first version of this migration died at `supabase db reset`, one statement into
-- the seed.
--
-- Hence the split, which is deliberate and not an inconsistency to tidy up: policies say
-- auth.uid(), function bodies say private.caller_id(). The two MUST agree, so this is a
-- transcription of auth.uid()'s source rather than a reimplementation of its intent —
-- including the legacy `request.jwt.claim.sub` GUC that PostgREST still sets, because a
-- caller who is one identity in a policy and another inside a function is a bug no test
-- would describe correctly.
-- SOURCE: transaction-local GUCs — identity travels in request.jwt.claims, which is
-- role-switch-independent [corpus: postgres/guc-set-local]
CREATE FUNCTION private.caller_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  -- SOURCE: transaction-local GUCs — request.jwt.claims, plus the legacy per-claim GUC PostgREST still sets [corpus: postgres/guc-set-local]
  SELECT coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Helpers — STABLE, SECURITY INVOKER, zero-argument
-- ─────────────────────────────────────────────────────────────────────────────
-- Zero arguments is the whole trick. `org_id = ANY((SELECT private.member_org_ids())::uuid[])`
-- is an uncorrelated scalar sub-select, which the planner hoists into ONE InitPlan per
-- statement. Passing the row's own column — `(SELECT private.member_rank(org_id)) >= 30`
-- — looks almost identical and is a correlated SubPlan re-evaluated per row, which also
-- re-enters this table's own policies. tools/check-tenancy.mjs reds that shape.
--
-- SECURITY INVOKER, deliberately: as invoker these read public.memberships under its
-- self-only SELECT policy, so they can only ever reveal the caller's own seats, and
-- the read path holds no elevated privilege at all.
-- SOURCE: RLS performance — wrap the identity call in a scalar sub-select so the
-- planner hoists it into an InitPlan [corpus: postgres/rls-initplan]
CREATE FUNCTION private.member_org_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT coalesce(pg_catalog.array_agg(m.org_id), ARRAY[]::uuid[])
    FROM public.memberships m
   WHERE m.user_id = (SELECT private.caller_id());
$$;

-- The rank map: org_id -> role_rank, as jsonb, so a rank floor is one hoisted lookup
-- rather than a per-row function call.
-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE FUNCTION private.member_ranks()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT coalesce(pg_catalog.jsonb_object_agg(m.org_id::text, m.role_rank), '{}'::jsonb)
    FROM public.memberships m
   WHERE m.user_id = (SELECT private.caller_id());
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The cycle-breaker: which orgs does the caller ADMINISTER?
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS EXISTS AT ALL. PostgreSQL applies a table's SELECT policies as an extra
-- row filter to any UPDATE or DELETE whose WHERE clause reads that table's columns —
-- with or without RETURNING. `set_member_role` and `remove_member` both say
-- `WHERE org_id = $1 AND user_id = $2`, so with a SELF-ONLY SELECT policy on
-- public.memberships an admin's promotion matched ZERO ROWS. The IF NOT FOUND guard
-- turned that into a loud 42501 rather than a silent success, but the feature did not
-- work: verified by promoting a rank-10 seat as a rank-40 owner and watching it fail.
--
-- So the rpc role needs to SEE the seats it is allowed to change. The obvious fix —
-- widen memberships_select_rpc with a rank term over private.member_ranks() — is the
-- one thing that cannot work: member_ranks() READS public.memberships, so a
-- memberships SELECT policy calling it is re-entered by it. (In this configuration
-- that surfaces as `54001 stack depth limit exceeded` rather than the tidy
-- `42P17 infinite recursion detected in policy`: SET search_path = '' populates
-- pg_proc.proconfig, and the planner refuses to inline a SQL function that carries
-- one, so the rewriter's cycle check never sees a cycle to report.)
--
-- The cycle is broken by SWITCHING ROLES mid-chain. This function is SECURITY DEFINER
-- owned by app_tenancy_reader, so its read of public.memberships is judged against
-- app_tenancy_reader's policy — memberships_select_reader, which is self-only and
-- calls NOTHING. The chain is therefore finite by construction:
--
--   memberships_select_rpc  (as app_tenancy_rpc)
--     -> private.rpc_admin_org_ids()            [definer, switches to app_tenancy_reader]
--        -> memberships_select_reader           (as app_tenancy_reader) -- terminal
--
-- app_tenancy_reader is deliberately the most boring role in the database: NOLOGIN,
-- one SELECT grant, one self-only policy, and it owns exactly this one function. It
-- cannot write anything, and nothing can assume it.
-- SOURCE: PostgreSQL row security — a SECURITY DEFINER function's reads are judged
-- against the OWNER's policies, which is what makes the chain terminate
-- [corpus: postgres/rls-force]
CREATE FUNCTION private.rpc_admin_org_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(pg_catalog.array_agg(m.org_id), ARRAY[]::uuid[])
    FROM public.memberships m
   WHERE m.user_id = (SELECT private.caller_id())
     AND m.role_rank >= 30;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Freeze triggers — a row may not change tenant
-- ─────────────────────────────────────────────────────────────────────────────
-- Without these, every scope predicate in the system is advisory: an UPDATE that
-- passes its policy could rewrite org_id and walk the row into another tenant. No
-- WHEN clause on the triggers — a freeze that can be disarmed is not a freeze.
CREATE FUNCTION private.freeze_org_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  -- SET-ONCE, not never-set. `OLD.org_id IS NOT NULL` is what lets an install already
  -- in production adopt org scope at all: the expand phase adds a NULLABLE org_id to a
  -- table full of pre-tenancy rows, and the backfill that fills it in is an UPDATE —
  -- which a strict `IS DISTINCT FROM` freeze would refuse on every row. The
  -- relaxation is not a hole, because it CLOSES ITSELF: the contract phase runs
  -- SET NOT NULL, after which OLD.org_id can never be NULL again and this branch is
  -- unreachable. A fresh scaffold ships NOT NULL from the first migration and so is
  -- never in the relaxed state for a single statement.
  -- SOURCE: docs/runbooks/tenancy-adoption.md (expand -> backfill -> contract)
  IF OLD.org_id IS NOT NULL AND NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'org_id is immutable once set (attempted % -> %)', OLD.org_id, NEW.org_id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION private.freeze_membership_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'a seat''s identity is immutable; grant a new seat instead'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER memberships_freeze_identity
  BEFORE UPDATE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION private.freeze_membership_identity();

CREATE TRIGGER invitations_freeze_org
  BEFORE UPDATE ON public.invitations
  FOR EACH ROW EXECUTE FUNCTION private.freeze_org_id();

-- ─────────────────────────────────────────────────────────────────────────────
-- Row security
-- ─────────────────────────────────────────────────────────────────────────────
-- SOURCE: PostgreSQL row security — FORCE applies row security to the table owner as
-- well [corpus: postgres/rls-force]
ALTER TABLE public.orgs ENABLE ROW LEVEL SECURITY;
-- SOURCE: PostgreSQL row security — FORCE applies row security to the table owner as well [corpus: postgres/rls-force]
ALTER TABLE public.orgs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
-- SOURCE: PostgreSQL row security — FORCE applies row security to the table owner as well [corpus: postgres/rls-force]
ALTER TABLE public.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;
-- SOURCE: PostgreSQL row security — FORCE applies row security to the table owner as well [corpus: postgres/rls-force]
ALTER TABLE public.invitations FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.orgs FROM anon, service_role;
REVOKE ALL ON TABLE public.memberships FROM anon, service_role;
REVOKE ALL ON TABLE public.invitations FROM anon, service_role;

-- authenticated READS its orgs and seats and pending invites; it writes NONE of them.
-- Every write goes through a definer RPC running as app_tenancy_rpc.
GRANT SELECT ON TABLE public.orgs TO authenticated;
GRANT SELECT ON TABLE public.memberships TO authenticated;
-- The reader role sees seats ONLY through its own self-only policy; this grant plus
-- that policy is its entire reach into the database.
GRANT SELECT ON TABLE public.memberships TO app_tenancy_reader;
GRANT SELECT ON TABLE public.invitations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.orgs TO app_tenancy_rpc;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.memberships TO app_tenancy_rpc;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.invitations TO app_tenancy_rpc;

-- ── orgs ────────────────────────────────────────────────────────────────────
-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE POLICY orgs_select_member ON public.orgs
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (id = ANY((SELECT private.member_org_ids())::uuid[]));

-- The RPC reads only what it created — enough for ensure_personal_org()'s idempotent
-- re-read, and nothing more.
-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE POLICY orgs_select_rpc ON public.orgs
  AS PERMISSIVE FOR SELECT TO app_tenancy_rpc
  USING (created_by = (SELECT auth.uid()));

-- At INSERT time the caller is not yet a member (the seat is created in the same
-- transaction, after), so a scope predicate would be false by construction. Binding
-- the new row to the caller's own id is the strongest property available at that
-- instant.
-- SOURCE: PostgreSQL row security — WITH CHECK validates the new row [corpus: postgres/rls-force]
CREATE POLICY orgs_insert_rpc ON public.orgs
  AS PERMISSIVE FOR INSERT TO app_tenancy_rpc
  WITH CHECK (created_by = (SELECT auth.uid()));

-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE POLICY orgs_update_rpc ON public.orgs
  AS PERMISSIVE FOR UPDATE TO app_tenancy_rpc
  USING (coalesce(((SELECT private.member_ranks()) ->> id::text)::smallint, 0) >= 40)
  WITH CHECK (coalesce(((SELECT private.member_ranks()) ->> id::text)::smallint, 0) >= 40);

-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE POLICY orgs_delete_rpc ON public.orgs
  AS PERMISSIVE FOR DELETE TO app_tenancy_rpc
  USING (coalesce(((SELECT private.member_ranks()) ->> id::text)::smallint, 0) >= 40);

-- ── memberships ─────────────────────────────────────────────────────────────
-- SELF-ONLY, for BOTH roles, and this is the load-bearing policy of the whole
-- design. It is the recursion terminator (the helpers read this table, so a policy
-- here that called them would be re-entered by them — see the 54001 note above), and for the rpc role it
-- is what makes the rank map non-empty during a definer call.
-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE POLICY memberships_select_self ON public.memberships
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Two arms, and both are load-bearing. The SELF arm is the pairing that keeps the
-- rank-scoped write policies from being runtime-dead (see the header). The ADMIN arm
-- is what lets set_member_role and remove_member reach somebody else's seat at all —
-- PostgreSQL applies this SELECT policy to their WHERE clauses, so without it every
-- promotion matches zero rows. It resolves through the definer cycle-breaker rather
-- than through member_ranks(), which would be re-entered by its own read.
--
-- This is the ONLY policy on this table that may call a helper, and only that one.
-- tools/check-tenancy.mjs enforces both halves.
-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE POLICY memberships_select_rpc ON public.memberships
  AS PERMISSIVE FOR SELECT TO app_tenancy_rpc
  USING (
    user_id = (SELECT auth.uid())
    OR org_id = ANY((SELECT private.rpc_admin_org_ids())::uuid[])
  );

-- The terminal node of the chain: self-only and helper-free, so nothing it is called
-- from can re-enter it. If a future edit adds a helper call here, the recursion this
-- whole arrangement exists to avoid comes straight back.
-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE POLICY memberships_select_reader ON public.memberships
  AS PERMISSIVE FOR SELECT TO app_tenancy_reader
  USING (user_id = (SELECT auth.uid()));

-- Deny-all to the human role. A self-keyed INSERT policy here would let any user
-- award themselves any rank in any org whose id they can guess.
-- SOURCE: PostgreSQL row security — USING restricts which rows the role may reach [corpus: postgres/rls-force]
CREATE POLICY memberships_insert_none ON public.memberships
  AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (false);
-- SOURCE: PostgreSQL row security — USING restricts which rows the role may reach [corpus: postgres/rls-force]
CREATE POLICY memberships_update_none ON public.memberships
  AS PERMISSIVE FOR UPDATE TO authenticated USING (false);
-- SOURCE: PostgreSQL row security — USING restricts which rows the role may reach [corpus: postgres/rls-force]
CREATE POLICY memberships_delete_none ON public.memberships
  AS PERMISSIVE FOR DELETE TO authenticated USING (false);

-- The RPC only ever inserts the CALLER'S OWN seat: create_org's founding rank-40 row
-- and accept_invitation's redeemed row. There is no path that inserts a seat for
-- somebody else, which is why an invitation must be redeemed by its holder.
-- SOURCE: PostgreSQL row security — WITH CHECK validates the new row [corpus: postgres/rls-force]
CREATE POLICY memberships_insert_rpc ON public.memberships
  AS PERMISSIVE FOR INSERT TO app_tenancy_rpc
  WITH CHECK (user_id = (SELECT auth.uid()));

-- Admin-escalation closure, as a predicate rather than as procedural logic: USING
-- sees the OLD row and WITH CHECK the NEW one, so `strictly below the caller's rank`
-- on both means an admin can neither promote anyone to or past their own rank nor
-- touch a peer. It also makes the last-owner rule structural — rank 40 is below
-- nobody, so an owner seat can never be demoted or removed, including one's own.
-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE POLICY memberships_update_rpc ON public.memberships
  AS PERMISSIVE FOR UPDATE TO app_tenancy_rpc
  USING (
    coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 30
    AND role_rank < coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0)
  )
  WITH CHECK (
    coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 30
    AND role_rank < coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0)
  );

-- Two arms, each independently scoped: an admin removing someone strictly below
-- them, or a member leaving on their own. `role_rank < 40` on the self arm is what
-- stops the last owner walking out of their own org.
-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE POLICY memberships_delete_rpc ON public.memberships
  AS PERMISSIVE FOR DELETE TO app_tenancy_rpc
  USING (
    role_rank < coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0)
    OR (user_id = (SELECT auth.uid()) AND role_rank < 40)
  );

-- ── invitations ─────────────────────────────────────────────────────────────
-- Admins see pending invitations for their orgs. They see the DIGEST, which is not
-- redeemable, so this read discloses who was invited and at what rank — not a
-- credential.
-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE POLICY invitations_select_admin ON public.invitations
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 30);

-- Two arms because this policy serves two callers: an admin managing invitations,
-- and an invitee redeeming one. The invitee holds NO seat in the org — that is the
-- point of an invitation — so no rank or scope term can be true for them, and the
-- only property checkable without a membership is that the invitation is still live.
-- Redemption is a DELETE, so a consumed token cannot be replayed: the row is gone.
-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE POLICY invitations_select_rpc ON public.invitations
  AS PERMISSIVE FOR SELECT TO app_tenancy_rpc
  USING (
    coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 30
    OR expires_at > now()
  );

-- SOURCE: PostgreSQL row security — WITH CHECK validates the new row [corpus: postgres/rls-force]
CREATE POLICY invitations_insert_rpc ON public.invitations
  AS PERMISSIVE FOR INSERT TO app_tenancy_rpc
  WITH CHECK (coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 30);

-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE POLICY invitations_update_rpc ON public.invitations
  AS PERMISSIVE FOR UPDATE TO app_tenancy_rpc
  USING (coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 30)
  WITH CHECK (coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 30);

-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE POLICY invitations_delete_rpc ON public.invitations
  AS PERMISSIVE FOR DELETE TO app_tenancy_rpc
  USING (
    coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 30
    OR expires_at > now()
  );

-- Deny-all writes to the human role, so an invitation cannot be minted, retargeted
-- or self-accepted over PostgREST.
-- SOURCE: PostgreSQL row security — USING restricts which rows the role may reach [corpus: postgres/rls-force]
CREATE POLICY invitations_insert_none ON public.invitations
  AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (false);
-- SOURCE: PostgreSQL row security — USING restricts which rows the role may reach [corpus: postgres/rls-force]
CREATE POLICY invitations_update_none ON public.invitations
  AS PERMISSIVE FOR UPDATE TO authenticated USING (false);
-- SOURCE: PostgreSQL row security — USING restricts which rows the role may reach [corpus: postgres/rls-force]
CREATE POLICY invitations_delete_none ON public.invitations
  AS PERMISSIVE FOR DELETE TO authenticated USING (false);

-- ─────────────────────────────────────────────────────────────────────────────
-- The RPCs
-- ─────────────────────────────────────────────────────────────────────────────
-- In `public`, because PostgREST can only call functions in an exposed schema and
-- supabase-js .rpc() is the only transport this stack has. Each one: pins
-- search_path, derives the caller from auth.uid() rather than from an argument, and
-- raises rather than returning quietly when it changed nothing.
-- SOURCE: PostgreSQL CREATE FUNCTION — writing SECURITY DEFINER functions safely
-- https://www.postgresql.org/docs/current/sql-createfunction.html

CREATE FUNCTION public.create_org(p_name text, p_slug text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid := (SELECT private.caller_id());
  v_org_id uuid;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.orgs (name, slug, kind, created_by)
  VALUES (p_name, p_slug, 'team', v_caller)
  RETURNING id INTO v_org_id;
  -- Same transaction as the org: an org with no owner seat is unreachable by every
  -- predicate form in the system, so the two rows are one atomic fact.
  INSERT INTO public.memberships (user_id, org_id, role_rank)
  VALUES (v_caller, v_org_id, 40);
  RETURN v_org_id;
END;
$$;

-- Lazy and idempotent, deliberately NOT an AFTER INSERT trigger on auth.users: GoTrue
-- inserts that row as supabase_auth_admin with no request.jwt.claims, so auth.uid() is
-- NULL in trigger context and every uid-anchored policy fails — the writes would need
-- a vacuous-predicate bypass. A raising trigger on auth.users also blocks ALL signups,
-- and Supabase manages that schema. Called from the authed session bootstrap instead.
CREATE FUNCTION public.ensure_personal_org()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid := (SELECT private.caller_id());
  v_org_id uuid;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  -- The conflict target carries the index predicate because the unique index is
  -- PARTIAL; a bare `ON CONFLICT (created_by)` raises "no unique or exclusion
  -- constraint matching" at first call, which no static gate would ever see.
  INSERT INTO public.orgs (name, slug, kind, created_by)
  VALUES ('Personal', 'personal-' || pg_catalog.replace(v_caller::text, '-', ''), 'personal', v_caller)
  ON CONFLICT (created_by) WHERE kind = 'personal' DO NOTHING
  RETURNING id INTO v_org_id;

  IF v_org_id IS NULL THEN
    SELECT o.id INTO v_org_id
      FROM public.orgs o
     WHERE o.created_by = v_caller AND o.kind = 'personal';
  END IF;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'could not resolve the personal org' USING ERRCODE = '55000';
  END IF;

  -- THE MEMBERSHIP IS THE REAL INVARIANT, so it is re-ensured on every call rather
  -- than inferred from the org's existence. An org row whose owner seat is missing
  -- would otherwise leave the user permanently zero-org, with this function reporting
  -- success forever because the org already exists.
  INSERT INTO public.memberships (user_id, org_id, role_rank)
  VALUES (v_caller, v_org_id, 40)
  ON CONFLICT (user_id, org_id) DO NOTHING;

  RETURN v_org_id;
END;
$$;

-- Returns the PLAINTEXT token exactly once; only its digest is stored.
CREATE FUNCTION public.create_invitation(p_org_id uuid, p_email text, p_role_rank smallint)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_rank smallint := coalesce(((SELECT private.member_ranks()) ->> p_org_id::text)::smallint, 0);
  v_token uuid := pg_catalog.gen_random_uuid();
BEGIN
  -- An admin may not mint a seat at or above their own rank; without this an admin
  -- could invite an owner and then redeem that invitation from a second account.
  IF p_role_rank >= v_caller_rank THEN
    RAISE EXCEPTION 'cannot invite at or above your own rank' USING ERRCODE = '42501';
  END IF;
  -- Clear any prior invitation for this address, expired or not, so re-inviting is
  -- never a duplicate-key error the UI has to translate.
  DELETE FROM public.invitations
   WHERE org_id = p_org_id AND pg_catalog.lower(email) = pg_catalog.lower(p_email);
  INSERT INTO public.invitations (org_id, email, role_rank, token_digest, invited_by)
  VALUES (
    p_org_id,
    pg_catalog.lower(p_email),
    p_role_rank,
    pg_catalog.sha256(pg_catalog.convert_to(v_token::text, 'utf8')),
    (SELECT private.caller_id())
  );
  RETURN v_token;
END;
$$;

-- ONE atomic guarded write. The DELETE is the expiry check, the used-check and the
-- consume, in a single statement — so two sessions racing the same token cannot both
-- proceed, and a redeemed token cannot be replayed because its row no longer exists.
CREATE FUNCTION public.accept_invitation(p_token uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid := (SELECT private.caller_id());
  v_org_id uuid;
  v_rank smallint;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.invitations
   WHERE token_digest = pg_catalog.sha256(pg_catalog.convert_to(p_token::text, 'utf8'))
     AND expires_at > pg_catalog.now()
  RETURNING org_id, role_rank INTO v_org_id, v_rank;
  IF v_org_id IS NULL THEN
    -- One message for invalid, expired and already-used: distinguishing them would
    -- turn this endpoint into a token oracle.
    RAISE EXCEPTION 'invitation is invalid, expired, or already used' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.memberships (user_id, org_id, role_rank)
  VALUES (v_caller, v_org_id, v_rank)
  ON CONFLICT (user_id, org_id) DO NOTHING;
  RETURN v_org_id;
END;
$$;

-- No RETURNING, on purpose (see the header): FOUND reports whether the policy matched
-- a row without dragging SELECT policies into the statement.
CREATE FUNCTION public.set_member_role(p_org_id uuid, p_target_user_id uuid, p_role_rank smallint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_rank smallint := coalesce(((SELECT private.member_ranks()) ->> p_org_id::text)::smallint, 0);
BEGIN
  IF p_role_rank >= v_caller_rank THEN
    RAISE EXCEPTION 'cannot grant a rank at or above your own' USING ERRCODE = '42501';
  END IF;
  UPDATE public.memberships SET role_rank = p_role_rank
   WHERE org_id = p_org_id AND user_id = p_target_user_id;
  -- The policy is the enforcement; this turns a policy MISS into a loud error rather
  -- than a zero-row success. Without it, every failure mode of this function is
  -- silent — which is exactly how the first version of this design would have shipped.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such member, or that seat is not yours to change'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE FUNCTION public.remove_member(p_org_id uuid, p_target_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.memberships
   WHERE org_id = p_org_id AND user_id = p_target_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such member, or that seat is not yours to remove'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Ownership and EXECUTE
-- ─────────────────────────────────────────────────────────────────────────────
-- The REVOKEs are not hygiene, they are the control: PostgreSQL grants EXECUTE to
-- PUBLIC on every new function and Supabase's default privileges additionally grant
-- anon, so a definer function that names no grants is ALREADY callable by an
-- unauthenticated caller. tools/check-rls-manifest.mjs requires the REVOKE for
-- exactly this reason and treats its absence as the exposure.
ALTER FUNCTION public.create_org(text, text) OWNER TO app_tenancy_rpc;
ALTER FUNCTION public.ensure_personal_org() OWNER TO app_tenancy_rpc;
ALTER FUNCTION public.create_invitation(uuid, text, smallint) OWNER TO app_tenancy_rpc;
ALTER FUNCTION public.accept_invitation(uuid) OWNER TO app_tenancy_rpc;
ALTER FUNCTION public.set_member_role(uuid, uuid, smallint) OWNER TO app_tenancy_rpc;
ALTER FUNCTION public.remove_member(uuid, uuid) OWNER TO app_tenancy_rpc;

REVOKE ALL ON FUNCTION public.create_org(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ensure_personal_org() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_invitation(uuid, text, smallint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.accept_invitation(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_member_role(uuid, uuid, smallint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remove_member(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.caller_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.rpc_admin_org_ids() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.member_org_ids() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.member_ranks() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_org(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_personal_org() TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_invitation(uuid, text, smallint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_invitation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_member_role(uuid, uuid, smallint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_member(uuid, uuid) TO authenticated;
-- The helpers are evaluated INSIDE policy expressions as the querying role, so both
-- roles that hold policies need EXECUTE on them.
GRANT EXECUTE ON FUNCTION private.caller_id() TO authenticated, app_tenancy_rpc, app_tenancy_reader;
-- Only the rpc role calls this, and only from inside memberships_select_rpc.
GRANT EXECUTE ON FUNCTION private.rpc_admin_org_ids() TO app_tenancy_rpc;
GRANT EXECUTE ON FUNCTION private.member_org_ids() TO authenticated, app_tenancy_rpc;
GRANT EXECUTE ON FUNCTION private.member_ranks() TO authenticated, app_tenancy_rpc;

-- Hand back the elevated grants used only to transfer ownership. Left in place,
-- `postgres` would INHERIT app_tenancy_rpc's write policies into every later
-- migration, seed and SQL-editor session — turning a deny-all write wall into
-- impersonation-shaped write access for the role most likely to be holding a
-- connection when something goes wrong.
ALTER FUNCTION private.rpc_admin_org_ids() OWNER TO app_tenancy_reader;

REVOKE CREATE ON SCHEMA public FROM app_tenancy_rpc;
REVOKE CREATE ON SCHEMA private FROM app_tenancy_reader;
-- PostgreSQL 16+ leaves an implicit ADMIN-OPTION membership behind from CREATE ROLE
-- that the creating role cannot revoke from itself. What these REVOKEs remove is the
-- part that matters: after them postgres neither INHERITS these roles privileges nor
-- may SET ROLE to them, which is exactly what the pgTAP structure suite asserts.
REVOKE app_tenancy_rpc FROM postgres;
REVOKE app_tenancy_reader FROM postgres;
