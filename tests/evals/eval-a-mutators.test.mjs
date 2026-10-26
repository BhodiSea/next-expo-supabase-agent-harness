// Eval A's mutators, one unit test each (2.1.0, #188): every mutator is a pure function of
// the helper and a seed, and makes the second home it names. Read through the extractor
// itself: a rename keeps `alpha` and `lit`, a literal swap keeps `alpha` and changes `lit`,
// an edit changes `alpha`, a schema copy keeps both.
import assert from 'node:assert/strict'
import { MUTATE, MUTATORS, prng, seedFor, sqlRenamed } from '../../scripts/lib/eval-a-mutators.mjs'
import { applySteps } from '../../scripts/lib/eval-b-fixture.mjs'
import { extractTs } from '../../template/base/tools/lib/shapes.mjs'
import { inTree, treeTest, ts } from '../gates/helpers/single-home.mjs'
import { test } from 'node:test'
import { sweep } from '../../template/base/tools/lib/sweep.mjs'

const HELPER = {
  id: 'h00',
  lang: 'ts',
  ext: 'ts',
  text: `export function noteCreated(origin: EventOrigin, noteId: string, occurredAt: string): NoteEvent {
  const { actorId } = origin
  const at = occurredAt.trim()
  return {
    name: 'notes.created',
    payload: { actorId, noteId, occurredAt: at, orgId: origin.orgId, version: 1 },
  }
}
`,
}

const SQL = {
  id: 'h99',
  lang: 'sql',
  ext: 'sql',
  text: `-- the caller's role, as the claims say
create or replace function private.claim_role(p_default text)
returns text language sql stable as $$
  select coalesce(auth.jwt() ->> 'role', p_default, 'anon');
$$;
`,
}

const ws = { dir: 'packages/home', name: '@eval/home' }
/** @returns {any} */
const shape = (text) => extractTs(ts, 'packages/home/src/x.ts', text, ws).callables.find((c) => c.name === 'noteCreated')

/** The one SQL callable of a migration text, through the sweep's SQL leg. */
function sqlShape(text) {
  return inTree({ 'supabase/migrations/20260101000000_x.sql': text }, () => {
    const doc = sweep(null)
    return doc
  })
}

test('every mutator is named, and the generator is a pure function of its seed', () => {
  assert.deepEqual(Object.keys(MUTATE).sort(), [...MUTATORS].sort())
  const a = prng(seedFor(188, 'h01', 'rename'))
  const b = prng(seedFor(188, 'h01', 'rename'))
  assert.deepEqual([a(), a(), a()], [b(), b(), b()])
  assert.notEqual(seedFor(188, 'h01', 'rename'), seedFor(188, 'h01', 'literal'))
})

treeTest('rename: every bound name respelled, shorthand keys kept; alpha and lit unchanged', () => {
  const out = MUTATE.rename(ts, HELPER, 7)
  assert.equal(out, MUTATE.rename(ts, HELPER, 7), 'deterministic')
  assert.doesNotMatch(out, /\(origin\b|\boccurredAt: string|const at\b/)
  assert.match(out, /noteId: \w+_/, 'the shorthand property keeps its key')
  assert.match(out, /\{ actorId: \w+_ \}/, 'the shorthand binding keeps its key')
  const [before, after] = [shape(HELPER.text), shape(out)]
  assert.equal(after.alpha, before.alpha)
  assert.equal(after.lit, before.lit)
  assert.equal(MUTATE.rename(ts, { ...HELPER, text: 'export function f(a: number) { { const a = 1; return a } }\n' }, 1), null, 'a shadowed name is ambiguous')
})

treeTest('literal: one literal changed; alpha unchanged, lit changed', () => {
  const out = MUTATE.literal(ts, HELPER, 3)
  assert.equal(out, MUTATE.literal(ts, HELPER, 3))
  assert.notEqual(out, HELPER.text)
  const [before, after] = [shape(HELPER.text), shape(out)]
  assert.equal(after.alpha, before.alpha)
  assert.notEqual(after.lit, before.lit)
  assert.equal(MUTATE.literal(ts, { ...HELPER, text: 'export function f(a: number) { return a + a }\n' }, 1), null)
})

treeTest('literal (SQL): a body string changed, never one in a comment', () => {
  const out = MUTATE.literal(ts, SQL, 5)
  assert.match(out, /^-- the caller's role, as the claims say$/m)
  assert.notEqual(out, SQL.text)
  const [before, after] = [sqlShape(SQL.text), sqlShape(sqlRenamed(out, 'm'))]
  assert.equal(before.records.length, 0)
  assert.equal(after.records.length, 0)
})

treeTest('reorder: one to three statement edits; alpha changes, the text still parses', () => {
  const out = MUTATE.reorder(ts, HELPER, 11)
  assert.equal(out, MUTATE.reorder(ts, HELPER, 11))
  const after = shape(out)
  assert.ok(after !== undefined, 'parses')
  assert.notEqual(after.alpha, shape(HELPER.text).alpha)
})

treeTest('sibling and move: the helper unchanged (the case tree places it)', () => {
  assert.equal(MUTATE.sibling(ts, HELPER), HELPER.text)
  assert.equal(MUTATE.move(ts, HELPER), HELPER.text)
  assert.equal(MUTATE.sibling(ts, SQL), null, 'a SQL sibling is sql-schema')
})

treeTest('sql-schema: the qualified name moves schema, the body is untouched; TS has none', () => {
  const out = MUTATE['sql-schema'](ts, SQL)
  assert.match(out, /function eval_other\.claim_role\(/)
  assert.equal(out.replace('eval_other.', 'private.'), SQL.text)
  assert.equal(MUTATE['sql-schema'](ts, HELPER), null)
})

treeTest('resemble: property names respelled; alpha changes and most shingles survive', () => {
  const out = MUTATE.resemble(ts, HELPER, 2)
  assert.equal(out, MUTATE.resemble(ts, HELPER, 2))
  assert.match(out, /\.\w+Of\b/)
  const [before, after] = [shape(HELPER.text), shape(out)]
  assert.notEqual(after.alpha, before.alpha)
  let both = 0
  for (const s of before.shingles) if (after.shingles.has(s)) both += 1
  assert.ok(both / before.shingles.size > 0.5, 'a resemblance, not a rewrite')
})

test("the push slice's APPLY.md steps: cp with continuations, cat >>, and Add-a-file blocks", () => {
  const md = [
    '```sh',
    'cp "$SLICE/supabase/x.sql" supabase/migrations/',
    'cp "$SLICE/a/b.ts.txt" \\',
    '   a/b.ts',
    'cat "$SLICE/c.txt" >> packages/c/src/index.ts',
    '```',
    '',
    'Add `packages/p/package.json`. It mirrors notes,',
    'with one difference:',
    '',
    '```json',
    '{ "name": "@app/p" }',
    '```',
    '',
    '```json',
    '{ "not": "a file" }',
    '```',
  ].join('\n')
  assert.deepEqual(applySteps(md), [
    { op: 'copy', src: 'supabase/x.sql', dst: 'supabase/migrations/x.sql' },
    { op: 'copy', src: 'a/b.ts.txt', dst: 'a/b.ts' },
    { op: 'append', src: 'c.txt', dst: 'packages/c/src/index.ts' },
    { op: 'write', dst: 'packages/p/package.json', text: '{ "name": "@app/p" }\n' },
  ])
})
