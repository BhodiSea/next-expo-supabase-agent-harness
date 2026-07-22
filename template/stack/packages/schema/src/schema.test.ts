// Table- and migration-coupled assertions, plus the CONTRACTS DRIFT TEST.
// Pure wire-contract behavior (bounds, formats, error codes) lives in
// packages/contracts/src/index.test.ts.
import { readFileSync } from 'node:fs'
import {
  EMBEDDING_DIM,
  NewNoteInput,
  NOTE_BODY_MAX,
  NOTE_TITLE_MAX,
  NoteDto,
  SOURCE_MODEL_MAX,
} from '@app/contracts'
import { getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as schema from './index.js'
import { notes } from './index.js'

const migrationSql = readFileSync(new URL('../drizzle/0000_init.sql', import.meta.url), 'utf8')
const keysetMigrationSql = readFileSync(
  new URL('../drizzle/0002_notes_keyset_idx.sql', import.meta.url),
  'utf8',
)

describe('EMBEDDING_DIM', () => {
  it('is 1024 and matches the vector column in the committed migration', () => {
    expect(EMBEDDING_DIM).toBe(1024)
    expect(migrationSql).toContain(`"embedding" vector(${String(EMBEDDING_DIM)})`)
  })
})

// ---------------------------------------------------------------------------
// CONTRACTS DRIFT TEST. Before the mobile split, the wire DTOs were DERIVED
// from this table via drizzle-zod, so table and contract could not diverge by
// construction. The mobile client must not import drizzle, so @app/contracts
// hand-authors the same shapes in pure Zod — and this test is what remains of
// the derivation: it re-derives the select/insert schemas with the SAME bound
// refinements the old module used and asserts structural equality with the
// hand-authored DTOs via z.toJSONSchema. The single-source discipline survives
// the split as a test instead of a derivation: change the table OR the
// contract alone and this reds.
// ---------------------------------------------------------------------------

// The same timestamptz-text refinement @app/contracts applies (drizzle's
// mode:'string' column crosses the wire as the driver text form).
const timestampText = (s: z.ZodString) => s.regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/).max(64)

// The refinements the pre-split @app/schema applied to its derivations —
// bounds come from @app/contracts (the bounds authority); the table supplies
// the shape (nullability, uuid/vector/real column types).
const selectRefinements = {
  body: (s: z.ZodString) => s.max(NOTE_BODY_MAX),
  createdAt: (s: z.ZodString) => timestampText(s),
  sourceConfidence: (s: z.ZodNumber) => s.min(0).max(1), // provenance confidence is a probability
  sourceModel: (s: z.ZodString) => s.max(SOURCE_MODEL_MAX),
  title: (s: z.ZodString) => s.min(1).max(NOTE_TITLE_MAX),
}

const DerivedNoteDto = createSelectSchema(notes, selectRefinements)

const DerivedNewNoteInput = createInsertSchema(notes, {
  // .optional() restated: a refinement callback replaces the derived schema,
  // including the optionality the column default ('') would have conferred.
  body: (s: z.ZodString) => s.max(NOTE_BODY_MAX).optional(),
  title: (s: z.ZodString) => s.min(1).max(NOTE_TITLE_MAX),
}).pick({ body: true, title: true })

// Structural comparison: JSON Schema is a stable, deeply-comparable rendering
// of a Zod shape (types, bounds, patterns, nullability, required-ness).
const shapeOf = (s: z.ZodType) => z.toJSONSchema(s)

describe('contracts drift (derived vs hand-authored)', () => {
  it('NoteDto in @app/contracts equals the drizzle-zod select derivation', () => {
    expect(shapeOf(NoteDto)).toEqual(shapeOf(DerivedNoteDto))
  })

  it('NewNoteInput in @app/contracts equals the drizzle-zod insert derivation (body+title pick)', () => {
    expect(shapeOf(NewNoteInput)).toEqual(shapeOf(DerivedNewNoteInput))
  })

  it('negative control: a deliberately different refinement must NOT compare equal', () => {
    // Proves the comparison can fail: if toJSONSchema collapsed bounds (or the
    // deep-equal were vacuous), this off-by-one bound would slip through and
    // the two green tests above would be theatre.
    const OffByOne = createSelectSchema(notes, {
      ...selectRefinements,
      title: (s: z.ZodString) => s.min(1).max(NOTE_TITLE_MAX + 1),
    })
    expect(shapeOf(OffByOne)).not.toEqual(shapeOf(NoteDto))
  })
})

describe('migration SQL self-check', () => {
  it('ENABLE + FORCE ROW LEVEL SECURITY covers every pgTable exported by the schema', () => {
    const exported: readonly unknown[] = Object.values(schema)
    const tables = exported.filter((value): value is PgTable => is(value, PgTable))
    expect(tables.length).toBeGreaterThan(0)
    for (const table of tables) {
      const name = getTableName(table)
      expect(migrationSql).toContain(`ALTER TABLE "${name}" ENABLE ROW LEVEL SECURITY`)
      expect(migrationSql).toContain(`ALTER TABLE "${name}" FORCE ROW LEVEL SECURITY`)
    }
  })

  it('defines all four per-operation owner policies for notes and grants DML to app_api', () => {
    for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(migrationSql).toContain(
        `CREATE POLICY "notes_${op.toLowerCase()}_own" ON "notes" AS PERMISSIVE FOR ${op} TO "app_api"`,
      )
    }
    expect(migrationSql).toContain(
      "(select nullif(current_setting('app.user_id', true), '')::uuid)",
    )
    expect(migrationSql).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "notes" TO "app_api"',
    )
  })

  it('indexes the keyset the list query orders by, not just the owner column', () => {
    // 0001 indexed (owner_id) alone. That satisfied the RLS policy predicate, the
    // pg_catalog leading-column check, and the old plan probe — and still left
    // notesDal.list() sorting the owner's ENTIRE partition on every page, because an
    // index on (owner_id) cannot serve `ORDER BY created_at DESC, id DESC`. The index
    // must carry the ORDERING, not merely the filter. Column order IS the keyset:
    // equality column first, then the ORDER BY columns in their declared direction.
    // The live proof is tests/rls/plan-regression.test.ts, which EXPLAINs the SQL the
    // DAL really emits and reds on any Sort node; this is the cheap unit-lane mirror.
    // SOURCE: https://use-the-index-luke.com/no-offset [corpus: postgres/rls-initplan]
    expect(keysetMigrationSql).toContain(
      'CREATE INDEX "notes_owner_created_id_idx" ON "notes" ("owner_id", "created_at" DESC, "id" DESC)',
    )
    // The narrow index is now a strict PREFIX of the composite — keeping both would only
    // add write amplification on every INSERT.
    expect(keysetMigrationSql).toContain('DROP INDEX "notes_owner_id_idx"')
  })
})
