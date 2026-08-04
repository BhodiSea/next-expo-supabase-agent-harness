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

## The RLS skeleton (per ORG-scoped table, all in the SAME migration)

**The tenant key is `org_id`, not `owner_id`.** This scaffold is B2B: the data controller is
the organization, and `owner_id` is nullable ATTRIBUTION that decides nothing. A table keyed
on the user instead is not merely a different choice — it is a regression no test can catch,
because per-user isolation is strictly TIGHTER than per-org: every cross-tenant assertion
passes while the colleagues who are supposed to share the row cannot see it. The `tenancy`
gate reds a new table that carries no `org_id` (escape: a reasoned `untenantedTables` entry
in `tools/tenancy.json`, as `profiles` has).

**Only two predicate shapes are legal**, both uncorrelated zero-argument scalar sub-selects
the planner hoists into ONE InitPlan per statement:

```sql
-- scope
org_id = ANY((SELECT private.member_org_ids())::uuid[])
-- rank floor
coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 20
```

The `::uuid[]` cast is **not cosmetic**. `ANY` followed by a parenthesized SELECT binds to the
grammar's subquery form, so `ANY((SELECT private.member_org_ids()))` compares `uuid = uuid[]`
and the `CREATE POLICY` fails outright — the cast is what makes it the ARRAY form. The
alternative `ANY(SELECT unnest(private.member_org_ids()))` parses but plans as a hashed
SubPlan over a Seq Scan; only the cast form yields an InitPlan **and** an Index Cond.

`(SELECT private.member_rank(org_id)) >= 20` looks almost identical and is **banned**:
passing a column of the row under test makes it a correlated SubPlan evaluated per row, which
also re-enters the membership table's own policies. It is syntactically wrapped in `(SELECT`,
so it passes every wrapper check — `tools/check-tenancy.mjs` inverts the rule and reds it.
Ranks are `viewer 10, member 20, admin 30, owner 40`.

