// Unit tests for the install/update report renderer (installer/lib/report.mjs).
// Pins the exact human-mode line format (init/update/refresh-seeded all funnel
// through printReport, and lifecycle tests grep this output), the JSON-mode
// passthrough, and the exit-code contract: 0 clean, 2 on conflicts or drift.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { printReport } from '../../installer/lib/report.mjs'

// Capture every console.log call as one line; printReport always passes a
// single string per call, but join defensively so a format change surfaces
// as a diff, not a silent [object Object].
function capture(t, fn) {
  const lines = []
  t.mock.method(console, 'log', (...args) => {
    lines.push(args.join(' '))
  })
  const code = fn()
  return { code, lines }
}

// Shapes mirror what installer/commands/{init,update}.mjs actually push.
const representative = () => ({
  title: 'harness update 0.1.2 → 0.1.3',
  written: ['tools/validate.mjs', '.claude/hooks/pretool-bash-guard.mjs'],
  skipped: ['AGENTS.md'],
  conflicts: [
    { path: 'eslint.config.mjs', detail: 'existing config kept; harness version at eslint.config.harness.mjs — merge manually' },
    { name: 'package.json#scripts.validate', detail: 'kept yours; harness version at scripts.harness:validate' },
  ],
  drift: [
    { path: '.claude/hooks/stop-validate-gate.mjs', pending: '.harness/pending/.claude/hooks/stop-validate-gate.mjs' },
  ],
  notes: ['.gitignore: kept yours, appended 3 harness pattern(s)'],
})

test('human mode: representative report renders every section, exact lines, exit 2', (t) => {
  const { code, lines } = capture(t, () => printReport(representative()))
  assert.equal(code, 2, 'conflicts + drift must exit 2')
  assert.deepEqual(lines, [
    '\nharness update 0.1.2 → 0.1.3',
    '  written: 2 file(s)',
    '  skipped (project-owned): 1',
    '  CONFLICT eslint.config.mjs: existing config kept; harness version at eslint.config.harness.mjs — merge manually',
    '  CONFLICT package.json#scripts.validate: kept yours; harness version at scripts.harness:validate',
    '  DRIFT .claude/hooks/stop-validate-gate.mjs: local edits preserved; incoming saved to .harness/pending/.claude/hooks/stop-validate-gate.mjs',
    '  note: .gitignore: kept yours, appended 3 harness pattern(s)',
    '\nResolve the items above, then run `doctor` to confirm a clean install.',
  ])
})

test('human mode: empty report renders title + zero count only, exit 0', (t) => {
  const empty = { title: 'harness init (bootstrap)', written: [], skipped: [], conflicts: [], drift: [], notes: [] }
  const { code, lines } = capture(t, () => printReport(empty))
  assert.equal(code, 0)
  assert.deepEqual(lines, [
    '\nharness init (bootstrap)',
    '  written: 0 file(s)',
  ])
})

test('human mode: written/skipped/notes without conflicts or drift stays exit 0, no resolve footer', (t) => {
  const clean = {
    title: 'refresh-seeded (template 0.1.4)',
    written: ['apps/desktop/src/App.tsx'],
    skipped: [],
    conflicts: [],
    drift: [],
    notes: ['consumed template checkout in place — installer/template trees removed'],
  }
  const { code, lines } = capture(t, () => printReport(clean))
  assert.equal(code, 0, 'notes alone must not flip the exit code')
  assert.deepEqual(lines, [
    '\nrefresh-seeded (template 0.1.4)',
    '  written: 1 file(s)',
    '  note: consumed template checkout in place — installer/template trees removed',
  ])
})

test('human mode: conflict label prefers path over name when both are present', (t) => {
  const report = {
    title: 't',
    written: [],
    skipped: [],
    conflicts: [{ path: 'the/path', name: 'the-name', detail: 'd' }],
    drift: [],
    notes: [],
  }
  const { lines } = capture(t, () => printReport(report))
  assert.ok(lines.includes('  CONFLICT the/path: d'), lines.join('\n'))
  assert.ok(!lines.some((l) => l.includes('the-name')), 'name must not be used when path exists')
})

