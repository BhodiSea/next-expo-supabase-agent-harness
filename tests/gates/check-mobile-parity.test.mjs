// Can-fail proofs for the parity gate (template/base/tools/check-mobile-parity.mjs).
// Fixture-driven: build a scaffold-shaped workspace (a committed action inventory, a
// PARITY.md ledger, the screen files its rows name), run the REAL gate with cwd inside it,
// and assert the exact red/green. Every branch of the two-way closure is falsified here — a
// gate that cannot go red is decoration.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-mobile-parity.mjs', import.meta.url),
)

// Run the gate with a SCRUBBED env so the outer runner's CI/strict flags never leak in — each
// test opts into exactly the env it means to exercise (extraEnv).
function run(dir, extraEnv = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.CHECK_MOBILE_PARITY_STRICT
  return spawnSync(process.execPath, [GATE], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...env, ...extraEnv },
  })
}

// { actions? } omitted → no inventory written (skip path). { parity? } omitted → no ledger.
/**
 * @param {{ actions?: any, parity?: string, files?: string[], manifest?: any }} [opts]
 */
function scaffold({ actions, parity, files = [], manifest } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'parity-'))
  if (actions !== undefined) {
    mkdirSync(join(dir, 'tools/generated'), { recursive: true })
    writeFileSync(
      join(dir, 'tools/generated/action-inventory.json'),
      `${JSON.stringify(actions, null, 2)}\n`,
    )
  }
  if (parity !== undefined) writeFileSync(join(dir, 'PARITY.md'), parity)
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true })
    writeFileSync(join(dir, f), '')
  }
  if (manifest !== undefined) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness/manifest.json'), JSON.stringify(manifest))
  }
  return dir
}

// A markdown parity table from [action, web, mobile, notes] rows.
function ledger(rows) {
  const head = '# Surface parity ledger\n\n| Action | Web | Mobile | Notes |\n| --- | --- | --- | --- |\n'
  return `${head}${rows.map((r) => `| ${r.join(' | ')} |`).join('\n')}\n`
}

const NOTE_COMPOSER = 'apps/mobile/src/features/notes/NoteComposer.tsx'
const NOTES_PANEL = 'apps/mobile/src/features/notes/NotesPanel.tsx'
const CONNECTION = 'apps/mobile/src/features/connection/ConnectionStatus.tsx'
const MOBILE_FILES = [NOTE_COMPOSER, NOTES_PANEL, CONNECTION]

const ACTIONS = [
  { action: 'notes.create', type: 'mutation' },
  { action: 'notes.list', type: 'query' },
  { action: 'system.health', type: 'query' },
]
const GREEN_ROWS = [
  ['notes.create', '—', NOTE_COMPOSER, 'web screen pending (W9)'],
  ['notes.list', '—', NOTES_PANEL, 'web screen pending (W9)'],
  ['system.health', '—', CONNECTION, 'infra liveness — web-exempt'],
]

test('GREEN — complete ledger, valid cells, no manifest (strict) → OK', () => {
  const r = run(scaffold({ actions: ACTIONS, parity: ledger(GREEN_ROWS), files: MOBILE_FILES }))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /parity: OK/)
})

