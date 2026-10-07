// The Single Home extractor (template/base/tools/lib/shapes.mjs, 2.1.0, #186), in process so
// the tools/lib coverage floor counts it: the normaliser, shorthand expansion, the token
// convention's golden, data-shaped bodies, subject ids, the scope and the SQL fold, the
// MinHash signature and the extractor digest.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { signature, subjectId } from '../../template/base/tools/lib/closed-text.mjs'
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
function shapesOf(src, opts, path = 'packages/x/src/a.ts') {
  const file = extractTs(ts, path, src, WS, opts)
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

treeTest("shapes: a method's name is not in scope in its body, so a bare call spelled like it stays as written", () => {
  const c = shapesOf(`
class NotesAdapter {
  async listNotes(orgId: string) { return listNotes(this.client, orgId) }
  async createNote(orgId: string) { return createNote(this.client, orgId) }
}
class A { save(x: number) { return save(x, 1) } }
class B { persist(x: number) { return save(x, 1) } }
`)
  // Two methods delegating to two different free functions are two shapes ...
  assert.notEqual(c['NotesAdapter.listNotes'].alpha, c['NotesAdapter.createNote'].alpha)
  // ... and two delegating to the same one are one, whatever the methods are called.
  assert.equal(c['A.save'].alpha, c['B.persist'].alpha)
  assert.ok(!c['A.save'].stream.includes('$f'), c['A.save'].stream.join(' '))
})

treeTest('shapes: an identifier spelled S or N never reads as a literal placeholder', () => {
  const c = shapesOf(`
const a = (key: string) => lookup(key, S, N)
const b = (key: string) => lookup(key, 'S', 7)
function select<S, N>(state: S, pick: (s: S) => N): N { return pick(state) }
`)
  assert.notEqual(c.a.alpha, c.b.alpha)
  assert.equal(c.a.tokens, c.b.tokens)
  assert.deepEqual([c.a.literals.length, c.b.literals.length], [0, 2])
  assert.equal(literalDensity(c.a.stream), 0)
  assert.equal(literalDensity(c.select.stream), 0)
  assert.equal(literalDensity(c.b.stream), 2 / 14)
})

treeTest('shapes: jsxShare counts the JSX tokens of the stream, so a line break between children changes nothing', () => {
  const c = shapesOf(
    `
const one = () => (<a><b /></a>)
const many = () => (<a>
  <b />
</a>)
const styled = (color: string) => <A style={{ color }} />
`,
    undefined,
    'packages/x/src/a.tsx',
  )
  assert.equal(c.one.alpha, c.many.alpha)
  // ( ) => ( < a > < b / > < / a > ): 11 of its 16 tokens are JSX, however it is laid out.
  assert.equal(c.one.jsxShare, 11 / 16)
  assert.equal(c.many.jsxShare, 11 / 16)
  // ( $1 : string ) => < A style = { { color : $1 } } / >: 13 of 19, the expanded shorthand
  // counting every token it pushes.
  assert.equal(c.styled.jsxShare, 13 / 19)
})

treeTest('shapes: the JSX share leaves out a function nested in the JSX, such as an inline handler', () => {
  const c = shapesOf(
    `
const inline = (open: boolean) => <button onClick={() => { setOpen(!open); log(open) }}>x</button>
const named = (open: boolean) => <button onClick={toggle}>x</button>
`,
    undefined,
    'packages/x/src/a.tsx',
  )
  // ( $1 : boolean ) => < button onClick = { ( ) => { … } } > S < / button >: the element is
  // 27 of the 33 tokens, but the handler's own 15 are code, so 12 count. Passed by name, the
  // handler is one token of the element's 13, out of 19.
  assert.equal(c.inline.jsxShare, 12 / 33)
  assert.equal(c.named.jsxShare, 13 / 19)
})

treeTest('shapes: JSX text is the literal JSX renders: a space between children is one, line-break whitespace none', () => {
  const c = shapesOf(
    `
const spaced = (a: string, b: string) => <p>{a} {b}</p>
const joined = (a: string, b: string) => <p>{a}{b}</p>
const lead = (n: number) => <p>{n} items</p>
const run = (n: number) => <p>{n}items</p>
const inline = () => <p>No notes yet. Create your first note.</p>
const wrapped = () => <p>
    No notes yet. Create your first note.
  </p>
const broken = () => <p>No notes yet.
    Create your first note.</p>
`,
    undefined,
    'packages/x/src/a.tsx',
  )
  // A space between two children renders, so it is a literal and the bodies are two shapes.
  assert.notEqual(c.spaced.alpha, c.joined.alpha)
  assert.deepEqual([c.spaced.literals, c.joined.literals], [[' '], []])
  // A space before a child's text renders too.
  assert.notEqual(c.lead.lit, c.run.lit)
  assert.deepEqual([c.lead.literals, c.run.literals], [[' items'], ['items']])
  // The whitespace around a line break is formatting: wrapped onto its own line, or broken
  // across two, the text is the one JSX renders, so the literals are equal.
  for (const other of [c.wrapped, c.broken]) {
    assert.equal(other.alpha, c.inline.alpha)
    assert.equal(other.lit, c.inline.lit)
    assert.deepEqual(other.literals, ['No notes yet. Create your first note.'])
  }
})

treeTest('shapes: a callable no closed printer can name is not extracted; one inside it scopes past it', () => {
  const c = shapesOf(`
export class Counter {
  #n = 0
  #next(): number { return this.#n + 1 }
  'kebab-name'(): number { return 1 }
  0(): number { return 0 }
  [Symbol.iterator]() { return [][Symbol.iterator]() }
  bump(): number { this.#n = this.#next(); return this.#n }
}
export class $Store { read(): number { return 1 } }
export const $t = (k: string) => {
  const inner = () => k.trim()
  return inner()
}
function café(): number { return 1 }
`)
  assert.deepEqual(Object.keys(c).sort(), ['Counter.bump', 'inner'])
  assert.equal(c.inner.scope, '')
})

treeTest('shapes: only a callable declared in the file itself is top-level, and only such a one is exported', () => {
  const c = shapesOf(`
export function shown(): number { return 1 }
const listed = () => 2
export { listed, nested }
export class Store {
  constructor() { const nested = () => 3; void nested }
  get size(): number { const inGetter = () => 4; return inGetter() }
  read(): number { return 5 }
}
export const api = { prep() { const inObject = () => 6; return inObject() } }
register(() => { const inCallback = () => 7; return inCallback() })
class Local { read(): number { return 8 } }
export function outer(): number {
  class Inner { read(): number { return 9 } }
  return new Inner().read()
}
`)
  const facts = Object.fromEntries(
    Object.entries(c).map(([name, x]) => [name, [x.topLevel, x.exported, x.scope]]),
  )
  // A constructor, an accessor, an object literal's method and a callback are not extracted,
  // so what sits in them has scope '' like a top-level callable, but is not one: nothing can
  // import it, whatever an export list names.
  assert.deepEqual(facts, {
    shown: [true, true, ''],
    listed: [true, true, ''],
    nested: [false, false, ''],
    inGetter: [false, false, ''],
    'Store.read': [true, true, ''],
    inObject: [false, false, ''],
    inCallback: [false, false, ''],
    'Local.read': [true, false, ''],
    outer: [true, true, ''],
    'Inner.read': [false, false, 'outer'],
  })
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

treeTest('shapes: a bare arrow parameter signs as its parenthesised twin, and the arrow is not in the signature', () => {
  const c = shapesOf(`
const double = x => x * 2
const triple = (x) => x * 3
const typed = (x: number): number => x * 4
`)
  assert.deepEqual(c.double.sig, ['(', 'x', ')'])
  assert.deepEqual(c.double.sig, c.triple.sig)
  assert.equal(signature.print(c.double.sig), '`(x)`')
  assert.equal(signature.print(c.typed.sig), '`(x: number): number`')
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

/** The SQL callables of one migration, by name. @param {string} sql */
const sqlOf = (sql) =>
  inTree({ 'supabase/migrations/20260101000000_a.sql': sql }, () =>
    Object.fromEntries(extractTree(null).callables.map((c) => [c.name, c])),
  )
/** A `language sql` function of `params` whose body is `select <body>`. */
const SQL_FN = (name, params, body, returns = 'int') =>
  `CREATE FUNCTION public.${name}(${params}) RETURNS ${returns} LANGUAGE sql AS $$ select ${body} $$;\n`

test('shapes: a SQL parameter whose name starts with in, out or variadic is bound like any other', () => {
  const c = sqlOf(
    SQL_FN('a', 'invitation_id uuid', 'invitation_id', 'uuid') +
      SQL_FN('b', 'token_id uuid', 'token_id', 'uuid') +
      SQL_FN('c', 'input jsonb', "input -> 'k'", 'jsonb') +
      SQL_FN('d', 'payload jsonb', "payload -> 'k'", 'jsonb') +
      SQL_FN('e', 'INOUT outcome int, VARIADIC index int[]', 'outcome + index[1]') +
      SQL_FN('f', 'INOUT x int, VARIADIC y int[]', 'x + y[1]'),
  )
  assert.equal(c['public.a'].alpha, c['public.b'].alpha, c['public.a'].stream.join(' '))
  assert.equal(c['public.c'].alpha, c['public.d'].alpha, c['public.c'].stream.join(' '))
  assert.equal(c['public.e'].alpha, c['public.f'].alpha, c['public.e'].stream.join(' '))
  assert.deepEqual(c['public.e'].stream.slice(0, 9), ['(', 'inout', '$1', 'int', ',', 'variadic', '$2', 'int', '['])
})

test("shapes: an unnamed SQL parameter's type stays as written, whatever its spelling", () => {
  const c = sqlOf(
    SQL_FN('by_uuid', 'uuid', '$1::uuid', 'uuid') +
      SQL_FN('by_text', 'text', '$1::text', 'text') +
      SQL_FN('by_big', 'IN bigint', '$1') +
      SQL_FN('by_int', 'IN int', '$1') +
      SQL_FN('spelled', 'double precision, timestamp with time zone, character varying(9), uuid DEFAULT null', '1'),
  )
  assert.notEqual(c['public.by_uuid'].alpha, c['public.by_text'].alpha)
  assert.notEqual(c['public.by_uuid'].lit, c['public.by_text'].lit)
  assert.deepEqual(c['public.by_uuid'].stream.slice(0, 5), ['(', 'uuid', ')', 'returns', 'uuid'])
  assert.notEqual(c['public.by_big'].alpha, c['public.by_int'].alpha)
  const spelled = c['public.spelled'].stream
  assert.deepEqual(spelled.slice(0, spelled.indexOf('returns')), [
    '(', 'double', 'precision', ',', 'timestamp', 'with', 'time', 'zone', ',',
    'character', 'varying', '(', 'N', ')', ',', 'uuid', 'default', 'null', ')',
  ])
})

test('shapes: a positional $n is the parameter it names, never a literal', () => {
  const c = sqlOf(
    SQL_FN('sub_a', 'a int, b int', '$1 - $2') +
      SQL_FN('sub_b', 'a int, b int', '$2 - $1') +
      SQL_FN('sub_c', 'a int, b int', 'a - b') +
      SQL_FN('pos_a', 'int, int', '$1 - $2') +
      SQL_FN('pos_b', 'int, int', '$2 - $1') +
      SQL_FN('mixed', 'OUT r int, a int', '$1') +
      SQL_FN('mixed_named', 'OUT r int, a int', 'a'),
  )
  assert.notEqual(c['public.sub_a'].alpha, c['public.sub_b'].alpha)
  assert.equal(c['public.sub_a'].alpha, c['public.sub_c'].alpha)
  assert.deepEqual(c['public.sub_a'].literals, [])
  assert.deepEqual(c['public.sub_a'].stream.slice(-5), ['select', '$1', '-', '$2', '$$'])
  assert.notEqual(c['public.pos_a'].alpha, c['public.pos_b'].alpha)
  // A `language sql` body numbers its input parameters only: $1 there is `a`, not `r`.
  assert.equal(c['public.mixed'].alpha, c['public.mixed_named'].alpha)
})

test('shapes: a nested SQL block comment ends at its outermost `*/`', () => {
  const c = sqlOf(
    SQL_FN('nbc', 'p int', '/* outer /* inner */ still a comment */ p') + SQL_FN('plain', 'p int', 'p'),
  )
  assert.equal(c['public.nbc'].alpha, c['public.plain'].alpha, c['public.nbc'].stream.join(' '))
  assert.equal(c['public.nbc'].tokens, c['public.plain'].tokens)
})

test('shapes: a SQL signature is the parameter list as written, balanced, and prints', () => {
  const c = sqlOf(
    SQL_FN('named', 'p_org_id uuid', 'p_org_id', 'uuid') +
      SQL_FN('money', 'p_amount numeric(10,2), p_label text', 'p_label', 'text') +
      SQL_FN('noargs', '', '1'),
  )
  assert.equal(signature.print(c['public.named'].sig), '`(p_org_id uuid)`')
  assert.equal(signature.print(c['public.money'].sig), '`(p_amount numeric(N, N), p_label text)`')
  assert.equal(signature.print(c['public.noargs'].sig), '`()`')
})

test('shapes: SQL overloads fold apart, and a DROP FUNCTION drops what it names', () => {
  const c = inTree(
    {
      'supabase/migrations/20260101000000_a.sql':
        SQL_FN('g', '_a int', '_a') +
        SQL_FN('g', '_a int, _b int', '_a + _b') +
        SQL_FN('h', '', '1') +
        SQL_FN('k', '', '2') +
        SQL_FN('m', 'x text', '4') +
        SQL_FN('n', 'x varchar(9)', '5') +
        SQL_FN('p', 'x notes.id%TYPE', '6') +
        SQL_FN('q', 'x int', '7'),
      'supabase/migrations/20260102000000_b.sql': `CREATE OR REPLACE FUNCTION public.g(_a int) RETURNS int LANGUAGE sql AS $$ select _a * 2 $$;
DROP FUNCTION public.g(IN integer, int4), public.h(), public.k();
DROP FUNCTION IF EXISTS public.m;
DROP FUNCTION public.n(character varying);
DROP FUNCTION public.p(uuid);
DROP FUNCTION IF EXISTS public.q(text);
`,
    },
    () => extractTree(null).callables,
  )
  // p's type reads differently in its DROP; PostgreSQL refuses a DROP that matches nothing, so
  // the name's one overload is the one dropped. q's IF EXISTS named a signature q never had.
  assert.deepEqual(c.map((x) => [x.subject, x.arity, x.path.slice(-5)]), [
    ['sql:public.g', 1, 'b.sql'],
    ['sql:public.q', 1, 'a.sql'],
  ])
  assert.ok(c[0].stream.includes('*'))
})

test('shapes: the trail wrappers and the shared pair they call are all live, each its own subject', () => {
  const c = inTree(
    {
      'supabase/migrations/20260202000000_audit.sql': SQL_FN('ensure', '_months int DEFAULT 3', '_months'),
      'supabase/migrations/20261007000000_shared.sql':
        SQL_FN('ensure', '_parent regclass, _months int', '_months') +
        SQL_FN('ensure', '_months int DEFAULT 3', "public.ensure('x'::regclass, _months)").replace('CREATE', 'CREATE OR REPLACE'),
    },
    () => extractTree(null).callables,
  )
  assert.deepEqual(c.map((x) => [x.subject, x.arity, x.path.slice(-10)]), [
    ['sql:public.ensure', 1, 'shared.sql'],
    ['sql:public.ensure_2', 2, 'shared.sql'],
  ])
  for (const x of c) assert.ok(subjectId.ok(x.subject), x.subject)
})

test("shapes: an overload's ordinal skips a real `<fn>_2`, so no two callables share a subject", () => {
  const c = inTree(
    {
      'supabase/migrations/20260101000000_f.sql':
        SQL_FN('f', 'a int', 'a') + SQL_FN('f', 'a int, b int', 'a + b') + SQL_FN('f_2', 'a int', 'a * 2'),
    },
    () => extractTree(null).callables,
  )
  assert.deepEqual(c.map((x) => [x.name, x.arity, x.subject]), [
    ['public.f', 1, 'sql:public.f'],
    ['public.f', 2, 'sql:public.f_3'],
    ['public.f_2', 1, 'sql:public.f_2'],
  ])
})

test('shapes: an ordinal on a long name cuts the name, so the subject still prints; an over-long SQL name is skipped', () => {
  const long = 'a'.repeat(62)
  const c = inTree(
    {
      'supabase/migrations/20260101000000_long.sql':
        SQL_FN(long, 'x int', 'x') + SQL_FN(long, 'x int, y int', 'x + y') + SQL_FN('c'.repeat(64), 'x int', 'x'),
    },
    () => extractTree(null).callables,
  )
  assert.deepEqual(c.map((x) => x.subject), [`sql:public.${long}`, `sql:public.${'a'.repeat(61)}_2`])
  for (const x of c) assert.ok(subjectId.ok(x.subject), x.subject)
})

/** `sql` with its CREATE FUNCTION statements made CREATE OR REPLACE. @param {string} sql */
const orReplace = (sql) => sql.replaceAll('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')

test('shapes: a comma inside an ARRAY[...] default splits no SQL parameter', () => {
  // Read as a split, `'admin' ]` became a third parameter: has_role kept a key its DROP never
  // named, kept a stale twin beside its REPLACE, and pick_a's `$2` took that phantom's slot.
  const roles = "p_org uuid, p_roles text[] DEFAULT ARRAY['owner', 'admin']"
  const pick = "a text[] DEFAULT ARRAY['x', 'y'], b int DEFAULT 0"
  const c = inTree(
    {
      'supabase/migrations/20260101000000_a.sql':
        SQL_FN('has_role', roles, 'p_org is not null', 'boolean') +
        SQL_FN('can', roles, 'p_org is not null', 'boolean') +
        SQL_FN('pick_a', pick, '$2') +
        SQL_FN('pick_b', pick, 'b'),
      'supabase/migrations/20260102000000_b.sql': `DROP FUNCTION IF EXISTS public.has_role(uuid, text[]);
${orReplace(SQL_FN('can', "p_org uuid, p_roles text[] DEFAULT ARRAY['owner']", 'true', 'boolean'))}`,
    },
    () => extractTree(null).callables,
  )
  assert.deepEqual(c.map((x) => [x.subject, x.arity, x.path.slice(-5)]), [
    ['sql:public.can', 2, 'b.sql'],
    ['sql:public.pick_a', 2, 'a.sql'],
    ['sql:public.pick_b', 2, 'a.sql'],
  ])
  assert.equal(c[1].alpha, c[2].alpha, c[1].stream.join(' '))
})

test('shapes: a CREATE OR REPLACE that spells a type differently replaces the overload it names', () => {
  // PostgreSQL resolves `%TYPE` at CREATE, and `vector` through the search_path, so each REPLACE
  // here replaces the one function its parameter names identify; a REPLACE never renames an
  // input parameter, so `renamed` with a new name is an overload, as is `pair`'s third, which
  // could replace either of two. A schemas copy in the old spelling fills in nothing.
  const c = inTree(
    {
      'supabase/migrations/20260101000000_a.sql':
        SQL_FN('archive', 'p_note public.notes.id%TYPE', 'p_note', 'uuid') +
        SQL_FN('match', 'q vector(1536), n int DEFAULT 10', 'n') +
        SQL_FN('renamed', 'p_id public.notes.id%TYPE', 'p_id', 'uuid') +
        SQL_FN('pair', 'p_id uuid', 'p_id', 'uuid') +
        SQL_FN('pair', 'p_id text', '1', 'uuid'),
      'supabase/migrations/20260102000000_b.sql': orReplace(
        SQL_FN('archive', 'p_note uuid', 'p_note', 'uuid') +
          SQL_FN('match', 'q extensions.vector(1536), n int DEFAULT 10', 'n + 1') +
          SQL_FN('renamed', 'p_other uuid', 'p_other', 'uuid') +
          SQL_FN('pair', 'p_id public.notes.id%TYPE', '2', 'uuid'),
      ),
      'supabase/schemas/10_docs.sql': SQL_FN('match', 'q vector(1536), n int DEFAULT 10', 'n + 1'),
    },
    () => extractTree(null).callables,
  )
  assert.deepEqual(c.map((x) => [x.subject, x.path.slice(-5)]), [
    ['sql:public.archive', 'b.sql'],
    ['sql:public.match', 'b.sql'],
    ['sql:public.renamed', 'a.sql'],
    ['sql:public.pair', 'a.sql'],
    ['sql:public.pair_2', 'a.sql'],
    ['sql:public.renamed_2', 'b.sql'],
    ['sql:public.pair_3', 'b.sql'],
  ])
})

test('shapes: an unnamed `text ARRAY` parameter is the type text[], and binds no name', () => {
  const c = inTree(
    {
      'supabase/migrations/20260101000000_a.sql':
        SQL_FN('arr_kw', 'text ARRAY', '$1[1]::text', 'text') +
        SQL_FN('first_of', 'text ARRAY', '$1[1]', 'text') +
        SQL_FN('first_of', 'uuid ARRAY', '$1[1]', 'uuid') +
        SQL_FN('named', 'a text ARRAY', 'a[1]', 'text'),
      'supabase/migrations/20260102000000_b.sql': `DROP FUNCTION IF EXISTS public.arr_kw(text[]);
${orReplace(SQL_FN('first_of', 'text[]', '$1[2]', 'text'))}`,
    },
    () => extractTree(null).callables,
  )
  assert.deepEqual(c.map((x) => [x.subject, x.path.slice(-5)]), [
    ['sql:public.first_of', 'b.sql'],
    ['sql:public.first_of_2', 'a.sql'],
    ['sql:public.named', 'a.sql'],
  ])
  assert.deepEqual(c[1].stream.slice(0, 6), ['(', 'uuid', 'array', ')', 'returns', 'uuid'])
})

test('shapes: the extractor digest is 12 hex and moves with the parser version', () => {
  const a = extractorDigest({ version: '6.0.3' })
  assert.match(a, /^[0-9a-f]{12}$/)
  assert.equal(extractorDigest({ version: '6.0.3' }), a)
  assert.notEqual(extractorDigest({ version: '6.0.4' }), a)
  assert.notEqual(extractorDigest(null), a)
})
