// Can-fail proofs for the query-shapes gate (template/base/tools/check-query-shapes.mjs)
// and for the recorder + resolver it is built on (tools/lib/query-recorder.mjs,
// tools/lib/query-shapes.mjs).
//
// The gate's whole value rests on a claim the rest of the repo cannot make: that the
// statements the DAL ACTUALLY ISSUES are ordered index scans. Every structural check
// beside it — pgTAP's leading-column assertion, `schema-rls`, `tenancy` — is true of an
// index that serves the filter and leaves the sort to be done in memory, so the cases
// below concentrate on the differences those checks cannot see:
//
//   the SORT TAIL — an index with the right leading column and the wrong tail.
//   the DIRECTION — a mixed ASC/DESC order no single scan direction can supply.
//   the BOUND — a list query with no LIMIT, and OFFSET pagination by name.
//   the CURSOR — a keyset whose columns disagree with its own ORDER BY.
//   the VACUITY — an empty or absent manifest, which passes every rule by having
//     nothing to judge.
//
// The recorder is proven separately, because it is the instrument: if it silently
// dropped an unknown builder method, the OFFSET ban would certify an absence it could
// not observe.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const GATE_SRC = join(ROOT, 'template/base/tools/check-query-shapes.mjs')
const LIB_SRC = join(ROOT, 'template/base/tools/lib')
const TENANCY_SRC = join(ROOT, 'template/base/tools/tenancy.json')
const LIMITS_SRC = join(ROOT, 'template/base/tools/db-limits.json')

const { boundKind, createRecorder, normalizeChain } = await import(
  join(LIB_SRC, 'query-recorder.mjs')
)
const { indexServes, selectSql } = await import(join(LIB_SRC, 'query-shapes.mjs'))

/** The shipped migration DDL the gate parses indexes out of, reduced to what matters. */
const MIGRATION_OK = `
CREATE TABLE public.notes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  PRIMARY KEY (org_id, id)
);
CREATE INDEX notes_org_id_created_at_id_idx
  ON public.notes (org_id, created_at DESC, id DESC);
`

/** The shape a first list page records. */
function listShape(over = {}) {
  return {
    columns: 'id, title, created_at',
    eq: ['org_id'],
    extra: [],
    fn: 'listNotes',
    id: 'notes.listNotes#page',
    is: ['archived_at'],
    kind: 'keyset',
    limit: 21,
    op: 'select',
    or: null,
    orColumns: [],
    order: [
      { ascending: false, column: 'created_at' },
      { ascending: false, column: 'id' },
    ],
    payload: [],
    range: [],
    table: 'notes',
    vertical: 'notes',
    ...over,
  }
}

/** The shape a point read records. */
function getShape(over = {}) {
  return {
    columns: 'id, title',
    eq: ['org_id', 'id'],
    extra: [],
    fn: 'getNote',
    id: 'notes.getNote#byId',
    is: [],
    kind: 'single',
    limit: 1,
    op: 'select',
    or: null,
    orColumns: [],
    order: [],
    payload: [],
    range: [],
    table: 'notes',
    vertical: 'notes',
    ...over,
  }
}

function fixture({ shapes = [listShape(), getShape()], rawManifest, migration = MIGRATION_OK } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nesah-queryshapes-'))
  mkdirSync(join(dir, 'tools/generated'), { recursive: true })
  mkdirSync(join(dir, 'tools/lib'), { recursive: true })
  mkdirSync(join(dir, 'supabase/migrations'), { recursive: true })
  mkdirSync(join(dir, 'packages/verticals/notes/src/data'), { recursive: true })
  cpSync(GATE_SRC, join(dir, 'tools/check-query-shapes.mjs'))
  cpSync(LIB_SRC, join(dir, 'tools/lib'), { recursive: true })
  cpSync(TENANCY_SRC, join(dir, 'tools/tenancy.json'))
  cpSync(LIMITS_SRC, join(dir, 'tools/db-limits.json'))
  writeFileSync(join(dir, 'supabase/migrations/20260101000000_notes.sql'), migration)
  // A probe module has to EXIST or the gate skips as "no DAL surface" — the fixtures
  // must exercise the judging path, not the absence path.
  writeFileSync(join(dir, 'packages/verticals/notes/src/data/query-probes.ts'), '// probes\n')
  if (rawManifest !== undefined) {
    writeFileSync(join(dir, 'tools/generated/query-shapes.json'), rawManifest)
  } else if (shapes !== null) {
    writeFileSync(
      join(dir, 'tools/generated/query-shapes.json'),
      `${JSON.stringify(shapes, null, 2)}\n`,
    )
  }
  return dir
}

