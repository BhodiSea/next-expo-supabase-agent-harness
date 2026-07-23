// Can-fail proofs for the schema-rls gate (template/base/tools/check-rls-manifest.mjs).
// The gate was ported from a Drizzle lineage to Supabase in W3: tables are discovered
// from supabase/schemas/*.sql, RLS facts from supabase/migrations/*.sql, and the runtime
// matrix is closed over TWO registries (tests/rls/db-context.ts ISOLATION_TARGETS and the
// pgTAP rls_targets in supabase/tests/rls_structure.test.sql). An early regex version was
// vacuous against `AS PERMISSIVE`; every rule here is fixture-driven — build a
// scaffold-shaped tree, run the real gate with cwd inside it, assert the exact red/green.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-rls-manifest.mjs', import.meta.url),
)
const STACK_SUPABASE = fileURLToPath(new URL('../../template/stack/supabase', import.meta.url))

const EXEMPT_EMPTY = '{"comment":"x","exempt":[]}\n'

// A minimal owner-scoped table whose owner column is a SEPARATE indexed column
// (owner_id), the notes shape. Overridable pieces let each RED case perturb one rule.
/**
 * @param {{enable?: string, force?: string, index?: string, usingSelect?: string, policies?: string, extra?: string}} [o]
 */
function migration(o = {}) {
  const {
    enable = 'ALTER TABLE public.thing ENABLE ROW LEVEL SECURITY;',
    force = 'ALTER TABLE public.thing FORCE ROW LEVEL SECURITY;',
    index = 'CREATE INDEX thing_owner_idx ON public.thing (owner_id, created_at DESC);',
    usingSelect = 'USING (owner_id = (SELECT auth.uid()))',
    policies,
    extra = '',
  } = o
  const pols =
    policies ??
    `CREATE POLICY thing_select_own ON public.thing AS PERMISSIVE FOR SELECT TO authenticated ${usingSelect};
CREATE POLICY thing_insert_own ON public.thing AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_update_own ON public.thing AS PERMISSIVE FOR UPDATE TO authenticated USING (owner_id = (SELECT auth.uid())) WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_delete_own ON public.thing AS PERMISSIVE FOR DELETE TO authenticated USING (owner_id = (SELECT auth.uid()));`
  return `CREATE TABLE public.thing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
${index}
${enable}
${force}
${pols}
${extra}`
}

const SCHEMA_THING =
  'CREATE TABLE public.thing (\n  id uuid PRIMARY KEY,\n  owner_id uuid NOT NULL\n);\n'
const structure = (rows) =>
  `BEGIN;\nCREATE TEMPORARY TABLE rls_targets (table_name text PRIMARY KEY, owner_column text NOT NULL);\nINSERT INTO rls_targets (table_name, owner_column) VALUES\n  ${rows};\nROLLBACK;\n`
const dbctx = (targets) => `export const ISOLATION_TARGETS = [${targets}] as const\n`

const THING_TARGET = "{ table: 'thing', ownerColumn: 'owner_id' }"
const THING_STRUCT = "('thing', 'owner_id')"

