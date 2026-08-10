// Proof for scripts/check-chain-budget.mjs — the chain's cost as data.
//
// Factory-side, so it lives here rather than in tests/canary/injections.json: that
// registry's `steps` keys come from VALIDATE_STEPS ∪ STOP_HOOK_STEPS and its `lanes` keys
// from job ids in the shipped consumer workflows, and a key matching neither reds it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  hasCommittedMeasurement,
  judgeBudget,
  judgeStopBudget,
  parseTimings,
  recordMeasurement,
  recordStopMeasurement,
} from '../../scripts/lib/chain-budget.mjs'

const budget = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../scripts/chain-budget.json', import.meta.url)), 'utf8'),
)
const { STOP_HOOK_STEPS, VALIDATE_STEPS } = await import(
  '../../template/base/tools/harness.config.mjs'
)
const chainSteps = VALIDATE_STEPS.map(([n]) => n)

// The Stop union, resolved by the SAME lib the Stop hook and `validate --stop-chain`
// import — one implementation, so this proof and the judge can never disagree with the
// hook about what the chain IS.
const { loadStopChain } = await import('../../template/base/tools/lib/stop-chain.mjs')
const stopResolution = loadStopChain(
  STOP_HOOK_STEPS,
  new URL('../../template/base/tools/stop.floor.json', import.meta.url),
)
const stopUnion = stopResolution.steps.map(([n]) => n)

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