```sql
-- <timestamp>_<slice> — one org-owned entity. Desired state + full reasoning live in
-- supabase/schemas/<NN>_<slice>.sql. Append-only and DML-free.
CREATE TABLE public.<t> (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  -- THE TENANT KEY. NOT NULL with a declared FK, both required by the tenancy gate: a
  -- nullable org_id is invisible to everyone (`= ANY(array)` is NULL-false, including for
  -- its own author), and the first fix anyone writes for that is `OR org_id IS NULL` — a
  -- global leak.
  org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  -- ATTRIBUTION, not authorization. Nullable with ON DELETE SET NULL: an employee closing
  -- their account must not delete the company's rows. It appears in exactly one policy arm
  -- ("an author may delete their own"), always alongside a rank term.
  owner_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  -- ... slice columns. Bounds mirror the @app/contracts zod DTO (defense in depth for a
  -- caller that reaches the table by another path), never restate it looser.
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- (org_id, id): partition-ready, and it makes org_id the leading indexed column. EVERY
  -- unique on a tenant table must carry the tenant column — partitioning by tenant requires
  -- it, and a tenant-blind unique is a cross-org information channel, because an insert
  -- failure discloses another org's value. Escape: a reasoned `uniqueWithoutTenantColumn`
  -- entry in tools/tenancy.json.
  PRIMARY KEY (org_id, id)
);

-- A row may not change tenant. Without this every scope predicate above is advisory: an
-- UPDATE that passes its policy could rewrite org_id and walk the row into another org. No
-- WHEN clause — a freeze that can be conditioned away is not a freeze.
CREATE TRIGGER <t>_freeze_org
  BEFORE UPDATE ON public.<t>
  FOR EACH ROW EXECUTE FUNCTION private.freeze_org_id();

-- updated_at is maintained by the shared trigger (supabase/schemas/00_shared.sql), never by
-- application code — the trigger is the one place all four writers (Server Action, tRPC
-- procedure, psql, Edge Function) pass through.
CREATE TRIGGER <t>_set_updated_at
  BEFORE UPDATE ON public.<t>
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- org_id LEADING. Every policy on this table filters by org_id on every statement, so this
-- index is what turns the policy qual into an Index Cond; org_id in second position does not
-- serve `org_id = ANY($1)` and the policy degrades to a sequential scan a two-row test
-- database can never reveal. Carry the list screen's ORDER BY columns in the SAME index so
-- one index serves policy, sort and keyset range; id breaks ties (a keyset cursor over a
-- non-unique key skips or repeats rows at page boundaries).
CREATE INDEX <t>_org_id_created_at_id_idx
  ON public.<t> (org_id, created_at DESC, id DESC);

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

-- Four per-operation policies, TO authenticated, each resolving through the uncorrelated
-- zero-argument helpers so the planner hoists them into one InitPlan per statement (once per
-- statement, not once per row). Never FOR ALL — each op stays independently auditable.
-- Reading is MEMBERSHIP; writing is RANK.
-- SOURCE: RLS performance — wrap the identity call in a scalar sub-select for an initPlan
-- [corpus: postgres/rls-initplan]
CREATE POLICY <t>_select_org ON public.<t>
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (org_id = ANY((SELECT private.member_org_ids())::uuid[]));

-- SOURCE: PostgreSQL row security — WITH CHECK validates the new row, so a client cannot
-- INSERT into an org it may not write [corpus: postgres/rls-force]
CREATE POLICY <t>_insert_org ON public.<t>
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 20);

-- USING sees the OLD row and WITH CHECK the NEW one. Both carry the rank term so a member
-- cannot move a row out of reach; the freeze trigger above is what stops org_id changing
-- at all.
-- SOURCE: PostgreSQL row security — UPDATE evaluates USING then WITH CHECK [corpus: postgres/rls-force]
CREATE POLICY <t>_update_org ON public.<t>
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 20)
  WITH CHECK (coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 20);

-- Two independently-scoped arms: an admin cleaning up anything in the org, or an author
-- removing their own row. EVERY arm carries a rank term — the tenancy gate reds a top-level
-- OR whose arm omits the scope, because such a policy is as open as its weakest arm and
-- `OR owner_id = (SELECT auth.uid())` quietly restores per-user scope on top of org scope.
-- SOURCE: PostgreSQL row security — DELETE USING restricts which rows the role may remove
-- [corpus: postgres/rls-force]
CREATE POLICY <t>_delete_org ON public.<t>
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (
    coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 30
    OR (
      owner_id = (SELECT auth.uid())
      AND coalesce(((SELECT private.member_ranks()) ->> org_id::text)::smallint, 0) >= 20
    )
  );
```

**Seat tables are not authored this way.** `orgs`, `memberships` and `invitations` are the
tenancy spine itself: they are read-only to `authenticated`, every write goes through an
allowlisted `SECURITY DEFINER` RPC running as `app_tenancy_rpc`, and their policies obey
extra rules (`memberships`' SELECT policy must stay self-only, or the scope helpers that read
it are re-entered by it — and because those helpers pin `SET search_path = ''`, the planner
will not inline them, the rewriter's cycle check never sees a cycle, and you get
`54001 stack depth limit exceeded` rather than the tidy `42P17 infinite recursion detected in
policy` you would search for). Do not copy this skeleton onto them; see
`supabase/migrations/20260201000000_tenancy_spine.sql` and
`docs/adr/20260201-org-scoped-tenancy.md`.

Mirror the SAME statements in the declarative `supabase/schemas/<NN>_<slice>.sql` so the two
agree — that file carries the desired state and the fuller comments; the migration carries
the applied history. `20_notes.sql` and `20260101000100_notes.sql` are the two halves of the
worked example.

## Identity is the verified JWT, never a GUC

`auth.uid()` resolves from the caller's verified `request.jwt.claims`, set by PostgREST from
the bearer/cookie token — the caller runs as the `authenticated` role over a real GoTrue JWT.
No policy reads an application-set identity variable, and nothing in this stack sets one — no
`set_config` identity GUC, no per-connection session value; a policy that trusted one would be
trusting a value the transport, not the auth server, decided. The pgTAP suites impersonate a tenant with
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
