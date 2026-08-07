// Proof for scripts/check-chain-budget.mjs — the chain's cost as data.
//
// Factory-side, so it lives here rather than in tests/canary/injections.json: that
// registry's `steps` keys come from VALIDATE_STEPS ∪ STOP_HOOK_STEPS and its `lanes` keys
// from job ids in the shipped consumer workflows, and a key matching neither reds it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { hasCommittedMeasurement, judgeBudget, parseTimings } from '../../scripts/lib/chain-budget.mjs'

const budget = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../scripts/chain-budget.json', import.meta.url)), 'utf8'),
)
const { VALIDATE_STEPS } = await import('../../template/base/tools/harness.config.mjs')
const chainSteps = VALIDATE_STEPS.map(([n]) => n)

const timingsFor = (overrides = {}, totalMs = 5000, notRun = 0) => ({
  totalMs,
  notRun,
  steps: { ...Object.fromEntries(chainSteps.map((n) => [n, 100])), ...overrides },
})

test('parseTimings finds the line among real validate output', () => {
  const out = [
    '=== format: pnpm exec biome ci .',
    'validate summary:',
    '  ✓ format (812ms)',
    '  total 4211ms',
    'VALIDATE_TIMINGS {"totalMs":4211,"notRun":0,"steps":{"format":812}}',
  ].join('\n')
  assert.deepEqual(parseTimings(out), { totalMs: 4211, notRun: 0, steps: { format: 812 } })
})

test('a missing VALIDATE_TIMINGS line is a problem, never a pass', () => {
  const { problems } = judgeBudget({ budget, timings: parseTimings('nothing here'), chainSteps })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /A missing measurement is not a passing measurement/)
})

test('malformed JSON on the line parses as absent rather than throwing', () => {
  assert.equal(parseTimings('VALIDATE_TIMINGS {not json}'), null)
})

test('the shipped budget covers every shipped chain step — no unbudgeted step today', () => {
  const { problems } = judgeBudget({ budget, timings: timingsFor(), chainSteps })
  assert.deepEqual(problems, [])
})

test('A CHAIN STEP WITH NO BUDGET ROW REDS — the rule that protects the next release', () => {
  // 0.6.0 plans to inject `auth-posture` and `data-flow`. Without this rule those two
  // additions would be spent against a total nobody holds.
  const withNewStep = [...chainSteps, 'auth-posture']
  const { problems } = judgeBudget({
    budget,
    timings: timingsFor({ 'auth-posture': 40 }),
    chainSteps: withNewStep,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /chain step `auth-posture` has no row in scripts\/chain-budget\.json/)
  assert.match(problems[0], /unbudgeted step is a step nobody holds/)
})

test('a budgeted step the chain no longer has reds too — a stale row', () => {
  const { problems } = judgeBudget({
    budget,
    timings: timingsFor(),
    chainSteps: chainSteps.filter((n) => n !== 'docs-sync'),
  })
  assert.ok(problems.some((p) => /budgets `docs-sync`, which is not a step/.test(p)))
})

test('a step over its class ceiling names THE STEP, not the wall', () => {
  const { problems } = judgeBudget({
    budget,
    timings: timingsFor({ 'gate-integrity': 9000 }),
    chainSteps,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /step `gate-integrity` took 9000ms, over its 5000ms ceiling/)
})

test('toolchain steps get the larger ceiling — the classes are not decoration', () => {
  // 30s would red a `static` step and must not red a `toolchain` one.
  const { problems } = judgeBudget({ budget, timings: timingsFor({ lint: 30000 }), chainSteps })
  assert.deepEqual(problems, [])
  const strict = judgeBudget({ budget, timings: timingsFor({ wiring: 30000 }), chainSteps })
  assert.equal(strict.problems.length, 1)
})

test('a partial run is a problem — a prefix inside budget is not the chain inside budget', () => {
  const t = timingsFor({}, 5000, 3)
  delete t.steps['docs-sync']
  const { problems } = judgeBudget({ budget, timings: t, chainSteps })
  assert.ok(problems.some((p) => /describe a prefix/.test(p)))
})

test('the wall warn band warns and the ceiling reds', () => {
  const warn = judgeBudget({ budget, timings: timingsFor({}, 95000), chainSteps })
  assert.deepEqual(warn.problems, [])
  assert.equal(warn.warnings.length, 1)
  const red = judgeBudget({ budget, timings: timingsFor({}, 130000), chainSteps })
  assert.ok(red.problems.some((p) => /over the 120000ms ceiling/.test(p)))
})

test('NO wall-clock measurement is committed yet, so no prose figure is licensed', () => {
  // The doctrine ordering: measure, commit the measurement, wire check-claims to it, THEN
  // publish. Until a lane records one, README.md must stay silent — and it does.
  assert.equal(hasCommittedMeasurement(budget), false)
  const readme = readFileSync(
    fileURLToPath(new URL('../../README.md', import.meta.url)),
    'utf8',
  )
  assert.match(readme, /No wall-clock timings appear in this README/)
})