test('parseTimings takes the LAST line — a nested member’s earlier line must not win', () => {
  // 2026-08-09, the FIRST recorded artifact (selftest run 31307386944): `validate
  // --stop-chain` runs `validate` as a MEMBER, and the member's own VALIDATE_TIMINGS line
  // rides the same stream ahead of the union's. The first-match parser stamped stopWall
  // from the nested line (27955ms, 33 validate step names), matched zero of the nine stop
  // rows, and shipped an artifact whose stop half was a measurement of the wrong chain.
  // "Emits last" was always the doctrine at the top of this lib; now it is the
  // implementation.
  const out = [
    '  ✓ validate (27995ms)',
    'VALIDATE_TIMINGS {"totalMs":27955,"notRun":0,"steps":{"format":2839,"types":6174}}',
    '  ✓ rls-isolation (6768ms)',
    'VALIDATE_TIMINGS {"totalMs":52480,"notRun":0,"steps":{"validate":27995,"rls-isolation":6768}}',
  ].join('\n')
  assert.deepEqual(parseTimings(out), {
    totalMs: 52480,
    notRun: 0,
    steps: { validate: 27995, 'rls-isolation': 6768 },
  })
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

test('the committed measurement describes THIS chain — and the published figures ARE the committed ones', () => {
  // This pin has now flipped three times, and the round-trip is the doctrine working. The
  // 0.7.0 recording (selftest run 31307386944) satisfied it; 0.8.0 grew the chain to 34
  // (`observability`) and the release deliberately shipped in the interim state — count
  // mismatch, hasCommittedMeasurement false, no figure licensed — until the post-release
  // dispatch (selftest run 31342080611) re-measured all 34 steps and both Stop halves in
  // one artifact, committed verbatim. 0.9.0 then PUBLISHED the licensed figures (the W5
  // prose-truth batch), so the sentinel half flips with it: the README's numbers must be
  // the committed measurement's own millisecond values, derived here rather than
  // hand-typed, and check-claims' chain-cost class holds the ~Ns phrasings around them.
  // The invariant is the same as ever: a measuredMs may exist only under a count-matched
  // provenance stamp, and never over its own ceiling.
  assert.equal(hasCommittedMeasurement(budget, chainSteps), true)
  assert.ok(budget.measurement.runner.trim(), 'a measurement with no runner is unattributed')
  assert.match(budget.measurement.recordedOn, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(budget.measurement.stepsMeasured, chainSteps.length)
  assert.ok(budget.wall.measuredMs <= budget.wall.ceilingMs, 'a committed wall over its own ceiling')
  const readme = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8')
  assert.ok(
    readme.includes(`(${budget.wall.measuredMs} ms`),
    'the README wall figure must be the committed measurement, verbatim in milliseconds',
  )
  assert.ok(
    readme.includes(`(${budget.stopWall.measuredMs} ms`),
    'the README Stop turn-end figure must be the committed stopWall measurement, verbatim',
  )
})

test('recordMeasurement fills the file the header promised nobody could write (0.6.0)', () => {
  // chain-budget.json says measuredMs "stays null until a real selftest run records one in a
  // reviewed commit" — and until 0.6.0 there was no writer at all. The runner judged against
  // ceilings and discarded the numbers, so step one of "measure, commit, publish" had no
  // implementation and the file has shipped all-null since it was introduced.
  const before = structuredClone(budget)
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
  assert.deepEqual(budget, before)
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

// ---------------------------------------------------------------------------------------
// THE STOP HALF (0.7.0, W7). The nine steps that dominate turn latency had no ceiling:
// a Stop step that grows to 40s degrades every agent turn invisibly, because nothing
// judged the chain the Stop hook actually runs. stopSteps rows judge the floor∪config
// union that `validate --stop-chain --report-all` executes and times (the VALIDATE_TIMINGS
// emitter is shared); `validate` is deliberately rowless — its cost IS the `wall` row.

const stopTimingsFor = (overrides = {}, totalMs = 60000, notRun = 0) => ({
  totalMs,
  notRun,
  steps: { ...Object.fromEntries(stopUnion.map((n) => [n, 100])), ...overrides },
})

test('a stop judge fed a VALIDATE-chain line reds instead of judging nothing — the incident pin', () => {
  // The exact shape of the 2026-08-09 defect, downstream of the parser bug above and a
  // hole of its own: 33 validate step names, none in the union, notRun 0. The old judge
  // skipped every row (`typeof ms === 'number'`), found no closure violation, passed the
  // 27955ms "wall", and CI printed `CHAIN BUDGET (stop-chain): CLEAN (33 step(s) inside
  // ceiling)` — a stop verdict describing 33 steps. A judge handed the wrong chain's line
  // must say so, not judge nothing and call it CLEAN.
  const { problems } = judgeStopBudget({ budget, timings: timingsFor(), unionSteps: stopUnion })
  assert.ok(
    problems.some((p) => /describes a different chain/.test(p)),
    `expected the wrong-chain refusal, got: ${JSON.stringify(problems)}`,
  )
})

test('the mirror holds for the validate judge — a stop-chain line cannot be judged as the validate chain', () => {
  const { problems } = judgeBudget({ budget, timings: stopTimingsFor(), chainSteps })
  assert.ok(
    problems.some((p) => /describes a different chain/.test(p)),
    `expected the wrong-chain refusal, got: ${JSON.stringify(problems)}`,
  )
})

test('the Stop union resolves from the shipped floor — the judge never holds a weakened chain', () => {
  assert.equal(stopResolution.floorNote, null)
  assert.ok(stopUnion.includes('validate'), 'the union carries the validate member')
  assert.ok(stopUnion.includes('reviewer-verdicts'), 'and the turn-scoped tail')
})

test('the shipped stopSteps cover the union minus `validate` — no unbudgeted Stop step today', () => {
  const { problems } = judgeStopBudget({
    budget,
    timings: stopTimingsFor(),
    unionSteps: stopUnion,
  })
  assert.deepEqual(problems, [])
  assert.equal(budget.stopSteps.validate, undefined, 'validate must stay rowless — its cost IS the wall row')
  assert.equal(Object.keys(budget.stopSteps).length, stopUnion.length - 1)
})

test('A STOP UNION MEMBER WITH NO stopSteps ROW REDS — a future injected Stop step forces a budget row', () => {
  // Same fixture-name discipline as the validate-chain must-red above: a name no release
  // will ever add, guarded so injecting a real step cannot silently green this proof.
  const ABSENT = 'a-stop-step-no-release-will-ever-add'
  assert.ok(!stopUnion.includes(ABSENT), 'the fixture must name a step the union does not have')
  assert.equal(budget.stopSteps[ABSENT], undefined, 'and one the budget does not hold')

  const { problems } = judgeStopBudget({
    budget,
    timings: stopTimingsFor({ [ABSENT]: 40 }),
    unionSteps: [...stopUnion, ABSENT],
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], new RegExp(`Stop-chain step \`${ABSENT}\` has no stopSteps row`))
  assert.match(problems[0], /unbudgeted step is a step nobody holds/)
})

test('a stopSteps row the union no longer has reds too — a stale row', () => {
  const t = stopTimingsFor()
  delete t.steps['duplication']
  const { problems } = judgeStopBudget({
    budget,
    timings: t,
    unionSteps: stopUnion.filter((n) => n !== 'duplication'),
  })
  assert.ok(
    problems.some((p) =>
      /stopSteps budgets `duplication`, which is not in the floor∪config Stop union/.test(p),
    ),
  )
})

test('an over-ceiling Stop timing in a synthetic log reds NAMING THE STEP', () => {
  const ceiling = budget.stopSteps['mobile-unit'].ceilingMs
  const { problems } = judgeStopBudget({
    budget,
    timings: stopTimingsFor({ 'mobile-unit': ceiling + 1 }),
    unionSteps: stopUnion,
  })
  assert.equal(problems.length, 1)
  assert.match(
    problems[0],
    new RegExp(
      `Stop step \`mobile-unit\` took ${String(ceiling + 1)}ms, over its ${String(ceiling)}ms ceiling`,
    ),
  )
})

test('`validate` is exempt from stopSteps — its cost IS the wall row, and a row for it reds', () => {
  // A nested warm validate of any duration must not red the Stop judge per-step: the
  // `wall` row (judged by the warm-validate step) already owns that number.
  const exempt = judgeStopBudget({
    budget,
    timings: stopTimingsFor({ validate: 999999999 }, 400000),
    unionSteps: stopUnion,
  })
  assert.deepEqual(exempt.problems, [])
  // And the exemption is enforced in BOTH directions: a stopSteps row naming validate is
  // itself a problem, so the doctrine cannot silently rot into double-judging.
  const withRow = {
    ...budget,
    stopSteps: { ...budget.stopSteps, validate: { ceilingMs: 1, measuredMs: null } },
  }
  const { problems } = judgeStopBudget({
    budget: withRow,
    timings: stopTimingsFor(),
    unionSteps: stopUnion,
  })
  assert.ok(problems.some((p) => /stopSteps row for `validate`/.test(p)))
})

test('the stopWall warn band warns and the ceiling reds', () => {
  const warn = judgeStopBudget({ budget, timings: stopTimingsFor({}, 460000), unionSteps: stopUnion })
  assert.deepEqual(warn.problems, [])
  assert.equal(warn.warnings.length, 1)
  const red = judgeStopBudget({ budget, timings: stopTimingsFor({}, 700000), unionSteps: stopUnion })
  assert.ok(red.problems.some((p) => /over the 600000ms ceiling/.test(p)))
})

test('a partial Stop run is a problem — a prefix inside budget is not the chain inside budget', () => {
  const t = stopTimingsFor({}, 60000, 2)
  delete t.steps['reviewer-verdicts']
  const { problems } = judgeStopBudget({ budget, timings: t, unionSteps: stopUnion })
  assert.ok(problems.some((p) => /describe a prefix/.test(p)))
})

test('a missing VALIDATE_TIMINGS line in a stop-chain log is a problem, never a pass', () => {
  const { problems } = judgeStopBudget({
    budget,
    timings: parseTimings('nothing here'),
    unionSteps: stopUnion,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /A missing measurement is not a passing measurement/)
})

test('the shipped stop measurement is REAL — every measuredMs sits under a provenance stamp', () => {
  // Until 2026-08-09 this test pinned every row NULL ("a measurement may not be invented").
  // The first reviewed recording flips the invariant, not the doctrine: a number may exist
  // only under a stopMeasurement stamp naming the runner and count-matched to the union it
  // measured, and no committed number may sit over its own ceiling — a budget whose own
  // data reds it is a contradiction someone committed without looking.
  assert.equal(typeof budget.stopWall.measuredMs, 'number')
  assert.ok(budget.stopWall.measuredMs <= budget.stopWall.ceilingMs)
  for (const [name, row] of Object.entries(budget.stopSteps)) {
    assert.equal(typeof row.measuredMs, 'number', `${name} lost its measurement`)
    assert.ok(row.measuredMs <= row.ceilingMs, `${name} committed a measuredMs over its own ceiling`)
  }
  assert.ok(budget.stopMeasurement.runner.trim(), 'a stop measurement with no runner is unattributed')
  assert.match(budget.stopMeasurement.recordedOn, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(budget.stopMeasurement.chainSteps, stopUnion.length)
  assert.equal(budget.stopMeasurement.stepsMeasured, stopUnion.length)
})

test('recordStopMeasurement stamps the stop rows + stopWall with provenance, purely', () => {
  const before = structuredClone(budget)
  const next = recordStopMeasurement({
    budget,
    timings: stopTimingsFor({ 'rls-isolation': 41000 }, 300000),
    unionSteps: stopUnion,
    runner: 'ubuntu-latest',
    recordedOn: '2026-08-08',
  })
  assert.equal(next.stopWall.measuredMs, 300000)
  assert.equal(next.stopSteps['rls-isolation'].measuredMs, 41000)
  assert.equal(next.stopMeasurement.runner, 'ubuntu-latest')
  assert.equal(next.stopMeasurement.chainSteps, stopUnion.length)
  // PURE, and the validate-chain measurement surface is untouched by the stop stamp.
  assert.deepEqual(budget, before)
  assert.equal(next.wall.measuredMs, budget.wall.measuredMs)
  assert.deepEqual(next.measurement, budget.measurement)
  // The provenance refusal holds at the seam for the new mode too.
  for (const runner of [undefined, '', '   ']) {
    assert.throws(
      () =>
        recordStopMeasurement({
          budget,
          timings: stopTimingsFor(),
          unionSteps: stopUnion,
          runner,
          recordedOn: '2026-08-08',
        }),
      /`runner` is required/,
    )
  }
})

test('--record --stop-chain refuses to stamp outside Actions without --runner (CLI re-pin for the new mode)', () => {
  // A synthetic GREEN stop log, so the CLI's judge passes and the refusal is the only
  // thing standing between the run and a stamped file.
  const dir = mkdtempSync(join(tmpdir(), 'chain-budget-stop-'))
  const logPath = join(dir, 'stop-chain.log')
  writeFileSync(logPath, `noise\nVALIDATE_TIMINGS ${JSON.stringify(stopTimingsFor())}\n`)
  const shippedPath = fileURLToPath(new URL('../../scripts/chain-budget.json', import.meta.url))
  const shippedBefore = readFileSync(shippedPath, 'utf8')
  const env = { ...process.env }
  delete env.GITHUB_ACTIONS // the refusal is about where the LOG came from, not where we run
  const r = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../../scripts/check-chain-budget.mjs', import.meta.url)),
      logPath,
      '--record',
      '--stop-chain',
    ],
    { encoding: 'utf8', env },
  )
  assert.equal(r.status, 2, `expected the provenance refusal (exit 2), got ${String(r.status)}:\n${r.stdout}\n${r.stderr}`)
  assert.match(r.stderr, /--record needs `--runner "<what you measured on>"` outside GitHub Actions/)
  // And the shipped file was NOT touched on the way to the refusal.
  assert.equal(readFileSync(shippedPath, 'utf8'), shippedBefore)
})
