# Migration & RLS reference

## Where things live — two files that move together

- **Declarative source of truth:** `supabase/schemas/<NN>_<slice>.sql` — the table's DESIRED
  STATE. `<NN>` is a two-digit prefix ordering the file after its dependencies (`00_shared`,
  `10_account`, `20_notes`, …). `supabase/schemas/20_notes.sql` is the shape every later
  vertical is copied from.
- **Applied history:** `supabase/migrations/<timestamp>_<slice>.sql` — a NEW, timestamped,
  append-only file that gets the database to that state. `supabase/migrations/20260101000100_notes.sql`
  is the worked pattern.

The pair is authored together: edit the schema file, then `supabase migration new <slice>`
(or `supabase db diff -f <slice>`), READ the generated draft, re-case its DDL (see the
provenance note below), commit both in one change. Editing only one of the two is the drift
this split exists to make visible.

Two things the diff engine does not see, so you must:
- DML is never captured — that is fine, data belongs in `supabase/seed.sql`, and the
  `migrations` gate rejects DML in a migration outright.
- policy ALTERs and column privileges are documented blind spots: a policy CHANGE reads as
  drop+create in the draft and a RENAME may read as nothing at all.

## Append-only, write-once

`supabase/migrations/*` is APPLIED history. `supabase db push` records a migration by
filename, so a retroactive edit yields a database that no longer matches its own history and
no diff can tell you. Compose the COMPLETE migration first and write it exactly once as a new
timestamped file; correct a mistake with a FURTHER new migration. That is why
`scaffold-slice.mjs` refuses to pre-create it.

## Keyword case is load-bearing

`supabase db diff` emits lowercase DDL, and the provenance heuristic
(`tools/lib/provenance-rules.mjs`) matches `CREATE POLICY` and `FORCE ROW LEVEL SECURITY`
case-SENSITIVELY — lowercase RLS statements are invisible to it, so the citation duty
silently lapses for that table. Re-case the RLS statements to UPPERCASE when you review the
draft.

## The RLS skeleton (per user-scoped table, all in the SAME migration)

```sql
-- <timestamp>_<slice> — one owned entity. Desired state + full reasoning live in
-- supabase/schemas/<NN>_<slice>.sql. Append-only and DML-free.
CREATE TABLE public.<t> (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- owner_id references auth.users DIRECTLY, not public.profiles: routing the FK via the
  -- profile spine makes the first write after signup fail until some other path created a
  -- profile row. DEFAULT auth.uid() is a convenience for a caller that omits the column; it
  -- is NOT the control — a caller that SENDS someone else's id is still rejected by the
  -- WITH CHECK below.
  owner_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
  -- ... slice columns. Bounds mirror the @app/contracts zod DTO (defense in depth for a
  -- caller that reaches the table by another path), never restate it looser.
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- updated_at is maintained by the shared trigger (supabase/schemas/00_shared.sql), never by
-- application code — the trigger is the one place all four writers (Server Action, tRPC
-- procedure, psql, Edge Function) pass through.
CREATE TRIGGER <t>_set_updated_at
  BEFORE UPDATE ON public.<t>
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- owner_id LEADING. Every policy on this table filters by owner_id on every statement, so
-- this index is what turns the policy qual into an Index Cond; owner_id in second position
-- does not serve `owner_id = $1` and the policy degrades to a sequential scan a two-row test
-- database can never reveal. Carry the list screen's ORDER BY columns in the SAME index so
-- one index serves policy, sort and keyset range; id breaks ties (a keyset cursor over a
-- non-unique key skips or repeats rows at page boundaries).
CREATE INDEX <t>_owner_id_created_at_id_idx
  ON public.<t> (owner_id, created_at DESC, id DESC);

-- FORCE subjects the table OWNER (`postgres`, the role running this migration) to the
-- policies too — without it the migration/seed/SQL-editor role reads and writes every row
-- and no test notices. A BYPASSRLS role (`service_role`) still bypasses; the REVOKE below is
-- the only lever over it.
-- SOURCE: PostgreSQL row security — FORCE applies row security to the table owner as well
-- [corpus: postgres/rls-force]
ALTER TABLE public.<t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.<t> FORCE ROW LEVEL SECURITY;

-- Grants are the outer gate. anon has no business here; service_role's grant is revoked
-- because BYPASSRLS makes the grant the only lever over it (see supabase/functions/README.md).
REVOKE ALL ON TABLE public.<t> FROM anon;
REVOKE ALL ON TABLE public.<t> FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.<t> TO authenticated;

-- Four per-operation policies, TO authenticated, each identity call wrapped in a scalar
-- sub-select so the planner hoists it into an InitPlan (once per statement, not once per
-- row). Never FOR ALL — each op stays independently auditable.
-- SOURCE: RLS performance — wrap the identity call in a scalar sub-select for an initPlan
-- [corpus: postgres/rls-initplan]
CREATE POLICY <t>_select_own ON public.<t>
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (owner_id = (SELECT auth.uid()));

-- SOURCE: PostgreSQL row security — WITH CHECK validates the new row, so a client cannot
-- INSERT under another user's owner_id [corpus: postgres/rls-force]
CREATE POLICY <t>_insert_own ON public.<t>
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (owner_id = (SELECT auth.uid()));

-- USING alone would let an owner rewrite owner_id and hand the row away; WITH CHECK keeps the
-- result owned by the same user.
-- SOURCE: PostgreSQL row security — UPDATE evaluates USING then WITH CHECK [corpus: postgres/rls-force]
CREATE POLICY <t>_update_own ON public.<t>
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));

-- Also the account-deletion guard: an unqualified DELETE by a signed-in user removes exactly
-- that user's rows, because this qual is the only WHERE clause the statement has.
-- SOURCE: PostgreSQL row security — DELETE USING restricts which rows the role may remove
-- [corpus: postgres/rls-force]
CREATE POLICY <t>_delete_own ON public.<t>
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (owner_id = (SELECT auth.uid()));
```

