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
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
// STATIC imports, and both reasons are load-bearing.
//
// They were computed dynamic imports (`pathToFileURL(join(LIB_SRC, …)).href`), which
// forced a Windows-only workaround — a bare 'D:\\a\\...' specifier is
// ERR_UNSUPPORTED_ESM_URL_SCHEME because 'd:' reads as a protocol — and that broke this
// red-proof on windows-latest once already. A static relative specifier has no such
// hazard on any platform, so the workaround disappears rather than being maintained.
//
// And a computed specifier is opaque to `knip --strict`: it could not see these call
// sites, so `boundKind` and `indexServes` read as dead exports. The choice there is to
// weaken the dead-code gate with an ignore entry or to let it see the truth. This is the
// second one — the imports are honest and the gate keeps its teeth.
import { boundKind, createRecorder, normalizeChain } from '../../template/base/tools/lib/query-recorder.mjs'
import { indexServes, parseShapes, selectSql } from '../../template/base/tools/lib/query-shapes.mjs'
import { parseFunctions, parseIndexes, splitStatements } from '../../template/base/tools/lib/sql-parse.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const GATE_SRC = join(ROOT, 'template/base/tools/check-query-shapes.mjs')
const LIB_SRC = join(ROOT, 'template/base/tools/lib')
const TENANCY_SRC = join(ROOT, 'template/base/tools/tenancy.json')
const LIMITS_SRC = join(ROOT, 'template/base/tools/db-limits.json')

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

/**
 * `shapes` writes a structured manifest (null omits the file entirely); `rawManifest`
 * replaces it BYTE for byte, which is the only way to express the malformed cases.
 * @param {{ shapes?: any[] | null, rawManifest?: string, migration?: string }} [opts]
 */
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

// ── 1.1.0 (#75): the history fold reaches the index lookup ────────────────────────────
// parseIndexes folded index and constraint drops but never a DROP TABLE, so a table dropped
// and re-created without its sort index still read as served. Folded, the re-created table
// starts fresh: a finding only the fold produces, which rides the 1.1.0 ramp until 1.2.0.
const RECREATED = `${MIGRATION_OK}
DROP TABLE public.notes;
CREATE TABLE public.notes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  PRIMARY KEY (org_id, id)
);
`

/** @param {{ baseVersion: string, harnessVersion: string } | null} manifest */
function recreatedFixture(manifest) {
  const dir = fixture({ migration: RECREATED })
  if (manifest !== null) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness/manifest.json'), JSON.stringify({ ...manifest, files: {} }))
  }
  return dir
}

test('RED (1.1.0): the index a dropped table took with it no longer serves the page', () => {
  const r = runGate(recreatedFixture(null))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('(notes.listNotes#page): no index on public.notes serves it'), r.out)
  // The point read is still served, by the re-created table's own primary key.
  assert.ok(!r.out.includes('(notes.getNote#byId): no index'), r.out)
  assert.ok(!r.out.includes('NOTE — (ramp)'), r.out)
})

test('RAMP (1.1.0): the fold-only finding is a NOTE on a 1.0.3 install at harness 1.1.0', () => {
  const r = runGate(recreatedFixture({ baseVersion: '1.0.3', harnessVersion: '1.1.0' }))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /query-shapes: NOTE — the SQL history fold .*expires in 1\.2\.0/)
  assert.ok(r.out.includes('query-shapes: NOTE — (ramp) tools/generated/query-shapes.json (notes.listNotes#page): no index'), r.out)
})

