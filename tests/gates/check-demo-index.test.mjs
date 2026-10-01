// Proofs for scripts/check-demo-index.mjs (2.0.0, #85): the factory check that keeps the
// worked example removable. `init --with-demo` overlays template/demo on the default plan,
// and `eject` takes it back out. Two things make that safe, and this check holds both:
//
//   1. THE INDEX. template/demo-index.json lists, for each seeded register the demo replaces,
//      the rows its copy adds or changes ({file, jsonPointer} for JSON, {file, rowKey} for a
//      markdown table), so `eject` can trim a register the project has since edited instead
//      of leaving the demo's rows behind. Checked in BOTH directions: a register row that
//      differs from the default copy but is missing from the index reds, and so does an
//      index entry that resolves to nothing.
//   2. THE OWNED FILES. An owned file is the same in every install, so one that names a demo
//      path (an install path only template/demo ships, or `@app/notes`) is a file that breaks,
//      or lies, when the demo is absent. Prose (`.md`) may describe the example; config, tool
//      and register files may not, except inside a JSON object that says `"demo": true`
//      (the census entry the boundaries gate keeps dormant without the demo).
//
// Every case runs the REAL script over a fixture template tree (--template), plants one
// defect, and asserts the exit code AND that the output names the file and the row or the
// needle, so a red for the wrong reason cannot pass. The LIVE case runs it over this checkout.
// No bash and no git: the installer-unit job's Windows leg can run this file.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { renderIndex } from '../../scripts/lib/demo-index.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/check-demo-index.mjs')

const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

const json = (v) => `${JSON.stringify(v, null, 2)}\n`

// A seeded JSON register (tools/rate-limit-budget.json is seeded, installer/lib/layout.mjs),
// a seeded markdown register (PARITY.md), an owned tool, a seeded app file, and the demo's
// own vertical. The demo adds one array row and one object key, and changes one scalar.
const BASE_REG = { comment: 'reviewed', procedures: { 'system.me': 'read' }, rows: [{ id: 'a' }], unmapped: 'write' }
const DEMO_REG = {
  comment: 'reviewed',
  procedures: { 'notes.create': 'write', 'system.me': 'read' },
  rows: [{ id: 'a' }, { id: 'notes' }],
  unmapped: 'read',
}
const PARITY_HEAD = '# Parity\n\nProse both copies share.\n\n| Action | Web | Mobile | Notes |\n|---|---|---|---|\n'
const BASE_PARITY = `${PARITY_HEAD}| system.me | — | apps/mobile/app/(tabs)/index.tsx | home |\n`
const DEMO_PARITY = `${PARITY_HEAD}| notes.create | — | apps/mobile/src/features/notes/NoteComposer.tsx | composer |\n| system.me | — | — | exempt |\n`

/** The index the fixture's trees imply, in generated order. */
const GOOD_ROWS = [
  { file: 'PARITY.md', rowKey: 'notes.create' },
  { file: 'PARITY.md', rowKey: 'system.me' },
  { file: 'PARITY.md', rowKey: 'system.me', restore: true },
  { file: 'tools/rate-limit-budget.json', jsonPointer: '/procedures/notes.create' },
  { file: 'tools/rate-limit-budget.json', jsonPointer: '/rows/1' },
  { file: 'tools/rate-limit-budget.json', jsonPointer: '/unmapped' },
  { file: 'tools/rate-limit-budget.json', jsonPointer: '/unmapped', restore: true },
]

/**
 * A template root: storage path -> content. `index` replaces template/demo-index.json.
 * @param {{ files?: Record<string, string | null>, index?: any }} [o]
 */
function fixture({ files = {}, index = { rows: GOOD_ROWS } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-demo-index-'))
  made.push(dir)
  const all = {
    'base/PARITY.md': BASE_PARITY,
    'base/tools/rate-limit-budget.json': json(BASE_REG),
    'base/tools/check-widgets.mjs': "// An owned tool that names no demo path.\nexport const ROOT = 'packages/verticals'\n",
    'stack/apps/web/app/page.tsx': 'export default function Page() { return null }\n',
    'stack/apps/mobile/src/features/actions/registry.ts': 'export const ACTIONS = []\n',
    'demo/PARITY.md': DEMO_PARITY,
    'demo/tools/rate-limit-budget.json': json(DEMO_REG),
    'demo/packages/verticals/notes/package.json.tmpl': json({ name: '@app/notes' }),
    'demo/packages/verticals/notes/src/index.ts': 'export const notes = 1\n',
    'demo/apps/mobile/src/features/notes/NoteComposer.tsx': 'export const x = 1\n',
    // The generated form the script writes, so a fixture index differs from it only where a
    // case says so.
    'demo-index.json': Array.isArray(index?.rows) ? renderIndex(index.rows) : json(index),
    ...files,
  }
  for (const [rel, content] of Object.entries(all)) {
    if (content === null) continue
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return dir
}

/** @param {string} dir @param {string[]} [args] */
function run(dir, args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, '--template', dir, ...args], { encoding: 'utf8' })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

test('GREEN: an index that lists exactly the demo rows, in generated form', () => {
  const r = run(fixture())
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /demo-index: OK — 7 row\(s\) over 2 register\(s\)/)
})

