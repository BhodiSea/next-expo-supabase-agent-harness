#!/usr/bin/env node
// scripts/check-essential-eight-evidence.mjs — the factory-side half of the Essential
// Eight register's closure: a `simulated-activity` claim must name a REGISTERED can-fail
// proof.
//
// WHY THIS IS FACTORY-SIDE. tests/canary/injections.json never ships to an install — it
// is the harness's own falsifiability registry — so a consumer's chain cannot judge a
// claim that points into it. Asking an install to answer for a registry it does not have
// is the defect scripts/check-tier-coverage.mjs avoids by living here: this is where the
// artefact is authored, so this is where it is judged. The consumer gate
// (tools/check-essential-eight.mjs) owns every closure that IS decidable from an install.
//
// WHY THE TOP TIER IS THE ONE THAT NEEDS GUARDING. ASD's assessment process guide ranks
// evidence: documentation and interviews are POOR, testing with simulated activity is
// EXCELLENT. That ranking is this release's whole design, so the strongest claim a row
// can make is exactly the claim that must be hardest to make — it has to name an
// injection somebody can watch go red.
//
// The judgements are shared with the consumer gate (template/base/tools/lib/
// essential-eight.mjs), never re-implemented, so the two can never disagree about shape.
// SOURCE: scripts/check-tier-coverage.mjs (the same factory-side-because-that-is-where-
// it-is-authored argument)
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { canaryProblems, summarise } from '../template/base/tools/lib/essential-eight.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REGISTER = 'template/base/tools/essential-eight.json'
const CANARIES = 'tests/canary/injections.json'
const OBLIGATIONS = 'scripts/obligations.json'

const fail = (lines) => {
  console.error(`ESSENTIAL EIGHT EVIDENCE: ${String(lines.length)} problem(s):`)
  for (const l of lines) console.error(`  - ${l}`)
  console.error(
    '\nASD ranks documentation and interviews as POOR evidence and simulated-activity testing as EXCELLENT. A row may only claim the top tier while an injection proves its control can go RED.',
  )
  process.exit(1)
}

let register
let canaries
try {
  register = JSON.parse(readFileSync(join(ROOT, REGISTER), 'utf8'))
} catch (e) {
  fail([`${REGISTER} is missing or unparseable: ${e instanceof Error ? e.message : String(e)}`])
}
try {
  canaries = JSON.parse(readFileSync(join(ROOT, CANARIES), 'utf8'))
} catch (e) {
  fail([`${CANARIES} is missing or unparseable: ${e instanceof Error ? e.message : String(e)}`])
}

const keys = new Set(Object.keys(canaries.steps ?? {}))
if (keys.size === 0) {
  // Anti-vacuity: an empty registry would make every simulated-activity claim resolve to
  // nothing and the check would pass by finding no evidence at all.
  fail([`${CANARIES} declares no steps{} — the registry this check resolves against is empty.`])
}

const problems = canaryProblems(register, keys)

// The obligations closure, factory-side for the same reason as the canary one:
// scripts/obligations.json is the HARNESS's register of its own forward debts and never
// ships to an install, so a consumer's chain cannot resolve the ids its register names.
// The consumer gate requires the field to be non-empty; this proves it points somewhere.
// Without it, `not-implemented` could name a debt nobody carries — which is a gap with the
// APPEARANCE of an owner, strictly worse than an unowned one.
let obligations
try {
  obligations = JSON.parse(readFileSync(join(ROOT, OBLIGATIONS), 'utf8'))
} catch (e) {
  fail([`${OBLIGATIONS} is missing or unparseable: ${e instanceof Error ? e.message : String(e)}`])
}
const owned = new Set((obligations.obligations ?? []).map((o) => o.id))
for (const r of register.requirements) {
  if (r.obligation && !owned.has(r.obligation)) {
    problems.push(
      `row '${String(r.id)}': obligation '${String(r.obligation)}' has no row in ${OBLIGATIONS}. An unbuilt requirement must name a debt somebody actually carries.`,
    )
  }
}

if (problems.length > 0) fail(problems)

const s = summarise(register)
const claiming = register.requirements.filter((r) => r.evidenceTier === 'simulated-activity')
const tiers = {}
for (const r of register.requirements) tiers[r.evidenceTier] = (tiers[r.evidenceTier] ?? 0) + 1

console.log(
  `ESSENTIAL EIGHT EVIDENCE: CLEAN (${String(s.total)} row(s); ${String(claiming.length)} claim simulated-activity and each names a registered can-fail proof [${[...new Set(claiming.map((r) => r.canary))].sort().join(', ')}]; tiers ${Object.entries(tiers)
    .sort()
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ')})`,
)
