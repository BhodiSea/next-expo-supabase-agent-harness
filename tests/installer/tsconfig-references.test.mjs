// Unit tests for the root solution file's reference surgery
// (installer/lib/tsconfig-references.mjs). The root tsconfig.json is a `tsc -b`
// SOLUTION file, and it has one unforgiving property: a reference to a project that
// does not exist is not a warning about that project, it is `error TS5083` and the
// whole build stops. So both directions have to hold — an enabled module's package
// must be NAMED, and a withheld package must not be.
//
// The prune half exists because the 0.1.3 -> 0.2.0 upgrade got it wrong in the real
// world: `tsconfig.json` is harness-owned so `update` rewrote it from the template
// including the new packages/platform/ratelimit reference, while the package itself is
// seedOnInitOnly and was deliberately withheld. These tests pin the rule that fixed it,
// including the subtlety that made the first attempt a no-op: every withheld file IS in
// the plan (the skip happens later, in update's write loop), so plan membership is the
// wrong question and "will this exist when the run finishes" is the right one.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  injectModuleProjectReferences,
  pruneMissingProjectReferences,
} from '../../installer/lib/tsconfig-references.mjs'

// A root tsconfig shaped like the real one: JSONC, with comments that carry the layering
// law. Every assertion below also proves those comments survive, because the module works
// textually for exactly that reason.
const ROOT = `{
  // Layering: kernel -> platform -> verticals -> api. apps/* are deliberately absent.
  "files": [],
  "references": [
    { "path": "packages/platform/errors" },
    { "path": "packages/platform/ratelimit" },
    { "path": "packages/api" }
  ]
}
`

/** @param {string} content */
const plan = (content, extra = []) => [
  { installPath: 'tsconfig.json', content },
  ...extra,
]

/** Paths of the reference entries, in file order. */
const refs = (content) =>
  [...content.matchAll(/\{\s*"path":\s*"([^"]+)"\s*\}/g)].map((m) => m[1])

/** A target dir containing exactly the given install paths (as empty files). */
function targetWith(paths) {
  const dir = mkdtempSync(join(tmpdir(), 'tsref-'))
  for (const p of paths) {
    const full = join(dir, p)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, '{}')
  }
  return dir
}

// ── prune ───────────────────────────────────────────────────────────────────────

test('prunes a reference whose package is withheld as seedOnInitOnly', () => {
  const p = plan(ROOT, [
    // In the plan and seeded — but registered init-time-only, so update skips it.
    { installPath: 'packages/platform/ratelimit/tsconfig.json', content: '{}' },
    { installPath: 'packages/platform/errors/tsconfig.json', content: '{}' },
    { installPath: 'packages/api/tsconfig.json', content: '{}' },
  ])
  const report = { notes: [] }
  const pruned = pruneMissingProjectReferences(p, targetWith([]), report, [
    'packages/platform/ratelimit/',
  ])
  assert.deepEqual(pruned, ['packages/platform/ratelimit'])
  assert.deepEqual(refs(p[0].content), ['packages/platform/errors', 'packages/api'])
  assert.match(report.notes[0], /packages\/platform\/ratelimit/)
  assert.match(report.notes[0], /refresh-seeded/)
})

test('the survivors keep valid JSON: the new last entry loses its comma, the rest keep theirs', () => {
  const p = plan(ROOT, [
    { installPath: 'packages/platform/errors/tsconfig.json', content: '{}' },
    { installPath: 'packages/platform/ratelimit/tsconfig.json', content: '{}' },
    { installPath: 'packages/api/tsconfig.json', content: '{}' },
  ])
  // Withhold the LAST reference — the comma-sensitive case.
  pruneMissingProjectReferences(p, targetWith([]), { notes: [] }, ['packages/api/tsconfig.json'])
  assert.doesNotThrow(() => JSON.parse(p[0].content.replace(/^\s*\/\/.*$/gm, '')))
  assert.deepEqual(refs(p[0].content), ['packages/platform/errors', 'packages/platform/ratelimit'])
})

