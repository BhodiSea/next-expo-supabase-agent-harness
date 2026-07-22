// Server-side schema surface: the drizzle table + RLS policy declarations.
// The wire DTOs live in @app/contracts (pure Zod, mobile-importable); this
// module is what the DAL queries through and what migrations are generated
// from. The drift test in schema.test.ts proves the two never diverge.
import { EMBEDDING_DIM } from '@app/contracts'
import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
// SOURCE: drizzle pgPolicy/pgRole declare RLS in the schema so the schema-rls
// gate can assert every table carries policies [corpus: postgres/rls-force]
import { pgPolicy, pgRole, pgTable, real, text, timestamp, uuid, vector } from 'drizzle-orm/pg-core'

// Runtime login role the API server connects as. Roles are created by the
// docker-compose init SQL, never by migrations — hence `.existing()`.
const appApi = pgRole('app_api').existing()

// Wrap current_setting() in a scalar sub-select so the planner evaluates it once
// per statement (initPlan) instead of per row. nullif(..., '') maps both
// no-identity shapes (GUC never set -> NULL; pooled session after a SET LOCAL
// tx -> '') to NULL, which never equals an owner_id — "no identity" fails closed
// instead of raising a 22P02 uuid-cast error.
// SOURCE: PostgreSQL row-security guidance [corpus: postgres/rls-initplan]
const ownerIsCurrentUser = (ownerId: AnyPgColumn) =>
  sql`${ownerId} = (select nullif(current_setting('app.user_id', true), '')::uuid)`

/**
 * Demo domain table proving the whole RLS chain (see drizzle/0000_init.sql for
 * the ENABLE + FORCE + GRANT side). `source_model`/`source_confidence` are the
 * ai-provenance example columns. The embedding dimension comes from
 * @app/contracts (EMBEDDING_DIM) — the single source both the column and the
 * wire DTO are asserted against.
 */
export const notes = pgTable(
  'notes',
  {
    body: text('body').notNull().default(''),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull(),
    sourceConfidence: real('source_confidence'),
    sourceModel: text('source_model'),
    title: text('title').notNull(),
  },
  (table) => [
    // Four per-operation policies (never FOR ALL): each op stays independently
    // auditable and a future widening of one op cannot silently widen the rest.
    // SOURCE: per-command policies, USING filters reads [corpus: postgres/rls-force]; per-op doctrine [corpus: harness/doctrine]
    pgPolicy('notes_select_own', {
      as: 'permissive',
      for: 'select',
      to: appApi,
      using: ownerIsCurrentUser(table.ownerId),
    }),
    // SOURCE: per-op owner policy — insert guards via WITH CHECK [corpus: postgres/rls-force]
    pgPolicy('notes_insert_own', {
      as: 'permissive',
      for: 'insert',
      to: appApi,
      withCheck: ownerIsCurrentUser(table.ownerId),
    }),
    // SOURCE: per-op owner policy — update guards read AND write rows [corpus: postgres/rls-force]
    pgPolicy('notes_update_own', {
      as: 'permissive',
      for: 'update',
      to: appApi,
      using: ownerIsCurrentUser(table.ownerId),
      withCheck: ownerIsCurrentUser(table.ownerId),
    }),
    // SOURCE: per-op owner policy — delete scoped by USING [corpus: postgres/rls-force]
    pgPolicy('notes_delete_own', {
      as: 'permissive',
      for: 'delete',
      to: appApi,
      using: ownerIsCurrentUser(table.ownerId),
    }),
  ],
).enableRLS()
