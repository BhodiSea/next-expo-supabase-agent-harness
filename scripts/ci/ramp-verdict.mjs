#!/usr/bin/env node
// The runner for scripts/lib/ramp-verdict.mjs — owns fs and the exit code, nothing else.
//
//   usage: node scripts/ci/ramp-verdict.mjs <expected-gates> <validate.log> <validateCode> <baseVersion>
//
// <expected-gates> is the lane's space-separated EXPIRED set AFTER narrowing to the chain
// this step actually ran (the Stop-chain gates are dropped upstream and reported there).
// Empty string means "no deadline is met", which is a legitimate expectation with its own
// consequence rather than an absence of one.
// SOURCE: scripts/ci/upgrade-lane.sh (§7a)
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { judgeExpiries } from '../lib/ramp-verdict.mjs'

const [rawExpected = '', logPath, rawCode, baseVersion] = process.argv.slice(2)
if (!logPath || rawCode === undefined || !baseVersion) {
  console.error(
    'usage: ramp-verdict.mjs <expected-gates> <validate.log> <validateCode> <baseVersion>',
  )
  process.exit(2)
}

const expected = rawExpected.split(/\s+/).filter(Boolean)
const { problems, fired, silent } = judgeExpiries({
  expected,
  validateLog: readFileSync(logPath, 'utf8'),
  validateCode: Number.parseInt(rawCode, 10),
  baseVersion,
})

for (const g of fired) console.log(`  expired:   ${g}`)
for (const g of silent) {
  console.log(`  (silent):  ${g} — deadline met, but this tree carries no finding for it to withhold`)
}

if (problems.length > 0) {
  console.error(`upgrade-lane: ${String(problems.length)} expiry problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
