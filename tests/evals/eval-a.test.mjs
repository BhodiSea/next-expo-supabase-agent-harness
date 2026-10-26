// Eval A's harness (2.1.0, #188): the development split runs in factory CI, every key it
// produces is labelled, the holdout refuses to run until frozen.json exists, and owed recall
// on renames and literal swaps is 1.0 (true by construction: a unit test, not a bar).
//
// The parser: these cases skip by name where `typescript` is absent (selftest.yml's
// installer-unit installs nothing) and fail there under HARNESS_TEST_REQUIRE_TYPESCRIPT=1,
// which lint.yml's machinery-evals step sets.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { A_DIR, holdoutRefusal, liveConstants, runA, splitOf } from '../../scripts/eval-a.mjs'
import { readJson, writeJson } from '../../scripts/lib/evals.mjs'
import { walkFiles } from '../../template/base/tools/lib/fs-walk.mjs'
import { extractorDigest } from '../../template/base/tools/lib/shapes.mjs'
import { treeTest, ts } from '../gates/helpers/single-home.mjs'

const CLI = fileURLToPath(new URL('../../scripts/eval-a.mjs', import.meta.url))
const made = []
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

/** A copy of tests/evals/a to change. */
function scratchEval() {
  const dir = mkdtempSync(join(tmpdir(), 'epah-eval-a-dir-'))
  made.push(dir)
  cpSync(A_DIR, dir, { recursive: true })
  return dir
}

const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })

let dev = null
const devRun = () => (dev ??= runA(ts, A_DIR, 'dev'))

treeTest('eval A dev split: every key the sweep produces has a label, and every leg completes', () => {
  const result = devRun()
  assert.deepEqual(result.unlabelled, [], 'run `node scripts/eval-a.mjs --write-labels`, then review the new labels')
  assert.equal(result.complete, true)
  assert.ok(result.cases >= 100, `the dev split builds ${String(result.cases)} cases`)
})

treeTest('eval A dev split: owed recall on renames and literal swaps is 1.0', () => {
  const { owed } = devRun()
  for (const mutator of ['rename', 'literal']) {
    assert.ok(owed[mutator].expected > 0, `${mutator}: the dev split has owed-eligible cases`)
    assert.equal(owed[mutator].recall, 1, `${mutator}: ${String(owed[mutator].found)} of ${String(owed[mutator].expected)}`)
  }
})

treeTest('eval A dev split: a move is silent, and the tag-only twin planting is owed', () => {
  const { runs } = devRun()
  const moves = runs.filter((r) => r.c.family === 'move')
  assert.ok(moves.length > 0)
  assert.deepEqual(moves.flatMap((r) => r.records), [])
  const twin = runs.find((r) => r.c.id === 'exact:tag-only-twin')
  assert.ok(twin.records.some(({ r }) => r.rule === 'exact' && r.facts.tier === 'owed'))
  const shorthand = runs.find((r) => r.c.id === 'exact:shorthand')
  assert.deepEqual(shorthand.records.filter(({ r }) => r.facts.tier === 'owed'), [], 'the shorthand planting forms no owed class')
})

treeTest('eval A CLI: the per-family numbers and the ±3 audit print, and the run exits 0', () => {
  const res = run([])
  assert.equal(res.status, 0, res.stdout + res.stderr)
  assert.match(res.stdout, /^recall per family/m)
  assert.match(res.stdout, /^ {2}rename +cases/m)
  assert.match(res.stdout, /^precision per rule and tier/m)
  assert.match(res.stdout, /^the ±3 audit \(classes within 3 tokens of FLOOR \d+\):$/m)
})

treeTest('eval A CLI: an unlabelled key fails the run and is named', () => {
  const dir = scratchEval()
  const file = join(dir, 'labels.json')
  const labels = readJson(file)
  const [gone] = Object.keys(labels.labels)
  delete labels.labels[gone]
  writeJson(file, labels)
  const res = run(['--dir', dir])
  assert.equal(res.status, 1)
  assert.match(res.stdout, new RegExp(`^unlabelled: ${gone}$`, 'm'))
})

treeTest('eval A CLI: --strict fails while any key is pending', () => {
  const dir = scratchEval()
  const file = join(dir, 'labels.json')
  const labels = readJson(file)
  const [first] = Object.keys(labels.labels)
  labels.labels[first].verdict = 'pending'
  writeJson(file, labels)
  assert.equal(run(['--dir', dir]).status, 0)
  assert.equal(run(['--dir', dir, '--strict']).status, 1)
})

treeTest('the holdout guard: --split holdout exits 1 with one line naming frozen.json while it is absent', () => {
  const res = run(['--split', 'holdout'])
  assert.equal(res.status, 1)
  const lines = res.stderr.trim().split('\n')
  assert.equal(lines.length, 1, res.stderr)
  assert.match(lines[0], /tests[\\/]evals[\\/]a[\\/]frozen\.json/)
})

treeTest('the holdout guard: a frozen.json that matches the live detector admits the run; one that drifted refuses it', () => {
  const dir = scratchEval()
  const x = extractorDigest(ts)
  writeFileSync(join(dir, 'frozen.json'), JSON.stringify(liveConstants(x)))
  assert.equal(holdoutRefusal(dir, x), null)
  writeFileSync(join(dir, 'frozen.json'), JSON.stringify({ ...liveConstants(x), FLOOR: 99 }))
  assert.match(holdoutRefusal(dir, x) ?? '', /differs from .*frozen\.json at FLOOR/)
  const res = run(['--split', 'holdout', '--dir', dir])
  assert.equal(res.status, 1)
  assert.doesNotMatch(res.stderr, /needs/)
})

treeTest('the split: 70/30 by the committed seed, and split.json is what that seed gives', () => {
  const corpus = readJson(join(A_DIR, 'corpus.json'))
  const split = readJson(join(A_DIR, 'split.json'))
  const again = splitOf(corpus.helpers, split.seed)
  assert.deepEqual({ dev: split.dev, holdout: split.holdout }, again)
  assert.equal(split.dev.length, Math.round(corpus.helpers.length * 0.7))
  assert.deepEqual(split.dev.filter((id) => split.holdout.includes(id)), [])
  assert.ok(corpus.helpers.length >= 36 && corpus.helpers.length <= 44, 'about 40 helpers')
})

test('the corpus is self-contained: no JavaScript file in tests/evals/a', () => {
  assert.deepEqual(walkFiles(A_DIR).filter((p) => /\.(js|mjs|cjs)$/.test(p)), [])
})
