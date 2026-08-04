-- supabase/schemas/05_tenancy.sql — the tenancy spine: orgs, seats, invitations.
--
-- DECLARATIVE FILE — see 00_shared.sql for how this directory relates to
-- supabase/migrations/ and what the diff engine does not see. The forward step that
-- builds this state, plus the full design argument, is
-- supabase/migrations/20260201000000_tenancy_spine.sql.
--
-- THE MODEL IN ONE PARAGRAPH. Authorization is table-anchored and
-- revocation-immediate: a user's reach is whatever public.memberships says right now,
-- never what a JWT claimed when it was minted. Two zero-argument STABLE helpers turn
-- that table into the only two predicate shapes any policy may use — a scope test
-- (`org_id = ANY((SELECT private.member_org_ids())::uuid[])`) and a rank floor over a jsonb
-- map. Both are uncorrelated scalar sub-selects, so the planner hoists them into one
-- InitPlan per statement rather than calling per row. tools/tenancy.json is that
-- closed form set as reviewable data and tools/check-tenancy.mjs enforces it.
--
-- WHY NO auth.jwt() ANYWHERE. Putting the org set in a token means revocation waits
-- for the token to expire, and the set outgrows the Edge header limit for any user in
-- a few hundred orgs. A table read that hoists once per statement costs a fraction of
-- what that complexity does.
--
-- WHY SEATS ARE WRITTEN BY A SEPARATE ROLE. Every table here is FORCE ROW LEVEL
-- SECURITY, so even a SECURITY DEFINER function's owner is subject to policies, and
-- seat writes are denied to `authenticated` (a self-keyed INSERT policy would let any
-- user award themselves any rank). `app_tenancy_rpc` is the one NOLOGIN role holding
-- seat-write policies; the only way to act as it is to call one of the allowlisted
-- definer RPCs, each of which re-derives the caller from auth.uid(). Its paired
-- self-only SELECT policy on public.memberships is not optional — see the migration.
--
-- AND WHY THERE IS A SECOND ONE. PostgreSQL AND-s a table's SELECT policies onto any
-- UPDATE or DELETE whose WHERE clause reads that table, so with a self-only seat read
-- an admin's promotion matched ZERO ROWS — the write policy admitted the row and the
-- read policy filtered it away first. The rpc role therefore needs to SEE the seats it
-- may change, and the obvious widening (a rank term over private.member_ranks()) is
-- the one thing that cannot work, because that helper READS this table and a seat
-- policy calling it is re-entered by it. `app_tenancy_reader` breaks the cycle: it
-- owns private.rpc_admin_org_ids() as SECURITY DEFINER, so that read is judged against
-- the READER's policy, which is self-only and calls nothing. The chain terminates in
-- one hop. The reader owns that single function, holds one SELECT grant, and can write
-- nothing at all.
--
-- Identity has a matching split: POLICIES call auth.uid(), function BODIES call
-- private.caller_id(). Not a style choice — `auth` is owned by supabase_admin and
-- neither role can resolve a name in it, but a stored policy expression was already
-- parsed as postgres and only re-checks EXECUTE. A body is parsed as its executing
-- role and raises 42501.
-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]

CREATE TABLE public.orgs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  -- Every user gets a 'personal' org lazily at first authed request; 'team' is
  -- everything else. There is no org-less mode on purpose: `= ANY(array)` is
  -- NULL-false, so a NULL org_id row would be invisible even to its author, and the
  -- first fix anyone reaches for is `OR org_id IS NULL` — a global leak.
  kind text NOT NULL DEFAULT 'team',
  -- Attribution, not ownership. ON DELETE SET NULL because in B2B the data controller
  -- is the org: the creator leaving must not delete the company's workspace.
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orgs_kind_known CHECK (kind IN ('personal', 'team')),
  CONSTRAINT orgs_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT orgs_slug_shape CHECK (
    slug ~ '^[a-z0-9][a-z0-9-]{0,46}[a-z0-9]$'
    AND slug NOT IN ('admin', 'api', 'app', 'auth', 'assets', 'internal', 'static', 'support', 'www')
  )
);

CREATE TABLE public.memberships (
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  -- Ranks rather than names, because every authorization question here is an ordering
  -- question ("at least admin"). viewer 10, member 20, admin 30, owner 40 — the scale
  -- lives in tools/tenancy.json and the gate rejects a floor that is off it.
  role_rank smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_id),
  CONSTRAINT memberships_rank_known CHECK (role_rank IN (10, 20, 30, 40))
);

CREATE TABLE public.invitations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  email text NOT NULL,
  role_rank smallint NOT NULL,
  -- The DIGEST of the bearer token, never the token. public.create_invitation returns
  -- the plaintext exactly once. Storing it would let any rank-30 admin read a pending
  -- rank-40 invitation's token straight out of the table and redeem it from a second
  -- account — seat discipline bypassed with nothing but a granted read.
  token_digest bytea NOT NULL UNIQUE,
  invited_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, email),
  CONSTRAINT invitations_rank_known CHECK (role_rank IN (10, 20, 30, 40)),
  CONSTRAINT invitations_email_length CHECK (char_length(email) BETWEEN 3 AND 320)
);
