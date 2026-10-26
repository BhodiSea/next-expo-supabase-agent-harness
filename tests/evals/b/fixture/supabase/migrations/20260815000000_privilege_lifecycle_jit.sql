-- 20260815000000_privilege_lifecycle_jit — privileged access gets a lifecycle
-- (Essential Eight RAP-02/RAP-03) and administration becomes just-in-time (RAP-13).
--
-- APPLIED HISTORY, NOT DESIRED STATE. The desired state lives in
-- supabase/schemas/05_tenancy.sql; the design argument for the spine this extends is
-- 20260201000000_tenancy_spine.sql. Append-only and DML-free.
--
-- ── WHAT CHANGES, IN ONE PARAGRAPH ────────────────────────────────────────────
-- Until this migration a privileged seat (role_rank >= 30) was a STANDING grant: it
-- never expired, never lapsed, and satisfied every admin predicate forever. From here
-- the two INVOKER helpers the policies are built on fold a LIFECYCLE into the rank
-- they report: a seat's rank counts at 30+ only while (a) its `revalidated_at` is
-- within 12 MONTHS and (b) the caller holds an UNEXPIRED row in
-- public.admin_elevations — otherwise the helpers report LEAST(rank, 20), so every
-- rank-floor predicate in the database sees a member, not an admin. The elevation is
-- minted by public.elevate() for at most ONE HOUR at a time, so administration is a
-- deliberate, short-lived act rather than an ambient property of a session.
--
-- ── THE NUMBERS, AND WHOSE THEY ARE ───────────────────────────────────────────
-- 12 months (revalidation) and 45 days (inactivity) are ASD's verbatim Essential
-- Eight numbers for RAP-02 and RAP-03, and they are the ONLY externally-sourced
-- numbers in this file — encoding a paraphrase would be claiming the control while
-- changing it. The ONE HOUR elevation lifetime is NOT an ASD number: RAP-13 asks that
-- administration be just-in-time and bounded, not for a specific bound, so the bound
-- here is session-shaped (it matches the access-token lifetime order of magnitude)
-- and is a reviewable choice, stated as such.
-- SOURCE: tools/essential-eight.json (RAP-02, RAP-03, RAP-13 — the graded register;
-- its `source` block pins ASD's Essential Eight Maturity Model URL and the verbatim
-- 12-month / 45-day timeframes these two windows transcribe)
--
-- ── WHY THE FOLD LIVES IN THE HELPERS ─────────────────────────────────────────
-- Every admin predicate already routes through private.member_ranks() or
-- private.rpc_admin_org_ids() (tools/tenancy.json's closed form set — the gate refuses
-- any other shape), so folding the lifecycle THERE means every rank floor in every
-- policy — orgs, memberships, invitations, org_quota, every future table — consults
-- the expiry at once, and an expired elevation STOPS SATISFYING the predicate rather
-- than being merely marked expired somewhere nothing reads. This is exactly the
-- discharge shape the register rows demanded, and it is why check-tenancy.mjs's
-- 0.11.0 resolveFunction fold (last definition wins) had to ship first: a gate that
-- judged the FIRST definition of member_ranks() would have been blind to this file.
--
-- ── WHY existing rows are seeded revalidated_at = now() ───────────────────────
-- The column arrives NOT NULL DEFAULT now(): on an existing install every seat is
-- treated as revalidated at the moment this migration lands. The alternative — a
-- backdated default — would instantly demote every admin on the upgrade that
-- delivered the control, which is the ambush shape the harness's own ramp doctrine
-- exists to refuse. The clock starts honest: from this migration on, the 12-month
-- window is real and its lapse is enforced.
-- SOURCE: PostgreSQL row security — FORCE applies row security to the table owner as
-- well [corpus: postgres/rls-force]

SET lock_timeout = '3s';

-- Ownership transfers below need role membership AND schema CREATE for the new
-- owner, exactly as in the tenancy spine; every elevated grant is handed back at
-- the END of this migration.
GRANT app_tenancy_rpc TO postgres;
GRANT app_tenancy_reader TO postgres;
GRANT USAGE, CREATE ON SCHEMA public TO app_tenancy_rpc;
GRANT USAGE, CREATE ON SCHEMA private TO app_tenancy_reader;

-- ─────────────────────────────────────────────────────────────────────────────
-- The seat lifecycle column
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.memberships
  ADD COLUMN revalidated_at timestamptz NOT NULL DEFAULT now();

