// Can-fail proofs for the schema-rls gate (template/base/tools/check-rls-manifest.mjs).
// An early regex version of this gate (in the source-harness lineage) was vacuous
// against the shipped migration's own syntax (`AS PERMISSIVE` defeated the
// per-operation lookahead) — every rule here is fixture-driven: build a
// scaffold-shaped tree, run the real gate script with cwd inside it, assert the
// exact red/green.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-rls-manifest.mjs', import.meta.url),
)
const SHIPPED_MIGRATION = readFileSync(
  fileURLToPath(new URL('../../template/stack/packages/schema/drizzle/0000_init.sql', import.meta.url)),
  'utf8',
)
const SHIPPED_INDEX_MIGRATION = readFileSync(
  fileURLToPath(new URL('../../template/stack/packages/schema/drizzle/0001_notes_owner_idx.sql', import.meta.url)),
  'utf8',
)

const EXEMPT_EMPTY = '{"comment":"x","exempt":[]}\n'

// indexMigration: null omits the owner-index migration (the red case for that rule).
function fixture({ schema, migration, exempt = EXEMPT_EMPTY, dbContext, indexMigration = SHIPPED_INDEX_MIGRATION }) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-rlsgate-'))
  mkdirSync(join(dir, 'packages/schema/src'), { recursive: true })
  mkdirSync(join(dir, 'packages/schema/drizzle'), { recursive: true })
  mkdirSync(join(dir, 'tools'), { recursive: true })
  writeFileSync(join(dir, 'packages/schema/src/index.ts'), schema)
  if (migration !== undefined) writeFileSync(join(dir, 'packages/schema/drizzle/0000_init.sql'), migration)
  if (indexMigration !== null) writeFileSync(join(dir, 'packages/schema/drizzle/0001_idx.sql'), indexMigration)
  writeFileSync(join(dir, 'tools/rls-exempt.json'), exempt)
  if (dbContext !== undefined) {
    mkdirSync(join(dir, 'tests/rls'), { recursive: true })
    writeFileSync(join(dir, 'tests/rls/db-context.ts'), dbContext)
  }
  return dir
}

