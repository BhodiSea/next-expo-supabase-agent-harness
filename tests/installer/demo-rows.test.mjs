// installer/lib/demo-rows.mjs (2.0.0, #85): how `eject` trims a register the project changed
// after `init --with-demo`. In-process and pure: every case hands texts in and reads the
// trimmed text back, so each branch of the delete and restore rules has its own proof (the
// installer-unit job holds installer/** to coverage floors, on Windows too).
//
// The rules under test: a demo row goes only where it still EQUALS the row the demo shipped
// (pointer first, then by value in the same container, so a project row that shifted an
// array cannot be deleted in its place); array rows go in descending order; a default row
// the demo dropped or changed comes back only where it is absent, in the default's position;
// and a row that cannot be judged is KEPT and reported, never guessed at.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  canonical,
  pointerTokens,
  readDemoIndex,
  resolvePointer,
  rowKeyOf,
  tokensToPointer,
  trimDemoRows,
} from '../../installer/lib/demo-rows.mjs'

const made = []
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

const j = (v) => `${JSON.stringify(v, null, 2)}\n`
const DEFAULT = { comment: 'default', buckets: ['read', 'write'], procedures: { 'system.me': 'read' }, rows: [{ id: 'a' }] }
const DEMO = {
  comment: 'demo',
  buckets: ['read', 'write'],
  procedures: { 'notes.create': 'write', 'system.me': 'read' },
  rows: [{ id: 'a' }, { id: 'n1' }, { id: 'n2' }],
}
const ROWS = [
  { file: 'r.json', jsonPointer: '/comment' },
  { file: 'r.json', jsonPointer: '/comment', restore: true },
  { file: 'r.json', jsonPointer: '/procedures/notes.create' },
  { file: 'r.json', jsonPointer: '/rows/1' },
  { file: 'r.json', jsonPointer: '/rows/2' },
]

test('pointer helpers: RFC 6901 escapes round-trip, and a non-pointer throws', () => {
  assert.deepEqual(pointerTokens('/a~1b/c~0d'), ['a/b', 'c~d'])
  assert.equal(tokensToPointer(['a/b', 'c~d']), '/a~1b/c~0d')
  assert.throws(() => pointerTokens('a'), /not a JSON pointer/)
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 0 }] }), canonical({ a: [2, { c: 0, d: 1 }], b: 1 }))
})

test('resolvePointer: found values carry their container; misses of every kind are not found', () => {
  const doc = { a: [{ b: 1 }], s: 'x' }
  const hit = resolvePointer(doc, '/a/0/b')
  assert.ok(hit.found && hit.value === 1 && hit.key === 'b')
  for (const p of ['/a/1', '/a/x', '/a/01', '/z', '/s/0']) assert.equal(resolvePointer(doc, p).found, false, p)
  assert.equal(resolvePointer(doc, '').found, false)
})

test('an unchanged demo register trims back to the default exactly', () => {
  const r = trimDemoRows('r.json', j(DEMO), j(DEMO), j(DEFAULT), ROWS)
  assert.deepEqual(JSON.parse(r.content), DEFAULT)
  assert.deepEqual(r.kept, [])
  assert.equal(r.deleted.length, 4)
  assert.deepEqual(r.restored, ['/comment'])
})

test('a restored object key lands where the default has it, not at the end', () => {
  const r = trimDemoRows('r.json', j(DEMO), j(DEMO), j(DEFAULT), ROWS)
  assert.deepEqual(Object.keys(JSON.parse(r.content)), ['comment', 'buckets', 'procedures', 'rows'])
})

