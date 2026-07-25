-- supabase/schemas/30_push_tokens.sql — the device push-token store
-- (push-notifications module), the declarative twin of
-- supabase/migrations/20260101000200_push_tokens.sql.
--
-- DECLARATIVE FILE — see 00_shared.sql for how this directory relates to
-- supabase/migrations/ and what the diff engine does not see. Edit this file,
-- run `supabase db diff -f push_tokens`, READ the draft (re-case the RLS
-- statements — `db diff` emits lowercase, and the provenance heuristic matches
-- CREATE POLICY / FORCE ROW LEVEL SECURITY case-sensitively), then commit the
-- schema file and the migration together.
--
-- This is the notes shape copied to a second entity, so every rule the harness
-- enforces is visible once more: FORCE row security, four per-operation
-- policies, no vacuous predicate, the initPlan sub-select, and an index whose
-- LEADING column is the owner column. What is entity-specific: the id carries a
-- gen_random_uuid() DEFAULT even though the DAL always supplies a DETERMINISTIC
-- version-5 UUID of (owner_id, token) — the default keeps probe/ad-hoc inserts
-- that omit the id working, and the deterministic primary key is what makes
-- registerToken() an idempotent, race-free upsert with no second unique index.
CREATE TABLE public.push_device_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- owner_id references auth.users directly, like notes. DEFAULT auth.uid() is a
  -- convenience, never the control: a client that SENDS someone else's id is
  -- still rejected by the WITH CHECK below. ON DELETE CASCADE keeps account
  -- deletion a single statement against the same root every owned table hangs
  -- off.
  owner_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
  token text NOT NULL,
  platform text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Bounds, not validation — the zod DTO in @app/contracts (PUSH_TOKEN_MAX = 512,
  -- PUSH_PLATFORMS = android|ios) is the input contract. These hold for callers
  -- that reach the table by another path, and the DAL's exit parse rejects
  -- anything the CHECK somehow let through.
  CONSTRAINT push_device_tokens_token_length CHECK (char_length(token) BETWEEN 1 AND 512),
  CONSTRAINT push_device_tokens_platform_check CHECK (platform IN ('android', 'ios'))
);

CREATE TRIGGER push_device_tokens_set_updated_at
  BEFORE UPDATE ON public.push_device_tokens
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- The owner column MUST be the leading column. Every policy on this table
-- filters by owner_id on every statement, so this index is what turns the policy
-- qual into an Index Cond; an index with owner_id in second position does not
-- serve `owner_id = $1` and the policy degrades to a sequential scan — a
-- correctness-shaped performance failure a two-row test database can never
-- reveal.
--
-- The trailing (created_at DESC, id DESC) is the sort order of the list query's
-- keyset pagination, so the same index that makes the policy cheap also serves
-- the ordered scan. id breaks ties, because created_at alone is not unique and a
-- keyset cursor over a non-unique key silently skips or repeats rows at page
-- boundaries.
CREATE INDEX push_device_tokens_owner_id_created_at_id_idx
  ON public.push_device_tokens (owner_id, created_at DESC, id DESC);

-- FORCE subjects the table OWNER to these policies as well — without it the
-- `postgres` role that runs migrations, seeds and SQL-editor sessions reads and
-- writes every row and no test notices. A BYPASSRLS role (`service_role`) still
-- bypasses; that hole is closed by the REVOKE below, not by a policy.
-- SOURCE: PostgreSQL row security — FORCE applies row security to the table
-- owner as well [corpus: postgres/rls-force]
ALTER TABLE public.push_device_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_device_tokens FORCE ROW LEVEL SECURITY;

-- Grants are the outer gate: anon has no business here, and service_role's grant
-- is revoked because BYPASSRLS makes the grant the only lever over it — an Edge
-- Function reaches this table only via a later, ADR'd migration that grants it.
REVOKE ALL ON TABLE public.push_device_tokens FROM anon;
REVOKE ALL ON TABLE public.push_device_tokens FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.push_device_tokens TO authenticated;

-- Four per-operation policies, TO authenticated, each with a real predicate and
-- the identity call wrapped in a scalar sub-select so the planner hoists it into
-- an InitPlan and runs it once per statement rather than once per candidate row.
-- SOURCE: RLS performance — wrap the identity call in a scalar sub-select for
-- an initPlan [corpus: postgres/rls-initplan]
CREATE POLICY push_device_tokens_select_own ON public.push_device_tokens
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (owner_id = (SELECT auth.uid()));

-- INSERT half of the upsert: WITH CHECK validates the NEW row, so a client
-- cannot register a token under another user's owner_id.
-- SOURCE: PostgreSQL row security — WITH CHECK validates the new row
-- [corpus: postgres/rls-force]
CREATE POLICY push_device_tokens_insert_own ON public.push_device_tokens
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (owner_id = (SELECT auth.uid()));

-- The conflict-update half of the upsert: USING alone would let an owner rewrite
-- owner_id and hand the row away; WITH CHECK keeps the result owned by the same
-- user.
-- SOURCE: PostgreSQL row security — UPDATE evaluates USING then WITH CHECK
-- [corpus: postgres/rls-force]
CREATE POLICY push_device_tokens_update_own ON public.push_device_tokens
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));

-- The delete policy is also the account-deletion guard: an unqualified
-- `DELETE FROM public.push_device_tokens` issued by a signed-in user removes
-- exactly that user's tokens. Asserted in supabase/tests/rls_push_tokens.test.sql.
-- SOURCE: PostgreSQL row security — DELETE USING restricts which rows the role
-- may remove [corpus: postgres/rls-force]
CREATE POLICY push_device_tokens_delete_own ON public.push_device_tokens
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (owner_id = (SELECT auth.uid()));
