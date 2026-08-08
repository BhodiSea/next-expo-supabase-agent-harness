// The chain-budget judge. PURE — no fs, no process — so the runner owns every exit and a
// test can inject a timings line without the check being able to kill the test runner.
// Same split as scripts/lib/ramp-sites.mjs and scripts/lib/escape-registry.mjs.
//
// The subject is the one machine-readable line tools/validate.mjs emits last:
//   VALIDATE_TIMINGS {"totalMs":…,"notRun":…,"steps":{"format":123,…}}
// SOURCE: scripts/chain-budget.json (the comment block states why this is factory-side)

const LINE_RE = /^VALIDATE_TIMINGS (\{.*\})$/m

/**
 * Pull the timings object out of a validate run's stdout.
 * @param {string} stdout
 * @returns {{ totalMs: number, notRun: number, steps: Record<string, number> } | null}
 */
export function parseTimings(stdout) {
  const m = LINE_RE.exec(stdout)
  if (m === null) return null
  try {
    const parsed = JSON.parse(m[1])
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
  if (typeof timings.totalMs === 'number') {
    if (timings.totalMs > budget.wall.ceilingMs) {
      problems.push(
        `warm validate wall time ${String(timings.totalMs)}ms is over the ${String(budget.wall.ceilingMs)}ms ceiling`,
      )
    } else if (timings.totalMs > budget.wall.warnMs) {
      warnings.push(
        `warm validate wall time ${String(timings.totalMs)}ms is over the ${String(budget.wall.warnMs)}ms target (ceiling ${String(budget.wall.ceilingMs)}ms)`,
      )
    }
  }

  // 5. A run that stopped early measured a PREFIX of the chain. Judging a partial run as
  //    if it were the whole thing is how a budget certifies a chain it never saw.
  if (timings.notRun > 0) {
    problems.push(
      `${String(timings.notRun)} step(s) did not run — the chain stopped early, so these timings describe a prefix. A prefix inside budget is not the chain inside budget.`,
    )
  }

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
  if (timings === null) throw new TypeError('recordMeasurement: no timings to record')
  if (typeof runner !== 'string' || runner.trim() === '') {
    throw new TypeError('recordMeasurement: `runner` is required — an unattributed measurement')
  }
  const steps = {}
  for (const [name, row] of Object.entries(budget.steps ?? {})) {
    const ms = timings.steps?.[name]
    // A step the run did not reach keeps its previous value rather than being zeroed: a
    // partial run must not overwrite a whole one with silence.
    steps[name] = { ...row, measuredMs: typeof ms === 'number' ? ms : (row.measuredMs ?? null) }
  }
  return {
    ...budget,
    wall: { ...budget.wall, measuredMs: timings.totalMs },
    steps,
    measurement: {
      recordedOn,
      runner,
      chainSteps: chainSteps.length,
      stepsMeasured: Object.keys(timings.steps ?? {}).length,
    },
  }
}
