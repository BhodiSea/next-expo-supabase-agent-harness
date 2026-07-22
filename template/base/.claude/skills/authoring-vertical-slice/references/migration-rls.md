# Migration & RLS reference

## Where things live

- Drizzle schema source: `packages/schema/src/` — `pgTable(...)` declarations with
  four per-operation `pgPolicy(...)` entries and `.enableRLS()`. The runtime role is
  declared `pgRole('app_api').existing()` (roles are created by the docker-compose
  init SQL, never by migrations). Vector columns use `EMBEDDING_DIM` from
  `@app/contracts` (asserted by a schema unit test).
- Migrations: `packages/schema/drizzle/NNNN_<feature>.sql` — 4-digit index, next in
  sequence; statements separated by `--> statement-breakpoint`; registered in
  `packages/schema/drizzle/meta/_journal.json`:

  ```json
  { "idx": 1, "version": "7", "when": 1767225600000, "tag": "0001_release-notes", "breakpoints": true }
  ```

## Append-only, write-once

The write-guard denies Edit/Write on ANY existing `packages/schema/drizzle/*.sql`
(even uncommitted). Compose the COMPLETE migration first and Write it exactly once as
a new file. Mistakes are corrected by a further new migration. `drizzle-kit push` and
`drizzle-kit drop` are bash-guard-blocked; verify consistency with
`pnpm --filter @app/schema exec drizzle-kit check`.

## The RLS skeleton (per user-scoped table, all in the SAME migration)

```sql
ALTER TABLE "t" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- SOURCE: FORCE applies row security to the table owner too — no owning role can
-- silently bypass the policies. [corpus: postgres/rls-force]
ALTER TABLE "t" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- SOURCE: scalar sub-select evaluates once per statement (initPlan), not per row;
-- nullif maps both no-identity shapes (unset GUC -> NULL, post-SET-LOCAL pooled
-- session -> '') to NULL, which never equals an owner_id — no identity fails closed
-- instead of raising 22P02. [corpus: postgres/rls-initplan]
CREATE POLICY "t_select_own" ON "t" AS PERMISSIVE FOR SELECT TO "app_api"
  USING ("owner_id" = (select nullif(current_setting('app.user_id', true), '')::uuid));
--> statement-breakpoint
CREATE POLICY "t_insert_own" ON "t" AS PERMISSIVE FOR INSERT TO "app_api"
  WITH CHECK ("owner_id" = (select nullif(current_setting('app.user_id', true), '')::uuid));
--> statement-breakpoint
CREATE POLICY "t_update_own" ON "t" AS PERMISSIVE FOR UPDATE TO "app_api"
  USING ("owner_id" = (select nullif(current_setting('app.user_id', true), '')::uuid))
  WITH CHECK ("owner_id" = (select nullif(current_setting('app.user_id', true), '')::uuid));
--> statement-breakpoint
CREATE POLICY "t_delete_own" ON "t" AS PERMISSIVE FOR DELETE TO "app_api"
  USING ("owner_id" = (select nullif(current_setting('app.user_id', true), '')::uuid));
--> statement-breakpoint
-- SOURCE: every policy filters by the owner column on EVERY statement; without a
-- leading-column index that is a per-row sequential scan at scale. The schema-rls
-- gate and the runtime EXPLAIN plan probe both require it. [corpus: postgres/rls-initplan]
CREATE INDEX "t_owner_id_idx" ON "t" ("owner_id");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "t" TO "app_api";
```

Four per-operation policies, never `FOR ALL` — each op stays independently auditable.
Mirror the same policies in the Drizzle source (`pgPolicy`) so schema and SQL agree
(see `packages/schema/src/index.ts` and `drizzle/0000_init.sql` +
`0001_notes_owner_idx.sql` for the worked example). The owner column must be the
LEADING column of an index (second position does not serve the policy's equality
qual); index every other policy-predicate column too. When the table is
keyset-paginated, carry the ORDER BY columns in the same index — an index on
`(owner_id)` alone leaves a keyset list sorting the owner's whole partition on every
page; `0002_notes_keyset_idx.sql` is the worked pattern.

## Gates that check this layer

- `schema-rls`: every `pgTable` name must be covered by ENABLE + FORCE + per-op
  policies somewhere in the cumulative migration SQL, or exempted in the
  write-guard-protected `tools/rls-exempt.json` (a human decision — never edit it).
  It also requires initPlan-shaped predicates, ISOLATION_TARGETS wiring, and the
  leading-column owner index above.
- `pnpm test:rls` runs the EXPLAIN plan probe (`tests/rls/plan-regression.test.ts`)
  against a scratch database (`<db>_rls` — dev data is never dropped): at 10k
  seeded rows every isolation target must be reached through its owner index with
  a once-per-statement InitPlan — no Seq Scan, no per-row SubPlan.
- `migrations`: append-only vs git; no DML without `-- harness-allow-dml: <reason>`;
  destructive DDL (DROP TABLE/COLUMN, TRUNCATE) requires `-- adr: docs/adr/<file>`
  pointing at an existing ADR — run `/adr` BEFORE writing the migration (it cannot be
  edited afterwards).
- `pnpm test:rls` fresh-applies the whole chain from zero
  (`tests/migrations/migration-apply.mjs`, migrator role), then runs the isolation
  matrix — pair every user-scoped table with an `IsolationTarget` in
  `tests/rls/db-context.ts` (see `tests.md`).

## Odds and ends

- pgvector: `vector(1024)` columns match `EMBEDDING_DIM`; index with HNSW and the
  opclass matching the query operator (`vector_cosine_ops` for `<=>`).
  `[corpus: pgvector/hnsw]`
- GUC discipline everywhere: identity only via `set_config('app.user_id', $, true)`
  / `SET LOCAL` inside a transaction — session-wide GUCs leak identity across pooled
  connections. `[corpus: postgres/guc-set-local]`
- `WITH RECURSIVE` over graph data needs a `CYCLE` clause or visited guard (the
  write-guard blocks it otherwise). `[corpus: postgres/recursive-cycle]`
- `MIGRATOR_DATABASE_URL` (owner role, bypasses RLS) is confined by the bash-guard to
  drizzle-kit migrate/generate/check, `pnpm db:migrate`, and the harness RLS runners
  (`tests/migrations/`, `tests/rls/`).