-- ─────────────────────────────────────────────────────────────────────────────
-- The elevation table — one live elevation per privileged seat
-- ─────────────────────────────────────────────────────────────────────────────
-- The tenant key carries exactly ONE foreign key — the org reference the tenant
-- rule demands — and there is deliberately NO composite FK onto the seat: a
-- second referential story on the same column would make the tenant key's
-- ON DELETE behaviour ambiguous to every reader, human and gate alike. The
-- seat-coupling invariant (an elevation cannot outlive the seat it elevates)
-- holds procedurally instead, and the closure is short because seat deletion has
-- exactly three paths: the user cascade (user_id FK below), the org cascade
-- (org_id FK below), and remove_member() — which this migration re-declares to
-- delete the elevation in the same statement. Demotion below 30 is the fourth
-- way a seat stops being privileged, and set_member_role() handles it the same
-- way. There is no direct client path: authenticated holds deny-all writes on
-- both tables.
CREATE TABLE public.admin_elevations (
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  -- RAP-03's subject: the last moment this seat ACTED privileged. elevate() stamps
  -- it on every mint and re-mint, and the 45-day inactivity judgement reads it.
  last_privileged_at timestamptz NOT NULL DEFAULT now(),
  -- The JIT bound. One hour, session-shaped — see the header for whose number this
  -- is and is not. The helpers consult this column directly, so expiry needs no
  -- sweeper: an expired row simply stops satisfying the predicate.
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '1 hour'),
  -- Which login minted it — informational for the audit trail, never a predicate:
  -- a session id is client-presented state, and authorization here is table-anchored.
  session_id uuid,
  PRIMARY KEY (user_id, org_id)
);

-- The rank lookups join elevations by (user_id, org_id) — the PK serves them, with
-- user_id leading for the self-row policies, same reasoning as the seat table's PK.
-- Per-org administrative reads lead on org_id:
CREATE INDEX admin_elevations_org_id_idx ON public.admin_elevations (org_id);

-- Freeze twins. freeze_org_id is the tenant-key freeze every org-scoped table
-- carries (tools/check-tenancy.mjs demands this exact function); the identity freeze
-- is the same guard the seat table uses, because an elevation whose user_id could be
-- UPDATEd would walk one seat's privilege onto another user.
CREATE TRIGGER admin_elevations_freeze
  BEFORE UPDATE ON public.admin_elevations
  FOR EACH ROW EXECUTE FUNCTION private.freeze_org_id();

CREATE TRIGGER admin_elevations_freeze_identity
  BEFORE UPDATE ON public.admin_elevations
  FOR EACH ROW EXECUTE FUNCTION private.freeze_membership_identity();

-- Org-scoped, therefore audited — metadata only, no WHEN, like every table in the
-- trail. Elevating and expiring IS the story an assessor asks the trail for.
CREATE TRIGGER admin_elevations_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.admin_elevations
  FOR EACH ROW EXECUTE FUNCTION audit.write_row('org_id', 'user_id');

-- ── Row security ─────────────────────────────────────────────────────────────
-- SOURCE: PostgreSQL row security — FORCE applies row security to the table owner as well [corpus: postgres/rls-force]
ALTER TABLE public.admin_elevations ENABLE ROW LEVEL SECURITY;
-- SOURCE: PostgreSQL row security — FORCE applies row security to the table owner as well [corpus: postgres/rls-force]
ALTER TABLE public.admin_elevations FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.admin_elevations FROM anon, service_role;

-- authenticated READS its own elevations (the UI shows "elevated until …");
-- it writes nothing — minting goes through elevate(), running as app_tenancy_rpc.
GRANT SELECT ON TABLE public.admin_elevations TO authenticated;
-- The reader role is the definer chain's terminal reader here exactly as on the
-- seat table: rpc_admin_org_ids() now consults elevations, and its reads are judged
-- against app_tenancy_reader's helper-free self-only policy.
GRANT SELECT ON TABLE public.admin_elevations TO app_tenancy_reader;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_elevations TO app_tenancy_rpc;

-- Self-only and HELPER-FREE for the human role — the recursion terminator, same
-- doctrine as memberships_select_self: member_ranks() now reads THIS table too, so
-- a policy here that called a rank helper would be re-entered by it.
-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE POLICY admin_elevations_select_self ON public.admin_elevations
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Deny-all writes to the human role: a self-keyed INSERT policy here would be
-- self-service elevation — any member minting their own admin hour.
-- SOURCE: PostgreSQL row security — USING restricts which rows the role may reach [corpus: postgres/rls-force]
CREATE POLICY admin_elevations_insert_none ON public.admin_elevations
  AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (false);