test('RED: a register row that differs from the default copy but is missing from the index', () => {
  const rows = GOOD_ROWS.filter((r) => r.jsonPointer !== '/rows/1')
  const r = run(fixture({ index: { rows } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('tools/rate-limit-budget.json /rows/1: the demo row is missing from template/demo-index.json'), r.out)
})

test('RED: a markdown register row missing from the index, named by its row key', () => {
  const rows = GOOD_ROWS.filter((r) => r.rowKey !== 'notes.create')
  const r = run(fixture({ index: { rows } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('PARITY.md row notes.create: the demo row is missing from template/demo-index.json'), r.out)
})

test('RED: a default row the demo drops must be indexed for restore, too', () => {
  const rows = GOOD_ROWS.filter((r) => !(r.rowKey === 'system.me' && r.restore))
  const r = run(fixture({ index: { rows } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('PARITY.md row system.me (restore): the default row is missing from template/demo-index.json'), r.out)
})

test('RED: an index entry that resolves to nothing', () => {
  for (const extra of [
    { file: 'tools/rate-limit-budget.json', jsonPointer: '/rows/7' },
    { file: 'tools/gone.json', jsonPointer: '/x' },
    { file: 'PARITY.md', rowKey: 'notes.ghost' },
  ]) {
    const r = run(fixture({ index: { rows: [...GOOD_ROWS, extra] } }))
    assert.equal(r.code, 1, `${JSON.stringify(extra)}\n${r.out}`)
    assert.ok(r.out.includes('resolves to nothing'), r.out)
  }
})

test('RED: an index entry that resolves to a row both copies share is not a demo row', () => {
  const r = run(fixture({ index: { rows: [...GOOD_ROWS, { file: 'tools/rate-limit-budget.json', jsonPointer: '/rows/0' }] } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('tools/rate-limit-budget.json /rows/0: indexed, but the default copy carries the same row'), r.out)
})

test('RED: a malformed or absent index fails closed', () => {
  for (const content of ['{ not json', json({ rows: 'x' }), null]) {
    const r = run(fixture({ files: { 'demo-index.json': content } }))
    assert.equal(r.code, 1, `${String(content)}\n${r.out}`)
    assert.ok(r.out.includes('template/demo-index.json'), r.out)
  }
})

test('RED: an owned file in scope that names a path only the demo ships', () => {
  const r = run(
    fixture({
      files: { 'base/tools/check-widgets.mjs': "const X = 'packages/verticals/notes/src/index.ts'\n" },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('tools/check-widgets.mjs:1: names packages/verticals/notes/src/index.ts'), r.out)
})

test('RED: an owned file that names a directory only the demo ships, or @app/notes', () => {
  for (const [text, needle] of [
    ["files: ['apps/mobile/src/features/notes/**']\n", 'apps/mobile/src/features/notes/'],
    ["import { x } from '@app/notes'\n", '@app/notes'],
  ]) {
    const r = run(fixture({ files: { 'base/tools/check-widgets.mjs': text } }))
    assert.equal(r.code, 1, `${needle}\n${r.out}`)
    assert.ok(r.out.includes(`tools/check-widgets.mjs:1: names ${needle}`), r.out)
  }
})

test('RED: an owned file in a module tree is in scope too', () => {
  const r = run(fixture({ files: { 'modules/e2ee/tools/check-keys.mjs': "// see @app/notes\n" } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('tools/check-keys.mjs:1: names @app/notes'), r.out)
})

test('GREEN: prose, seeded files, generic slots and a "demo": true object may name the example', () => {
  const r = run(
    fixture({
      files: {
        'base/docs/guide.md': 'The worked example lives at packages/verticals/notes/src/index.ts (@app/notes).\n',
        'modules/push/docs/modules/push/slice/index.ts.txt': "// modelled on @app/notes' packages/verticals/notes/src/index.ts\n",
        'stack/apps/web/app/page.tsx': "// the notes route: apps/mobile/src/features/notes/NoteComposer.tsx\nexport default function Page() { return null }\n",
        'base/tools/census.json': json({ sanctioned: [{ package: '@app/notes', demo: true, reason: 'the example' }] }),
      },
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('RED: a "demo" marker other than true does not excuse the object', () => {
  const r = run(
    fixture({ files: { 'base/tools/census.json': json({ sanctioned: [{ package: '@app/notes', demo: 'yes' }] }) } }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('tools/census.json'), r.out)
})

test('RED: the demo may replace only SEEDED files — an owned file it overlays is named', () => {
  const r = run(fixture({ files: { 'demo/tools/check-widgets.mjs': '// the demo copy\n' } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('tools/check-widgets.mjs: the demo replaces an OWNED file'), r.out)
})

test('RED: a markdown register whose prose differs between the copies cannot be trimmed', () => {
  const r = run(fixture({ files: { 'demo/PARITY.md': DEMO_PARITY.replace('Prose both copies share.', 'Demo prose.') } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('PARITY.md: the copies differ outside table rows'), r.out)
})

test('--write regenerates the index in generated form and the check then passes', () => {
  const dir = fixture({ index: { rows: [] } })
  assert.equal(run(dir).code, 1)
  const w = run(dir, ['--write'])
  assert.equal(w.code, 0, w.out)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'demo-index.json'), 'utf8')).rows, GOOD_ROWS)
  assert.equal(run(dir).code, 0)
})

test('--write refuses while an owned file names a demo path, and writes nothing', () => {
  const dir = fixture({ index: { rows: [] }, files: { 'base/tools/check-widgets.mjs': "// @app/notes\n" } })
  const w = run(dir, ['--write'])
  assert.equal(w.code, 1, w.out)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'demo-index.json'), 'utf8')).rows, [])
})

test('LIVE: this checkout passes', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: ROOT })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /demo-index: OK — \d+ row\(s\) over \d+ register\(s\)/)
})
