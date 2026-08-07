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
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { judgeBudget, parseTimings } from './lib/chain-budget.mjs'

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
console.log(
  `CHAIN BUDGET: CLEAN (${String(Object.keys(timings.steps).length)} step(s) inside ceiling, wall ${String(timings.totalMs)}ms of ${String(budget.wall.ceilingMs)}ms)`,
)