-- SOURCE: PostgreSQL row security — USING restricts which rows the role may reach [corpus: postgres/rls-force]
CREATE POLICY admin_elevations_update_none ON public.admin_elevations
  AS PERMISSIVE FOR UPDATE TO authenticated USING (false);
-- SOURCE: PostgreSQL row security — USING restricts which rows the role may reach [corpus: postgres/rls-force]
CREATE POLICY admin_elevations_delete_none ON public.admin_elevations
  AS PERMISSIVE FOR DELETE TO authenticated USING (false);

-- The terminal node for the definer chain, exactly like memberships_select_reader:
-- self-only, helper-free, so rpc_admin_org_ids()'s read of this table terminates.
-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE POLICY admin_elevations_select_reader ON public.admin_elevations
  AS PERMISSIVE FOR SELECT TO app_tenancy_reader
  USING (user_id = (SELECT auth.uid()));

-- Two arms, mirroring memberships_select_rpc and for the same mechanical reason:
-- PostgreSQL AND-s SELECT policies onto UPDATE/DELETE WHERE clauses, and
-- set_member_role's demote path DELETEs the TARGET's elevation — a self-only read
-- would make that delete match zero rows and report success.
-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE POLICY admin_elevations_select_rpc ON public.admin_elevations
  AS PERMISSIVE FOR SELECT TO app_tenancy_rpc
  USING (
    user_id = (SELECT auth.uid())
    OR org_id = ANY((SELECT private.rpc_admin_org_ids())::uuid[])
  );

-- elevate() mints only the CALLER'S OWN elevation; there is no path that elevates
-- somebody else, which is what makes elevation an act rather than a grant.
-- SOURCE: PostgreSQL row security — WITH CHECK validates the new row [corpus: postgres/rls-force]
CREATE POLICY admin_elevations_insert_rpc ON public.admin_elevations
  AS PERMISSIVE FOR INSERT TO app_tenancy_rpc
  WITH CHECK (user_id = (SELECT auth.uid()));

