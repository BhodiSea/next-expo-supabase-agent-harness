// The chain-budget judge. PURE — no fs, no process — so the runner owns every exit and a
// test can inject a timings line without the check being able to kill the test runner.
// Same split as scripts/lib/ramp-sites.mjs and scripts/lib/escape-registry.mjs.
//
// The subject is the machine-readable line tools/validate.mjs emits LAST:
//   VALIDATE_TIMINGS {"totalMs":…,"notRun":…,"steps":{"format":123,…}}
// "Last" is load-bearing, not narration: `validate --stop-chain` runs `validate` as a
// MEMBER, and the member's own line rides the same stream ahead of the union's. The
// first recorded artifact (2026-08-09) was stamped by a first-match parser from the
// nested line — a stop measurement wearing 33 validate step names.
// SOURCE: scripts/chain-budget.json (the comment block states why this is factory-side)

const LINE_RE = /^VALIDATE_TIMINGS (\{.*\})$/gm

/**
 * Pull the timings object out of a validate run's stdout — the LAST line, because a
 * nested member's earlier one is a different chain's summary.
 * @param {string} stdout
 * @returns {{ totalMs: number, notRun: number, steps: Record<string, number> } | null}
 */
export function parseTimings(stdout) {
  let last = null
  for (const m of stdout.matchAll(LINE_RE)) last = m[1]
  if (last === null) return null
  try {
    const parsed = JSON.parse(last)
    if (typeof parsed?.totalMs !== 'number' || typeof parsed?.steps !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * @param {{ budget: any, timings: any, chainSteps: string[] }} input
 * @returns {{ problems: string[], warnings: string[] }}
 */
export function judgeBudget({ budget, timings, chainSteps }) {
  const problems = []
  const warnings = []

  if (timings === null) {
    problems.push(
      'no VALIDATE_TIMINGS line in the validate output — tools/validate.mjs emits it unconditionally as its last line, so its absence means the run died before the summary or the runner is a version that predates it. A missing measurement is not a passing measurement.',
    )
    return { problems, warnings }
  }

  pushForeignStepsProblem(
    timings,
    new Set([...chainSteps, ...Object.keys(budget.steps ?? {})]),
    problems,
  )

  const ceilingFor = (name) => {
    const row = budget.steps?.[name]
    if (typeof row?.ceilingMs === 'number') return row.ceilingMs
    return row?.class === 'toolchain'
      ? budget.defaults.toolchainCeilingMs
      : budget.defaults.staticCeilingMs
  }

  // 1. Every step that RAN is inside its ceiling.
  for (const [name, ms] of Object.entries(timings.steps)) {
    const ceiling = ceilingFor(name)
    if (ms > ceiling) {
      problems.push(
        `step \`${name}\` took ${String(ms)}ms, over its ${String(ceiling)}ms ceiling. This names the step, which the wall-clock literal it replaced could not. Either the step regressed, or the ceiling is wrong and moving it is a reviewed commit.`,
      )
    }
  }

  // 2. THE ONE THAT MATTERS FOR THE NEXT RELEASE: a step nobody budgeted. Every release
  //    that adds a chain step would otherwise spend it against a total nobody holds —
  //    exactly the hole 0.6.0's two planned steps would fall into.
  for (const name of chainSteps) {
    if (!(name in (budget.steps ?? {}))) {
      problems.push(
        `chain step \`${name}\` has no row in scripts/chain-budget.json — an unbudgeted step is a step nobody holds. Add a row with its class (static | toolchain), or an explicit ceilingMs.`,
      )
    }
  }

  // 3. And the inverse: a budgeted step the chain no longer has. A stale row is how a
  //    budget quietly stops describing the chain.
  const chainSet = new Set(chainSteps)
  for (const name of Object.keys(budget.steps ?? {})) {
    if (!chainSet.has(name)) {
      problems.push(
        `scripts/chain-budget.json budgets \`${name}\`, which is not a step in VALIDATE_STEPS — a stale row. Remove it.`,
      )
    }
  }

  // 4. The wall, one-sided, with the warn band kept as a warning rather than promoted.
  judgeWall({
    wall: budget.wall,
    totalMs: timings.totalMs,
    label: 'warm validate wall time',
    problems,
    warnings,
  })

  // 5. A run that stopped early measured a PREFIX of the chain. Judging a partial run as
  //    if it were the whole thing is how a budget certifies a chain it never saw.
  pushPrefixProblem(timings, problems)

  return { problems, warnings }
}

// The wall verdict both modes share: over the ceiling is a problem, inside the warn band
// is a warning kept as a warning rather than promoted. One implementation so the two
// walls cannot drift in shape, only in the (deliberately different) numbers.
/**
 * @param {{ wall: any, totalMs: unknown, label: string, problems: string[], warnings: string[] }} input
 */
function judgeWall({ wall, totalMs, label, problems, warnings }) {
  if (typeof totalMs !== 'number' || typeof wall?.ceilingMs !== 'number') return
  if (totalMs > wall.ceilingMs) {
    problems.push(`${label} ${String(totalMs)}ms is over the ${String(wall.ceilingMs)}ms ceiling`)
  } else if (typeof wall.warnMs === 'number' && totalMs > wall.warnMs) {
    warnings.push(
      `${label} ${String(totalMs)}ms is over the ${String(wall.warnMs)}ms target (ceiling ${String(wall.ceilingMs)}ms)`,
    )
  }
}

/**
 * A timings line naming steps neither the chain under judgment nor the budget knows is
 * a DIFFERENT chain's summary — the wrong log for the mode, or a nested member's line
 * (the emitter is shared, and `--stop-chain` runs `validate` as a member). Shared by
 * both judges, because the 2026-08-09 incident fit through both directions: the stop
 * judge skipped every row a 33-name validate line failed to match and printed CLEAN.
 * @param {{ steps?: Record<string, number> }} timings
 * @param {Set<string>} allowed
 * @param {string[]} problems
 */
function pushForeignStepsProblem(timings, allowed, problems) {
  const foreign = Object.keys(timings.steps ?? {}).filter((n) => !allowed.has(n))
  if (foreign.length > 0) {
    const shown = foreign.slice(0, 3).join(', ') + (foreign.length > 3 ? ', …' : '')
    problems.push(
      `the timings name ${String(foreign.length)} step(s) the chain under judgment does not have (${shown}) — this VALIDATE_TIMINGS line describes a different chain: the wrong log for this mode, or a nested member's line riding the same stream. Nothing it says has been judged.`,
    )
  }
}

/** A run that stopped early measured a PREFIX of the chain — shared by both judges. */
function pushPrefixProblem(timings, problems) {
  if (timings.notRun > 0) {
    problems.push(
      `${String(timings.notRun)} step(s) did not run — the chain stopped early, so these timings describe a prefix. A prefix inside budget is not the chain inside budget.`,
    )
  }
}

/**
 * The STOP half (0.7.0, W7). Judge a `validate --stop-chain --report-all` run — which
 * shares the VALIDATE_TIMINGS emitter — against the stopSteps/stopWall section.
 *
 * `unionSteps` is the floor∪config Stop union, resolved by tools/lib/stop-chain.mjs (the
 * SAME lib the Stop hook imports), so the row-closure red covers the union: a future
 * injected Stop step forces a budget row exactly like a validate step does today.
 *
 * `validate` is EXEMPT by doctrine — its cost IS the `wall` row above, judged where the
 * warm-validate log is judged — and the exemption is enforced in BOTH directions: no row
 * may name it, and its timing in the log is never judged per-step here (the stopWall
 * still contains it, deliberately: the wall is the turn-end latency an agent waits
 * through, and the nested validate is part of that wait).
 *
 * Stop rows carry an EXPLICIT ceilingMs each, no class defaults: nine members whose
 * natures differ too much for two classes to be honest (see the file's stopComment).
 * @param {{ budget: any, timings: any, unionSteps: string[] }} input
 * @returns {{ problems: string[], warnings: string[] }}
 */
export function judgeStopBudget({ budget, timings, unionSteps }) {
  const problems = []
  const warnings = []

  if (timings === null) {
    problems.push(
      'no VALIDATE_TIMINGS line in the stop-chain output — `validate --stop-chain` shares the emitter tools/validate.mjs prints unconditionally as its last line, so its absence means the run died before the summary or the runner predates the mode. A missing measurement is not a passing measurement.',
    )
    return { problems, warnings }
  }

  const rows = budget.stopSteps ?? {}
  if ('validate' in rows) {
    problems.push(
      'scripts/chain-budget.json carries a stopSteps row for `validate` — its cost IS the `wall` row (the stop rows deliberately exclude it, so the same number is never judged twice). Remove the row.',
    )
  }

  pushForeignStepsProblem(timings, new Set([...unionSteps, ...Object.keys(rows)]), problems)

  // 1. Every budgeted stop step that RAN is inside its explicit ceiling.
  for (const [name, row] of Object.entries(rows)) {
    const ms = timings.steps?.[name]
    if (typeof ms === 'number' && ms > row.ceilingMs) {
      problems.push(
        `Stop step \`${name}\` took ${String(ms)}ms, over its ${String(row.ceilingMs)}ms ceiling. Either the step regressed, or the ceiling is wrong and moving it is a reviewed commit.`,
      )
    }
  }

  // 2. THE ROW CLOSURE over the union: a Stop step nobody budgeted.
  for (const name of unionSteps) {
    if (name !== 'validate' && !(name in rows)) {
      problems.push(
        `Stop-chain step \`${name}\` has no stopSteps row in scripts/chain-budget.json — an unbudgeted step is a step nobody holds. Add a row with an explicit ceilingMs (stop rows carry no class defaults; every ceiling is chosen).`,
      )
    }
  }

  // 3. And the inverse: a row the union no longer has.
  const unionSet = new Set(unionSteps)
  for (const name of Object.keys(rows)) {
    if (!unionSet.has(name)) {
      problems.push(
        `scripts/chain-budget.json stopSteps budgets \`${name}\`, which is not in the floor∪config Stop union — a stale row. Remove it.`,
      )
    }
  }

  judgeWall({
    wall: budget.stopWall,
    totalMs: timings.totalMs,
    label: 'Stop-chain wall time',
    problems,
    warnings,
  })
  pushPrefixProblem(timings, problems)

  return { problems, warnings }
}

/**
 * Whether a wall-clock figure may appear in prose yet. Consumed by check-claims.mjs.
 *
 * TWO CONDITIONS, and the second is the one that keeps this honest past the first release
 * that records a number. A measurement is a statement about a CHAIN, and this chain grows:
 * 31 steps at 0.5.0, 33 at 0.6.0. A figure measured against 31 steps and left in place while
 * the chain gained two is not a stale number, it is a wrong one — and it would go on
 * unlocking the README claim forever, because nothing about a committed integer expires.
 *
 * So the recorded step count must match the chain being described. That comparison is
 * arithmetic over two committed values — clockless, offline, the same verdict on any machine
 * on any day — which is the same split W5a applied to the framework floor: the wall-clock
 * half is data, the closure over it rides the check.
 *
 * `chainSteps` is optional so the pure unit tests can ask the narrow question; every
 * production caller passes it.
 * @param {any} budget
 * @param {string[]} [chainSteps]
 */
export function hasCommittedMeasurement(budget, chainSteps) {
  if (typeof budget?.wall?.measuredMs !== 'number') return false
  if (chainSteps === undefined) return true
  return budget?.measurement?.chainSteps === chainSteps.length
}

/**
 * A new budget object carrying this run's measurements. PURE — returns, never writes.
 *
 * `runner` and `recordedOn` are REQUIRED and are stamped into the file, because the header
 * of chain-budget.json says these numbers are one specific runner's and are not portable.
 * A measurement with no provenance is a number a reviewer cannot weigh: they cannot tell a
 * GitHub-hosted ubuntu-latest from somebody's laptop, and the second one is worse than null
 * because it unlocks a published claim that no CI run can reproduce.
 *
 * @param {{ budget: any, timings: any, chainSteps: string[], runner: string, recordedOn: string }} input
 */
export function recordMeasurement({ budget, timings, chainSteps, runner, recordedOn }) {
  assertRecordable('recordMeasurement', timings, runner)
  return {
    ...budget,
    wall: { ...budget.wall, measuredMs: timings.totalMs },
    steps: stampRows(budget.steps, timings),
    measurement: {
      recordedOn,
      runner,
      chainSteps: chainSteps.length,
      stepsMeasured: Object.keys(timings.steps ?? {}).length,
    },
  }
}

/**
 * The STOP writer (0.7.0, W7): a new budget object with this stop-chain run's
 * measurements stamped into stopSteps/stopWall plus a `stopMeasurement` provenance block.
 * PURE — returns, never writes — and it leaves the validate-chain surface (wall, steps,
 * measurement) byte-untouched, so the two recordings compose in either order on the same
 * file. Same provenance doctrine as recordMeasurement: an unattributed number is worse
 * than null.
 * @param {{ budget: any, timings: any, unionSteps: string[], runner: string, recordedOn: string }} input
 */
export function recordStopMeasurement({ budget, timings, unionSteps, runner, recordedOn }) {
  assertRecordable('recordStopMeasurement', timings, runner)
  return {
    ...budget,
    stopWall: { ...budget.stopWall, measuredMs: timings.totalMs },
    stopSteps: stampRows(budget.stopSteps, timings),
    stopMeasurement: {
      recordedOn,
      runner,
      chainSteps: unionSteps.length,
      stepsMeasured: Object.keys(timings.steps ?? {}).length,
    },
  }
}

/**
 * The COLD writer (1.0.0): the first validate of a fresh clone with cold caches — the
 * `--min-floor` CI run bootstrap-linux performs before anything is warm. It stamps ONLY
 * `coldWall` and a `coldMeasurement` provenance block, leaving the warm and Stop surfaces
 * byte-untouched, so the three recordings compose in any order on the same file.
 *
 * The cold path is MEASURED, never BUDGETED: it has no per-step ceilings and no coldSteps
 * table, because a first-clone figure is dominated by installs and toolchain resolution the
 * chain does not own, and a ceiling there would red on the registry's afternoon rather than
 * on the chain. What the record must still hold is COVERAGE — every chain step present in
 * the timings — because a cold figure for a run that died at step 20 is not a cold figure.
 * @param {{ budget: any, timings: any, chainSteps: string[], runner: string, recordedOn: string }} input
 */
export function recordColdMeasurement({ budget, timings, chainSteps, runner, recordedOn }) {
  assertRecordable('recordColdMeasurement', timings, runner)
  const measured = Object.keys(timings.steps ?? {})
  const missing = chainSteps.filter((s) => !measured.includes(s))
  if (missing.length > 0) {
    throw new TypeError(
      `recordColdMeasurement: the cold run did not reach ${String(missing.length)} chain step(s) (${missing.join(', ')}) — a partial run is not a cold measurement`,
    )
  }
  return {
    ...budget,
    coldWall: { ...(budget.coldWall ?? {}), measuredMs: timings.totalMs },
    coldMeasurement: {
      recordedOn,
      runner,
      chainSteps: chainSteps.length,
      stepsMeasured: measured.length,
      path: 'validate --min-floor under CI=true + HARNESS_REQUIRE_TOOLCHAINS=1 on a fresh clone with cold caches — the first validate of an install',
    },
  }
}

/**
 * The cold-figure licence: `coldWall.measuredMs` is a number AND the recorded step count
 * matches the live chain — the same count-match arithmetic hasCommittedMeasurement uses,
 * applied to the cold block, so a cold figure measured against 34 steps licenses nothing
 * once the chain is 36.
 * @param {any} budget
 * @param {string[] | undefined} chainSteps
 */
export function hasCommittedColdMeasurement(budget, chainSteps) {
  if (typeof budget?.coldWall?.measuredMs !== 'number') return false
  if (chainSteps === undefined) return true
  return budget?.coldMeasurement?.chainSteps === chainSteps.length
}

/** The shared provenance refusal — enforced at the seam so a second caller inherits it. */
function assertRecordable(fnName, timings, runner) {
  if (timings === null) throw new TypeError(`${fnName}: no timings to record`)
  if (typeof runner !== 'string' || runner.trim() === '') {
    throw new TypeError(`${fnName}: \`runner\` is required — an unattributed measurement`)
  }
}

/**
 * Stamp measuredMs onto a row table from a timings object. A step the run did not reach
 * keeps its previous value rather than being zeroed: a partial run must not overwrite a
 * whole one with silence.
 * @param {Record<string, any> | undefined} rows
 * @param {{ steps?: Record<string, number> }} timings
 */
function stampRows(rows, timings) {
  /** @type {Record<string, any>} */
  const out = {}
  for (const [name, row] of Object.entries(rows ?? {})) {
    const ms = timings.steps?.[name]
    out[name] = {
      ...row,
      measuredMs: typeof ms === 'number' ? ms : (row.measuredMs ?? null),
    }
  }
  return out
}
