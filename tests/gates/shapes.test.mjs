// The Single Home extractor (template/base/tools/lib/shapes.mjs, 2.1.0, #186), in process so
// the tools/lib coverage floor counts it: the normaliser, shorthand expansion, the token
// convention's golden, data-shaped bodies, subject ids, the scope and the SQL fold, the
// MinHash signature and the extractor digest.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { subjectId } from '../../template/base/tools/lib/closed-text.mjs'
import {
  extractorDigest,
  extractTree,
  extractTs,
  isDataShaped,
  literalDensity,
  minhash,
  repetitionRatio,
  shingles,
  TOKEN_CONVENTION,
} from '../../template/base/tools/lib/shapes.mjs'
import { GOLDEN, inTree, pkg, treeTest, ts } from './helpers/single-home.mjs'

const WS = { dir: 'packages/x', name: '@app/x' }

/** The callables of one source, by name. */
function shapesOf(src, opts) {
  const file = extractTs(ts, 'packages/x/src/a.ts', src, WS, opts)
  return Object.fromEntries(file.callables.map((c) => [c.name, c]))
}

// ── the normaliser ──────────────────────────────────────────────────────────────

treeTest('shapes: renaming every local, parameter and the function itself leaves alpha unchanged', () => {
  const c = shapesOf(`
export function total(rows: readonly number[], seed: number): number {
  let sum = seed
  for (const row of rows) sum += row
  try { return sum } catch (err) { return total([], 0) }
}
function grand(xs: readonly number[], start: number): number {
  let acc = start
  for (const x of xs) acc += x
  try { return acc } catch (e) { return grand([], 0) }
}
`)
  assert.equal(c.total.alpha, c.grand.alpha)
  assert.equal(c.total.lit, c.grand.lit)
})

treeTest('shapes: swapping a literal changes lit and not alpha, for strings, templates and numbers', () => {
  const c = shapesOf(`
const a = (n: number) => ({ code: 'x', at: \`p\${n}\`, limit: 10 })
const b = (n: number) => ({ code: 'y', at: \`p\${n}\`, limit: 10 })
const d = (n: number) => ({ code: 'x', at: \`q\${n}\`, limit: 10 })
const e = (n: number) => ({ code: 'x', at: \`p\${n}\`, limit: 20 })
`)
  for (const other of [c.b, c.d, c.e]) {
    assert.equal(other.alpha, c.a.alpha)
    assert.notEqual(other.lit, c.a.lit)
  }
  assert.deepEqual(c.a.stream.filter((t) => t === 'S' || t === 'N'), ['S', 'S', 'S', 'N'])
})

treeTest('shapes: properties, keys, free identifiers and types are kept as written', () => {
  const c = shapesOf(`
const a = (x: Row) => x.title.trim()
const b = (x: Row) => x.body.trim()
const d = (x: Note) => x.title.trim()
const e = (x: Row) => y.title.trim()
`)
  assert.notEqual(c.a.alpha, c.b.alpha)
  assert.notEqual(c.a.alpha, c.d.alpha)
  assert.notEqual(c.a.alpha, c.e.alpha)
})

treeTest('shapes: { noteId } and { noteId: noteId } hash equal, in a literal and in a binding', () => {
  const c = shapesOf(`
const a = (noteId: string) => ({ noteId })
const b = (noteId: string) => ({ noteId: noteId })
const d = (o: { noteId: string }) => { const { noteId } = o; return noteId }
const e = (o: { noteId: string }) => { const { noteId: noteId } = o; return noteId }
`)
  assert.equal(c.a.alpha, c.b.alpha)
  assert.equal(c.d.alpha, c.e.alpha)
})

const EVENTS = `
export function noteCreated(origin: EventOrigin, noteId: string, occurredAt: string): NoteEvent {
  return {
    name: 'notes.created',
    payload: { actorId: origin.actorId, noteId, occurredAt, orgId: origin.orgId },
  }
}
export function taskCreated(origin: EventOrigin, taskId: string, occurredAt: string): NoteEvent {
  return {
    name: 'notes.created',
    payload: { actorId: origin.actorId, taskId, occurredAt, orgId: origin.orgId },
  }
}
`

treeTest('shapes: taskCreated does not share alpha with noteCreated; without expansion it would', () => {
  const on = shapesOf(EVENTS)
  assert.notEqual(on.taskCreated.alpha, on.noteCreated.alpha)
  const off = shapesOf(EVENTS, { expand: false })
  assert.equal(off.taskCreated.alpha, off.noteCreated.alpha)
})

// ── the token convention ────────────────────────────────────────────────────────
// The plan's named functions (SINGLE-HOME §2.1, G.5; GOLDEN, in helpers/single-home.mjs). The
// counts are the convention's: TOKEN_CONVENTION states it, and these pin it.