-- The re-mint (elevate()'s ON CONFLICT arm) touches only the caller's own row.
-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE POLICY admin_elevations_update_rpc ON public.admin_elevations
  AS PERMISSIVE FOR UPDATE TO app_tenancy_rpc
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- Self-revocation, plus the demote path: an elevated admin demoting a seat below 30
-- deletes its now-meaningless elevation in the same RPC.
-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE POLICY admin_elevations_delete_rpc ON public.admin_elevations
  AS PERMISSIVE FOR DELETE TO app_tenancy_rpc
  USING (
    user_id = (SELECT auth.uid())
    OR org_id = ANY((SELECT private.rpc_admin_org_ids())::uuid[])
  );

-- THE PAIRING RULE, extended to the two roles that evaluate rank-floored policies
-- OUTSIDE the tenancy spine. The audit read floor (audit.events SELECT TO
-- app_audit_reader) and the quota policies (TO app_quota_writer) call
-- private.member_ranks(), which is SECURITY INVOKER and now reads THIS table too —
-- as those roles. Without the grant the read raises 42501 and every audit read
-- dies; without the self-only policy it returns an empty map and every rank
-- comparison is silently false — the two failure shapes the tenancy spine's
-- header documents, one table over. Self-only and helper-free, like every other
-- read of this table: the terminal-node discipline is what keeps the fold
-- recursion-safe for every role at once.
-- SOURCE: PostgreSQL row security — a SECURITY DEFINER function's reads are judged
-- against the OWNER's policies [corpus: postgres/rls-force]
GRANT SELECT ON TABLE public.admin_elevations TO app_audit_reader, app_quota_writer;

-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE POLICY admin_elevations_select_audit_reader ON public.admin_elevations
  AS PERMISSIVE FOR SELECT TO app_audit_reader
  USING (user_id = (SELECT auth.uid()));

-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE POLICY admin_elevations_select_quota_writer ON public.admin_elevations
  AS PERMISSIVE FOR SELECT TO app_quota_writer
  USING (user_id = (SELECT auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────────
-- The effective-rank fold — the discharge itself
-- ─────────────────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE, judged by check-tenancy.mjs's last-definition-wins fold. The
-- CASE folds the lifecycle INTO the rank map every rank-floor predicate reads:
-- a privileged rank is reported only while the seat is revalidated (12 months,
-- RAP-02) AND currently elevated (RAP-13); otherwise the seat reads as LEAST(rank,
-- 20) — a member. SECURITY INVOKER is unchanged and is the safety property: the
-- elevation read happens under admin_elevations' own self-only policies, so the
-- helper can only ever consult the caller's own elevation.
-- SOURCE: RLS performance — the initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE OR REPLACE FUNCTION private.member_ranks()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT coalesce(pg_catalog.jsonb_object_agg(
    m.org_id::text,
    CASE
      WHEN m.role_rank >= 30
       AND m.revalidated_at > pg_catalog.now() - interval '12 months'
       AND EXISTS (
             SELECT 1 FROM public.admin_elevations e
              WHERE e.user_id = m.user_id
                AND e.org_id = m.org_id
                AND e.expires_at > pg_catalog.now()
           )
      THEN m.role_rank
      -- LEAST is a SQL conditional expression, not a resolvable function name —
      -- it needs (and permits) no pg_catalog qualification under the empty path.
      ELSE least(m.role_rank, 20::smallint)
    END
  ), '{}'::jsonb)
    FROM public.memberships m
   WHERE m.user_id = (SELECT private.caller_id());
$$;

-- The cycle-breaker gets the SAME fold, or the two disagree about who is an admin:
-- memberships_select_rpc's admin arm (what seats a definer call can SEE) and every
-- rank-floor predicate (what it may CHANGE) must consult one lifecycle. Owner and
-- role chain are unchanged — the reads of BOTH tables terminate at
-- app_tenancy_reader's helper-free self-only policies.
-- SOURCE: PostgreSQL row security — a SECURITY DEFINER function's reads are judged
-- against the OWNER's policies, which is what makes the chain terminate
-- [corpus: postgres/rls-force]
CREATE OR REPLACE FUNCTION private.rpc_admin_org_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(pg_catalog.array_agg(m.org_id), ARRAY[]::uuid[])
    FROM public.memberships m
   WHERE m.user_id = (SELECT private.caller_id())
     AND m.role_rank >= 30
     AND m.revalidated_at > pg_catalog.now() - interval '12 months'
     AND EXISTS (
           SELECT 1 FROM public.admin_elevations e
            WHERE e.user_id = m.user_id
              AND e.org_id = m.org_id
              AND e.expires_at > pg_catalog.now()
         );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The session claim, for the audit column
-- ─────────────────────────────────────────────────────────────────────────────
-- Both GUC spellings, like caller_id() and caller_aal(), and for the same reason.
-- NULL in a direct psql or migration session — the column is nullable because the
-- claim is informational, never a predicate.
-- SOURCE: transaction-local GUCs — identity travels in request.jwt.claims, which is
-- role-switch-independent [corpus: postgres/guc-set-local]
CREATE FUNCTION private.caller_session()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  -- SOURCE: transaction-local GUCs — request.jwt.claims, plus the legacy per-claim GUC PostgREST still sets [corpus: postgres/guc-set-local]
  SELECT coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.session_id', true), ''),
    (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id')
  )::uuid
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The narrow deadlock-breaker policy — and the narrowing that makes it safe
-- ─────────────────────────────────────────────────────────────────────────────
-- PERMISSIVE POLICIES OR PER CLAUSE, ACROSS THE SET. An UPDATE's OLD row may pass
-- the USING of one permissive policy while its NEW row passes the WITH CHECK of a
-- DIFFERENT one — the two clauses are evaluated against the whole permissive set
-- independently. Found live by this migration's own suite: with the owner-self
-- policy below added naively, an owner's self-demotion passed USING through it
-- (self, rank 40) and WITH CHECK through the spine's admin policy (new rank 20 is
-- strictly below the caller's 40) — and the last-owner rule, which the spine makes
-- STRUCTURAL, evaporated in the cross-product. So the admin policy is re-declared
-- OTHERS-ONLY on both clauses first. That costs nothing real: no self write was
-- ever admissible through it, because your own rank is never strictly below itself.
-- adr: docs/adr/20260815-privilege-lifecycle-jit.md
-- SOURCE: PostgreSQL row security — permissive policies are combined with OR
-- [corpus: postgres/rls-force]
DROP POLICY memberships_update_rpc ON public.memberships;
CREATE POLICY memberships_update_rpc ON public.memberships
  AS PERMISSIVE FOR UPDATE TO app_tenancy_rpc
  USING (
    user_id <> (SELECT auth.uid())
    AND coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 30
    AND role_rank < coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0)
  )
  WITH CHECK (
    user_id <> (SELECT auth.uid())
    AND coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 30
    AND role_rank < coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0)
  );

-- Without this row the lifecycle can wedge shut: a rank-40 seat whose 12-month
-- window lapsed has effective rank 20, so it satisfies no admin predicate, so it can
-- neither elevate nor be revalidated by anyone — rank 40 is below nobody, and there
-- is no rank above owner (the same structural fact behind the last-owner rule). The
-- escape is the NARROWEST predicate that can exist here: the rpc role may update the
-- caller's OWN rank-40 row, nothing else. elevate() is its only caller and gates the
-- act on aal2 (private.mfa_satisfied()), so a lapsed owner re-enters the lifecycle
-- by proving a second factor — a deliberate act with an audit row, not a bypass.
-- role_rank = 40 in WITH CHECK also pins what the row may BECOME: the one writer
-- this policy admits cannot demote or promote through it.
-- SOURCE: PostgreSQL row security — WITH CHECK validates the new row [corpus: postgres/rls-force]
CREATE POLICY memberships_update_owner_self ON public.memberships
  AS PERMISSIVE FOR UPDATE TO app_tenancy_rpc
  USING (user_id = (SELECT auth.uid()) AND role_rank = 40)
  WITH CHECK (user_id = (SELECT auth.uid()) AND role_rank = 40);

-- ─────────────────────────────────────────────────────────────────────────────
-- The RPCs
-- ─────────────────────────────────────────────────────────────────────────────

-- The JIT door. Reads the RAW seat (this function MINTS what the effective helpers
-- consult, so it cannot itself consult them), applies both ASD windows at the
-- threshold, and mints or refreshes a one-hour elevation. Returns the expiry so the
-- UI can show "elevated until …".
CREATE FUNCTION public.elevate(p_org_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid := (SELECT private.caller_id());
  v_raw_rank smallint;
  v_revalidated_at timestamptz;
  v_last_active timestamptz;
  v_expires timestamptz;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT m.role_rank, m.revalidated_at INTO v_raw_rank, v_revalidated_at
    FROM public.memberships m
   WHERE m.user_id = v_caller AND m.org_id = p_org_id;
  IF v_raw_rank IS NULL OR v_raw_rank < 30 THEN
    RAISE EXCEPTION 'no privileged seat in this org' USING ERRCODE = '42501';
  END IF;

  -- The seat's last privileged ACTIVITY: the elevation trail's stamp when one
  -- exists, else the seat's own revalidation. Both windows are judged at this one
  -- threshold, because both have the same remedy.
  -- GREATEST, like LEAST above, is SQL syntax rather than a catalog function.
  SELECT greatest(
           coalesce((SELECT e.last_privileged_at
                       FROM public.admin_elevations e
                      WHERE e.user_id = v_caller AND e.org_id = p_org_id),
                    v_revalidated_at),
           v_revalidated_at)
    INTO v_last_active;

  -- RAP-02: revalidated within 12 months. RAP-03: active within 45 days. ASD's
  -- verbatim numbers — see the header for why no others may appear here.
  IF v_revalidated_at <= pg_catalog.now() - interval '12 months'
     OR v_last_active < pg_catalog.now() - interval '45 days' THEN
    IF v_raw_rank >= 40 THEN
      -- The deadlock-breaker: there is no rank above owner to revalidate an owner,
      -- so a lapsed rank-40 seat revalidates ITSELF — gated on a verified second
      -- factor, through the one narrow policy that admits exactly this write.
      IF NOT (SELECT private.mfa_satisfied()) THEN
        RAISE EXCEPTION 'this seat has lapsed (12-month revalidation / 45-day activity); revalidating an owner seat requires a verified second factor (aal2) — complete an MFA challenge and retry'
          USING ERRCODE = '42501';
      END IF;
      UPDATE public.memberships SET revalidated_at = pg_catalog.now()
       WHERE user_id = v_caller AND org_id = p_org_id AND role_rank = 40;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'could not revalidate the owner seat' USING ERRCODE = '42501';
      END IF;
    ELSE
      RAISE EXCEPTION 'this seat has lapsed (12-month revalidation / 45-day activity) — ask an owner to run revalidate_member for you'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO public.admin_elevations (user_id, org_id, session_id)
  VALUES (v_caller, p_org_id, (SELECT private.caller_session()))
  ON CONFLICT (user_id, org_id) DO UPDATE
    SET expires_at = pg_catalog.now() + interval '1 hour',
        last_privileged_at = pg_catalog.now(),
        session_id = excluded.session_id
  RETURNING expires_at INTO v_expires;
  RETURN v_expires;
END;
$$;

-- The human half of RAP-02: an elevated owner re-affirms that a colleague's
-- privileged seat is still warranted. Rides memberships_update_rpc (effective rank
-- >= 30, target strictly below the caller), so the caller must themselves be
-- ELEVATED — revalidating someone is an administrative act and takes the same door
-- as every other one.
CREATE FUNCTION public.revalidate_member(p_org_id uuid, p_target_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.memberships SET revalidated_at = pg_catalog.now()
   WHERE org_id = p_org_id AND user_id = p_target_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such member, or that seat is not yours to revalidate'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

-- set_member_role gains the lifecycle's two side-effects, same signature and
-- discipline: a rank CHANGE is itself a human privilege decision, so it re-stamps
-- revalidated_at; and a demotion below 30 deletes the target's elevation — a seat
-- that is no longer privileged has nothing to be elevated about, and leaving the
-- row would re-arm the moment someone re-promotes them without a fresh elevate().
CREATE OR REPLACE FUNCTION public.set_member_role(p_org_id uuid, p_target_user_id uuid, p_role_rank smallint)
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
  UPDATE public.memberships
     SET role_rank = p_role_rank,
         revalidated_at = pg_catalog.now()
   WHERE org_id = p_org_id AND user_id = p_target_user_id;
  -- The policy is the enforcement; this turns a policy MISS into a loud error rather
  -- than a zero-row success (see the tenancy spine's header for the defect class).
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such member, or that seat is not yours to change'
      USING ERRCODE = '42501';
  END IF;
  IF p_role_rank < 30 THEN
    DELETE FROM public.admin_elevations
     WHERE org_id = p_org_id AND user_id = p_target_user_id;
  END IF;
END;
$$;

-- remove_member gains the elevation cleanup — the RPC half of the seat-coupling
-- invariant stated on the table: with no composite FK, this is the one seat-delete
-- path the user/org cascades do not cover. ORDER MATTERS and is the authorization:
-- the SEAT delete is the policy-checked act, so the elevation goes only after it
-- SUCCEEDS. Deleting the elevation first would let a rank-30 admin revoke the
-- OWNER's elevation on the way to a refusal — a denial-of-privilege the seat
-- policies were never asked about.
CREATE OR REPLACE FUNCTION public.remove_member(p_org_id uuid, p_target_user_id uuid)
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
  DELETE FROM public.admin_elevations
   WHERE org_id = p_org_id AND user_id = p_target_user_id;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Ownership and EXECUTE — the same explicit REVOKE discipline as the spine
-- ─────────────────────────────────────────────────────────────────────────────
ALTER FUNCTION public.elevate(uuid) OWNER TO app_tenancy_rpc;
ALTER FUNCTION public.revalidate_member(uuid, uuid) OWNER TO app_tenancy_rpc;

REVOKE ALL ON FUNCTION public.elevate(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revalidate_member(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.caller_session() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.elevate(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revalidate_member(uuid, uuid) TO authenticated;
-- Called only from inside elevate() (as app_tenancy_rpc); the helpers stay reachable
-- to the policy-evaluating roles exactly as before.
GRANT EXECUTE ON FUNCTION private.caller_session() TO app_tenancy_rpc;
-- elevate()'s self-revalidation branch consults the MFA rail FROM INSIDE a definer
-- running as app_tenancy_rpc, so that role needs EXECUTE on the whole predicate
-- chain (mfa_satisfied is INVOKER and calls the other two as the executing role).
-- The 20260812 migration granted them to `authenticated` only, which was every
-- caller that existed then.
GRANT EXECUTE ON FUNCTION private.mfa_satisfied() TO app_tenancy_rpc;
GRANT EXECUTE ON FUNCTION private.caller_aal() TO app_tenancy_rpc;
GRANT EXECUTE ON FUNCTION private.mfa_is_required() TO app_tenancy_rpc;

-- Hand back the elevated grants used for the ownership transfers, exactly as the
-- spine does and for the same reason.
REVOKE CREATE ON SCHEMA public FROM app_tenancy_rpc;
REVOKE CREATE ON SCHEMA private FROM app_tenancy_reader;
REVOKE app_tenancy_rpc FROM postgres;
REVOKE app_tenancy_reader FROM postgres;
