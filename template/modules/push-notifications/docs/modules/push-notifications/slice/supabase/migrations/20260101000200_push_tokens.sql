-- 20260101000200_push_tokens — the device push-token store (push-notifications module).
--
-- APPLIED HISTORY, NOT DESIRED STATE. The desired state and the full reasoning
-- live in supabase/schemas/30_push_tokens.sql. Append-only and DML-free for the
-- reasons stated at the top of 20260101000000_account_spine.sql: `supabase db
-- push` records a migration by FILENAME, so editing an applied file changes
-- nothing on a database that already ran it — correct the schema with a NEW
-- migration, never a retroactive edit.
--
-- One row per (owner, device push token). The DAL always supplies a
-- DETERMINISTIC version-5 UUID of (owner_id, token) as the primary key, which is
-- the upsert arbiter that makes registerToken() idempotent and race-free WITHOUT
-- a (owner_id, token) unique index. The id DEFAULT stays gen_random_uuid() so
-- the pgTAP isolation inserts (and any ad-hoc insert) that omit the column still
-- get a key. See the module README's honest limits.
CREATE TABLE public.push_device_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- DEFAULT auth.uid() is a convenience for callers that omit the column; it is
  -- NOT the control. A caller that sends someone else's id is rejected by the
  -- WITH CHECK below either way. ON DELETE CASCADE makes account deletion a
  -- single statement against auth.users rather than a hand-maintained sweep.
  owner_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
  token text NOT NULL,
  platform text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Bounds, not validation — the zod DTO in @app/contracts (PUSH_TOKEN_MAX,
  -- PUSH_PLATFORMS) is the input contract. These hold for callers that reach the
  -- table by another path: the DB is an enforcement surface, not a hope.
  CONSTRAINT push_device_tokens_token_length CHECK (char_length(token) BETWEEN 1 AND 512),
  CONSTRAINT push_device_tokens_platform_check CHECK (platform IN ('android', 'ios'))
);

-- The upsert's DO UPDATE path fires this BEFORE UPDATE trigger, so a
-- re-registration bumps updated_at in the database rather than in each caller —
-- the same discipline the notes table uses, and how a future lifecycle sweep can
-- see which tokens still re-register.
CREATE TRIGGER push_device_tokens_set_updated_at
  BEFORE UPDATE ON public.push_device_tokens
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- owner_id LEADING. Every policy on this table filters by owner_id on every
-- statement, so this index is what turns the policy qual into an Index Cond. An
-- index with owner_id in second position does not serve `owner_id = $1`: the
-- policy degrades to a sequential scan, which a two-row test database can never
-- reveal and a production table always does.
-- The (created_at DESC, id DESC) tail is the list query's keyset order, so one
-- index serves both jobs; id breaks ties because a keyset cursor over a
-- non-unique key skips or repeats rows at page boundaries.
CREATE INDEX push_device_tokens_owner_id_created_at_id_idx
  ON public.push_device_tokens (owner_id, created_at DESC, id DESC);

-- FORCE subjects the table owner (`postgres`, the role running this migration)
-- to the policies. A BYPASSRLS role still bypasses — the REVOKE below is the
-- only lever over service_role.
-- SOURCE: PostgreSQL row security — FORCE applies row security to the table
-- owner as well [corpus: postgres/rls-force]
ALTER TABLE public.push_device_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_device_tokens FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.push_device_tokens FROM anon;
REVOKE ALL ON TABLE public.push_device_tokens FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.push_device_tokens TO authenticated;

-- Four per-operation policies, TO authenticated, each predicate real and each
-- identity call wrapped in a scalar sub-select (InitPlan: once per statement,
-- not once per row).
-- SOURCE: RLS performance — the initPlan sub-select pattern
-- [corpus: postgres/rls-initplan]
CREATE POLICY push_device_tokens_select_own ON public.push_device_tokens
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (owner_id = (SELECT auth.uid()));

-- registerToken() is an upsert (INSERT ... ON CONFLICT DO UPDATE): this WITH
-- CHECK screens the proposed row so a client cannot INSERT under another user's
-- owner_id, and the DO UPDATE path additionally re-checks the UPDATE policy
-- below against the conflicting row.
-- SOURCE: PostgreSQL row security — WITH CHECK validates the new row; ON CONFLICT
-- DO UPDATE also checks the UPDATE policies on the conflicting row
-- [corpus: postgres/rls-force]
CREATE POLICY push_device_tokens_insert_own ON public.push_device_tokens
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (owner_id = (SELECT auth.uid()));

-- UPDATE evaluates USING (rows visible to change) then WITH CHECK (result stays
-- owned), so the conflict-update path of the upsert cannot hand the row to
-- another owner.
-- SOURCE: PostgreSQL row security — UPDATE evaluates USING then WITH CHECK
-- [corpus: postgres/rls-force]
CREATE POLICY push_device_tokens_update_own ON public.push_device_tokens
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));

-- Also the account-deletion guard: an unqualified DELETE issued by a signed-in
-- user removes exactly that user's tokens, because this qual is the only WHERE
-- clause the statement has.
-- SOURCE: PostgreSQL row security — DELETE USING restricts which rows the role
-- may remove [corpus: postgres/rls-force]
CREATE POLICY push_device_tokens_delete_own ON public.push_device_tokens
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (owner_id = (SELECT auth.uid()));