// schema/migration/structure/dbContext each override a slice; `shipped: true` copies the
// REAL supabase/ tree instead (the scaffold-passes-untouched regression guard).
function fixture({
  schema = SCHEMA_THING,
  migration: mig = migration(),
  exempt = EXEMPT_EMPTY,
  dbContext = dbctx(THING_TARGET),
  structureRows = THING_STRUCT,
  shipped = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nesah-rlsgate-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  mkdirSync(join(dir, 'tests/rls'), { recursive: true })
  writeFileSync(join(dir, 'tools/rls-exempt.json'), exempt)
  writeFileSync(join(dir, 'tests/rls/db-context.ts'), dbContext)
  if (shipped) {
    cpSync(STACK_SUPABASE, join(dir, 'supabase'), { recursive: true })
  } else {
    mkdirSync(join(dir, 'supabase/schemas'), { recursive: true })
    mkdirSync(join(dir, 'supabase/migrations'), { recursive: true })
    mkdirSync(join(dir, 'supabase/tests'), { recursive: true })
    writeFileSync(join(dir, 'supabase/schemas/10_thing.sql'), schema)
    if (mig !== null) writeFileSync(join(dir, 'supabase/migrations/0001_thing.sql'), mig)
    writeFileSync(join(dir, 'supabase/tests/rls_structure.test.sql'), structure(structureRows))
  }
  return dir
}

function runGate(dir) {
  const res = spawnSync('node', [GATE], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('GREEN: the untouched shipped supabase/ scaffold passes (profiles inline-PK + notes)', () => {
  const r = runGate(
    fixture({
      shipped: true,
      dbContext: dbctx(
        "{ table: 'profiles', ownerColumn: 'id' }, { table: 'notes', ownerColumn: 'owner_id' }",
      ),
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('GREEN: minimal owner-scoped table with a separate leading index', () => {
  const r = runGate(fixture())
  assert.equal(r.code, 0, r.out)
})

test('GREEN: an INLINE primary key on the owner column satisfies the index rule', () => {
  // owner column IS `id`, indexed by the inline PRIMARY KEY — no separate CREATE INDEX
  // (the public.profiles shape).
  const mig = `CREATE TABLE public.thing (
  id uuid PRIMARY KEY,
  display_name text NOT NULL DEFAULT ''
);
ALTER TABLE public.thing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.thing FORCE ROW LEVEL SECURITY;
CREATE POLICY thing_select_own ON public.thing FOR SELECT TO authenticated USING (id = (SELECT auth.uid()));
CREATE POLICY thing_insert_own ON public.thing FOR INSERT TO authenticated WITH CHECK (id = (SELECT auth.uid()));
CREATE POLICY thing_update_own ON public.thing FOR UPDATE TO authenticated USING (id = (SELECT auth.uid())) WITH CHECK (id = (SELECT auth.uid()));
CREATE POLICY thing_delete_own ON public.thing FOR DELETE TO authenticated USING (id = (SELECT auth.uid()));`
  const r = runGate(
    fixture({
      migration: mig,
      dbContext: dbctx("{ table: 'thing', ownerColumn: 'id' }"),
      structureRows: "('thing', 'id')",
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('RED: dropping one per-operation policy fails naming the op (the AS PERMISSIVE vacuity regression)', () => {
  const pols = `CREATE POLICY thing_select_own ON public.thing AS PERMISSIVE FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_insert_own ON public.thing AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY thing_update_own ON public.thing AS PERMISSIVE FOR UPDATE TO authenticated USING (owner_id = (SELECT auth.uid())) WITH CHECK (owner_id = (SELECT auth.uid()));`
  const r = runGate(fixture({ migration: migration({ policies: pols }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('FOR DELETE'), r.out)
})

test('RED: USING (true) is a vacuous predicate', () => {
  const r = runGate(fixture({ migration: migration({ usingSelect: 'USING (true)' }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('vacuous'), r.out)
})

test('RED: a per-row identity call without the initPlan sub-select', () => {
  const r = runGate(
    fixture({ migration: migration({ usingSelect: 'USING (owner_id = auth.uid())' }) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('per row'), r.out)
})

test('RED: no ENABLE/FORCE ROW LEVEL SECURITY', () => {
  const r = runGate(fixture({ migration: migration({ enable: '', force: '' }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no ENABLE') && r.out.includes('no FORCE'), r.out)
})

test('RED: a migration-created table not declared in supabase/schemas', () => {
  const r = runGate(
    fixture({ migration: `${migration()}\nCREATE TABLE public.widgets (id uuid PRIMARY KEY);\n` }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('widgets') && r.out.includes('not declared'), r.out)
})

test('RED: an isolation target with no owner-column index in any migration', () => {
  const r = runGate(fixture({ migration: migration({ index: '' }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no index with leading column owner_id'), r.out)
})

test('RED: an index with the owner column in SECOND position does not count (leading-column rule)', () => {
  const r = runGate(
    fixture({
      migration: migration({ index: 'CREATE INDEX thing_cover ON public.thing (id, owner_id);' }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no index with leading column owner_id'), r.out)
})

test('RED: a declared table absent from ISOLATION_TARGETS (client-suite closure)', () => {
  const r = runGate(fixture({ dbContext: dbctx('') }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('ISOLATION_TARGETS'), r.out)
})

test('RED: a declared table absent from the pgTAP rls_targets registry', () => {
  const r = runGate(fixture({ structureRows: "('other', 'owner_id')" }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('rls_targets'), r.out)
})

test('RED: a stale ISOLATION_TARGETS row naming a table no schema declares (two-way closure)', () => {
  const r = runGate(
    fixture({ dbContext: dbctx(`${THING_TARGET}, { table: 'ghost', ownerColumn: 'owner_id' }`) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('ghost') && r.out.includes('stale target'), r.out)
})

test('RED: the two registries disagree on the owner column', () => {
  const r = runGate(fixture({ structureRows: "('thing', 'id')" }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('disagree'), r.out)
})

test('exemptions: canonical entries work; malformed entries fail LOUD, never open', () => {
  // A fully-uncovered second table passes when exempted with a reviewed reason.
  const green = runGate(
    fixture({
      schema: `${SCHEMA_THING}CREATE TABLE public.country_codes (code text PRIMARY KEY);\n`,
      exempt: JSON.stringify({
        comment: 'x',
        exempt: [{ table: 'country_codes', reason: 'static reference data, no user rows' }],
      }),
    }),
  )
  assert.equal(green.code, 0, green.out)

  // Missing reason → the gate itself fails (the escape hatch cannot fail open).
  const noReason = runGate(
    fixture({ exempt: JSON.stringify({ comment: 'x', exempt: [{ table: 'country_codes' }] }) }),
  )
  assert.equal(noReason.code, 1, noReason.out)
  assert.ok(noReason.out.includes('reason'), noReason.out)

  // Legacy/wrong shape (object map instead of array) → loud fail with the expected shape.
  const wrongShape = runGate(fixture({ exempt: JSON.stringify({ tables: { thing: 'nope' } }) }))
  assert.equal(wrongShape.code, 1, wrongShape.out)
  assert.ok(wrongShape.out.includes('ARRAY'), wrongShape.out)
})