treeTest('shapes: the token golden for the named functions', () => {
  const got = {}
  for (const [name, [, src]] of Object.entries(GOLDEN)) got[name] = shapesOf(src)[name].tokens
  assert.deepEqual(got, Object.fromEntries(Object.entries(GOLDEN).map(([n, [count]]) => [n, count])))
  // noteCreated is 44 before shorthand expansion adds `noteId :` and `occurredAt :`.
  assert.equal(shapesOf(GOLDEN.noteCreated[1], { expand: false }).noteCreated.tokens, 44)
  assert.match(TOKEN_CONVENTION, /^tc1: /)
})

treeTest('shapes: a bare arrow parameter counts its implied parentheses; type parameters do not count', () => {
  const c = shapesOf(`
const a = x => x + 1
const b = (x) => x + 1
function f<T>(x: T): T { return x }
function g(x: T): T { return x }
`)
  assert.equal(c.a.tokens, c.b.tokens)
  assert.equal(c.f.tokens, c.g.tokens)
})

// ── data-shaped bodies ──────────────────────────────────────────────────────────

treeTest('shapes: a table of literals is data-shaped; row 23 (noteCreated) is not', () => {
  const c = shapesOf(`
const table = () => [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5], ['f', 6], ['g', 7]]
${GOLDEN.noteCreated[1]}
`)
  assert.equal(c.table.dataShaped, true)
  assert.equal(c.noteCreated.dataShaped, false)
  assert.ok(c.noteCreated.rnr >= 0.9, String(c.noteCreated.rnr))
  assert.ok(literalDensity(c.noteCreated.stream) < 0.05)
})

test('shapes: the repetition ratio and literal density of plain streams', () => {
  assert.equal(repetitionRatio(['a', 'b', 'c', 'd']), 1)
  assert.ok(repetitionRatio(['x', ',', 'x', ',', 'x', ',', 'x', ',']) < 0.5)
  assert.equal(literalDensity([]), 0)
  assert.equal(literalDensity(['S', 'N', 'a', 'b']), 0.5)
  assert.equal(isDataShaped(['S', 'S', 'S', 'a']), true)
  assert.equal(isDataShaped(['a', 'b', 'c', 'd']), false)
})

test('shapes: MinHash is 64 fixed-seed values, equal for equal shingle sets', () => {
  const one = minhash(shingles(['a', 'b', 'c', 'd', 'e']))
  assert.equal(one.length, 64)
  assert.deepEqual(minhash(shingles(['a', 'b', 'c', 'd', 'e'])), one)
  assert.notDeepEqual(minhash(shingles(['a', 'b', 'c', 'd', 'f'])), one)
  assert.ok(one.every((n) => Number.isInteger(n) && n >= 0 && n < 2 ** 32))
})

// ── subjects and scope ──────────────────────────────────────────────────────────

const TREE = {
  'packages/x/package.json': pkg('@app/x'),
  'packages/x/src/a.ts': `
export function shared(): number { return 1 }
export function once(): number { return 2 }
function hidden(): number {
  const inner = () => 3
  return inner()
}
export class Store { read(): number { return 4 } }
`,
  'packages/x/src/b.ts': `
export function shared(): number { return 5 }
function other(): number {
  const inner = () => 6
  return inner()
}
`,
  'packages/x/src/b.test.ts': 'export function tested(): number { return 7 }\n',
  'packages/x/src/types.d.ts': 'export declare function declared(): number\n',
  'packages/x/src/generated/out.ts': 'export function made(): number { return 8 }\n',
  'packages/x/src/schema.gen.ts': 'export function gen(): number { return 9 }\n',
  'packages/x/src/database.types.ts': 'export function db(): number { return 10 }\n',
  'apps/web/lib/w.ts': 'export function onWeb(): number { return 11 }\n',
  'apps/web/package.json': pkg('web'),
  'supabase/migrations/20260101000000_a.sql': `CREATE FUNCTION app.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
CREATE FUNCTION app.g() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
`,
  'supabase/migrations/20260102000000_b.sql': `CREATE OR REPLACE FUNCTION app.f() RETURNS int LANGUAGE sql AS $$ SELECT 2 + 2 $$;
DROP FUNCTION app.g();
`,
  'supabase/schemas/10_app.sql': `CREATE FUNCTION app.h() RETURNS int LANGUAGE sql AS $$ SELECT 3 $$;
CREATE FUNCTION app.f() RETURNS int LANGUAGE sql AS $$ SELECT 9 $$;
`,
}

treeTest('shapes: subject ids follow v2, every one passes the closed subject printer', () => {
  inTree(TREE, () => {
    const { callables } = extractTree(ts)
    const subjects = callables.map((c) => c.subject).sort()
    assert.deepEqual(subjects, [
      '@app/x#once',
      'packages/x/src/a.ts#Store.read',
      'packages/x/src/a.ts#hidden',
      'packages/x/src/a.ts#hidden.inner',
      'packages/x/src/a.ts#shared',
      'packages/x/src/b.ts#other',
      'packages/x/src/b.ts#other.inner',
      'packages/x/src/b.ts#shared',
      'sql:app.f',
      'sql:app.h',
      'web#onWeb',
    ])
    for (const s of subjects) assert.ok(subjectId.ok(s), s)
  })
})