test("the project's own rows survive, including one inserted BEFORE the demo's (a shifted pointer)", () => {
  const project = structuredClone(DEMO)
  project.rows.splice(1, 0, { id: 'mine' })
  project.procedures['orders.create'] = 'write'
  const r = trimDemoRows('r.json', j(project), j(DEMO), j(DEFAULT), ROWS)
  const out = JSON.parse(r.content)
  assert.deepEqual(out.rows, [{ id: 'a' }, { id: 'mine' }])
  assert.deepEqual(out.procedures, { 'orders.create': 'write', 'system.me': 'read' })
  assert.deepEqual(r.kept, [])
})

test('a demo row the project changed is KEPT and reported, never deleted', () => {
  const project = structuredClone(DEMO)
  project.rows[1] = { id: 'n1', tuned: true }
  project.procedures['notes.create'] = 'read'
  const r = trimDemoRows('r.json', j(project), j(DEMO), j(DEFAULT), ROWS)
  const out = JSON.parse(r.content)
  assert.deepEqual(out.rows, [{ id: 'a' }, { id: 'n1', tuned: true }])
  assert.equal(out.procedures['notes.create'], 'read')
  assert.deepEqual(r.kept.sort(), ['/procedures/notes.create', '/rows/1'])
})

test('a changed scalar the project edited again is kept, and its default is not forced back', () => {
  const project = { ...structuredClone(DEMO), comment: 'project prose' }
  const r = trimDemoRows('r.json', j(project), j(DEMO), j(DEFAULT), ROWS)
  assert.equal(JSON.parse(r.content).comment, 'project prose')
  assert.ok(r.kept.includes('/comment'))
  assert.ok(!r.restored.includes('/comment'))
})

test('a default ARRAY row comes back at its index, once; one already present is left alone', () => {
  const def = { rows: [{ id: 'a' }, { id: 'b' }] }
  const demo = { rows: [{ id: 'a' }, { id: 'n' }] }
  const rows = [
    { file: 'r.json', jsonPointer: '/rows/1' },
    { file: 'r.json', jsonPointer: '/rows/1', restore: true },
  ]
  const first = trimDemoRows('r.json', j({ rows: [{ id: 'a' }, { id: 'n' }, { id: 'p' }] }), j(demo), j(def), rows)
  assert.deepEqual(JSON.parse(first.content).rows, [{ id: 'a' }, { id: 'b' }, { id: 'p' }])
  const again = trimDemoRows('r.json', first.content, j(demo), j(def), rows)
  assert.deepEqual(JSON.parse(again.content).rows, [{ id: 'a' }, { id: 'b' }, { id: 'p' }])
  assert.deepEqual(again.restored, [])
})

test('a row whose container the project deleted cannot be judged: kept, and the restore skipped', () => {
  const r = trimDemoRows('r.json', j({ comment: 'demo' }), j(DEMO), j(DEFAULT), ROWS)
  const out = JSON.parse(r.content)
  assert.equal(out.comment, 'default')
  assert.equal(out.rows, undefined)
  assert.ok(r.kept.includes('/rows/1') && r.kept.includes('/procedures/notes.create'))
})

test('an index pointer the demo copy does not resolve is kept, not guessed at', () => {
  const r = trimDemoRows('r.json', j(DEMO), j(DEMO), j(DEFAULT), [{ file: 'r.json', jsonPointer: '/rows/9' }])
  assert.deepEqual(r.kept, ['/rows/9'])
  assert.deepEqual(JSON.parse(r.content), DEMO)
})

test('a restore pointer the default copy does not resolve restores nothing', () => {
  const r = trimDemoRows('r.json', j(DEMO), j(DEMO), j(DEFAULT), [{ file: 'r.json', jsonPointer: '/nope', restore: true }])
  assert.deepEqual(r.restored, [])
  assert.deepEqual(r.kept, ['/nope'])
})

test('a top-level array register and a top-level restore work too', () => {
  const r = trimDemoRows(
    'g.json',
    j([{ a: 1 }, { n: 1 }, { p: 1 }]),
    j([{ a: 1 }, { n: 1 }]),
    j([{ a: 1 }, { d: 1 }]),
    [
      { file: 'g.json', jsonPointer: '/1' },
      { file: 'g.json', jsonPointer: '/1', restore: true },
    ],
  )
  assert.deepEqual(JSON.parse(r.content), [{ a: 1 }, { d: 1 }, { p: 1 }])
})

