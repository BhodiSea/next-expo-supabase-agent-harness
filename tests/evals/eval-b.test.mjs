// Eval B's harness (2.1.0, #188): the frozen pre-dogfood fixture is self-contained and
// matches its manifest, every required key is labelled, an unlabelled key fails, and the
// dogfood rows appear: rows 1 to 5 and 23 as exact owed classes, row 7 as exact-small.
//
// The parser: these cases skip by name where `typescript` is absent and fail there under
// HARNESS_TEST_REQUIRE_TYPESCRIPT=1 (lint.yml's machinery-evals step).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { B_DIR, runB, SAMPLE, stratified } from '../../scripts/eval-b.mjs'
import { checkManifest, readJson, writeJson } from '../../scripts/lib/evals.mjs'
import { walkFiles } from '../../template/base/tools/lib/fs-walk.mjs'
import { treeTest, ts } from '../gates/helpers/single-home.mjs'

const CLI = fileURLToPath(new URL('../../scripts/eval-b.mjs', import.meta.url))
const FIXTURE = join(B_DIR, 'fixture')
const made = []
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

function scratchEval() {
  const dir = mkdtempSync(join(tmpdir(), 'epah-eval-b-dir-'))
  made.push(dir)
  cpSync(B_DIR, dir, { recursive: true })
  return dir
}

const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })

let result = null
const bRun = () => (result ??= runB(B_DIR, ts))

test("the fixture's digest manifest matches its files", () => {
  assert.deepEqual(checkManifest(FIXTURE, join(B_DIR, 'fixture.sha256')), [])
})

test('the fixture holds no .js, .mjs or .cjs file (eslint and knip never read it)', () => {
  assert.deepEqual(walkFiles(FIXTURE).filter((p) => /\.(js|mjs|cjs)$/.test(p)), [])
})

test('a changed fixture file is drift', () => {
  const dir = scratchEval()
  writeFileSync(join(dir, 'fixture/PARITY.md'), 'changed\n')
  assert.deepEqual(checkManifest(join(dir, 'fixture'), join(dir, 'fixture.sha256')), ['changed: PARITY.md'])
})

treeTest('eval B: every required key has a label, and every leg completes', () => {
  const r = bRun()
  assert.deepEqual(r.drift, [])
  assert.equal(r.doc.complete, true)
  assert.deepEqual(r.unlabelled, [], 'run `node scripts/eval-b.mjs --write-labels`, then label the new keys')
})

treeTest('eval B: dogfood rows 1 to 5 and 23 are exact owed classes, row 7 is exact-small', () => {
  const rows = new Map(bRun().coverage.map((c) => [c.row, c.found]))
  for (const row of ['1', '2', '3', '4', '5', '23']) {
    assert.deepEqual([rows.get(row)?.rule, rows.get(row)?.tier], ['exact', 'owed'], `Dogfood #${row}`)
  }
  assert.equal(rows.get('7')?.rule, 'exact-small', 'Dogfood #7 (the push slice is materialised)')
})

treeTest('eval B: the coverage table reports row 10 (the three error mappers) whatever it finds', () => {
  const rows = bRun().coverage.filter((c) => /^10[a-c]$/.test(c.row))
  assert.equal(rows.length, 3)
  const res = run([])
  assert.match(res.stdout, /^ {2}#10a +near-miss advisory +-> /m)
  assert.match(res.stdout, /^second homes with a hit: \d+ of \d+$/m)
})

treeTest('eval B CLI: an unlabelled key fails the run and is named; --strict fails on pending', () => {
  const dir = scratchEval()
  const file = join(dir, 'labels.json')
  const labels = readJson(file)
  const pending = Object.keys(labels.labels).find((k) => labels.labels[k].verdict === 'pending')
  assert.equal(run(['--dir', dir]).status, 0)
  assert.equal(run(['--dir', dir, '--strict']).status, 1)
  delete labels.labels[pending]
  writeJson(file, labels)
  const res = run(['--dir', dir])
  assert.equal(res.status, 1)
  assert.match(res.stdout, new RegExp(`^unlabelled: ${pending}$`, 'm'))
})

test(`sampling: a family over ${String(SAMPLE)} hits is labelled on a stratified sample of ${String(SAMPLE)}`, () => {
  const rec = (path, i) => ({ v: 1, producer: 'duplication', rule: 'single-consumer', subject: `${path}#f${String(i)}`, facts: { tier: 'advisory', member: { path, line: 1, name: `f${String(i)}` } } })
  const records = [
    ...Array.from({ length: 90 }, (_, i) => rec('apps/web/a.ts', i)),
    ...Array.from({ length: 30 }, (_, i) => rec('apps/mobile/a.ts', i)),
    ...Array.from({ length: 5 }, (_, i) => rec('packages/api/a.ts', i)),
  ]
  const sample = stratified(records, SAMPLE)
  assert.equal(sample.length, SAMPLE)
  const count = (p) => sample.filter((r) => r.facts.member.path.startsWith(p)).length
  assert.deepEqual([count('apps/web'), count('apps/mobile'), count('packages/api')], [36, 12, 2])
  assert.deepEqual(stratified(records, SAMPLE), sample, 'deterministic')
  assert.equal(stratified(records.slice(0, 10), SAMPLE).length, 10)
})
