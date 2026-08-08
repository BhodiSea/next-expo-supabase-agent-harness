// Proof for scripts/check-chain-budget.mjs — the chain's cost as data.
//
// Factory-side, so it lives here rather than in tests/canary/injections.json: that
// registry's `steps` keys come from VALIDATE_STEPS ∪ STOP_HOOK_STEPS and its `lanes` keys
// from job ids in the shipped consumer workflows, and a key matching neither reds it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  hasCommittedMeasurement,
  judgeBudget,
  parseTimings,
  recordMeasurement,
} from '../../scripts/lib/chain-budget.mjs'

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
  // THE FIXTURE NAME IS DELIBERATELY ONE NO STEP CAN EVER HAVE. It used to be
  // `auth-posture` — the step 0.6.0 was planning to inject — and injecting it turned this
  // must-red silently GREEN, because the name then had a budget row and there was nothing
  // left to be missing. A must-red keyed to a name the roadmap intends to create is a
  // must-red with an expiry date nobody wrote down. The guard below is what makes the name
  // a claim rather than a hope.
  const ABSENT = 'a-step-no-release-will-ever-add'
  assert.ok(!chainSteps.includes(ABSENT), 'the fixture must name a step the chain does not have')
  assert.equal(budget.steps[ABSENT], undefined, 'and one the budget does not hold')

  const { problems } = judgeBudget({
    budget,
    timings: timingsFor({ [ABSENT]: 40 }),
    chainSteps: [...chainSteps, ABSENT],
  })
  assert.equal(problems.length, 1)
  assert.match(
    problems[0],
    new RegExp(`chain step \`${ABSENT}\` has no row in scripts/chain-budget\\.json`),
  )
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
  const readme = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8')
  assert.match(readme, /No wall-clock timings appear in this README/)
})

test('recordMeasurement fills the file the header promised nobody could write (0.6.0)', () => {
  // chain-budget.json says measuredMs "stays null until a real selftest run records one in a
  // reviewed commit" — and until 0.6.0 there was no writer at all. The runner judged against
  // ceilings and discarded the numbers, so step one of "measure, commit, publish" had no
  // implementation and the file has shipped all-null since it was introduced.
  const next = recordMeasurement({
    budget,
    timings: timingsFor({ alpha: 40, beta: 60 }, 100),
    chainSteps,
    runner: 'ubuntu-latest',
    recordedOn: '2026-08-08',
  })
  assert.equal(next.wall.measuredMs, 100)
  assert.equal(next.measurement.runner, 'ubuntu-latest')
  assert.equal(next.measurement.chainSteps, chainSteps.length)
  // PURE: the input is not mutated, so a caller that decides not to write has not already.
  assert.equal(budget.wall.measuredMs, null)
})

test('an unattributed measurement is refused at the seam, not just at the CLI', () => {
  // The provenance is the point: chain-budget.json's header states these numbers belong to
  // one runner and are not portable, so a figure with no `runner` is worse than null — it
  // unlocks a published claim no CI run can reproduce. Enforced in the pure function too,
  // because a second caller would otherwise inherit only the CLI's discipline.
  for (const runner of [undefined, '', '   ']) {
    assert.throws(
      () =>
        recordMeasurement({
          budget,
          timings: timingsFor({}, 100),
          chainSteps,
          runner,
          recordedOn: '2026-08-08',
        }),
      /`runner` is required/,
    )
  }
})

test('a measurement taken against a DIFFERENT chain no longer licenses prose (0.6.0)', () => {
  // The half that keeps this honest past the first recorded number. A measurement describes
  // a CHAIN, and this chain grows — 31 steps at 0.5.0, 33 at 0.6.0. A figure measured against
  // 31 and left in place while two steps landed is not stale, it is wrong, and nothing about
  // a committed integer expires on its own. The comparison is arithmetic over two committed
  // values: clockless, offline, same verdict anywhere — the same split W5a applied to the
  // framework floor's review window.
  const measured = recordMeasurement({
    budget,
    timings: timingsFor({}, 100),
    chainSteps,
    runner: 'ubuntu-latest',
    recordedOn: '2026-08-08',
  })
  assert.equal(hasCommittedMeasurement(measured, chainSteps), true)
  assert.equal(hasCommittedMeasurement(measured, [...chainSteps, 'a-new-step']), false)
})