test('human mode: exit 2 for conflicts alone and for drift alone', (t) => {
  const conflictsOnly = capture(t, () => printReport({
    title: 't',
    written: [],
    skipped: [],
    conflicts: [{ path: 'p', detail: 'd' }],
    drift: [],
    notes: [],
  }))
  assert.equal(conflictsOnly.code, 2)
  assert.equal(conflictsOnly.lines.at(-1), '\nResolve the items above, then run `doctor` to confirm a clean install.')

  const driftOnly = capture(t, () => printReport({
    title: 't',
    written: [],
    skipped: [],
    conflicts: [],
    drift: [{ path: 'p', pending: '.harness/pending/p' }],
    notes: [],
  }))
  assert.equal(driftOnly.code, 2)
  assert.equal(driftOnly.lines.at(-1), '\nResolve the items above, then run `doctor` to confirm a clean install.')
})

test('human mode: missing array fields fall back to empty via destructuring defaults', (t) => {
  const { code, lines } = capture(t, () => printReport({ title: 'bare' }))
  assert.equal(code, 0)
  assert.deepEqual(lines, [
    '\nbare',
    '  written: 0 file(s)',
  ])
})

test('json mode: single pretty-printed JSON dump, exit 0 when clean', (t) => {
  const report = {
    title: 'harness init (bootstrap)',
    written: ['a.txt'],
    skipped: [],
    conflicts: [],
    drift: [],
    notes: ['n1'],
  }
  const { code, lines } = capture(t, () => printReport(report, { json: true }))
  assert.equal(code, 0)
  assert.equal(lines.length, 1, 'json mode must emit exactly one log call')
  assert.equal(lines[0], JSON.stringify(report, null, 2))
  assert.deepEqual(JSON.parse(lines[0]), report, 'json output must round-trip')
})

test('json mode: exit 2 on conflicts or drift; skipped/notes do not affect the code', (t) => {
  const base = { title: 't', written: [], skipped: ['s'], conflicts: [], drift: [], notes: ['n'] }
  assert.equal(capture(t, () => printReport(base, { json: true })).code, 0)
  assert.equal(
    capture(t, () => printReport({ ...base, conflicts: [{ path: 'p', detail: 'd' }] }, { json: true })).code,
    2,
  )
  assert.equal(
    capture(t, () => printReport({ ...base, drift: [{ path: 'p', pending: 'q' }] }, { json: true })).code,
    2,
  )
})

test('json mode requires conflicts/drift arrays (human mode tolerates their absence)', (t) => {
  // Pins an asymmetry: human mode destructures with defaults, json mode reads
  // report.conflicts/.drift directly. Every real caller builds full report
  // objects, so this only documents the current contract for partial inputs.
  assert.throws(() => capture(t, () => printReport({ title: 't' }, { json: true })), TypeError)
})

test('human mode, `list`: a dry run NAMES what it would write — and only when asked (1.0.2)', (t) => {
  // A count cannot answer the one question a dry run is run to answer: WHICH of my files
  // would this touch. The listing rides the options, never the report object — the
  // dry-run/real JSON parity test holds the two reports deep-equal.
  const { code, lines } = capture(t, () => printReport(representative(), { list: true }))
  assert.equal(code, 2)
  assert.deepEqual(lines.slice(0, 5), [
    '\nharness update 0.1.2 → 0.1.3',
    '  written: 2 file(s)',
    '    would write tools/validate.mjs',
    '    would write .claude/hooks/pretool-bash-guard.mjs',
    '  skipped (project-owned): 1',
  ])
  // Without the option the output is byte-for-byte what it was — the exact-lines tests
  // above are the proof; this one only pins that `list: false` is the same as absent.
  const plain = capture(t, () => printReport(representative(), { list: false })).lines
  assert.ok(!plain.some((l) => l.includes('would write')), plain.join('\n'))
  // JSON mode ignores it: the report object is the whole payload.
  const json = capture(t, () => printReport(representative(), { json: true, list: true })).lines
  assert.equal(json.length, 1)
  assert.deepEqual(JSON.parse(json[0]), representative())
})