Mirror the SAME statements in the declarative `supabase/schemas/<NN>_<slice>.sql` so the two
agree — that file carries the desired state and the fuller comments; the migration carries
the applied history. `20_notes.sql` and `20260101000100_notes.sql` are the two halves of the
worked example.

## Identity is the verified JWT, never a GUC

`auth.uid()` resolves from the caller's verified `request.jwt.claims`, set by PostgREST from
the bearer/cookie token — the caller runs as the `authenticated` role over a real GoTrue JWT.
There is NO `set_config('app.user_id', …)`, no `SET LOCAL app.user_id`, and no per-connection
identity GUC anywhere in this stack; a policy that read one would be trusting a value the
transport, not the auth server, decided. The pgTAP suites impersonate a tenant with
`SET LOCAL "request.jwt.claims"` + `SET LOCAL ROLE authenticated` precisely because that is
the shape a real request arrives with.

## Gates that check this layer

- `schema-rls` (`tools/check-rls-manifest.mjs`): every user-scoped table must be covered by
  `ENABLE` + `FORCE` + four per-op policies, a leading-column owner index, and initPlan-shaped
  predicates, OR exempted in the write-guard-protected `tools/rls-exempt.json` (a human
  decision — never edit it). It closes over `ISOLATION_TARGETS` in `tests/rls/db-context.ts`
  and holds it in sync with `rls_targets` in `supabase/tests/rls_structure.test.sql`.
- `migrations`: append-only vs git; no DML without an explicit allowance; destructive DDL
  (`DROP TABLE`/`COLUMN`, `TRUNCATE`) requires an `-- adr: docs/adr/<file>` pointing at an
  existing ADR — run `/adr` BEFORE writing the migration (it cannot be edited afterwards).
- `pnpm test:rls` (`node tests/rls/run-rls.mjs`) fresh-applies the whole chain into a local
  Supabase stack and runs BOTH twins: the pgTAP structural + isolation suites
  (`supabase/tests/*.sql`) and the supabase-js client isolation suite (`tests/rls/`). It
  SKIPS LOUDLY when no local stack is up and FAILS CLOSED in CI — a skip is never a pass.

## Odds and ends

- Service-role code is confined to an ADR-governed Edge Function
  (`supabase/functions/<name>/index.ts`), which reaches a table only through a migration that
  `GRANT`s it explicitly per-table. Never `GRANT ALL ON ALL TABLES`. See
  `supabase/functions/README.md`.
- `set_updated_at()` is `SECURITY INVOKER` with `SET search_path = ''` and spells `now()` as
  `pg_catalog.now()` — a table planted in a caller-controlled schema cannot be resolved from
  inside it. Reuse it; do not reimplement per table.
