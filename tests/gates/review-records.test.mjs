// Review records (1.1.0, #64): the rounds of a change's review go in
// docs/reviews/<YYYYMMDD>-<slice>.md, outside the ADR. Nothing reads that directory, so this
// file is not a gate's anti-vacuity proof. It pins the prose that points at the directory, and
// the properties that keep a record inert:
//   - no shipped gate, hook or workflow names docs/reviews;
//   - no path-triggered reviewer is owed by a record, so writing one after a PASS leaves that
//     reviewer's verdict standing (the whole-turn class binds to every path, and the README
//     says what that means for the order of work);
//   - the README carries no `[corpus: …]` reference for the provenance gate to resolve.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// Namespace imports, the 1.1.0 convention for these libs: a missing export fails the case
// that reaches it, not the whole file at load.
import * as provenanceRules from '../../template/base/tools/lib/provenance-rules.mjs'
import * as reviewerLib from '../../template/base/tools/lib/reviewer-verdicts.mjs'

const TEMPLATE = fileURLToPath(new URL('../../template/', import.meta.url))
const BASE = join(TEMPLATE, 'base')
const README = 'docs/reviews/README.md'
const RECORD = 'docs/reviews/20260101-x.md'

/** @param {string} rel install-relative path under template/base, LF-normalized */
const readBase = (rel) =>
  readFileSync(join(BASE, ...rel.split('/')), 'utf8').replace(/\r\n/g, '\n')

test('the review-record README defines one record per change and the four-field round table', () => {
  assert.ok(existsSync(join(BASE, ...README.split('/'))), `template/base/${README} must exist`)
  const text = readBase(README)
  assert.ok(text.includes('docs/reviews/<YYYYMMDD>-<slice>.md'), 'the record path shape')
  assert.ok(text.includes('## Round <n> — YYYY-MM-DD'), 'the round heading shape')
  assert.match(text, /^\| *Reviewer *\| *Verdict *\| *Findings *\| *Resolution *\|$/m)
  for (const field of ['Reviewer', 'Verdict', 'Findings', 'Resolution']) {
    assert.match(text, new RegExp(`^- \\*\\*${field}:\\*\\*`, 'm'), `${field} is defined`)
  }
})

test('the ADR template, the ADR README, /adr, /new-feature and AGENTS.md each point at docs/reviews/', () => {
  for (const rel of [
    'docs/adr/0000-adr-template.md',
    'docs/adr/README.md',
    '.claude/commands/adr.md',
    '.claude/commands/new-feature.md',
    'AGENTS.md',
  ]) {
    assert.ok(readBase(rel).includes('docs/reviews/'), `${rel} must name docs/reviews/`)
  }
})

/** Every shipped directory that holds a gate, a hook or a workflow. */
function machineryDirs() {
  const dirs = [
    join(BASE, 'tools'),
    join(BASE, '.claude', 'hooks'),
    join(BASE, 'github', 'workflows'),
    join(TEMPLATE, 'stack', 'tools'),
  ]
  for (const mod of readdirSync(join(TEMPLATE, 'modules'))) {
    dirs.push(join(TEMPLATE, 'modules', mod, 'tools'))
    dirs.push(join(TEMPLATE, 'modules', mod, 'github', 'workflows'))
  }
  return dirs.filter((dir) => existsSync(dir))
}

/** @param {string} dir @returns {string[]} */
const filesUnder = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))

test('no shipped gate, hook or workflow names docs/reviews', () => {
  const dirs = machineryDirs()
  assert.ok(dirs.length >= 5, `found only ${String(dirs.length)} machinery directories`)
  const naming = dirs
    .flatMap(filesUnder)
    .filter((file) => readFileSync(file, 'utf8').includes('docs/reviews'))
  assert.deepEqual(naming, [], 'a record is prose: no machinery may read or name it')
})

test('a review record owes no path-triggered reviewer under the shipped trigger table', () => {
  const triggers = JSON.parse(readBase('tools/reviewer-triggers.json'))
  assert.ok((triggers.reviewers ?? []).length > 0, 'the table lists path-triggered reviewers')
  assert.deepEqual(reviewerLib.owedBy([RECORD], triggers.reviewers), [])
})

test('only the wholeTurn class is owed by a record, and the README names each of its reviewers', () => {
  const triggers = JSON.parse(readBase('tools/reviewer-triggers.json'))
  const wholeTurn = (triggers.wholeTurn ?? []).map((w) => w.agent).sort()
  const owed = reviewerLib.owedByTurn([RECORD], triggers).map((o) => o.agent).sort()
  assert.deepEqual(owed, wholeTurn)
  const text = readBase(README)
  assert.ok(text.includes('wholeTurn'), 'the README names the class whose digest covers a record')
  for (const agent of wholeTurn) assert.ok(text.includes(agent), `the README names ${agent}`)
})

test('the README carries no [corpus: …] reference (placeholders use the <id> form)', () => {
  const refs = [...readBase(README).matchAll(provenanceRules.CORPUS_REF)].map((m) => m[0])
  assert.deepEqual(refs, [])
})