test('PLAN MEMBERSHIP IS NOT THE QUESTION — every package is planned, only the withheld one goes', () => {
  // The first attempt at this fix asked `plan.has(...)` and was a silent no-op, because
  // seedOnInitOnly files are ALL in the plan; update skips them later, in the write loop.
  // Here all three are planned and only the withheld one is pruned, so membership is
  // necessary but not sufficient — and the cheaper, wrong predicate cannot come back.
  // The pattern is the EXACT-FILE form, the matcher's other spelling.
  const p = plan(ROOT, [
    { installPath: 'packages/platform/errors/tsconfig.json', content: '{}' },
    { installPath: 'packages/platform/ratelimit/tsconfig.json', content: '{}' },
    { installPath: 'packages/api/tsconfig.json', content: '{}' },
  ])
  const pruned = pruneMissingProjectReferences(p, targetWith([]), { notes: [] }, [
    'packages/platform/ratelimit/tsconfig.json',
  ])
  assert.deepEqual(pruned, ['packages/platform/ratelimit'])
  assert.deepEqual(refs(p[0].content), ['packages/platform/errors', 'packages/api'])
})

test('a withheld package ALREADY ON DISK keeps its reference (an earlier install wrote it)', () => {
  const p = plan(ROOT)
  const dir = targetWith([
    'packages/platform/ratelimit/tsconfig.json',
    'packages/platform/errors/tsconfig.json',
    'packages/api/tsconfig.json',
  ])
  const pruned = pruneMissingProjectReferences(p, dir, { notes: [] }, [
    'packages/platform/ratelimit/',
  ])
  assert.deepEqual(pruned, [])
  assert.deepEqual(refs(p[0].content), [
    'packages/platform/errors',
    'packages/platform/ratelimit',
    'packages/api',
  ])
})

test('with no withheld patterns (init) nothing is pruned — init is what plants seeded content', () => {
  const p = plan(ROOT, [
    { installPath: 'packages/platform/errors/tsconfig.json', content: '{}' },
    { installPath: 'packages/platform/ratelimit/tsconfig.json', content: '{}' },
    { installPath: 'packages/api/tsconfig.json', content: '{}' },
  ])
  assert.deepEqual(pruneMissingProjectReferences(p, targetWith([]), { notes: [] }), [])
  assert.equal(refs(p[0].content).length, 3)
})

test('no root entry in the plan is a no-op, not a throw (the retrofit conflict path)', () => {
  const report = { notes: [] }
  assert.deepEqual(pruneMissingProjectReferences([], '/nonexistent', report, ['x/']), [])
  assert.deepEqual(report.notes, [])
})

test('a non-packages/ reference is never judged — this owns the workspace graph only', () => {
  const content = `{
  "references": [
    { "path": "tools/tsconfig.json" },
    { "path": "packages/api" }
  ]
}
`
  const p = plan(content, [{ installPath: 'packages/api/tsconfig.json', content: '{}' }])
  assert.deepEqual(pruneMissingProjectReferences(p, targetWith([]), { notes: [] }, ['x/']), [])
})

// ── inject, and the two together ────────────────────────────────────────────────

test('inject then prune: a module package is added and a withheld base package removed', () => {
  const p = plan(ROOT, [
    { installPath: 'packages/eval/tsconfig.json', content: '{}', module: 'eval-live' },
    { installPath: 'packages/platform/errors/tsconfig.json', content: '{}' },
    { installPath: 'packages/platform/ratelimit/tsconfig.json', content: '{}' },
    { installPath: 'packages/api/tsconfig.json', content: '{}' },
  ])
  const report = { notes: [] }
  injectModuleProjectReferences(p, report, 'added')
  pruneMissingProjectReferences(p, targetWith([]), report, ['packages/platform/ratelimit/'])
  assert.deepEqual(refs(p[0].content), [
    'packages/platform/errors',
    'packages/api',
    'packages/eval',
  ])
  assert.doesNotThrow(() => JSON.parse(p[0].content.replace(/^\s*\/\/.*$/gm, '')))
  // The JSONC comments carrying the layering law survive both passes — the reason this
  // module edits text instead of round-tripping through JSON.stringify.
  assert.match(p[0].content, /Layering: kernel -> platform/)
})