test('RAMP (1.1.0): the fold-only finding is RAMP EXPIRED and red at harness 1.2.0', () => {
  const r = runGate(recreatedFixture({ baseVersion: '1.0.3', harnessVersion: '1.2.0' }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('query-shapes: RAMP EXPIRED — the SQL history fold'), r.out)
  assert.ok(r.out.includes('no index on public.notes serves it'), r.out)
})

// ── 1.1.0 (#79): rpc() and upsert() ──────────────────────────────────────────
// Through 1.0.x the recording port had only `from()`, so a probed DAL that called
// `.rpc()` threw inside `pnpm gen`, and `upsert` was outside KNOWN_METHODS, so an upsert
// recorded as a `select` with `extra: ["upsert"]` and redded with OFFSET advice. Both now
// record as their own op, and the gate judges what PostgREST and PostgreSQL would refuse
// at runtime: an rpc no migration creates or called with the wrong argument names
// (PGRST202), and an upsert whose conflict columns match no UNIQUE index or primary key.

/** A row exactly as tools/gen-query-shapes.mjs writes it: identity, then the chain. */
async function recordRow(vertical, id, fn, run) {
  const { chains, db } = createRecorder()
  await run(db)
  assert.equal(chains.length, 1)
  return { id: `${vertical}.${id}`, vertical, fn, ...normalizeChain(chains[0]) }
}

/** The web app's invitation RPC, driven through the recording port. */
const acceptRow = () =>
  recordRow('orgs', 'acceptInvitation#accept', 'acceptInvitation', (db) =>
    db.rpc('accept_invitation', { p_token: 'tok-VALUE-never-recorded' }),
  )

/** An idempotent write on an untenanted table, keyed on a UNIQUE index. */
const handleUpsertRow = (onConflict = 'handle') =>
  recordRow('profiles', 'saveHandle#upsert', 'saveHandle', (db) =>
    db
      .from('profiles')
      .upsert({ handle: 'h', id: 'x' }, onConflict === null ? undefined : { onConflict })
      .select('id')
      .limit(1),
  )

/**
 * A tenant upsert on the notes table, targeting its primary key by default.
 * @param {Record<string, string>} [payload]
 */
const noteUpsertRow = (payload = { id: 'x', org_id: 'o', title: 't' }) =>
  recordRow('notes', 'saveNote#upsert', 'saveNote', (db) =>
    db.from('notes').upsert(payload).select('id').limit(1),
  )

const FUNCTIONS_SQL = `
CREATE FUNCTION public.accept_invitation(p_token uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN p_token;
END;
$$;
CREATE FUNCTION public.org_audit_events(
  _org uuid,
  _before timestamptz DEFAULT NULL,
  _limit int = 50,
  _amount numeric(10,2) DEFAULT 0,
  OUT event_id bigint
)
RETURNS SETOF record
LANGUAGE sql
STABLE
AS $$ SELECT 1::bigint $$;
CREATE TABLE public.profiles (
  id uuid NOT NULL,
  handle text NOT NULL,
  CONSTRAINT profiles_pk PRIMARY KEY (id)
);
CREATE UNIQUE INDEX profiles_handle_key ON public.profiles (handle);
`
const MIGRATION_CALLS = `${MIGRATION_OK}${FUNCTIONS_SQL}`

test('RECORDER (1.1.0): db.rpc() records op "rpc", table null and the argument NAMES only', async () => {
  const row = await acceptRow()
  assert.equal(row.op, 'rpc')
  assert.equal(row.table, null)
  assert.deepEqual(row.rpc, { args: ['p_token'], name: 'accept_invitation' })
  assert.equal(row.kind, 'write')
  assert.deepEqual(row.extra, [])
  assert.ok(!JSON.stringify(row).includes('tok-VALUE'), JSON.stringify(row))
})

test('RECORDER (1.1.0): an rpc with no arguments records args [] and a later unknown method lands in extra', async () => {
  const { chains, db } = createRecorder()
  await db.rpc('ensure_personal_org').range(0, 20)
  const shape = normalizeChain(chains[0])
  assert.deepEqual(shape.rpc, { args: [], name: 'ensure_personal_org' })
  assert.deepEqual(shape.extra, ['range'])
})

test('RECORDER (1.1.0): an upsert records op "upsert", its payload and onConflict, with an empty extra', async () => {
  const row = await handleUpsertRow('handle')
  assert.equal(row.op, 'upsert')
  assert.equal(row.table, 'profiles')
  assert.deepEqual(row.payload, ['handle', 'id'])
  assert.deepEqual(row.onConflict, ['handle'])
  assert.deepEqual(row.extra, [])
  assert.equal(row.kind, 'write')
})

test('RECORDER (1.1.0): onConflict is split on commas and sorted, null when absent; an array payload reads its first element', async () => {
  const { chains, db } = createRecorder()
  await db.from('t').upsert([{ b: 1, a: 2 }, { c: 3 }], { onConflict: 'b, a' })
  await db.from('t').upsert({ z: 1 })
  const [many, one] = chains.map(normalizeChain)
  assert.deepEqual(many.payload, ['a', 'b'])
  assert.deepEqual(many.onConflict, ['a', 'b'])
  assert.equal(one.onConflict, null)
  assert.equal(boundKind(many), 'write')
})

test('RECORDER (1.1.0): the key list of select, insert, update and delete rows is pinned — neither new key reaches them', async () => {
  const BASE = ['columns', 'eq', 'is', 'limit', 'op', 'or', 'orColumns', 'order', 'payload', 'range', 'table', 'extra', 'kind']
  const { chains, db } = createRecorder()
  await db.from('notes').select('id').eq('org_id', 'o').limit(1)
  await db.from('notes').insert({ org_id: 'o' }).select('id').limit(1)
  await db.from('notes').update({ title: 't' }).eq('org_id', 'o').select('id').limit(1)
  await db.from('notes').delete().eq('org_id', 'o').select('id').limit(1)
  await db.rpc('f', { a: 1 })
  await db.from('notes').upsert({ org_id: 'o' })
  const shapes = chains.map(normalizeChain)
  assert.deepEqual(
    shapes.slice(0, 4).map((s) => s.op),
    ['select', 'insert', 'update', 'delete'],
  )
  for (const s of shapes.slice(0, 4)) assert.deepEqual(Object.keys(s), BASE, s.op)
  // Each new op gains exactly its one key, in the key order the rows already use.
  assert.deepEqual(Object.keys(shapes[4]), [...BASE.slice(0, 10), 'rpc', ...BASE.slice(10)])
  assert.deepEqual(Object.keys(shapes[5]), [...BASE.slice(0, 4), 'onConflict', ...BASE.slice(4)])
})

test('PARSE (1.1.0): rpc and upsert rows parse; a missing rpc/onConflict key or a misplaced null table fails closed', async () => {
  const rpc = await acceptRow()
  const upsert = await handleUpsertRow()
  assert.equal(parseShapes(JSON.stringify([rpc, upsert])).length, 2)
  const { rpc: _r, ...noRpc } = rpc
  const { onConflict: _o, ...noConflict } = upsert
  assert.throws(() => parseShapes(JSON.stringify([noRpc])), /bad or missing "rpc"/)
  assert.throws(() => parseShapes(JSON.stringify([noConflict])), /bad or missing "onConflict"/)
  assert.throws(() => parseShapes(JSON.stringify([{ ...rpc, rpc: { name: '', args: [] } }])), /"rpc"/)
  assert.throws(() => parseShapes(JSON.stringify([{ ...upsert, onConflict: 'handle' }])), /"onConflict"/)
  // An empty option records [] and parses: the arbiter rule, not the parser, judges it.
  assert.equal(parseShapes(JSON.stringify([{ ...upsert, onConflict: [] }])).length, 1)
  assert.throws(() => parseShapes(JSON.stringify([{ ...upsert, table: null }])), /bad or missing "table"/)
  assert.throws(() => parseShapes(JSON.stringify([listShape({ table: null })])), /bad or missing "table"/)
  assert.throws(() => parseShapes(JSON.stringify([{ ...rpc, table: 'notes' }])), /bad or missing "table"/)
})

test('PARSE (1.1.0): the parser marks a primary key, named or not, and splits a parameter list at top level', () => {
  const statements = splitStatements(MIGRATION_CALLS)
  const pk = parseIndexes(statements).all.filter((i) => i.primaryKey)
  assert.deepEqual(
    pk.map((i) => `${i.table}:${i.name}`),
    ['notes:notes_pkey', 'profiles:profiles_pk'],
  )
  const handle = parseIndexes(statements).all.find((i) => i.name === 'profiles_handle_key')
  assert.equal(handle?.primaryKey, false)
  assert.equal(handle?.unique, true)
  const audit = parseFunctions(statements).find((f) => f.name === 'org_audit_events')
  // `numeric(10,2)` is ONE parameter: a naive split(',') tore it into two.
  assert.deepEqual(
    audit?.params.map((p) => p.raw),
    ['_org uuid', '_before timestamptz DEFAULT NULL', '_limit int = 50', '_amount numeric(10,2) DEFAULT 0', 'OUT event_id bigint'],
  )
  const altered = parseIndexes(
    splitStatements(
      'CREATE TABLE public.t (id uuid NOT NULL, k text);\nALTER TABLE public.t ADD CONSTRAINT t_main PRIMARY KEY (id), ADD UNIQUE (k);',
    ),
  ).all
  assert.deepEqual(
    altered.map((i) => [i.name, i.primaryKey]),
    [
      ['t_main', true],
      ['t_k_key', false],
    ],
  )
})

test('GREEN (1.1.0): an rpc a migration creates, called with its parameter names', async () => {
  const r = runGate(fixture({ migration: MIGRATION_CALLS, shapes: [listShape(), await acceptRow()] }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('orgs.acceptInvitation#accept -> rpc public.accept_invitation'), r.out)
  // The null table must not reach the tenant-equality or index-service rules.
  assert.ok(!r.out.includes('null'), r.out)
})

test('GREEN (1.1.0): an rpc may omit a DEFAULT parameter, and an OUT parameter is not an input', async () => {
  const row = await recordRow('audit', 'events#first', 'events', (db) =>
    db.rpc('org_audit_events', { _org: 'o' }).limit(50),
  )
  const r = runGate(fixture({ migration: MIGRATION_CALLS, shapes: [row] }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('rpc public.org_audit_events'), r.out)
})

test('GREEN (1.1.0): an upsert whose onConflict is a UNIQUE index', async () => {
  const r = runGate(fixture({ migration: MIGRATION_CALLS, shapes: [await handleUpsertRow('handle')] }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('profiles.saveHandle#upsert -> ON CONFLICT profiles_handle_key'), r.out)
})

test('GREEN (1.1.0): an upsert with no onConflict on a table whose primary key is a NAMED constraint', async () => {
  const migration = MIGRATION_CALLS.replace('  PRIMARY KEY (org_id, id)\n', '  CONSTRAINT notes_pk PRIMARY KEY (org_id, id)\n')
  assert.notEqual(migration, MIGRATION_CALLS)
  const r = runGate(fixture({ migration, shapes: [listShape(), await noteUpsertRow()] }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('notes.saveNote#upsert -> ON CONFLICT notes_pk'), r.out)
})

test('RED (1.1.0): an rpc no migration creates — the anti-vacuity rename', async () => {
  const migration = MIGRATION_CALLS.replace('public.accept_invitation(', 'public.accept_invite(')
  const r = runGate(fixture({ migration, shapes: [await acceptRow()] }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('(orgs.acceptInvitation#accept): calls rpc public.accept_invitation, which no migration creates'), r.out)
  assert.ok(r.out.includes('PGRST202'), r.out)
})

test('RED (1.1.0): an rpc missing a required parameter, or naming one the function lacks', async () => {
  const wrong = await recordRow('orgs', 'acceptInvitation#accept', 'acceptInvitation', (db) =>
    db.rpc('accept_invitation', { token: 'x' }),
  )
  const r = runGate(fixture({ migration: MIGRATION_CALLS, shapes: [wrong] }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('without its required parameter(s) p_token'), r.out)
  assert.ok(r.out.includes('names token, which public.accept_invitation has no input parameter called'), r.out)
  const out = await recordRow('audit', 'events#first', 'events', (db) =>
    db.rpc('org_audit_events', { _org: 'o', event_id: 1 }),
  )
  const r2 = runGate(fixture({ migration: MIGRATION_CALLS, shapes: [out] }))
  assert.equal(r2.code, 1, r2.out)
  assert.ok(r2.out.includes('names event_id, which public.org_audit_events has no input parameter called'), r2.out)
})

test('RED (1.1.0): an upsert with no matching arbiter — the anti-vacuity drop of the unique index', async () => {
  const migration = MIGRATION_CALLS.replace(
    'CREATE UNIQUE INDEX profiles_handle_key ON public.profiles (handle);',
    'CREATE INDEX profiles_handle_idx ON public.profiles (handle);',
  )
  assert.notEqual(migration, MIGRATION_CALLS)
  const r = runGate(fixture({ migration, shapes: [await handleUpsertRow('handle')] }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('upsert into public.profiles ON CONFLICT (handle)'), r.out)
  assert.ok(r.out.includes('no UNIQUE index or primary key'), r.out)
  // A superset or subset of an index's columns is not an arbiter: the match is a set.
  const r2 = runGate(fixture({ migration: MIGRATION_CALLS, shapes: [await handleUpsertRow('handle,id')] }))
  assert.equal(r2.code, 1, r2.out)
  assert.ok(r2.out.includes('ON CONFLICT (handle, id)'), r2.out)
})

test('RED (1.1.0): an upsert with no onConflict on a table with no primary key', async () => {
  const migration = MIGRATION_CALLS.replace('  CONSTRAINT profiles_pk PRIMARY KEY (id)\n', '  CONSTRAINT profiles_id_check CHECK (id IS NOT NULL)\n')
  assert.notEqual(migration, MIGRATION_CALLS)
  const r = runGate(fixture({ migration, shapes: [await handleUpsertRow(null)] }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('upsert into public.profiles with no onConflict targets the primary key'), r.out)
})

test('RED (1.1.0): a tenant upsert that writes no tenant column', async () => {
  const r = runGate(
    fixture({ migration: MIGRATION_CALLS, shapes: [await noteUpsertRow({ id: 'x', title: 't' })] }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('upsert into tenant table "notes" writes no org_id'), r.out)
  // The upsert is judged as a write: no equality or index-service finding rides along.
  assert.ok(!r.out.includes('no org_id equality'), r.out)
  assert.ok(!r.out.includes('no index on public.notes serves it'), r.out)
})

test('RED (1.1.0): an rpc row with no rpc key, and an upsert row with no onConflict key, fail closed', async () => {
  const { rpc: _r, ...noRpc } = await acceptRow()
  const r = runGate(fixture({ migration: MIGRATION_CALLS, shapes: [noRpc] }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('bad or missing "rpc"'), r.out)
  const { onConflict: _o, ...noConflict } = await handleUpsertRow()
  const r2 = runGate(fixture({ migration: MIGRATION_CALLS, shapes: [noConflict] }))
  assert.equal(r2.code, 1, r2.out)
  assert.ok(r2.out.includes('bad or missing "onConflict"'), r2.out)
})

test('RED (1.1.0): the extra and ceiling rules still judge an rpc row', async () => {
  const row = await recordRow('audit', 'events#page', 'events', (db) =>
    db.rpc('org_audit_events', { _org: 'o' }).range(0, 20).limit(5000),
  )
  const r = runGate(fixture({ migration: MIGRATION_CALLS, shapes: [row] }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('uses .range()'), r.out)
  assert.ok(r.out.includes('exceeds [api].max_rows'), r.out)
})

test('GREEN/RED (1.1.0): parameter modes, mode-prefixed names and unnamed parameters are read from the declaration', async () => {
  const migration = `${MIGRATION_OK}
CREATE FUNCTION public.set_role(INOUT invite_rank smallint, VARIADIC out_tags text[], OUT result text)
LANGUAGE sql AS $$ SELECT 1, 'x' $$;
CREATE FUNCTION public.echo(jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT $1 $$;
CREATE FUNCTION public.scale(double precision) RETURNS float8 LANGUAGE sql AS $$ SELECT $1 $$;
`
  const call = (fn, args) =>
    recordRow('orgs', `${fn}#call`, fn, (db) => db.rpc(fn, args))
  // An INOUT and a VARIADIC parameter are inputs, and a name starting with "in" or "out" is
  // not a mode (parseFunctions' own reading takes "INOUT invite_rank" for a parameter "out").
  const green = runGate(
    fixture({
      migration,
      shapes: [
        await call('set_role', { invite_rank: 1, out_tags: [] }),
        // Unnamed input parameters cannot be matched by name: resolved, arguments not judged.
        await call('echo', { anything: 1 }),
        await call('scale', { x: 1 }),
      ],
    }),
  )
  assert.equal(green.code, 0, green.out)
  assert.ok(green.out.includes('orgs.scale#call -> rpc public.scale'), green.out)
  const red = runGate(fixture({ migration, shapes: [await call('set_role', { rank: 1, result: 'r' })] }))
  assert.equal(red.code, 1, red.out)
  assert.ok(red.out.includes('without its required parameter(s) invite_rank, out_tags'), red.out)
  assert.ok(red.out.includes('names rank, result, which public.set_role has no input parameter called'), red.out)
})