function runGate(dir) {
  const res = spawnSync('node', [GATE], { cwd: dir, encoding: 'utf8', env: { ...process.env, CI: 'true' } })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const NOTES_SCHEMA = "export const notes = pgTable('notes', {})\n"
const NOTES_TARGETS = "export const ISOLATION_TARGETS = [{ table: 'notes', ownerColumn: 'owner_id' }]\n"

test('GREEN: the shipped migration passes (AS PERMISSIVE syntax, per-op policies, initPlan predicates)', () => {
  const r = runGate(fixture({ schema: NOTES_SCHEMA, migration: SHIPPED_MIGRATION, dbContext: NOTES_TARGETS }))
  assert.equal(r.code, 0, r.out)
})

test('RED: dropping one per-operation policy fails naming the op (the early-regex vacuity regression)', () => {
  const migration = SHIPPED_MIGRATION.split('--> statement-breakpoint')
    .filter((s) => !s.includes('notes_delete_own'))
    .join('--> statement-breakpoint')
  const r = runGate(fixture({ schema: NOTES_SCHEMA, migration, dbContext: NOTES_TARGETS }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('FOR DELETE'), r.out)
})

test('RED: USING (true) is a vacuous predicate', () => {
  const migration = SHIPPED_MIGRATION.replace(
    /USING \("owner_id" = \(select nullif\(current_setting\('app\.user_id', true\), ''\)::uuid\)\);\n--> statement-breakpoint\n-- SOURCE: WITH CHECK/,
    'USING (true);\n--> statement-breakpoint\n-- SOURCE: WITH CHECK',
  )
  assert.notEqual(migration, SHIPPED_MIGRATION, 'fixture replacement must hit')
  const r = runGate(fixture({ schema: NOTES_SCHEMA, migration, dbContext: NOTES_TARGETS }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('vacuous'), r.out)
})

test('RED: per-row current_setting() without the initPlan sub-select', () => {
  const migration = SHIPPED_MIGRATION.replaceAll(
    `(select nullif(current_setting('app.user_id', true), '')::uuid)`,
    `nullif(current_setting('app.user_id', true), '')::uuid`,
  )
  const r = runGate(fixture({ schema: NOTES_SCHEMA, migration, dbContext: NOTES_TARGETS }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('per row'), r.out)
})

test('RED: policies on a prefix-named table must not satisfy the base table (word-boundary match)', () => {
  // Everything for notes_archive, nothing for notes.
  const migration = SHIPPED_MIGRATION.replaceAll('"notes"', '"notes_archive"')
  const r = runGate(fixture({
    schema: `${NOTES_SCHEMA}export const notesArchive = pgTable('notes_archive', {})\n`,
    migration,
    dbContext: `${NOTES_TARGETS.replace(']', ", { table: 'notes_archive', ownerColumn: 'owner_id' }]")}`,
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('notes: no ENABLE'), r.out)
})

test('RED: a migration-created table missing from the Drizzle schema', () => {
  const migration = `${SHIPPED_MIGRATION}\n--> statement-breakpoint\nCREATE TABLE "widgets" ("id" uuid PRIMARY KEY);\n`
  const r = runGate(fixture({ schema: NOTES_SCHEMA, migration, dbContext: NOTES_TARGETS }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('widgets'), r.out)
  assert.ok(r.out.includes('not declared as a pgTable'), r.out)
})

test('RED: an isolation target with no owner-column index in any migration', () => {
  const r = runGate(fixture({
    schema: NOTES_SCHEMA,
    migration: SHIPPED_MIGRATION,
    dbContext: NOTES_TARGETS,
    indexMigration: null,
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no index with leading column owner_id'), r.out)
})

test('RED: an index with the owner column in SECOND position does not count (leading-column rule)', () => {
  const r = runGate(fixture({
    schema: NOTES_SCHEMA,
    migration: SHIPPED_MIGRATION,
    dbContext: NOTES_TARGETS,
    indexMigration: 'CREATE INDEX "notes_cover" ON "notes" ("id", "owner_id");\n',
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no index with leading column owner_id'), r.out)
})

test('GREEN: a UNIQUE constraint leading on the owner column also satisfies the index rule', () => {
  const r = runGate(fixture({
    schema: NOTES_SCHEMA,
    migration: SHIPPED_MIGRATION,
    dbContext: NOTES_TARGETS,
    indexMigration:
      'ALTER TABLE "notes" ADD CONSTRAINT "notes_owner_singleton" UNIQUE ("owner_id", "title");\n',
  }))
  assert.equal(r.code, 0, r.out)
})

test('RED: a declared table absent from ISOLATION_TARGETS (runtime-matrix closure)', () => {
  const r = runGate(fixture({
    schema: NOTES_SCHEMA,
    migration: SHIPPED_MIGRATION,
    dbContext: "export const ISOLATION_TARGETS = []\n",
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('ISOLATION_TARGETS'), r.out)
})

test('exemptions: canonical entries work; malformed entries fail LOUD, never open', () => {
  // A fully-uncovered table passes when exempted with a reviewed reason.
  const green = runGate(fixture({
    schema: `${NOTES_SCHEMA}export const lookup = pgTable('country_codes', {})\n`,
    migration: SHIPPED_MIGRATION,
    exempt: JSON.stringify({ comment: 'x', exempt: [{ table: 'country_codes', reason: 'static reference data, no user rows' }] }),
    dbContext: NOTES_TARGETS,
  }))
  assert.equal(green.code, 0, green.out)

  // Missing reason → the gate itself fails (the escape hatch cannot fail open).
  const noReason = runGate(fixture({
    schema: NOTES_SCHEMA,
    migration: SHIPPED_MIGRATION,
    exempt: JSON.stringify({ comment: 'x', exempt: [{ table: 'country_codes' }] }),
    dbContext: NOTES_TARGETS,
  }))
  assert.equal(noReason.code, 1, noReason.out)
  assert.ok(noReason.out.includes('reason'), noReason.out)

  // Legacy/wrong shape (object map instead of array) → loud fail with the expected shape.
  const wrongShape = runGate(fixture({
    schema: NOTES_SCHEMA,
    migration: SHIPPED_MIGRATION,
    exempt: JSON.stringify({ tables: { notes: 'nope' } }),
    dbContext: NOTES_TARGETS,
  }))
  assert.equal(wrongShape.code, 1, wrongShape.out)
  assert.ok(wrongShape.out.includes('ARRAY'), wrongShape.out)
})