treeTest('shapes: SQL folds last-wins across migrations, a DROP removes, schemas fill in only what is missing', () => {
  inTree(TREE, () => {
    const sql = extractTree(ts).callables.filter((c) => c.lang === 'sql')
    const f = sql.find((c) => c.name === 'app.f')
    assert.equal(f.path, 'supabase/migrations/20260102000000_b.sql')
    assert.ok(f.stream.includes('+'), f.stream.join(' '))
    assert.equal(sql.find((c) => c.name === 'app.h')?.path, 'supabase/schemas/10_app.sql')
    assert.equal(sql.some((c) => c.name === 'app.g'), false)
  })
})

test('shapes: with no parser the tree is the SQL half alone', () => {
  inTree(TREE, () => {
    const { files, callables } = extractTree(null)
    assert.equal(files.length, 0)
    assert.deepEqual(callables.map((c) => c.subject).sort(), ['sql:app.f', 'sql:app.h'])
  })
})

const DENY = (schema) => `CREATE FUNCTION ${schema}.deny_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $deny$
BEGIN
  RAISE EXCEPTION '${schema}.events is append-only (% on % refused)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '42501',
          HINT = 'Rows are never updated or deleted. Remove history by dropping a partition: ${schema}.drop_partitions_older_than(interval).';
END
$deny$;
`

test('shapes: the SQL golden: deny_mutation is 31 tokens, one alpha for both trails, two literals apart', () => {
  inTree(
    {
      'supabase/migrations/20260202000000_audit.sql': DENY('audit'),
      'supabase/migrations/20260816000000_auth_event_trail.sql': DENY('auth_trail'),
    },
    () => {
      const [a, b] = extractTree(null).callables
      assert.equal(a.tokens, 31)
      assert.equal(a.alpha, b.alpha)
      assert.notEqual(a.lit, b.lit)
      assert.equal(a.literals.filter((x, i) => x !== b.literals[i]).length, 2)
    },
  )
})

// Row 4 (ensure_partitions) read as a near-miss until the body was tokenised from the raw
// statement: the audit copy carries comments the auth_trail copy does not, and a comment
// with an apostrophe, read from the whitespace-normalized text, swallowed the rest of the
// body. A comment changes nothing a reader of the code would call the code.
const PARTITIONS = (schema, comment) => `CREATE FUNCTION ${schema}.ensure_partitions(_months_ahead int DEFAULT 3)
RETURNS int
LANGUAGE plpgsql
AS $ensure$
DECLARE
  _i int := 0; ${comment ? "-- the loop's counter" : ''}
  _created int := 0;
BEGIN
  WHILE _i <= _months_ahead LOOP
    ${comment ? "-- Direct access is judged by the PARTITION's own RLS, not the parent's." : ''}
    EXECUTE format('ALTER TABLE ${schema}.%I ENABLE ROW LEVEL SECURITY', 'events');
    EXECUTE format('ALTER TABLE ${schema}.%I FORCE ROW LEVEL SECURITY', 'events');
    _created := _created + 1;
    _i := _i + 1;
  END LOOP;
  RETURN _created;
END
$ensure$;
`

test('shapes: a comment inside a SQL body ends at its line, so it changes no token', () => {
  inTree(
    {
      'supabase/migrations/20260202000000_audit.sql': PARTITIONS('audit', true),
      'supabase/migrations/20260816000000_auth_event_trail.sql': PARTITIONS('auth_trail', false),
    },
    () => {
      const [a, b] = extractTree(null).callables
      assert.equal(a.alpha, b.alpha)
      assert.equal(a.tokens, b.tokens)
      assert.equal(a.stmts, 9)
      assert.equal(a.line, 1)
      // Both DECLAREd locals are bound, the one after the comment included, and the body
      // runs to its end.
      assert.deepEqual(a.stream.slice(-5), ['return', '$3', ';', 'end', '$$'])
    },
  )
})

test("shapes: a backslash in a SQL string is an ordinary character, so `'a\\'` ends there", () => {
  // As sql-parse.mjs scans it: `''` is a string's only escape. Read as an escape, the
  // backslash would run the first string on through `|| '`, and an unterminated string of
  // many backslash pairs would backtrack exponentially.
  inTree(
    {
      'supabase/migrations/20260101000000_slash.sql':
        "CREATE FUNCTION private.slash() RETURNS text LANGUAGE sql AS $$ SELECT 'a\\' || 'b' $$;\n",
    },
    () => {
      const [fn] = extractTree(null).callables
      assert.deepEqual(fn.stream.slice(-5), ['select', 'S', '||', 'S', '$$'])
    },
  )
})

test('shapes: the extractor digest is 12 hex and moves with the parser version', () => {
  const a = extractorDigest({ version: '6.0.3' })
  assert.match(a, /^[0-9a-f]{12}$/)
  assert.equal(extractorDigest({ version: '6.0.3' }), a)
  assert.notEqual(extractorDigest({ version: '6.0.4' }), a)
  assert.notEqual(extractorDigest(null), a)
})