function runGate(dir) {
  const env = { ...process.env }
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  const res = spawnSync(process.execPath, ['tools/check-query-shapes.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...env, CI: 'true' },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// ── the reference shape ───────────────────────────────────────────────────────

test('GREEN: the shipped index serves both the keyset page and the point read', () => {
  const r = runGate(fixture())
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('notes_org_id_created_at_id_idx'), r.out)
  assert.ok(r.out.includes('notes_pkey'), r.out)
})

// ── THE SORT TAIL: what every other check in the repo is blind to ─────────────

test('RED: the index carries the tenant key and NOT the sort — the failure this gate exists for', () => {
  // schema-rls and pgTAP both stay green here: the index exists and its leading column
  // is the tenant key. Every page is a filter plus an in-memory sort of the tenant's
  // whole row set, and its cost grows with the customer's success.
  const r = runGate(
    fixture({
      migration: `${MIGRATION_OK.replace(
        'CREATE INDEX notes_org_id_created_at_id_idx\n  ON public.notes (org_id, created_at DESC, id DESC);',
        'CREATE INDEX notes_org_id_idx ON public.notes (org_id);',
      )}`,
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no index on public.notes serves it'), r.out)
  assert.ok(r.out.includes('CREATE INDEX'), r.out)
})

test('RED: a MIXED sort direction no single scan can supply', () => {
  // (created_at DESC, id ASC) against a (… DESC, … DESC) index. A btree can be walked
  // backwards, so all-DESC and all-ASC are both served — reversing one column and not
  // the next is not.
  const r = runGate(
    fixture({
      shapes: [
        listShape({
          order: [
            { ascending: false, column: 'created_at' },
            { ascending: true, column: 'id' },
          ],
          orColumns: [],
        }),
      ],
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no index on public.notes serves it'), r.out)
})

test('GREEN: the fully-reversed sort IS served — a btree walks backwards', () => {
  const r = runGate(
    fixture({
      shapes: [
        listShape({
          order: [
            { ascending: true, column: 'created_at' },
            { ascending: true, column: 'id' },
          ],
        }),
      ],
    }),
  )
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('(backward)'), r.out)
})

// ── THE BOUND ────────────────────────────────────────────────────────────────

test('RED: a list read with no LIMIT', () => {
  const r = runGate(fixture({ shapes: [listShape({ kind: 'unbounded', limit: null })] }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('unbounded read'), r.out)
})

test('RED: OFFSET pagination, named', () => {
  const r = runGate(fixture({ shapes: [listShape({ extra: ['range'] })] }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('.range()'), r.out)
  assert.ok(r.out.includes('no-offset'), r.out)
})

test('RED: a LIMIT above [api].max_rows — PostgREST truncates it silently', () => {
  const r = runGate(fixture({ shapes: [listShape({ limit: 5000 })] }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('exceeds [api].max_rows'), r.out)
})

// ── THE CURSOR ───────────────────────────────────────────────────────────────

test('RED: a keyset cursor whose columns disagree with its own ORDER BY', () => {
  const r = runGate(
    fixture({
      shapes: [
        listShape({
          or: 'created_at.lt.?',
          orColumns: ['created_at'],
          range: [{ column: 'created_at', op: 'lte' }],
        }),
      ],
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('keyset cursor is over'), r.out)
})

test('RED: a cursor sent as ONE disjunction — the expensive mistake that looks right', () => {
  // This is the spelling the shipped DAL had, and the reason this rule exists. It is
  // logically correct, it is what every keyset tutorial shows, and it is O(page number):
  // PostgreSQL cannot turn a top-level OR into an index range, so the cursor lands in
  // `Filter:` and the scan still starts at the tenant's newest row. Measured against
  // 1.1M seeded rows at page 1000, before the fix: `Rows Removed by Filter: 1115` to
  // return 21, and 1798 buffers versus 8. Nothing else in the chain could see it — the
  // index existed, its leading column was the tenant key, its tail was the sort order,
  // and every structural gate was green.
  const r = runGate(
    fixture({
      shapes: [
        listShape({
          or: 'created_at.lt.?,and(created_at.eq.?,id.lt.?)',
          orColumns: ['created_at', 'id'],
          range: [],
        }),
      ],
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no range predicate on "created_at"'), r.out)
  assert.ok(r.out.includes('the exact cost of OFFSET'), r.out)
})

test('GREEN: range + tie-break is the served form', () => {
  const r = runGate(
    fixture({
      shapes: [
        listShape({
          or: 'created_at.lt.?,id.lt.?',
          orColumns: ['created_at', 'id'],
          range: [{ column: 'created_at', op: 'lte' }],
        }),
      ],
    }),
  )
  assert.equal(r.code, 0, r.out)
})

// ── THE TENANT KEY ───────────────────────────────────────────────────────────

test('RED: a read of a tenant table with no tenant equality', () => {
  const r = runGate(fixture({ shapes: [listShape({ eq: [] })] }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no org_id equality'), r.out)
  assert.ok(r.out.includes('filters by SCANNING'), r.out)
})

test('RED: an index that serves the shape but does not LEAD with the tenant key', () => {
  const r = runGate(
    fixture({
      migration: MIGRATION_OK.replace(
        '(org_id, created_at DESC, id DESC)',
        '(created_at DESC, id DESC, org_id)',
      ),
      shapes: [
        listShape({
          eq: ['created_at'],
          order: [],
          orColumns: [],
          kind: 'single',
          limit: 1,
        }),
      ],
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('leading column'), r.out)
})

// ── THE VACUITY: the ways this gate could pass by judging nothing ────────────

test('RED: an EMPTY manifest beside a live DAL', () => {
  const r = runGate(fixture({ shapes: [] }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('is EMPTY'), r.out)
})

test('RED: an ABSENT manifest beside a live DAL', () => {
  const r = runGate(fixture({ shapes: null }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('is missing'), r.out)
})

test('RED: a manifest that is not valid JSON — generated files are tampering, not drift', () => {
  const r = runGate(fixture({ rawManifest: '{ not json' }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('tampering'), r.out)
})

test('RED: a manifest row missing a required field fails closed rather than being skipped', () => {
  const { order: _dropped, ...withoutOrder } = listShape()
  const r = runGate(fixture({ rawManifest: JSON.stringify([withoutOrder]) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('bad or missing "order"'), r.out)
})

// ── THE INSTRUMENT ───────────────────────────────────────────────────────────

test('the recorder captures a method NO port declares — the OFFSET ban needs that', async () => {
  const { chains, db } = createRecorder()
  await db.from('notes').select('id').eq('org_id', 'x').range(0, 20)
  const shape = normalizeChain(chains[0])
  assert.deepEqual(shape.extra, ['range'])
  assert.equal(shape.table, 'notes')
})

test('the recorder resolves an await to a well-formed EMPTY result, not an error', async () => {
  const { db } = createRecorder()
  const out = await db.from('notes').select('id').limit(1)
  assert.deepEqual(out, { data: [], error: null })
})

test('the recorder drops literal VALUES from a filter and keeps columns + operators', async () => {
  const { chains, db } = createRecorder()
  await db
    .from('notes')
    .select('id')
    .or('created_at.lt."2026-01-01T00:00:00.000Z",and(created_at.eq."2026-01-01T00:00:00.000Z",id.lt."abc")')
    .limit(1)
  const shape = normalizeChain(chains[0])
  assert.equal(shape.or, 'created_at.lt.?,and(created_at.eq.?,id.lt.?)')
  assert.deepEqual(shape.orColumns, ['created_at', 'id'])
})

test('boundKind is DERIVED — an ordered, limited read is keyset; an unlimited one is not', () => {
  const ordered = { columns: 'id', limit: 21, op: 'select', order: [{ column: 'created_at' }] }
  assert.equal(boundKind(ordered), 'keyset')
  assert.equal(boundKind({ ...ordered, limit: null }), 'unbounded')
  assert.equal(boundKind({ columns: 'id', limit: 1, op: 'select', order: [] }), 'single')
  assert.equal(boundKind({ columns: 'count()', limit: null, op: 'select', order: [] }), 'aggregate')
  assert.equal(boundKind({ columns: 'id', limit: null, op: 'delete', order: [] }), 'write')
})

test('indexServes is a PREFIX rule — extra index columns after the sort are fine, before it are not', () => {
  const shape = listShape()
  const good = {
    columns: [
      { desc: false, name: 'org_id' },
      { desc: true, name: 'created_at' },
      { desc: true, name: 'id' },
      { desc: false, name: 'title' },
    ],
    name: 'good',
    table: 'notes',
  }
  const bad = {
    columns: [
      { desc: false, name: 'org_id' },
      { desc: false, name: 'title' },
      { desc: true, name: 'created_at' },
      { desc: true, name: 'id' },
    ],
    name: 'bad',
    table: 'notes',
  }
  assert.equal(indexServes(shape, good), 'forward')
  assert.equal(indexServes(shape, bad), null)
})

test('selectSql rebuilds the SAME predicate — range AND both tie-break arms', () => {
  const { columns, text } = selectSql(
    listShape({
      or: 'created_at.lt.?,id.lt.?',
      orColumns: ['created_at', 'id'],
      range: [{ column: 'created_at', op: 'lte' }],
    }),
  )
  // Dropping either half would turn the seek into a query the app does not send: without
  // the range it is a filter over the whole tenant, without the tie-break it silently
  // repeats the rows sharing the cursor's instant.
  assert.ok(text.includes('"created_at" <= $2'), text)
  assert.ok(text.includes('"created_at" < $3'), text)
  assert.ok(text.includes('"id" < $4'), text)
  assert.ok(text.includes('"archived_at" IS NULL'), text)
  assert.ok(text.includes('ORDER BY "created_at" DESC, "id" DESC'), text)
  assert.ok(text.includes('LIMIT 21'), text)
  assert.deepEqual(columns, ['org_id', 'created_at', 'created_at', 'id'])
})

test('selectSql REFUSES an unrecognized filter operator rather than dropping it', () => {
  assert.throws(
    () => selectSql(listShape({ or: 'created_at.wat.?', orColumns: ['created_at'] })),
    /unsupported PostgREST operator/,
  )
})

test('selectSql refuses a write shape — a gate must not mutate what it measures', () => {
  assert.throws(() => selectSql(listShape({ op: 'delete' })), /is a delete, not a read/)
})
