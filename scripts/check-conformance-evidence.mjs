#!/usr/bin/env node
// scripts/check-conformance-evidence.mjs — the factory-side half of the conformance MAP's
// closure: every `covered`/`partial` row names a REGISTERED can-fail proof for ITS OWN
// control, and every above-floor `not-applicable` row names the registered proof that
// would red if its absent surface reappeared.
//
// WHY THIS IS FACTORY-SIDE. tests/canary/injections.json never ships to an install — it is
// the harness's own falsifiability registry — so a consumer's chain cannot judge a claim
// that points into it. Asking an install to answer for a registry it does not have is the
// defect scripts/check-tier-coverage.mjs avoids by living here: this is where the artefact
// is authored, so this is where it is judged. The consumer gate
// (tools/check-conformance-map.mjs) owns every closure that IS decidable from an install:
// census, live controls, module conditionality, the unmapped-controls partition, the
// claim-sentence ban, and the regen-diff of the two generated documents.
//
// THREE REGISTRIES, NOT TWO. A control this map names is a chain step (steps{}), a CI job
// (lanes{}), or a WRITE-GUARD RULE — and a rule's red-proof is keyed by the HOOK that runs
// it (hookRules{}), which is why the union here is wider than the Essential Eight script's
// steps ∪ lanes. Four rows rest on a guard rule (dangerouslySetInnerHTML, the weak-crypto
// and key-material rules, the .env read ban); under the narrower union they could not have
// named a proof at all, which is how a closure ends up weakened to fit rather than met.
//
// The judgements are shared with the consumer gate (template/base/tools/lib/
// conformance-map.mjs), never re-implemented, so the two can never disagree about shape.
// SOURCE: scripts/check-essential-eight-evidence.mjs (the factory-side twin this mirrors)
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  canaryProblems,
  guardRuleIds,
  summarise,
} from '../template/base/tools/lib/conformance-map.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REGISTER = 'template/base/tools/conformance-map.json'
const CANARIES = 'tests/canary/injections.json'
const GUARD_RULES = 'template/base/.claude/hooks/lib/guard-rules.mjs'

const fail = (lines) => {
  console.error(`CONFORMANCE EVIDENCE: ${String(lines.length)} problem(s):`)
  for (const l of lines) console.error(`  - ${l}`)
  console.error(
    '\nA row may claim a control only while a registered injection proves that control can go RED, and only the proof of its OWN control — citing another gate’s proof resolves cleanly and proves nothing about the requirement.',
  )
  process.exit(1)
}

let register
let canaries
let guardSource
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
try {
  guardSource = readFileSync(join(ROOT, GUARD_RULES), 'utf8')
} catch (e) {
  fail([`${GUARD_RULES} is missing or unreadable: ${e instanceof Error ? e.message : String(e)}`])
}

// steps ∪ lanes ∪ hookRules — see the header. Anti-vacuity PER REGISTRY rather than over the
// union: a union that is non-empty because one half survived would let every claim backed
// by another half resolve to nothing while this check reported clean.
const sizes = {
  steps: Object.keys(canaries.steps ?? {}).length,
  lanes: Object.keys(canaries.lanes ?? {}).length,
  hookRules: Object.keys(canaries.hookRules ?? {}).length,
}
if (sizes.steps === 0 || sizes.lanes === 0 || sizes.hookRules === 0) {
  fail([
    `${CANARIES} declares ${String(sizes.steps)} steps{}, ${String(sizes.lanes)} lanes{} and ${String(sizes.hookRules)} hookRules{} — all three registries must be populated, or every claim resolving against the empty one passes by finding no evidence at all.`,
  ])
}
const keys = new Set([
  ...Object.keys(canaries.steps ?? {}),
  ...Object.keys(canaries.lanes ?? {}),
  ...Object.keys(canaries.hookRules ?? {}),
])

// THE OTHER HALF OF THE SAME GUARD: canaryProblems() iterates the register's rows, so a
// register with NO rows produces no findings and this script would print CLEAN. An empty
// register is a broken file, never a compliant one.
if (!Array.isArray(register.requirements) || register.requirements.length === 0) {
  fail([
    `${REGISTER} declares no requirements[] — the closure below iterates rows, so an empty register produces zero findings and would be reported CLEAN.`,
  ])
}

const guardRules = guardRuleIds(guardSource)
if (guardRules.size === 0) {
  fail([
    `${GUARD_RULES} yields no rule ids — the guard-rule → hook map is what lets a rule-backed row be held to its OWN hook's proof, and an empty map would let it cite any hook.`,
  ])
}

const problems = canaryProblems(register, keys, guardRules)
if (problems.length > 0) fail(problems)

const s = summarise(register)
// The headline is the POSITIVE-CLAIM count — every row that claims a control — beside the
// negative one, because a closure nobody can see the result of is indistinguishable from
// one that did not run. Module rows with a null canary are counted separately: they are
// CONDITIONAL on their module and the registry keys only what the base tree runs.
const positive = register.requirements.filter(
  (r) => r.outcome === 'covered' || r.outcome === 'partial',
)
const cited = positive.filter((r) => r.canary)
const conditional = positive.filter((r) => !r.canary)
const negative = register.requirements.filter(
  (r) => r.outcome === 'not-applicable' && r.evidenceTier !== 'documentation',
)
const tiers = {}
for (const r of register.requirements) tiers[r.evidenceTier] = (tiers[r.evidenceTier] ?? 0) + 1

console.log(
  `CONFORMANCE EVIDENCE: CLEAN (${String(s.total)} row(s); ${String(positive.length)} positive claim(s) — ${String(cited.length)} name a registered can-fail proof for their OWN control [${[...new Set(cited.map((r) => r.canary))].sort().join(', ')}] and ${String(conditional.length)} module-conditional row(s) carry none; all ${String(negative.length)} above-floor not-applicable row(s) name a registered negativeCanary [${[...new Set(negative.map((r) => r.negativeCanary))].sort().join(', ')}]; tiers ${Object.entries(
    tiers,
  )
    .sort()
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ')})`,
)
