#!/usr/bin/env node
// check-chain-budget — the runner. Reads a validate run's stdout (a file path, or stdin)
// and judges it against scripts/chain-budget.json.
//
// Usage, from .github/workflows/selftest.yml's warm-validate step:
//   node tools/validate.mjs --report-all | tee validate.log
//   node scripts/check-chain-budget.mjs validate.log
//
// FACTORY-SIDE ONLY. It is not a chain step and never will be: a consumer's hardware is
// not the harness's runner, and scripts/check-claims.mjs:12 already carries the honest
// version of this — "wall-clock timings are hardware-dependent, so no gate can assert
// they are true".
// SOURCE: scripts/chain-budget.json
import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { judgeBudget, parseTimings, recordMeasurement } from './lib/chain-budget.mjs'

const HERE = (p) => fileURLToPath(new URL(p, import.meta.url))
const budget = JSON.parse(readFileSync(HERE('./chain-budget.json'), 'utf8'))
const { VALIDATE_STEPS } = await import(HERE('../template/base/tools/harness.config.mjs'))

// A FILE PATH, deliberately not stdin. A synchronous read of fd 0 raises EAGAIN on macOS
// whenever the writer has not finished, which would make this check flaky in exactly the
// way a timing check must not be — a control that intermittently dies is indistinguishable
// from one that intermittently passes. The lane already tees to a file.
const logPath = process.argv[2]
if (logPath === undefined) {
  console.error(
    'usage: node scripts/check-chain-budget.mjs <validate-log-path>\n  e.g. node tools/validate.mjs --report-all | tee validate.log && node scripts/check-chain-budget.mjs validate.log',
  )
  process.exit(2)
}
const stdout = readFileSync(logPath, 'utf8')

const { problems, warnings } = judgeBudget({
  budget,
  timings: parseTimings(stdout),
  chainSteps: VALIDATE_STEPS.map(([name]) => name),
})

for (const w of warnings) console.log(`::warning::CHAIN BUDGET: ${w}`)

if (problems.length > 0) {
  console.error(`CHAIN BUDGET: ${String(problems.length)} problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error(
    '\nCeilings are a reviewed policy value in scripts/chain-budget.json, not a measurement. Moving one is a commit; measuring is what the lane does.',
  )
  process.exit(1)
}

const timings = parseTimings(stdout)

// `--record` — the writer chain-budget.json's own header promised and nobody had built.
//
// That header says measuredMs "stays null until a real selftest run records one in a
// reviewed commit". Nothing could record one: this runner JUDGED against ceilings and threw
// the numbers away, so the file has shipped all-null since it was introduced and the README
// has carried no wall-clock figure because of it. The ordering it prescribes — measure,
// commit the measurement, then publish — was unreachable at step one.
//
// `--runner` is REQUIRED and is stamped into the file rather than inferred, because the
// whole point of the header is that these numbers belong to one machine. In Actions it
// defaults from the job's own environment; anywhere else you have to say what you ran on,
// and that string lands in the diff for a reviewer to weigh. A CI-only env check was the
// other option and it is weaker: it asks WHERE the process is, when the question is where
// the LOG came from — a maintainer recording from a downloaded CI log is doing the right
// thing, and `CI=1` on a laptop is a keystroke.
if (process.argv.includes('--record')) {
  // `indexOf` returns -1 when the flag is absent, and argv[-1 + 1] is argv[0] — the node
  // binary path. The first version of this recorded a measurement attributed to
  // `/opt/homebrew/.../bin/node` and reported success, which is the exact failure the flag
  // exists to prevent: an unattributed number wearing a provenance string. Guard the index.
  const at = process.argv.indexOf('--runner')
  const flagged = at === -1 ? undefined : process.argv[at + 1]
  const fromActions =
    process.env.GITHUB_ACTIONS === 'true'
      ? `${process.env.RUNNER_OS ?? 'unknown'}/${process.env.RUNNER_ARCH ?? 'unknown'} (${process.env.GITHUB_WORKFLOW ?? 'workflow'})`
      : undefined
  const runner = flagged !== undefined && !flagged.startsWith('--') ? flagged : fromActions
  if (runner === undefined) {
    console.error(
      'CHAIN BUDGET: --record needs `--runner "<what you measured on>"` outside GitHub Actions. scripts/chain-budget.json\'s header states these numbers are the harness runner\'s and are NOT portable, so a measurement with no provenance is worse than none — it unlocks a published figure that no CI run can reproduce.',
    )
    process.exit(2)
  }
  const next = recordMeasurement({
    budget,
    timings,
    chainSteps: VALIDATE_STEPS.map(([name]) => name),
    runner,
    recordedOn: new Date().toISOString().slice(0, 10),
  })
  writeFileSync(HERE('./chain-budget.json'), `${JSON.stringify(next, null, 2)}\n`)
  console.log(
    `CHAIN BUDGET: RECORDED wall ${String(timings.totalMs)}ms over ${String(next.measurement.chainSteps)} step(s) on ${runner}. Commit scripts/chain-budget.json — the figure may be published only after that lands.`,
  )
}

console.log(
  `CHAIN BUDGET: CLEAN (${String(Object.keys(timings.steps).length)} step(s) inside ceiling, wall ${String(timings.totalMs)}ms of ${String(budget.wall.ceilingMs)}ms)`,
)