// ---- markdown --------------------------------------------------------------------------

const HEAD = '# Parity\n\n| Action | Web | Mobile |\n|---|---|---|\n'
const MD_DEFAULT = `${HEAD}| system.health | — | — |\n| system.me | — | home |\n\ntrailing prose\n`
const MD_DEMO = `${HEAD}| notes.create | — | composer |\n| system.health | — | — |\n| system.me | — | — |\n\ntrailing prose\n`
const MD_ROWS = [
  { file: 'PARITY.md', rowKey: 'notes.create' },
  { file: 'PARITY.md', rowKey: 'system.me' },
  { file: 'PARITY.md', rowKey: 'system.me', restore: true },
]

test('rowKeyOf: a table row is keyed by its first cell; prose and the separator are not rows', () => {
  assert.equal(rowKeyOf('| notes.create | — |'), 'notes.create')
  assert.equal(rowKeyOf('|---|---|'), null)
  assert.equal(rowKeyOf('| :--- | --- |'), null)
  assert.equal(rowKeyOf('prose'), null)
})

test('markdown: an unchanged demo table trims back to the default exactly', () => {
  const r = trimDemoRows('PARITY.md', MD_DEMO, MD_DEMO, MD_DEFAULT, MD_ROWS)
  assert.equal(r.content, MD_DEFAULT)
  assert.deepEqual(r.deleted, ['notes.create', 'system.me'])
  assert.deepEqual(r.restored, ['system.me'])
})

test("markdown: the project's rows stay, an edited demo row is kept, and a restore is not doubled", () => {
  const project = MD_DEMO.replace('| notes.create | — | composer |', '| notes.create | — | composer (ours) |').replace(
    '| system.health | — | — |\n',
    '| orders.list | web | mobile |\n| system.health | — | — |\n',
  )
  const r = trimDemoRows('PARITY.md', project, MD_DEMO, MD_DEFAULT, MD_ROWS)
  assert.ok(r.content.includes('| notes.create | — | composer (ours) |'))
  assert.ok(r.content.includes('| orders.list | web | mobile |'))
  assert.equal(r.content.match(/\| system\.me \|/g)?.length, 1)
  assert.ok(r.content.includes('| system.me | — | home |'))
  assert.deepEqual(r.kept, ['notes.create'])
})

test('markdown: a restored row whose neighbour is gone lands at the end of the table', () => {
  const project = MD_DEMO.replace('| system.health | — | — |\n', '')
  const r = trimDemoRows('PARITY.md', project, MD_DEMO, MD_DEFAULT, MD_ROWS)
  const lines = r.content.split('\n')
  assert.equal(lines[lines.indexOf('| system.me | — | home |') - 1], '|---|---|---|')
})

// ---- the index file --------------------------------------------------------------------

test('readDemoIndex fails loud on an absent, unparsable or row-less index', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-demo-rows-'))
  made.push(dir)
  assert.throws(() => readDemoIndex(join(dir, 'absent.json')), /missing or not valid JSON/)
  writeFileSync(join(dir, 'bad.json'), '{ nope')
  assert.throws(() => readDemoIndex(join(dir, 'bad.json')), /missing or not valid JSON/)
  writeFileSync(join(dir, 'norows.json'), '{}')
  assert.throws(() => readDemoIndex(join(dir, 'norows.json')), /has no rows\[\]/)
  writeFileSync(join(dir, 'ok.json'), '{"rows":[]}')
  assert.deepEqual(readDemoIndex(join(dir, 'ok.json')), { rows: [] })
  // The shipped index parses.
  assert.ok(Array.isArray(readDemoIndex().rows))
})
