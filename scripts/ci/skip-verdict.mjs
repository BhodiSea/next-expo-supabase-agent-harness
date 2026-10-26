#!/usr/bin/env node
// The runner for scripts/lib/skip-verdict.mjs — owns fs and the exit code, nothing else.
//
//   usage: node scripts/ci/skip-verdict.mjs <validate.log> <validateCode>
//
// SOURCE: .github/workflows/selftest.yml (macos-scaffold)
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { judgeSkips } from '../lib/skip-verdict.mjs'

const [logPath, rawCode] = process.argv.slice(2)
if (!logPath || rawCode === undefined) {
  console.error('usage: skip-verdict.mjs <validate.log> <validateCode>')
  process.exit(2)
}

const { problems, allowedSkips } = judgeSkips({
  validateLog: readFileSync(logPath, 'utf8'),
  validateCode: Number.parseInt(rawCode, 10),
})

for (const s of allowedSkips) console.log(`  allowed (database): ${s.line.trim()}`)

if (problems.length > 0) {
  console.error(`skip-verdict: ${String(problems.length)} problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('skip-verdict: OK — no gate skipped that runs without a database')