test('digit-bearing action names are admitted (the source regex silently dropped them)', () => {
  const actions = [...ACTIONS, { action: 'billing.v2Invoice', type: 'query' }]
  const rows = [...GREEN_ROWS, ['billing.v2Invoice', '—', '—', 'reporting only — no screen yet']]
  const r = run(scaffold({ actions, parity: ledger(rows), files: MOBILE_FILES }))
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('RED forward — an inventory action with no ledger row reds (strict)', () => {
  const actions = [...ACTIONS, { action: 'notes.remove', type: 'mutation' }]
  const r = run(scaffold({ actions, parity: ledger(GREEN_ROWS), files: MOBILE_FILES }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /notes\.remove[\s\S]*no row/)
})

test('RED backward — a ledger row for a non-inventory action reds as STALE', () => {
  const rows = [...GREEN_ROWS, ['notes.ghost', '—', '—', 'removed, row left behind']]
  const r = run(scaffold({ actions: ACTIONS, parity: ledger(rows), files: MOBILE_FILES }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /notes\.ghost[\s\S]*not in/)
})

test('RED — an exempt (—) surface cell with an empty Notes reds', () => {
  const rows = [['notes.create', '—', NOTE_COMPOSER, ''], ...GREEN_ROWS.slice(1)]
  const r = run(scaffold({ actions: ACTIONS, parity: ledger(rows), files: MOBILE_FILES }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /exempt[\s\S]*Notes is empty/)
})

test('RED — a surface path that does not exist reds', () => {
  const rows = [
    ['notes.create', '—', 'apps/mobile/src/features/notes/DoesNotExist.tsx', 'x'],
    ...GREEN_ROWS.slice(1),
  ]
  const r = run(scaffold({ actions: ACTIONS, parity: ledger(rows), files: MOBILE_FILES }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /does not exist/)
})

test('RED — a duplicate row for one action reds', () => {
  const rows = [...GREEN_ROWS, ['notes.create', '—', NOTE_COMPOSER, 'dupe']]
  const r = run(scaffold({ actions: ACTIONS, parity: ledger(rows), files: MOBILE_FILES }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /duplicate row/)
})

test('RED — a malformed action name reds on grammar', () => {
  const actions = [...ACTIONS, { action: 'Notes.Create', type: 'mutation' }]
  const rows = [...GREEN_ROWS, ['Notes.Create', '—', '—', 'bad name']]
  const r = run(scaffold({ actions, parity: ledger(rows), files: MOBILE_FILES }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /not a valid action name/)
})

test('RED — inventory present but PARITY.md absent reds (strict, all actions unrowed)', () => {
  const r = run(scaffold({ actions: ACTIONS }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /does not exist/)
})

test('a forward gap reds on any install — the closure is unconditional', () => {
  // 0.4.0 DELETED this ramp rather than expiring it: its minVersion sat below v0.1.3,
  // the oldest release this lineage ever tagged, so gate.mjs returned false at
  // `base >= minVersion` for every install that has ever existed. This test used to
  // prove the NOTE path with a HYPOTHETICAL pre-lineage manifest — its own comment said
  // so — which is proof of a path no consumer can take. Inverted: the check is
  // unconditional now, so even that manifest is held.
  // CHECK_MOBILE_PARITY_STRICT went with it: an env var that forces a check already live
  // is a knob with one setting.
  const actions = [...ACTIONS, { action: 'notes.remove', type: 'mutation' }]
  const parity = ledger(GREEN_ROWS)
  const manifest = { baseVersion: '0.1.0', harnessVersion: '0.1.0' }
  const r = run(scaffold({ actions, parity, files: MOBILE_FILES, manifest }))
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stderr, /notes\.remove/)
  assert.doesNotMatch(r.stdout, /NOTE/, 'the ramp is gone; a NOTE here would mean it came back')
})

test('skip — absent action inventory skips locally (exit 0, SKIPPED)', () => {
  const r = run(scaffold({}))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /SKIPPED/)
})

// Not a gate proof: a content check on the worked example's own ledger (#148). The gate only
// asks that a path cell exist and that an exempt cell carry a reason, so it stayed green while
// template/demo/PARITY.md called the web notes route's two actions unsurfaced. Pin both cells to
// the screens that reach them, and each screen to its call, so neither row can drift back to —.
const DEMO = fileURLToPath(new URL('../../template/demo/', import.meta.url))

// The demo ledger's rows by action, cells split the way the gate splits them.
function demoRows() {
  const rows = new Map()
  for (const line of readFileSync(join(DEMO, 'PARITY.md'), 'utf8').split('\n')) {
    if (!line.trim().startsWith('|')) continue
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim())
    rows.set(cells[0], cells)
  }
  return rows
}

for (const [action, screen, call] of [
  ['notes.create', 'apps/web/app/(protected)/o/[orgSlug]/notes/note-composer.tsx', 'createNoteAction('],
  ['notes.list', 'apps/web/app/(protected)/o/[orgSlug]/notes/page.tsx', 'loadNotesPage('],
]) {
  test(`demo PARITY.md names the web notes route for ${action}, and that screen reaches it`, () => {
    const row = demoRows().get(action)
    assert.ok(row, `template/demo/PARITY.md has no ${action} row`)
    assert.equal(row[1], screen, `the ${action} web cell must name the screen that surfaces it`)
    assert.ok(
      readFileSync(join(DEMO, screen), 'utf8').includes(call),
      `template/demo/${screen} no longer calls ${call} — the ledger names a screen that does not reach ${action}`,
    )
  })
}
